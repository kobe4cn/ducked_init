// app/.server/pipeline/sync-engine.ts —— 同步源表：把变化作为变更批次追加到本租户数据湖的原始层（ADR-0006）。有水位线的表按水位线增量读取（ADR-0012），
// 没有的表每次全表读取、与数据湖里的当前镜像全量比对（ADR-0010）。
// 在工作进程里运行，数据湖与数据源挂在同一个 DuckDB 里（源端只读挂载为 src）。每个数据源在数据湖里一个 schema（bronzeSchema），
// 每张源表一张原始层表：源表的全部列加上操作类型 _op、源端提交时间 _commit_ts、批次号 _batch 与同步时间 _synced_at。
// 批次日志 _batches 与变更批次在同一个 DuckLake 事务里写入，是水位线的唯一依据：任务结果没记下来也不会重复或漏掉变化。
// 有主键（源端主键或成员确认的业务主键）的表另在 <schema>_keys 里保存当前主键状态：每个仍存在的主键一行及其最新一版的整行哈希，
// 用来判断新增还是更新、去掉回看重读到的未变化行，全表读取时找出源端已删除的主键，以及每天比对主键全集。
// 没有主键的表另在 <schema>_mirror 里保存当前镜像：源表当前的每一行（重复行各一行）及其整行哈希，全表读取时按整行多重集比对
import type { DuckDBConnection } from '@duckdb/node-api';
import { SPILL_RATIO, type EngineLimits, type TenantLakeSession } from './lake-engine';
import { primaryKeys, writeGrants, type SourceSpec, type SourceTable, type WatermarkKind } from './source-engine';

/**
 * 同步任务里的一张表：成员确认的水位线字段及其种类（没有时全量比对）；源表没有主键时可带成员声明的业务主键（一列或多列），
 * 有主键（源端主键或业务主键）时可带软删除字段
 */
export interface SyncTableParam { name: string; column?: string; kind?: WatermarkKind; key?: string[]; softDelete?: string }

/**
 * 批次的来源：水位线表的全表读取（首次同步或换了水位线字段）、按水位线增量读取、比对主键全集（有主键的水位线表，补上删除与漏掉的行），
 * 或全量比对（没有水位线的表每次同步；有水位线、没有主键的表每个比对周期一次）。全表读取与全量比对都会与当前主键状态或镜像比对
 */
export type BatchMode = 'full' | 'incremental' | 'reconcile' | 'compare';

/** 同步的可调参数：回看窗口与主键全集比对的周期 */
export interface SyncOptions {
  /** 更新时间与 ObjectId 水位线往回多读的分钟数：补上长事务在上次同步之后才提交的行 */
  lookbackMinutes: number;
  /** 整数自增主键水位线往回多读的主键个数：补上分配在前、提交在后的主键 */
  lookbackIds: number;
  /** 有主键的表多久比对一次主键全集（小时） */
  reconcileHours: number;
}

/** 工作进程从环境变量读取同步参数（SOURCE_SYNC_LOOKBACK_MINUTES 默认 15，SOURCE_SYNC_LOOKBACK_IDS 默认 1000，SOURCE_RECONCILE_HOURS 默认 24） */
export const syncOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): SyncOptions => ({
  lookbackMinutes: Number(env.SOURCE_SYNC_LOOKBACK_MINUTES ?? 15),
  lookbackIds: Number(env.SOURCE_SYNC_LOOKBACK_IDS ?? 1000),
  reconcileHours: Number(env.SOURCE_RECONCILE_HOURS ?? 24),
});

/** 一张表一次同步的结果：成功时是写入的变更批次，失败时是错误。时间为 ISO 字符串 */
export type SyncRecord = { table: string; startedAt: string; durationMs: number } & (
  | {
    batch: number;
    mode: BatchMode;
    rows: number;
    inserted: number;
    updated: number;
    deleted: number;
    /** 水位线字段；没有水位线的表为 null */
    watermarkColumn: string | null;
    /** 本批次的起点（上一批次的水位线）；全表读取时为 null */
    watermarkFrom: string | null;
    /** 实际读取的起点：起点往回退一个回看窗口；全表读取时为 null */
    readFrom: string | null;
    /** 同步后的水位线：起点与本次读到的最大值中较大的一个 */
    watermarkTo: string | null;
  }
  /** gone：源端已经没有这张表，跳过（不算同步失败） */
  | { error: string; gone?: true }
);

/** 数据源在租户数据湖里的原始层 schema */
export const bronzeSchema = (sourceId: string) => `bronze_${sourceId.replace(/-/g, '')}`;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const mysqlIdent = (s: string) => `\`${s.replace(/`/g, '``')}\``;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const columnsOf = (con: DuckDBConnection, relation: string) =>
  rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${relation}`);
const cast = (value: string, type: string) => `CAST(${lit(value)} AS ${type})`;

/** 原始层表里平台追加的列（ADR-0006） */
const BATCH_COLUMNS = `NULL::VARCHAR AS _op, NULL::TIMESTAMPTZ AS _commit_ts, NULL::BIGINT AS _batch, NULL::TIMESTAMPTZ AS _synced_at`;

/** 发往源端执行时一次带多少个主键 */
const KEYS_PER_QUERY = 1000;
/** 比对主键全集时漏掉的主键超过这个数，改为整表读取后在 DuckDB 里筛选，而不是按主键分批查询 */
const MAX_KEYS_BY_QUERY = 20_000;
/** 平台为原始层表追加的列（除此之外都是源表的列） */
export const PLATFORM_COLUMNS = ['_op', '_commit_ts', '_batch', '_synced_at'];
/** 本次读到的行（带整行哈希 _hash），暂存在会话的本机库 stage 里：落盘时压缩，不占溢写配额 */
const INCOMING = 'stage.incoming';
/** 整行多重集比对的中间结果：镜像的整行哈希、各整行哈希的出现次数之差、源端多出来的行、镜像多出来的行，同样暂存在 stage 里 */
const MIRRORED = 'stage.mirrored';
const DIFF = 'stage.diff';
const ADDED = 'stage.added';
const REMOVED = 'stage.removed';
/** 按主键比对的中间结果：当前主键状态的本机副本、要写入的行及其操作类型、源端已经没有的主键 */
const KEYED = 'stage.keyed';
const CHANGED = 'stage.changed';
const GONE = 'stage.gone';
/** 由原始层重建镜像或主键状态时，原始层（带整行哈希）的本机副本 */
const HISTORY = 'stage.history';
/** 按哈希分桶时，每 MiB 内存上限一个桶放多少行（实测 2 GiB 放 3000 多万个哈希仍不溢写，这里留一倍余量） */
const HASHES_PER_MB = 8192;

export type Quote = (name: string) => string;

/**
 * PostgreSQL 与 MySQL：查询写好后经 postgres_query / mysql_query 发往源端执行，条件在源端生效，不依赖扩展的条件下推。
 * 其他数据源返回 null，由调用方在 DuckDB 里读取
 */
export function pushdown(spec: SourceSpec, table: SourceTable, columns: string[] | null, where?: (q: Quote) => string) {
  if (spec.kind !== 'postgres' && spec.kind !== 'mysql') return null;
  const q = spec.kind === 'mysql' ? mysqlIdent : ident;
  const sql = `SELECT ${columns ? columns.map(q).join(', ') : '*'} FROM ${q(table.schema)}.${q(table.table)}${where ? ` WHERE ${where(q)}` : ''}`;
  return `${spec.kind}_query('src', ${lit(sql)})`;
}

/** 在源端执行的查询：PostgreSQL 与 MySQL 发往源端，其他数据源在 DuckDB 里读取。build 拿到引号函数与表的写法 */
export function onSource(spec: SourceSpec, table: SourceTable, build: (q: Quote, from: string) => string) {
  if (spec.kind !== 'postgres' && spec.kind !== 'mysql') return `(${build(ident, table.from)})`;
  const q = spec.kind === 'mysql' ? mysqlIdent : ident;
  return `${spec.kind}_query('src', ${lit(build(q, `${q(table.schema)}.${q(table.table)}`))})`;
}

/**
 * 软删除字段上“仍存在”的条件（DuckDB、PostgreSQL 与 MySQL 通用）：布尔为真、整数非零、日期与时间非空的行按删除处理。
 * column 是已加引号的列
 */
export function liveCondition(column: string, type: string) {
  if (type === 'BOOLEAN') return `${column} IS NOT TRUE`;
  if (/INT/.test(type)) return `(${column} IS NULL OR ${column} = 0)`;
  return `${column} IS NULL`;
}

type KeyCheck = (con: DuckDBConnection, relation: (build: (q: Quote, from: string) => string) => string, keys: string[]) => Promise<string | null>;

/** 业务主键有空值时返回说明。PostgreSQL 与 MySQL 在源端统计，只传回结果 */
const nullKeys: KeyCheck = async (con, relation, keys) => {
  const [{ n: nulls }] = await rows<{ n: string }>(con, `SELECT * FROM ${relation((q, from) =>
    `SELECT COUNT(*) AS n FROM ${from} WHERE ${keys.map(k => `${q(k)} IS NULL`).join(' OR ')}`)}`);
  return Number(nulls) ? `业务主键 ${keys.join('、')} 有 ${nulls} 行为空` : null;
};

/** 业务主键不唯一时返回说明，带一个重复样例 */
const duplicateKey: KeyCheck = async (con, relation, keys) => {
  const [dup] = await rows<Record<string, unknown>>(con, `SELECT * FROM ${relation((q, from) =>
    `SELECT ${keys.map(q).join(', ')}, COUNT(*) AS n FROM ${from} GROUP BY ${keys.map(q).join(', ')} HAVING COUNT(*) > 1 LIMIT 1`)}`);
  return dup ? `业务主键 ${keys.join('、')} 在源表中不唯一（${keys.map(k => `${k}=${dup[k]}`).join(', ')} 出现 ${dup.n} 次）` : null;
};

/** 声明业务主键时的检查结果：主键有空值的行数，以及出现次数最多的至多 KEY_DUPLICATES 个重复键（取值为文本） */
export interface KeyColumnsCheck { nullRows: number; duplicates: { key: string[]; count: number }[] }

/** 检查结果里最多列出几个重复键 */
const KEY_DUPLICATES = 5;

/**
 * 成员声明业务主键时，在源表全表上检查这个组合非空且唯一（不抽样）。行数与空值在源端统计（PostgreSQL 与 MySQL），
 * 重复按主键的哈希分桶找：每桶只读主键列，放得进租户的内存上限，桶多时源表要读多遍
 */
export async function checkKeyColumns(con: DuckDBConnection, spec: SourceSpec, table: SourceTable, keys: string[], limits: EngineLimits): Promise<KeyColumnsCheck> {
  const complete = (q: Quote) => keys.map(k => `${q(k)} IS NOT NULL`).join(' AND ');
  const [{ n, nulls }] = await rows<{ n: string; nulls: string }>(con, `SELECT * FROM ${onSource(spec, table, (q, from) =>
    `SELECT COUNT(*) AS n, COUNT(*) - COUNT(CASE WHEN ${complete(q)} THEN 1 END) AS nulls FROM ${from}`)}`);
  const keyed = onSource(spec, table, (q, from) => `SELECT ${keys.map(q).join(', ')} FROM ${from} WHERE ${complete(q)}`);
  const buckets = bucketCount(limits, Number(n) - Number(nulls));
  const duplicates: KeyColumnsCheck['duplicates'] = [];
  for (let b = 0; b < buckets; b++) {
    const found = await rows<Record<string, string> & { _n: string }>(con, `
      SELECT ${keys.map(k => `${ident(k)}::VARCHAR AS ${ident(k)}`).join(', ')}, count(*) AS _n FROM ${keyed} k
      WHERE ${inBucket(keyHash(keys, 'k'), buckets, b)} GROUP BY ${keyList(keys, 'k')} HAVING count(*) > 1
      ORDER BY _n DESC, ${keys.map(ident).join(', ')} LIMIT ${KEY_DUPLICATES}`);
    duplicates.push(...found.map(d => ({ key: keys.map(k => d[k]), count: Number(d._n) })));
  }
  // 与桶内的排序一致：次数多的在前，次数相同时逐列按文本（字节序）比较
  const byText = (a: string[], b: string[]) => { const i = a.findIndex((v, j) => v !== b[j]); return i < 0 ? 0 : a[i] < b[i] ? -1 : 1; };
  duplicates.sort((a, b) => b.count - a.count || byText(a.key, b.key));
  return { nullRows: Number(nulls), duplicates: duplicates.slice(0, KEY_DUPLICATES) };
}

/**
 * 源端查询里的取值。MySQL 的 TIMESTAMP 列在 DuckDB 里是带时区的时间：换成 FROM_UNIXTIME，
 * 由 MySQL 按会话时区换算（各版本都支持，不依赖 8.0.19 起才有的带时区字面量）
 */
async function sourceValue(con: DuckDBConnection, spec: SourceSpec, type: string, value: string) {
  if (spec.kind !== 'mysql' || type !== 'TIMESTAMP WITH TIME ZONE') return lit(value);
  const [{ epoch }] = await rows<{ epoch: string }>(con, `
    SELECT printf('%d.%06d', us // 1000000, us % 1000000) AS epoch FROM (SELECT epoch_us(${cast(value, 'TIMESTAMPTZ')}) AS us)`);
  return `FROM_UNIXTIME(${epoch})`;
}

/**
 * 回看窗口的起点：更新时间往前 lookbackMinutes 分钟，整数自增主键往前 lookbackIds 个，
 * ObjectId 按其中的创建时间（前 4 字节，秒）往前 lookbackMinutes 分钟
 */
async function lookbackStart(con: DuckDBConnection, kind: WatermarkKind, type: string, from: string, options: SyncOptions) {
  let expr: string;
  if (kind === 'updated_at') {
    expr = `${cast(from, type)} - to_microseconds(${Math.round(options.lookbackMinutes * 60e6)})`;
  } else if (type === 'VARCHAR') {
    expr = `lower(lpad(to_hex(greatest(('0x' || ${lit(from.slice(0, 8))})::BIGINT - ${Math.round(options.lookbackMinutes * 60)}, 0)), 8, '0')) || '0000000000000000'`;
  } else {
    const n = Math.round(options.lookbackIds);
    expr = `CASE WHEN ${cast(from, 'HUGEINT')} >= 0 THEN greatest(${cast(from, 'HUGEINT')} - ${n}, 0) ELSE ${cast(from, 'HUGEINT')} - ${n} END`;
  }
  const [{ start }] = await rows<{ start: string }>(con, `SELECT (${expr})::VARCHAR AS start`);
  return start;
}

interface LastBatch { batch: string; watermark_column: string; watermark_to: string | null }

/** 同步一张表所需的上下文 */
interface TableSync {
  con: DuckDBConnection;
  spec: SourceSpec;
  schema: string;
  table: SourceTable;
  param: SyncTableParam;
  /** 主键列：源端主键，没有时为成员声明的业务主键，都没有时为空 */
  keys: string[];
  /** 成员声明的软删除字段及其在 DuckDB 里的类型 */
  softDelete?: { column: string; type: string };
  options: SyncOptions;
  limits: EngineLimits;
}

const targetOf = (t: TableSync) => `${ident(t.schema)}.${ident(t.table.name)}`;
const keyStateOf = (t: TableSync) => `${ident(`${t.schema}_keys`)}.${ident(t.table.name)}`;
const mirrorOf = (t: TableSync) => `${ident(`${t.schema}_mirror`)}.${ident(t.table.name)}`;
const tableExists = async (con: DuckDBConnection, schema: string, name: string) => (await rows(con, `
  SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).length > 0;
/** 软删除字段上仍存在的行（alias 为行的别名）；没有声明软删除字段时为 true */
const isLive = (t: TableSync, alias: string) => (t.softDelete ? liveCondition(`${alias}.${ident(t.softDelete.column)}`, t.softDelete.type) : 'true');
export const joinOn = (keys: string[], a: string, b: string) => keys.map(k => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' AND ');
export const keyList = (keys: string[], alias?: string) => keys.map(k => (alias ? `${alias}.${ident(k)}` : ident(k))).join(', ');
/**
 * 整行哈希：对“列名=取值”的文本按列名排序后拼接，空值不参与。这样与源端列的顺序、列类型的放宽无关，
 * 源表新增字段（旧行在新字段上为空）也不会让回看窗口里没变的行被当成更新
 */
const rowHash = (columns: string[], alias: string) =>
  `hash(concat_ws(chr(31), ${[...columns].sort().map(c => `${lit(`${c}=`)} || ${alias}.${ident(c)}::VARCHAR`).join(', ')}))`;
const count = async (con: DuckDBConnection, relation: string) => Number((await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${relation}`))[0].n);
/** n 行按哈希分成几个桶：每桶放得进租户的内存上限，不必溢写 */
export const bucketCount = (limits: EngineLimits, n: number) => Math.max(1, Math.ceil(n / (limits.memoryLimitMb * HASHES_PER_MB)));
const bucketsFor = (t: TableSync, n: number) => bucketCount(t.limits, n);
/** 第 b 个桶的条件：hashed 是整行哈希或主键的哈希（整数位宽不同的同一个值哈希相同）；只有一个桶时为 true */
export const inBucket = (hashed: string, buckets: number, b: number) => (buckets > 1 ? `${hashed} % ${buckets} = ${b}` : 'true');
export const keyHash = (keys: string[], alias: string) => `hash(${keyList(keys, alias)})`;

/** 事务里执行：失败时回滚 */
async function inTransaction<T>(con: DuckDBConnection, work: () => Promise<T>) {
  await con.run('BEGIN');
  try {
    const result = await work();
    await con.run('COMMIT');
    return result;
  } catch (e) {
    await con.run('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

type Column = { column_name: string; column_type: string };

/** 为 relation 补上 columns 里它还没有的列（之前的行里为空） */
async function addColumns(con: DuckDBConnection, relation: string, columns: Column[]) {
  const known = new Set((await columnsOf(con, relation)).map(c => c.column_name));
  for (const c of columns.filter(c => !known.has(c.column_name))) {
    await con.run(`ALTER TABLE ${relation} ADD COLUMN ${ident(c.column_name)} ${c.column_type}`);
  }
}

/** 在事务里：原始层表不存在时按 staged（源表的列）的结构建表，存在时为源表新增的字段加列（之前的批次里为空） */
async function ensureTarget(t: TableSync, staged: string, columns: Column[]) {
  if (!await tableExists(t.con, t.schema, t.table.name)) {
    await t.con.run(`CREATE TABLE ${targetOf(t)} AS SELECT *, ${BATCH_COLUMNS} FROM ${staged} LIMIT 0`);
    return;
  }
  await addColumns(t.con, targetOf(t), columns);
}

/**
 * 保证没有主键的表的当前镜像存在，并有源表的全部列。没有时由原始层重建：此前有主键（当前主键状态还在）时，
 * 取状态里每个主键的最新一版（有主键时删除记录只带主键、更新不记旧版本的删除，不能按整行回放）；
 * 否则按整行哈希回放各批次（新增与更新加一次、删除减一次），每个哈希留下净出现次数那么多行。
 * 原始层先连同整行哈希取到本机，再按主键或整行哈希分桶回放，在一个事务里写入镜像
 */
async function ensureMirror(t: TableSync, columns: Column[]) {
  const { con } = t;
  const mirror = mirrorOf(t);
  if (await tableExists(con, `${t.schema}_mirror`, t.table.name)) {
    await addColumns(con, mirror, columns);
    return;
  }
  if (!await tableExists(con, t.schema, t.table.name)) {
    await con.run(`CREATE TABLE ${mirror} AS SELECT * FROM ${INCOMING} LIMIT 0`);
    return;
  }
  const data = (await columnsOf(con, targetOf(t))).map(c => c.column_name).filter(c => !PLATFORM_COLUMNS.includes(c));
  const keyed = await tableExists(con, `${t.schema}_keys`, t.table.name);
  const keys = keyed ? (await columnsOf(con, keyStateOf(t))).map(c => c.column_name).filter(c => c !== '_hash') : [];
  await con.run(`
    CREATE OR REPLACE TABLE ${HISTORY} AS SELECT b.* EXCLUDE (_commit_ts, _synced_at), ${rowHash(data, 'b')} AS _hash
    FROM ${targetOf(t)} b${keyed ? ` WHERE b._op <> 'delete'` : ''}`);
  if (keyed) await con.run(`CREATE OR REPLACE TABLE ${KEYED} AS SELECT ${keyList(keys)} FROM ${keyStateOf(t)}`);
  const buckets = bucketsFor(t, await count(con, HISTORY));
  await inTransaction(con, async () => {
    await con.run(`CREATE TABLE ${mirror} AS SELECT * EXCLUDE (_op, _batch) FROM ${HISTORY} LIMIT 0`);
    for (let b = 0; b < buckets; b++) {
      if (keyed) {
        await con.run(`
          INSERT INTO ${mirror} BY NAME SELECT r.* EXCLUDE (_op, _batch, _rn) FROM (
            SELECT h.*, row_number() OVER (PARTITION BY ${keyList(keys, 'h')} ORDER BY h._batch DESC) AS _rn
            FROM ${HISTORY} h WHERE ${inBucket(keyHash(keys, 'h'), buckets, b)}) r
          SEMI JOIN (SELECT * FROM ${KEYED} s WHERE ${inBucket(keyHash(keys, 's'), buckets, b)}) s ON ${joinOn(keys, 'r', 's')}
          WHERE r._rn = 1`);
      } else {
        await con.run(`
          INSERT INTO ${mirror} BY NAME SELECT r.* EXCLUDE (_op, _batch, _rn) FROM (
            SELECT h.*, row_number() OVER (PARTITION BY h._hash ORDER BY h._batch DESC) AS _rn
            FROM ${HISTORY} h WHERE h._op <> 'delete' AND ${inBucket('h._hash', buckets, b)}) r
          JOIN (
            SELECT _hash, sum(CASE WHEN _op = 'delete' THEN -1 ELSE 1 END) AS _net
            FROM ${HISTORY} WHERE ${inBucket('_hash', buckets, b)} GROUP BY _hash) n ON n._hash = r._hash
          WHERE r._rn <= n._net`);
      }
    }
  });
  await con.run(`DROP TABLE ${HISTORY}; DROP TABLE IF EXISTS ${KEYED}`);
  await addColumns(con, mirror, columns);
}

/**
 * 保证当前主键状态存在且按当前主键组织。没有（首次同步、此前没有主键）或主键变了（成员改了业务主键）时重建：
 * 此前没有主键、当前镜像还在时由镜像接续（整行比对的删除可能比新版本晚几个批次才记下，按批次取最新一版会把主键当成已删除）；
 * 否则由原始层重建，每个主键取最新一版（同一批次里一删一增时取新增），去掉最新一版是删除的。
 * 镜像或原始层先取到本机，再按主键的哈希分桶，在一个事务里写入主键状态
 */
async function ensureKeyState(t: TableSync, columns: Column[]) {
  const { con, keys } = t;
  const state = keyStateOf(t);
  if (await tableExists(con, `${t.schema}_keys`, t.table.name)) {
    const current = (await columnsOf(con, state)).map(c => c.column_name).filter(c => c !== '_hash');
    if (current.join('\u0000') === keys.join('\u0000')) return;
    await con.run(`DROP TABLE ${state}`);
  }
  const mirrored = await tableExists(con, `${t.schema}_mirror`, t.table.name);
  if (!mirrored && !await tableExists(con, t.schema, t.table.name)) {
    await con.run(`CREATE TABLE ${state} AS SELECT ${keyList(keys)}, _hash FROM ${INCOMING} LIMIT 0`);
    return;
  }
  if (mirrored) {
    await con.run(`CREATE OR REPLACE TABLE ${HISTORY} AS SELECT ${keyList(keys)}, _hash FROM ${mirrorOf(t)}`);
  } else {
    // 原始层还没有的新字段在旧行里为空，整行哈希里本来就不计
    const known = new Set((await columnsOf(con, targetOf(t))).map(c => c.column_name));
    const hashed = columns.map(c => c.column_name).filter(c => known.has(c));
    await con.run(`
      CREATE OR REPLACE TABLE ${HISTORY} AS SELECT ${keyList(keys, 'b')}, b._batch, b._op, ${rowHash(hashed, 'b')} AS _hash FROM ${targetOf(t)} b`);
  }
  const buckets = bucketsFor(t, await count(con, HISTORY));
  await inTransaction(con, async () => {
    await con.run(`CREATE TABLE ${state} AS SELECT ${keyList(keys)}, _hash FROM ${HISTORY} LIMIT 0`);
    for (let b = 0; b < buckets; b++) {
      const bucket = inBucket(keyHash(keys, 'h'), buckets, b);
      await con.run(mirrored
        ? `INSERT INTO ${state} SELECT ${keyList(keys, 'h')}, any_value(h._hash) FROM ${HISTORY} h WHERE ${bucket} GROUP BY ${keyList(keys, 'h')}`
        : `INSERT INTO ${state} SELECT ${keyList(keys, 'r')}, r._hash FROM (
            SELECT h.*, row_number() OVER (PARTITION BY ${keyList(keys, 'h')} ORDER BY h._batch DESC, h._op = 'delete') AS _rn
            FROM ${HISTORY} h WHERE ${bucket}) r
          WHERE r._rn = 1 AND r._op <> 'delete'`);
    }
  });
  await con.run(`DROP TABLE ${HISTORY}`);
}

/**
 * 在写入数据湖的事务之前：有主键的表按主键与当前主键状态比对，结果暂存在 stage 里。CHANGED 是要写入的行及其操作类型：
 * 新增、更新，以及软删除字段标记为删除、主键状态里还有的行；全表读取时 GONE 是主键状态里有、源端已经没有的主键。
 * 全表读取时主键状态先取到本机，两边按主键的哈希分桶比对；增量读取的行不多，直接与数据湖里的主键状态比对。
 * 主键状态为空（首次同步）时读到的行都是新增，不必比对。
 * 返回要写入的行所在的关系，以及主键状态里要换掉的主键数（主键状态为空时为 0）
 */
async function stageKeyedDiff(t: TableSync, incremental: boolean) {
  const { con, keys } = t;
  const state = keyStateOf(t);
  await con.run(`CREATE OR REPLACE TABLE ${GONE} AS SELECT ${keyList(keys)} FROM ${INCOMING} LIMIT 0`);
  const stated = await count(con, state);
  if (!stated) return { changed: `(SELECT i.*, 'insert' AS _op FROM ${INCOMING} i WHERE ${isLive(t, 'i')})`, replaced: 0 };

  let known = state;
  let buckets = 1;
  if (!incremental) {
    await con.run(`CREATE OR REPLACE TABLE ${KEYED} AS SELECT * FROM ${state}`);
    known = KEYED;
    buckets = bucketsFor(t, await count(con, INCOMING) + stated);
  }
  await con.run(`CREATE OR REPLACE TABLE ${CHANGED} AS SELECT *, NULL::VARCHAR AS _op FROM ${INCOMING} LIMIT 0`);
  for (let b = 0; b < buckets; b++) {
    const read = `(SELECT * FROM ${INCOMING} i WHERE ${inBucket(keyHash(keys, 'i'), buckets, b)})`;
    const held = `(SELECT * FROM ${known} s WHERE ${inBucket(keyHash(keys, 's'), buckets, b)})`;
    await con.run(`
      INSERT INTO ${CHANGED} BY NAME SELECT i.*, CASE WHEN s._hash IS NULL THEN 'insert' ELSE 'update' END AS _op
      FROM ${read} i LEFT JOIN ${held} s ON ${joinOn(keys, 's', 'i')}
      WHERE ${isLive(t, 'i')} AND s._hash IS DISTINCT FROM i._hash`);
    if (t.softDelete) {
      await con.run(`
        INSERT INTO ${CHANGED} BY NAME SELECT i.*, 'delete' AS _op
        FROM ${read} i SEMI JOIN ${held} s ON ${joinOn(keys, 's', 'i')} WHERE NOT (${isLive(t, 'i')})`);
    }
    if (!incremental) {
      await con.run(`INSERT INTO ${GONE} SELECT ${keyList(keys, 's')} FROM ${held} s ANTI JOIN ${read} i ON ${joinOn(keys, 's', 'i')}`);
    }
  }
  if (known === KEYED) await con.run(`DROP TABLE ${KEYED}`);
  return { changed: CHANGED, replaced: await count(con, CHANGED) + await count(con, GONE) };
}

/**
 * 在事务里：写入主键比对的结果（stageKeyedDiff），随后主键状态跟上源端：写入与删除的主键先移除（按主键的哈希分桶），
 * 再放入新增与更新的行（整行哈希取读取时算好的，与下次读到的比对口径一致）
 */
async function applyKeyedDiff(t: TableSync, changed: string, replaced: number, batch: number, syncedAt: string) {
  const { con, keys } = t;
  const state = keyStateOf(t);
  await con.run(`INSERT INTO ${targetOf(t)} BY NAME SELECT c.* EXCLUDE (_hash, _op), ${batchColumns(t, 'c._op', batch, syncedAt, 'c')} FROM ${changed} c`);
  await con.run(`INSERT INTO ${targetOf(t)} BY NAME SELECT g.*, ${batchColumns(t, `'delete'`, batch, syncedAt, 'g')} FROM ${GONE} g`);
  const buckets = bucketsFor(t, replaced);
  for (let b = 0; replaced && b < buckets; b++) {
    await con.run(`
      DELETE FROM ${state} USING (
        SELECT ${keyList(keys, 'c')} FROM ${changed} c WHERE ${inBucket(keyHash(keys, 'c'), buckets, b)}
        UNION ALL SELECT ${keyList(keys, 'g')} FROM ${GONE} g WHERE ${inBucket(keyHash(keys, 'g'), buckets, b)}) n
      WHERE ${joinOn(keys, state, 'n')}`);
  }
  await con.run(`INSERT INTO ${state} SELECT ${keyList(keys, 'c')}, c._hash FROM ${changed} c WHERE c._op <> 'delete'`);
}

/** 主键在读到的行里必须非空且唯一（成员声明的业务主键只在声明时校验过）。按主键的哈希分桶找重复 */
async function assertKeysUnique(t: TableSync, columns: string[]) {
  const missing = t.keys.filter(k => !columns.includes(k));
  if (missing.length) throw new Error(`源表中没有主键字段 ${missing.join('、')}，请重新采集并确认`);
  const problem = await nullKeys(t.con, build => `(${build(ident, INCOMING)})`, t.keys);
  if (problem) throw new Error(`${problem}，请换一个业务主键`);
  const buckets = bucketsFor(t, await count(t.con, INCOMING));
  for (let b = 0; b < buckets; b++) {
    const read = `(SELECT * FROM ${INCOMING} i WHERE ${inBucket(keyHash(t.keys, 'i'), buckets, b)})`;
    const duplicate = await duplicateKey(t.con, build => `(${build(ident, read)})`, t.keys);
    if (duplicate) throw new Error(`${duplicate}，请换一个业务主键`);
  }
}

/**
 * 本批次行的平台列：更新时间水位线的源端提交时间取该字段（fromRow 为 false 时不取，如只带主键的删除记录），
 * 其余（自增主键、全量比对、比对出的删除）用同步时间代替
 */
const batchColumns = (t: TableSync, op: string, batch: number, syncedAt: string, alias: string, fromRow = op !== `'delete'`) => `
  ${op} AS _op,
  ${t.param.kind === 'updated_at' && fromRow ? `CAST(${alias}.${ident(t.param.column!)} AS TIMESTAMPTZ)` : syncedAt} AS _commit_ts,
  ${batch} AS _batch,
  ${syncedAt} AS _synced_at`;

/** 在事务里：本批次的行数与各操作的行数 */
async function batchStats(t: TableSync, batch: number) {
  const [s] = await rows<{ n: string; inserted: string; updated: string; deleted: string }>(t.con, `
    SELECT count(*) AS n, count_if(_op = 'insert') AS inserted, count_if(_op = 'update') AS updated, count_if(_op = 'delete') AS deleted
    FROM ${targetOf(t)} WHERE _batch = ${batch}`);
  return { rows: Number(s.n), inserted: Number(s.inserted), updated: Number(s.updated), deleted: Number(s.deleted) };
}

/** 在事务里：记入批次日志并返回本批次的结果 */
async function recordBatch(t: TableSync, record: Extract<SyncRecord, { batch: number }>, startedAt: Date, finishedAt: Date) {
  const v = (s: string | null) => (s === null ? 'NULL' : lit(s));
  await t.con.run(`INSERT INTO ${ident(t.schema)}._batches VALUES (
    ${lit(t.table.name)}, ${record.batch}, ${lit(record.mode)}, ${v(record.watermarkColumn)},
    ${v(record.watermarkFrom)}, ${v(record.readFrom)}, ${v(record.watermarkTo)},
    ${record.rows}, ${record.inserted}, ${record.updated}, ${record.deleted},
    TIMESTAMPTZ ${lit(startedAt.toISOString())}, TIMESTAMPTZ ${lit(finishedAt.toISOString())})`);
  return record;
}

/**
 * 在写入数据湖的事务之前：没有主键的表按整行多重集与当前镜像比对，结果暂存在 stage 里。
 * 各整行哈希在源端与镜像里出现次数之差按哈希分桶统计（每桶的哈希放得进内存，不必溢写），只留下有差异的哈希；
 * 源端多出来的行（ADDED）与镜像多出来的行（REMOVED）按差值取够行数，完全相同的重复行按出现次数计。
 * 镜像为空（首次同步）时读到的行都是新增，不必比对。返回源端多出来的行所在的关系
 */
async function stageMultisetDiff(t: TableSync) {
  const { con } = t;
  const mirror = mirrorOf(t);
  await con.run(`CREATE OR REPLACE TABLE ${DIFF} (_hash UBIGINT, _delta BIGINT, _n BIGINT)`);
  await con.run(`CREATE OR REPLACE TABLE ${REMOVED} AS SELECT * FROM ${mirror} LIMIT 0`);
  const mirrored = await count(con, mirror);
  if (!mirrored) return INCOMING;

  // 镜像的哈希先取到本机，分桶时不必反复读数据湖
  await con.run(`CREATE OR REPLACE TABLE ${MIRRORED} AS SELECT _hash FROM ${mirror}`);
  const buckets = bucketsFor(t, await count(con, INCOMING) + mirrored);
  for (let b = 0; b < buckets; b++) {
    await con.run(`
      INSERT INTO ${DIFF}
      SELECT _hash, sum(s) AS _delta, count_if(s = 1) AS _n FROM (
        SELECT _hash, 1 AS s FROM ${INCOMING} WHERE ${inBucket('_hash', buckets, b)}
        UNION ALL SELECT _hash, -1 AS s FROM ${MIRRORED} WHERE ${inBucket('_hash', buckets, b)})
      GROUP BY _hash HAVING sum(s) <> 0`);
  }
  await con.run(`DROP TABLE ${MIRRORED}`);

  // 某个哈希在源端的行全是多出来的（最常见：新行）时整组都取，否则按差值取够行数
  await con.run(`CREATE OR REPLACE TABLE ${ADDED} AS SELECT * FROM ${INCOMING} LIMIT 0`);
  for (let b = 0; b < buckets; b++) {
    const grown = `(SELECT * FROM ${DIFF} WHERE ${inBucket('_hash', buckets, b)} AND _delta > 0)`;
    await con.run(`INSERT INTO ${ADDED} SELECT i.* FROM ${INCOMING} i JOIN ${grown} d ON d._hash = i._hash WHERE d._delta = d._n`);
    await con.run(`
      INSERT INTO ${ADDED} SELECT r.* EXCLUDE (_delta, _rn) FROM (
        SELECT i.*, d._delta, row_number() OVER (PARTITION BY i._hash) AS _rn
        FROM ${INCOMING} i JOIN ${grown} d ON d._hash = i._hash WHERE d._delta < d._n) r
      WHERE r._rn <= r._delta`);
  }
  await con.run(`
    INSERT INTO ${REMOVED} SELECT r.* EXCLUDE (_delta, _rn) FROM (
      SELECT m.*, d._delta, row_number() OVER (PARTITION BY m._hash) AS _rn
      FROM ${mirror} m JOIN (SELECT * FROM ${DIFF} WHERE _delta < 0) d ON d._hash = m._hash) r
    WHERE r._rn <= -r._delta`);
  return ADDED;
}

/**
 * 在事务里：写入整行多重集比对的结果（stageMultisetDiff）。源端多出来的行记为新增、镜像多出来的行记为删除（带整行），
 * 修改表现为一删一增。随后镜像跟上源端：有行减少的哈希换成源端的行，再追加多出来的行
 */
async function applyMultisetDiff(t: TableSync, added: string, batch: number, syncedAt: string) {
  const { con } = t;
  const mirror = mirrorOf(t);
  const shrunk = `(SELECT _hash FROM ${DIFF} WHERE _delta < 0)`;
  await con.run(`INSERT INTO ${targetOf(t)} BY NAME SELECT r.* EXCLUDE (_hash), ${batchColumns(t, `'insert'`, batch, syncedAt, 'r')} FROM ${added} r`);
  await con.run(`INSERT INTO ${targetOf(t)} BY NAME SELECT r.* EXCLUDE (_hash), ${batchColumns(t, `'delete'`, batch, syncedAt, 'r')} FROM ${REMOVED} r`);
  await con.run(`DELETE FROM ${mirror} WHERE _hash IN ${shrunk}`);
  await con.run(`INSERT INTO ${mirror} BY NAME SELECT i.* FROM ${INCOMING} i SEMI JOIN ${shrunk} d ON d._hash = i._hash`);
  await con.run(`INSERT INTO ${mirror} BY NAME SELECT * FROM ${added}`);
}

/**
 * 同步一张表，产出一个变更批次（可能为空）：
 * - 有水位线、已经按当前水位线字段同步过的表增量读取：从水位线往回退一个回看窗口读起，补上长事务晚提交、
 *   自增主键晚提交的行。回看重读到的、已经同步过的行不再写入：有主键时与当前主键状态里的整行哈希比对，
 *   没有主键时与原始层里同一范围的行比对。有主键时，当前主键状态里有的记为更新，否则记为新增；没有主键的表一律记为新增。
 * - 其余情况（没有水位线的表、水位线表首次同步或换了字段，以及 compare 为真时）全表读取并比对：有主键时按主键
 *   与当前主键状态全外连接，得出新增、更新与删除（删除只带主键）；没有主键时按整行多重集与当前镜像比对。
 * 声明了软删除字段时，标记为删除的行按源端已删除处理：当前主键状态里有的记一条删除（带整行），没有的跳过
 */
async function syncTable(t: TableSync, compare = false): Promise<Extract<SyncRecord, { batch: number }>> {
  const { con, spec, schema, table, param, keys } = t;
  const startedAt = new Date();
  const target = targetOf(t);
  const [last] = await rows<LastBatch>(con, `
    SELECT batch, watermark_column, watermark_to FROM ${ident(schema)}._batches
    WHERE table_name = ${lit(table.name)} ORDER BY batch DESC LIMIT 1`);
  const from = param.column && last?.watermark_column === param.column ? last.watermark_to : null;
  const incremental = from !== null && !compare;
  const mode: BatchMode = !param.column || compare ? 'compare' : incremental ? 'incremental' : 'full';
  const batch = Number(last?.batch ?? 0) + 1;

  const described = await columnsOf(con, `SELECT * FROM ${table.from}`);
  const wm = param.column ? described.find(c => c.column_name === param.column) : undefined;
  if (param.column && !wm) throw new Error(`源表中没有水位线字段 ${param.column}，请重新采集并确认`);
  const readFrom = incremental ? await lookbackStart(con, param.kind!, wm!.column_type, from!, t.options) : null;
  const bound = readFrom === null ? null : await sourceValue(con, spec, wm!.column_type, readFrom);
  const read = pushdown(spec, table, null, bound === null ? undefined : q => `${q(param.column!)} >= ${bound}`)
    ?? `(SELECT * FROM ${table.from}${readFrom === null ? '' : ` WHERE ${ident(param.column!)} >= ${cast(readFrom, wm!.column_type)}`})`;
  // 读取时一并算好整行哈希：比对、去重与更新当前主键状态都用它
  await con.run(`CREATE OR REPLACE TABLE ${INCOMING} AS SELECT r.*, ${rowHash(described.map(c => c.column_name), 'r')} AS _hash FROM ${read} r`);
  try {
    const columns = (await columnsOf(con, INCOMING)).filter(c => c.column_name !== '_hash');
    const names = columns.map(c => c.column_name);
    const staged = `(SELECT * EXCLUDE (_hash) FROM ${INCOMING})`;
    if (keys.length) await assertKeysUnique(t, names);
    const top = wm ? (await rows<{ top: string | null }>(con, `
      SELECT greatest(${from === null ? 'NULL' : cast(from, wm.column_type)}, max(${ident(wm.column_name)}))::VARCHAR AS top FROM ${INCOMING}`))[0].top : null;
    const syncedAt = `TIMESTAMPTZ ${lit(startedAt.toISOString())}`;
    const multiset = !keys.length && !incremental;
    // 先保证主键状态或镜像存在、比对好（在写入数据湖的事务之外：一个事务只能写一个库，比对结果暂存在 stage 里）
    if (keys.length) await ensureKeyState(t, columns);
    else await ensureMirror(t, columns);
    const keyed = keys.length ? await stageKeyedDiff(t, incremental) : null;
    const added = multiset ? await stageMultisetDiff(t) : null;

    return await inTransaction(con, async () => {
      await ensureTarget(t, staged, columns);
      if (keyed) {
        // 当前主键状态与镜像只保留正在维护的那一个：主键有无变化后，另一个会过时（主键状态可能已由镜像接续）
        await con.run(`DROP TABLE IF EXISTS ${mirrorOf(t)}`);
        await applyKeyedDiff(t, keyed.changed, keyed.replaced, batch, syncedAt);
      } else {
        await con.run(`DROP TABLE IF EXISTS ${keyStateOf(t)}`);
        if (added) {
          await applyMultisetDiff(t, added, batch, syncedAt);
        } else {
          const inWindow = (alias: string) => `${alias}.${ident(param.column!)} <= ${cast(from!, wm!.column_type)}`;
          await con.run(`
            INSERT INTO ${target} BY NAME SELECT i.* EXCLUDE (_hash), ${batchColumns(t, `'insert'`, batch, syncedAt, 'i')} FROM ${INCOMING} i
            WHERE NOT coalesce(${inWindow('i')} AND i._hash IN (
              SELECT ${rowHash(names, 'b')} FROM ${target} b
              WHERE b.${ident(param.column!)} >= ${cast(readFrom!, wm!.column_type)} AND ${inWindow('b')}), false)`);
          // 增量写入的行同样进入镜像，下次整行比对时才不会被当成新增
          await con.run(`INSERT INTO ${mirrorOf(t)} BY NAME SELECT i.* FROM ${INCOMING} i SEMI JOIN (
            SELECT ${rowHash(names, 'b')} AS _hash FROM ${target} b WHERE b._batch = ${batch}) n ON n._hash = i._hash`);
        }
      }
      return recordBatch(t, {
        table: table.name,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        batch,
        mode,
        ...(await batchStats(t, batch)),
        watermarkColumn: param.column ?? null,
        watermarkFrom: from,
        readFrom,
        watermarkTo: top,
      }, startedAt, new Date());
    });
  } finally {
    await con.run([INCOMING, MIRRORED, DIFF, ADDED, REMOVED, KEYED, CHANGED, GONE, HISTORY].map(r => `DROP TABLE IF EXISTS ${r};`).join(' '));
  }
}

/** 距上次读全集（全表读取、主键比对或全量比对）是否已满一个比对周期 */
async function reconcileDue(t: TableSync, now: Date) {
  const dueBefore = new Date(now.getTime() - t.options.reconcileHours * 3_600_000);
  const [{ due }] = await rows<{ due: boolean | null }>(t.con, `
    SELECT max(started_at) <= TIMESTAMPTZ ${lit(dueBefore.toISOString())} AS due FROM ${ident(t.schema)}._batches
    WHERE table_name = ${lit(t.table.name)} AND mode IN ('full', 'reconcile', 'compare')`);
  return due === true;
}

/** 读取源表中这些主键的整行：主键不多时按主键分批发往源端查询，否则整表读取后在 DuckDB 里筛选 */
async function readRowsByKey(t: TableSync, missing: string, count: number) {
  const { con, spec, table, keys } = t;
  if (count > MAX_KEYS_BY_QUERY || !pushdown(spec, table, null)) {
    await con.run(`CREATE TEMP TABLE backfill AS SELECT r.* FROM ${table.from} r SEMI JOIN ${missing} m ON ${joinOn(keys, 'r', 'm')}`);
    return;
  }
  // 主键值一律写成字符串字面量，由源端按列的类型转换
  const quoted = keys.map(k => `'''' || replace(${ident(k)}::VARCHAR, '''', '''''') || ''''`);
  const values = await rows<{ tuple: string }>(con, `
    SELECT ${keys.length > 1 ? `'(' || concat_ws(', ', ${quoted.join(', ')}) || ')'` : quoted[0]} AS tuple FROM ${missing}`);
  for (let i = 0; i < values.length; i += KEYS_PER_QUERY) {
    const chunk = values.slice(i, i + KEYS_PER_QUERY).map(v => v.tuple).join(', ');
    const read = pushdown(spec, table, null, q => `${keys.length > 1 ? `(${keys.map(q).join(', ')})` : q(keys[0])} IN (${chunk})`)!;
    await con.run(i === 0 ? `CREATE TEMP TABLE backfill AS SELECT * FROM ${read}` : `INSERT INTO backfill BY NAME SELECT * FROM ${read}`);
  }
}

/**
 * 比对主键全集（有主键的水位线表，每 reconcileHours 小时一次），产出一个批次：当前主键状态里有、源端已没有的主键记为删除
 * （只带主键列），源端有、当前主键状态里没有的主键（水位线漏掉的行）读取整行后记为新增。软删除字段标记为删除的行不算源端有。
 * 水位线不变
 */
async function reconcileTable(t: TableSync, previous: Extract<SyncRecord, { batch: number }>): Promise<SyncRecord> {
  const { con, spec, table, keys } = t;
  const startedAt = new Date();
  const target = targetOf(t);
  const state = keyStateOf(t);
  const batch = previous.batch + 1;
  const syncedAt = `TIMESTAMPTZ ${lit(startedAt.toISOString())}`;
  try {
    const live = t.softDelete && ((q: Quote) => liveCondition(q(t.softDelete!.column), t.softDelete!.type));
    const read = pushdown(spec, table, keys, live || undefined)
      ?? `(SELECT ${keyList(keys)} FROM ${table.from}${live ? ` WHERE ${live(ident)}` : ''})`;
    await con.run(`CREATE TEMP TABLE source_keys AS SELECT * FROM ${read}`);
    await con.run(`CREATE TEMP TABLE missing AS SELECT k.* FROM source_keys k ANTI JOIN ${state} s ON ${joinOn(keys, 'k', 's')}`);
    const [{ n }] = await rows<{ n: string }>(con, 'SELECT count(*) AS n FROM missing');
    if (Number(n)) await readRowsByKey(t, 'missing', Number(n));
    const columns = Number(n) ? await columnsOf(con, 'backfill') : [];
    const names = columns.map(c => c.column_name);

    return await inTransaction(con, async () => {
      await con.run(`
        INSERT INTO ${target} BY NAME
        SELECT ${keyList(keys, 's')}, ${batchColumns(t, `'delete'`, batch, syncedAt, 's')}
        FROM ${state} s ANTI JOIN source_keys k ON ${joinOn(keys, 's', 'k')}`);
      if (columns.length) {
        await ensureTarget(t, 'backfill', columns);
        await con.run(`INSERT INTO ${target} BY NAME SELECT r.*, ${batchColumns(t, `'insert'`, batch, syncedAt, 'r')} FROM backfill r`);
      }
      await con.run(`DELETE FROM ${state} USING (SELECT ${keyList(keys)} FROM ${target} WHERE _batch = ${batch} AND _op = 'delete') d
        WHERE ${joinOn(keys, state, 'd')}`);
      if (columns.length) await con.run(`INSERT INTO ${state} SELECT ${keyList(keys, 'r')}, ${rowHash(names, 'r')} FROM backfill r`);
      return recordBatch(t, {
        table: table.name,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        batch,
        mode: 'reconcile',
        ...(await batchStats(t, batch)),
        watermarkColumn: previous.watermarkColumn,
        watermarkFrom: previous.watermarkTo,
        readFrom: null,
        watermarkTo: previous.watermarkTo,
      }, startedAt, new Date());
    });
  } finally {
    await con.run('DROP TABLE IF EXISTS source_keys; DROP TABLE IF EXISTS missing; DROP TABLE IF EXISTS backfill');
  }
}

/** DuckDB 内存或溢写空间不足时，在报错前说明租户的配额与处理办法 */
function explain(message: string, limits: EngineLimits) {
  if (!/Out of Memory/i.test(message)) return message;
  return `超出租户的计算配额（单任务内存 ${limits.memoryLimitMb} MiB、线程 ${limits.threads}，溢写上限 ${limits.memoryLimitMb * SPILL_RATIO} MiB），`
    + `请运营者在租户页提高单任务内存上限后重新同步；有水位线或主键时确认下来也能减少比对的开销。原始错误：${message}`;
}

/**
 * 同步数据源的若干张表（有水位线的增量读取，没有的全量比对），每张表一个变更批次、各自一个事务：一张表失败不影响其他表，
 * 源端已经没有的表记为跳过。
 * 增量同步的表到了比对周期时，紧接着再比对一次：有主键的比对主键全集，没有的整行全量比对。
 * 账号可写时整体拒绝（登记之后才被授予写权限的账号）。
 * redact 用来抹掉错误信息里的凭据
 */
export async function syncSourceTables(
  session: TenantLakeSession, spec: SourceSpec, sourceId: string, params: SyncTableParam[], limits: EngineLimits,
  redact: (message: string) => string, options: SyncOptions = syncOptionsFromEnv(),
): Promise<SyncRecord[]> {
  const { con, source } = session;
  if (!source) throw new Error('数据源没有挂载');
  const writable = await writeGrants({ con, mongo: source.mongo }, spec);
  if (writable.length) throw new Error(`账号可以写入数据源（${writable.map(g => g.object).join('、')}），平台只使用只读账号，请更换账号`);
  const tables = await source.tables();
  const primary = await primaryKeys(con, spec, tables);
  const schema = bronzeSchema(sourceId);
  await con.run(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)};
    CREATE SCHEMA IF NOT EXISTS ${ident(`${schema}_keys`)};
    CREATE SCHEMA IF NOT EXISTS ${ident(`${schema}_mirror`)};
    CREATE TABLE IF NOT EXISTS ${ident(schema)}._batches (
      table_name VARCHAR, batch BIGINT, mode VARCHAR, watermark_column VARCHAR, watermark_from VARCHAR, read_from VARCHAR, watermark_to VARCHAR,
      rows BIGINT, inserted BIGINT, updated BIGINT, deleted BIGINT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);

  const records: SyncRecord[] = [];
  const failed = (table: string, startedAt: Date, e: unknown): SyncRecord =>
    ({ table, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: redact(explain((e as Error).message, limits)) });
  for (const param of params) {
    let startedAt = new Date();
    const table = tables.find(t => t.name === param.name);
    if (!table) {
      records.push({ table: param.name, startedAt: startedAt.toISOString(), durationMs: 0, error: `源端已不存在表 ${param.name}，已跳过`, gone: true });
      continue;
    }
    try {
      if (!table.readable) throw new Error(`账号没有表 ${param.name} 的读权限`);
      const keys = primary.get(param.name) ?? param.key ?? [];
      const t: TableSync = { con, spec, schema, table, param, keys, options, limits };
      if (param.softDelete) {
        if (!keys.length) throw new Error(`没有主键的表不能按软删除字段 ${param.softDelete} 产出删除，请先声明业务主键`);
        const column = (await columnsOf(con, `SELECT * FROM ${table.from}`)).find(c => c.column_name === param.softDelete);
        if (!column) throw new Error(`源表中没有软删除字段 ${param.softDelete}，请重新采集并确认`);
        t.softDelete = { column: column.column_name, type: column.column_type };
      }
      const synced = await syncTable(t);
      records.push(synced);
      startedAt = new Date();
      if (synced.mode === 'incremental' && await reconcileDue(t, startedAt)) {
        records.push(keys.length ? await reconcileTable(t, synced) : await syncTable(t, true));
      }
    } catch (e) {
      records.push(failed(param.name, startedAt, e));
    }
  }
  return records;
}

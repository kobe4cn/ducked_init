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
import { openSource, primaryKeys, redactSourceSecrets, writeGrants, type SourceSpec, type SourceTable, type WatermarkKind } from './source-engine';

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
  | { error: string }
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
const PLATFORM_COLUMNS = ['_op', '_commit_ts', '_batch', '_synced_at'];
/** 本次读到的行（带整行哈希 _hash），暂存在会话的本机库 stage 里：落盘时压缩，不占溢写配额 */
const INCOMING = 'stage.incoming';
/** 整行多重集比对的中间结果：镜像的整行哈希、各整行哈希的出现次数之差、源端多出来的行、镜像多出来的行，同样暂存在 stage 里 */
const MIRRORED = 'stage.mirrored';
const DIFF = 'stage.diff';
const ADDED = 'stage.added';
const REMOVED = 'stage.removed';
/** 按整行哈希分桶比对时，每 MiB 内存上限一个桶放多少个哈希（实测 2 GiB 放 3000 多万个仍不溢写，这里留一倍余量） */
const HASHES_PER_MB = 8192;

type Quote = (name: string) => string;

/**
 * PostgreSQL 与 MySQL：查询写好后经 postgres_query / mysql_query 发往源端执行，条件在源端生效，不依赖扩展的条件下推。
 * 其他数据源返回 null，由调用方在 DuckDB 里读取
 */
function pushdown(spec: SourceSpec, table: SourceTable, columns: string[] | null, where?: (q: Quote) => string) {
  if (spec.kind !== 'postgres' && spec.kind !== 'mysql') return null;
  const q = spec.kind === 'mysql' ? mysqlIdent : ident;
  const sql = `SELECT ${columns ? columns.map(q).join(', ') : '*'} FROM ${q(table.schema)}.${q(table.table)}${where ? ` WHERE ${where(q)}` : ''}`;
  return `${spec.kind}_query('src', ${lit(sql)})`;
}

/** 在源端执行的查询：PostgreSQL 与 MySQL 发往源端，其他数据源在 DuckDB 里读取。build 拿到引号函数与表的写法 */
function onSource(spec: SourceSpec, table: SourceTable, build: (q: Quote, from: string) => string) {
  if (spec.kind !== 'postgres' && spec.kind !== 'mysql') return `(${build(ident, table.from)})`;
  const q = spec.kind === 'mysql' ? mysqlIdent : ident;
  return `${spec.kind}_query('src', ${lit(build(q, `${q(table.schema)}.${q(table.table)}`))})`;
}

/**
 * 软删除字段上“仍存在”的条件（DuckDB、PostgreSQL 与 MySQL 通用）：布尔为真、整数非零、日期与时间非空的行按删除处理。
 * column 是已加引号的列
 */
function liveCondition(column: string, type: string) {
  if (type === 'BOOLEAN') return `${column} IS NOT TRUE`;
  if (/INT/.test(type)) return `(${column} IS NULL OR ${column} = 0)`;
  return `${column} IS NULL`;
}

/**
 * 业务主键在源表中的问题：有空值或不唯一时返回说明（不唯一时带一个重复样例），没有问题时返回 null。
 * PostgreSQL 与 MySQL 在源端统计，只传回结果
 */
async function keyViolation(con: DuckDBConnection, relation: (build: (q: Quote, from: string) => string) => string, keys: string[]) {
  const [{ n: nulls }] = await rows<{ n: string }>(con, `SELECT * FROM ${relation((q, from) =>
    `SELECT COUNT(*) AS n FROM ${from} WHERE ${keys.map(k => `${q(k)} IS NULL`).join(' OR ')}`)}`);
  if (Number(nulls)) return `业务主键 ${keys.join('、')} 有 ${nulls} 行为空`;
  const [dup] = await rows<Record<string, unknown>>(con, `SELECT * FROM ${relation((q, from) =>
    `SELECT ${keys.map(q).join(', ')}, COUNT(*) AS n FROM ${from} GROUP BY ${keys.map(q).join(', ')} HAVING COUNT(*) > 1 LIMIT 1`)}`);
  if (dup) return `业务主键 ${keys.join('、')} 在源表中不唯一（${keys.map(k => `${k}=${dup[k]}`).join(', ')} 出现 ${dup.n} 次）`;
  return null;
}

/**
 * 成员声明业务主键时，在源端校验这个组合非空且唯一（要扫一遍源表，PostgreSQL 与 MySQL 在源端执行）。
 * 返回问题说明，没有问题时返回 null。redact 前的错误信息可能带凭据，这里一并抹掉
 */
export async function checkDeclaredKey(spec: SourceSpec, limits: EngineLimits, tableName: string, keys: string[]) {
  const session = await openSource(spec, limits);
  try {
    const table = (await session.tables()).find(t => t.name === tableName);
    if (!table) throw new Error(`数据源中已没有表 ${tableName}`);
    return await keyViolation(session.con, build => onSource(spec, table, build), keys);
  } catch (e) {
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  } finally {
    session.close();
  }
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
const joinOn = (keys: string[], a: string, b: string) => keys.map(k => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' AND ');
const keyList = (keys: string[], alias?: string) => keys.map(k => (alias ? `${alias}.${ident(k)}` : ident(k))).join(', ');
/**
 * 整行哈希：对“列名=取值”的文本按列名排序后拼接，空值不参与。这样与源端列的顺序、列类型的放宽无关，
 * 源表新增字段（旧行在新字段上为空）也不会让回看窗口里没变的行被当成更新
 */
const rowHash = (columns: string[], alias: string) =>
  `hash(concat_ws(chr(31), ${[...columns].sort().map(c => `${lit(`${c}=`)} || ${alias}.${ident(c)}::VARCHAR`).join(', ')}))`;

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
 * 否则按整行哈希回放各批次（新增与更新加一次、删除减一次），每个哈希留下净出现次数那么多行
 */
async function ensureMirror(t: TableSync, columns: Column[]) {
  const mirror = mirrorOf(t);
  if (await tableExists(t.con, `${t.schema}_mirror`, t.table.name)) {
    await addColumns(t.con, mirror, columns);
    return;
  }
  if (!await tableExists(t.con, t.schema, t.table.name)) {
    await t.con.run(`CREATE TABLE ${mirror} AS SELECT * FROM ${INCOMING} LIMIT 0`);
    return;
  }
  const data = (await columnsOf(t.con, targetOf(t))).map(c => c.column_name).filter(c => !PLATFORM_COLUMNS.includes(c));
  if (await tableExists(t.con, `${t.schema}_keys`, t.table.name)) {
    const state = keyStateOf(t);
    const keys = (await columnsOf(t.con, state)).map(c => c.column_name).filter(c => c !== '_hash');
    await t.con.run(`
      CREATE TABLE ${mirror} AS
      SELECT r.* EXCLUDE (${PLATFORM_COLUMNS.join(', ')}, _rn) FROM (
        SELECT b.*, ${rowHash(data, 'b')} AS _hash, row_number() OVER (PARTITION BY ${keyList(keys, 'b')} ORDER BY b._batch DESC) AS _rn
        FROM ${targetOf(t)} b WHERE b._op <> 'delete') r
      SEMI JOIN ${state} s ON ${joinOn(keys, 'r', 's')} WHERE r._rn = 1`);
  } else {
    await t.con.run(`
    CREATE TABLE ${mirror} AS
    WITH b AS (SELECT x.*, ${rowHash(data, 'x')} AS _hash FROM ${targetOf(t)} x),
    net AS (SELECT _hash, sum(CASE WHEN _op = 'delete' THEN -1 ELSE 1 END) AS _net FROM b GROUP BY _hash)
    SELECT r.* EXCLUDE (${PLATFORM_COLUMNS.join(', ')}, _rn)
    FROM (SELECT b.*, row_number() OVER (PARTITION BY b._hash ORDER BY b._batch DESC) AS _rn FROM b WHERE b._op <> 'delete') r
    JOIN net USING (_hash) WHERE r._rn <= net._net`);
  }
  await addColumns(t.con, mirror, columns);
}

/**
 * 在事务里：保证当前主键状态存在且按当前主键组织。没有（首次同步、此前没有主键）或主键变了（成员改了业务主键）时重建：
 * 此前没有主键、当前镜像还在时由镜像接续（整行比对的删除可能比新版本晚几个批次才记下，按批次取最新一版会把主键当成已删除）；
 * 否则由原始层重建，每个主键取最新一版（同一批次里一删一增时取新增），去掉最新一版是删除的
 */
async function ensureKeyState(t: TableSync, hashed: string[]) {
  const state = keyStateOf(t);
  if (await tableExists(t.con, `${t.schema}_keys`, t.table.name)) {
    const current = (await columnsOf(t.con, state)).map(c => c.column_name).filter(c => c !== '_hash');
    if (current.join('\u0000') === t.keys.join('\u0000')) return;
    await t.con.run(`DROP TABLE ${state}`);
  }
  if (await tableExists(t.con, `${t.schema}_mirror`, t.table.name)) {
    await t.con.run(`
      CREATE TABLE ${state} AS SELECT ${keyList(t.keys, 'm')}, m._hash
      FROM (SELECT *, row_number() OVER (PARTITION BY ${keyList(t.keys)}) AS _rn FROM ${mirrorOf(t)}) m WHERE m._rn = 1`);
    return;
  }
  await t.con.run(`
    CREATE TABLE ${state} AS
    SELECT ${keyList(t.keys, 'b')}, ${rowHash(hashed, 'b')} AS _hash
    FROM (SELECT *, row_number() OVER (PARTITION BY ${keyList(t.keys)} ORDER BY _batch DESC, _op = 'delete') AS _rn FROM ${targetOf(t)}) b
    WHERE b._rn = 1 AND b._op <> 'delete'`);
}

/**
 * 在事务里：本批次写入的主键在当前主键状态里换成本次读到的最新一版，删除的主键移除
 * （整行哈希取读取时算好的，与下次读到的比对口径一致）
 */
async function updateKeyState(t: TableSync, batch: number) {
  const state = keyStateOf(t);
  const written = (where = '') => `(SELECT ${keyList(t.keys)} FROM ${targetOf(t)} WHERE _batch = ${batch}${where})`;
  await t.con.run(`DELETE FROM ${state} USING ${written()} n WHERE ${joinOn(t.keys, state, 'n')}`);
  await t.con.run(`
    INSERT INTO ${state} SELECT ${keyList(t.keys, 'i')}, i._hash
    FROM ${INCOMING} i SEMI JOIN ${written(` AND _op <> 'delete'`)} n ON ${joinOn(t.keys, 'i', 'n')}`);
}

/** 主键在读到的行里必须非空且唯一（成员声明的业务主键只在声明时校验过） */
async function assertKeysUnique(t: TableSync, columns: string[]) {
  const missing = t.keys.filter(k => !columns.includes(k));
  if (missing.length) throw new Error(`源表中没有主键字段 ${missing.join('、')}，请重新采集并确认`);
  const problem = await keyViolation(t.con, build => `(${build(ident, INCOMING)})`, t.keys);
  if (problem) throw new Error(`${problem}，请换一个业务主键`);
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
  const count = async (relation: string) => Number((await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${relation}`))[0].n);
  await con.run(`CREATE OR REPLACE TABLE ${DIFF} (_hash UBIGINT, _delta BIGINT, _n BIGINT)`);
  await con.run(`CREATE OR REPLACE TABLE ${REMOVED} AS SELECT * FROM ${mirror} LIMIT 0`);
  const mirrored = await count(mirror);
  if (!mirrored) return INCOMING;

  // 镜像的哈希先取到本机，分桶时不必反复读数据湖
  await con.run(`CREATE OR REPLACE TABLE ${MIRRORED} AS SELECT _hash FROM ${mirror}`);
  const buckets = Math.max(1, Math.ceil((await count(INCOMING) + mirrored) / (t.limits.memoryLimitMb * HASHES_PER_MB)));
  const bucket = (column: string, b: number) => (buckets > 1 ? ` WHERE ${column} % ${buckets} = ${b}` : '');
  for (let b = 0; b < buckets; b++) {
    await con.run(`
      INSERT INTO ${DIFF}
      SELECT _hash, sum(s) AS _delta, count_if(s = 1) AS _n FROM (
        SELECT _hash, 1 AS s FROM ${INCOMING}${bucket('_hash', b)}
        UNION ALL SELECT _hash, -1 AS s FROM ${MIRRORED}${bucket('_hash', b)})
      GROUP BY _hash HAVING sum(s) <> 0`);
  }
  await con.run(`DROP TABLE ${MIRRORED}`);

  // 某个哈希在源端的行全是多出来的（最常见：新行）时整组都取，否则按差值取够行数
  await con.run(`CREATE OR REPLACE TABLE ${ADDED} AS SELECT * FROM ${INCOMING} LIMIT 0`);
  for (let b = 0; b < buckets; b++) {
    const grown = `(SELECT * FROM ${DIFF}${bucket('_hash', b)}${buckets > 1 ? ' AND' : ' WHERE'} _delta > 0)`;
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
    // 没有主键的表先保证镜像存在、整行比对好（在写入数据湖的事务之外：一个事务只能写一个库，比对结果暂存在 stage 里）
    if (!keys.length) await ensureMirror(t, columns);
    const added = multiset ? await stageMultisetDiff(t) : null;

    return await inTransaction(con, async () => {
      await ensureTarget(t, staged, columns);
      if (keys.length) {
        // 当前主键状态与镜像只保留正在维护的那一个：主键有无变化后，另一个会过时（主键状态可能要先由镜像接续）
        await ensureKeyState(t, names);
        await con.run(`DROP TABLE IF EXISTS ${mirrorOf(t)}`);
        const state = keyStateOf(t);
        await con.run(`
          INSERT INTO ${target} BY NAME
          SELECT i.* EXCLUDE (_hash), ${batchColumns(t, `CASE WHEN s._hash IS NULL THEN 'insert' ELSE 'update' END`, batch, syncedAt, 'i')}
          FROM ${INCOMING} i LEFT JOIN ${state} s ON ${joinOn(keys, 's', 'i')}
          WHERE ${isLive(t, 'i')} AND s._hash IS DISTINCT FROM i._hash`);
        if (t.softDelete) {
          await con.run(`
            INSERT INTO ${target} BY NAME SELECT i.* EXCLUDE (_hash), ${batchColumns(t, `'delete'`, batch, syncedAt, 'i', true)}
            FROM ${INCOMING} i SEMI JOIN ${state} s ON ${joinOn(keys, 's', 'i')} WHERE NOT (${isLive(t, 'i')})`);
        }
        if (!incremental) {
          await con.run(`
            INSERT INTO ${target} BY NAME SELECT ${keyList(keys, 's')}, ${batchColumns(t, `'delete'`, batch, syncedAt, 's')}
            FROM ${state} s ANTI JOIN ${INCOMING} i ON ${joinOn(keys, 's', 'i')}`);
        }
        await updateKeyState(t, batch);
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
    await con.run([INCOMING, MIRRORED, DIFF, ADDED, REMOVED].map(r => `DROP TABLE IF EXISTS ${r};`).join(' '));
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
 * 同步数据源的若干张表（有水位线的增量读取，没有的全量比对），每张表一个变更批次、各自一个事务：一张表失败不影响其他表。
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
    try {
      if (!table) throw new Error(`数据源中已没有表 ${param.name}`);
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

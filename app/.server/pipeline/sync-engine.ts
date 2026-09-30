// app/.server/pipeline/sync-engine.ts —— 水位线增量同步：把源表自上次同步以来的变化作为变更批次追加到本租户数据湖的原始层（ADR-0006、ADR-0012）。
// 在工作进程里运行，数据湖与数据源挂在同一个 DuckDB 里（源端只读挂载为 src）。每个数据源在数据湖里一个 schema（bronzeSchema），
// 每张源表一张原始层表：源表的全部列加上操作类型 _op、源端提交时间 _commit_ts、批次号 _batch 与同步时间 _synced_at。
// 批次日志 _batches 与变更批次在同一个 DuckLake 事务里写入，是水位线的唯一依据：任务结果没记下来也不会重复或漏掉变化。
// 有主键（源端主键或成员确认的业务主键）的表另在 <schema>_keys 里保存当前主键状态：每个仍存在的主键一行及其最新一版的整行哈希，
// 用来判断新增还是更新、去掉回看重读到的未变化行，以及每天比对主键全集时找出源端已删除和漏掉的主键
import type { DuckDBConnection } from '@duckdb/node-api';
import type { TenantLakeSession } from './lake-engine';
import { primaryKeys, writeGrants, type SourceSpec, type SourceTable, type WatermarkKind } from './source-engine';

/** 同步任务里的一张表：成员确认的水位线字段及其种类；源表没有主键时可带成员确认的业务主键 */
export interface SyncTableParam { name: string; column: string; kind: WatermarkKind; key?: string }

/**
 * 批次的来源：全表读取（首次同步或换了水位线字段）、按水位线增量读取，或比对主键全集（补上删除与漏掉的行）。
 * 与“全量比对”这种同步方式无关
 */
export type BatchMode = 'full' | 'incremental' | 'reconcile';

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
    watermarkColumn: string;
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
  /** 主键列：源端主键，没有时为成员确认的业务主键，都没有时为空 */
  keys: string[];
  options: SyncOptions;
}

const targetOf = (t: TableSync) => `${ident(t.schema)}.${ident(t.table.name)}`;
const keyStateOf = (t: TableSync) => `${ident(`${t.schema}_keys`)}.${ident(t.table.name)}`;
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

/** 在事务里：原始层表不存在时按 staged 的结构建表，存在时为源表新增的字段加列（之前的批次里为空） */
async function ensureTarget(t: TableSync, staged: string, columns: { column_name: string; column_type: string }[]) {
  const target = targetOf(t);
  const [exists] = await rows(t.con, `
    SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(t.schema)} AND table_name = ${lit(t.table.name)}`);
  if (!exists) {
    await t.con.run(`CREATE TABLE ${target} AS SELECT *, ${BATCH_COLUMNS} FROM ${staged} LIMIT 0`);
    return;
  }
  const known = new Set((await columnsOf(t.con, target)).map(c => c.column_name));
  for (const c of columns.filter(c => !known.has(c.column_name))) {
    await t.con.run(`ALTER TABLE ${target} ADD COLUMN ${ident(c.column_name)} ${c.column_type}`);
  }
}

/**
 * 在事务里：保证当前主键状态存在且按当前主键组织。没有（首次同步、此前没有主键）或主键变了（成员改了业务主键）时，
 * 由原始层重建：每个主键取最新一版，去掉最新一版是删除的
 */
async function ensureKeyState(t: TableSync, hashed: string[]) {
  const state = keyStateOf(t);
  const [exists] = await rows(t.con, `
    SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(`${t.schema}_keys`)} AND table_name = ${lit(t.table.name)}`);
  if (exists) {
    const current = (await columnsOf(t.con, state)).map(c => c.column_name).filter(c => c !== '_hash');
    if (current.join('\u0000') === t.keys.join('\u0000')) return;
    await t.con.run(`DROP TABLE ${state}`);
  }
  await t.con.run(`
    CREATE TABLE ${state} AS
    SELECT ${keyList(t.keys, 'b')}, ${rowHash(hashed, 'b')} AS _hash
    FROM (SELECT *, row_number() OVER (PARTITION BY ${keyList(t.keys)} ORDER BY _batch DESC) AS _rn FROM ${targetOf(t)}) b
    WHERE b._rn = 1 AND b._op <> 'delete'`);
}

/** 在事务里：本批次写入的主键在当前主键状态里换成 staged 中的最新一版（整行哈希按 staged 的取值计算，与下次读到的比对口径一致） */
async function updateKeyState(t: TableSync, batch: number, staged: string, hashed: string[]) {
  const state = keyStateOf(t);
  const written = `(SELECT ${keyList(t.keys)} FROM ${targetOf(t)} WHERE _batch = ${batch})`;
  await t.con.run(`DELETE FROM ${state} USING ${written} n WHERE ${joinOn(t.keys, state, 'n')}`);
  await t.con.run(`
    INSERT INTO ${state} SELECT ${keyList(t.keys, 's')}, ${rowHash(hashed, 's')}
    FROM ${staged} s SEMI JOIN ${written} n ON ${joinOn(t.keys, 's', 'n')}`);
}

/** 主键在读到的行里必须非空且唯一（成员确认的业务主键可能与样本统计不符） */
async function assertKeysUnique(t: TableSync, staged: string, columns: string[]) {
  const missing = t.keys.filter(k => !columns.includes(k));
  if (missing.length) throw new Error(`源表中没有主键字段 ${missing.join('、')}，请重新采集并确认`);
  const [nulls] = await rows<{ n: string }>(t.con, `SELECT count(*) AS n FROM ${staged} WHERE ${t.keys.map(k => `${ident(k)} IS NULL`).join(' OR ')}`);
  if (Number(nulls.n)) throw new Error(`主键 ${t.keys.join('、')} 有 ${nulls.n} 行为空，请换一个业务主键`);
  const [dup] = await rows<{ key: string; n: string }>(t.con, `
    SELECT concat_ws(', ', ${keyList(t.keys)}) AS key, count(*) AS n FROM ${staged} GROUP BY ALL HAVING count(*) > 1 LIMIT 1`);
  if (dup) throw new Error(`主键 ${t.keys.join('、')} 在源表中不唯一（${dup.key} 出现 ${dup.n} 次），请换一个业务主键`);
}

/** 本批次行的平台列：更新时间水位线的源端提交时间取该字段，其余（自增主键、删除）用同步时间代替 */
const batchColumns = (t: TableSync, op: string, batch: number, syncedAt: string, alias: string) => `
  ${op} AS _op,
  ${t.param.kind === 'updated_at' && op !== `'delete'` ? `CAST(${alias}.${ident(t.param.column)} AS TIMESTAMPTZ)` : syncedAt} AS _commit_ts,
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
    ${lit(t.table.name)}, ${record.batch}, ${lit(record.mode)}, ${lit(record.watermarkColumn)},
    ${v(record.watermarkFrom)}, ${v(record.readFrom)}, ${v(record.watermarkTo)},
    ${record.rows}, ${record.inserted}, ${record.updated}, ${record.deleted},
    TIMESTAMPTZ ${lit(startedAt.toISOString())}, TIMESTAMPTZ ${lit(finishedAt.toISOString())})`);
  return record;
}

/**
 * 同步一张表，产出一个变更批次（可能为空）：
 * - 这张表还没有按当前水位线字段同步过时全表读取；否则从水位线往回退一个回看窗口读起，补上长事务晚提交、
 *   自增主键晚提交的行。回看重读到的、已经同步过的行不再写入：有主键时与当前主键状态里的整行哈希比对，
 *   没有主键时与原始层里同一范围的行比对。
 * - 有主键时，当前主键状态里有的记为更新，否则记为新增；没有主键的表一律记为新增。
 */
async function syncTable(t: TableSync): Promise<Extract<SyncRecord, { batch: number }>> {
  const { con, spec, schema, table, param, keys } = t;
  const startedAt = new Date();
  const target = targetOf(t);
  const [last] = await rows<LastBatch>(con, `
    SELECT batch, watermark_column, watermark_to FROM ${ident(schema)}._batches
    WHERE table_name = ${lit(table.name)} ORDER BY batch DESC LIMIT 1`);
  const from = last?.watermark_column === param.column ? last.watermark_to : null;
  const batch = Number(last?.batch ?? 0) + 1;

  const wm = (await columnsOf(con, `SELECT * FROM ${table.from}`)).find(c => c.column_name === param.column);
  if (!wm) throw new Error(`源表中没有水位线字段 ${param.column}，请重新采集并确认`);
  const readFrom = from === null ? null : await lookbackStart(con, param.kind, wm.column_type, from, t.options);
  const bound = readFrom === null ? null : await sourceValue(con, spec, wm.column_type, readFrom);
  const read = pushdown(spec, table, null, bound === null ? undefined : q => `${q(param.column)} >= ${bound}`)
    ?? `(SELECT * FROM ${table.from}${readFrom === null ? '' : ` WHERE ${ident(param.column)} >= ${cast(readFrom, wm.column_type)}`})`;
  await con.run(`CREATE OR REPLACE TEMP TABLE incoming AS SELECT * FROM ${read}`);
  try {
    const columns = await columnsOf(con, 'incoming');
    const names = columns.map(c => c.column_name);
    if (keys.length) await assertKeysUnique(t, 'incoming', names);
    const [{ top }] = await rows<{ top: string | null }>(con, `
      SELECT greatest(${from === null ? 'NULL' : cast(from, wm.column_type)}, max(${ident(param.column)}))::VARCHAR AS top FROM incoming`);
    const syncedAt = `TIMESTAMPTZ ${lit(startedAt.toISOString())}`;

    return await inTransaction(con, async () => {
      await ensureTarget(t, 'incoming', columns);
      if (keys.length) {
        await ensureKeyState(t, names);
        const state = keyStateOf(t);
        await con.run(`
          INSERT INTO ${target} BY NAME
          SELECT i.*, ${batchColumns(t, `CASE WHEN s._hash IS NULL THEN 'insert' ELSE 'update' END`, batch, syncedAt, 'i')}
          FROM incoming i LEFT JOIN ${state} s ON ${joinOn(keys, 's', 'i')}
          WHERE s._hash IS DISTINCT FROM ${rowHash(names, 'i')}`);
        await updateKeyState(t, batch, 'incoming', names);
      } else {
        const inWindow = (alias: string) => `${alias}.${ident(param.column)} <= ${cast(from ?? '', wm.column_type)}`;
        const seen = from === null ? '' : `
          WHERE NOT coalesce(${inWindow('i')} AND ${rowHash(names, 'i')} IN (
            SELECT ${rowHash(names, 'b')} FROM ${target} b
            WHERE b.${ident(param.column)} >= ${cast(readFrom!, wm.column_type)} AND ${inWindow('b')}), false)`;
        await con.run(`INSERT INTO ${target} BY NAME SELECT i.*, ${batchColumns(t, `'insert'`, batch, syncedAt, 'i')} FROM incoming i ${seen}`);
      }
      return recordBatch(t, {
        table: table.name,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        batch,
        mode: from === null ? 'full' : 'incremental',
        ...(await batchStats(t, batch)),
        watermarkColumn: param.column,
        watermarkFrom: from,
        readFrom,
        watermarkTo: top,
      }, startedAt, new Date());
    });
  } finally {
    await con.run('DROP TABLE IF EXISTS incoming');
  }
}

/** 距上次读全集（全表读取或主键比对）是否已满一个比对周期 */
async function reconcileDue(t: TableSync, now: Date) {
  const dueBefore = new Date(now.getTime() - t.options.reconcileHours * 3_600_000);
  const [{ due }] = await rows<{ due: boolean | null }>(t.con, `
    SELECT max(started_at) <= TIMESTAMPTZ ${lit(dueBefore.toISOString())} AS due FROM ${ident(t.schema)}._batches
    WHERE table_name = ${lit(t.table.name)} AND mode IN ('full', 'reconcile')`);
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
 * 比对主键全集（有主键的表，每 reconcileHours 小时一次），产出一个批次：当前主键状态里有、源端已没有的主键记为删除
 * （只带主键列），源端有、当前主键状态里没有的主键（水位线漏掉的行）读取整行后记为新增。水位线不变
 */
async function reconcileTable(t: TableSync, previous: Extract<SyncRecord, { batch: number }>): Promise<SyncRecord> {
  const { con, spec, table, keys } = t;
  const startedAt = new Date();
  const target = targetOf(t);
  const state = keyStateOf(t);
  const batch = previous.batch + 1;
  const syncedAt = `TIMESTAMPTZ ${lit(startedAt.toISOString())}`;
  try {
    await con.run(`CREATE TEMP TABLE source_keys AS SELECT * FROM ${pushdown(spec, table, keys) ?? `(SELECT ${keyList(keys)} FROM ${table.from})`}`);
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

/**
 * 按成员确认的水位线同步数据源的若干张表，每张表一个变更批次、各自一个事务：一张表失败不影响其他表。
 * 有主键的表到了比对周期时，紧接着再比对一次主键全集。账号可写时整体拒绝（登记之后才被授予写权限的账号）。
 * redact 用来抹掉错误信息里的凭据
 */
export async function syncSourceTables(
  session: TenantLakeSession, spec: SourceSpec, sourceId: string, params: SyncTableParam[], redact: (message: string) => string,
  options: SyncOptions = syncOptionsFromEnv(),
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
    CREATE TABLE IF NOT EXISTS ${ident(schema)}._batches (
      table_name VARCHAR, batch BIGINT, mode VARCHAR, watermark_column VARCHAR, watermark_from VARCHAR, read_from VARCHAR, watermark_to VARCHAR,
      rows BIGINT, inserted BIGINT, updated BIGINT, deleted BIGINT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);

  const records: SyncRecord[] = [];
  const failed = (table: string, startedAt: Date, e: unknown): SyncRecord =>
    ({ table, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: redact((e as Error).message) });
  for (const param of params) {
    let startedAt = new Date();
    const table = tables.find(t => t.name === param.name);
    try {
      if (!table) throw new Error(`数据源中已没有表 ${param.name}`);
      if (!table.readable) throw new Error(`账号没有表 ${param.name} 的读权限`);
      const keys = primary.get(param.name) ?? (param.key ? [param.key] : []);
      const t: TableSync = { con, spec, schema, table, param, keys, options };
      const synced = await syncTable(t);
      records.push(synced);
      startedAt = new Date();
      if (keys.length && synced.mode !== 'full' && await reconcileDue(t, startedAt)) records.push(await reconcileTable(t, synced));
    } catch (e) {
      records.push(failed(param.name, startedAt, e));
    }
  }
  return records;
}

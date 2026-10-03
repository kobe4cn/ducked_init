// app/.server/pipeline/verify-engine.ts —— 核对湖中数据（source.verify）：从源端的全部表出发，回答每张源表的数据进了湖里的什么位置、
// 是否真实存在、结构与数据量是否与源端一致。只读、只出报告：数据湖以只读方式挂载（写入会被 DuckDB 拒绝），
// 中间结果只暂存在会话的本机库 stage 里。发现差异时由成员触发一次主键比对同步去修复，修复只走同步这一条写入路径。
// 在工作进程里运行，数据湖与数据源挂在同一个 DuckDB 里（源端只读挂载为 src），只用租户自己的凭据。
// 每张已进湖的表核对四项：
// - 位置：原始层 schema 与表名、对象存储前缀、当前主键状态或镜像的位置。
// - 文件：目录登记的每个文件在存储上存在且大小一致，当前数据文件的尾部元数据（行数、字段）与目录一致；加密的数据文件（ADR-0020）
//   用目录里登记的文件密钥读行数，尾部的字段信息读不出来，不查字段；
//   表前缀下存在、目录未登记的孤儿文件（已在待删除清单里的不算）只报告不删除；内联在目录库里的小批次单独列出行数。
// - 结构：以核对时实时读取的源表结构为基准，与原始层的列对照。
// - 数据量：有主键的表比对源端主键全集与原始层回放后的当前主键（与每日主键比对同一机制，但不写入）；没有主键的表比较行数
import type { DuckDBConnection } from '@duckdb/node-api';
import type { LakeCoverage, NotInLakeReason } from '../../lib/sources';
import type { EngineLimits, TenantLakeSession } from './lake-engine';
import { estimatedRows, primaryKeys, writeGrants, type SourceSpec, type SourceTable, type WatermarkKind } from './source-engine';
import {
  bronzeSchema, bucketCount, inBucket, joinOn, keyHash, keyList, liveCondition, onSource, PLATFORM_COLUMNS, pushdown,
} from './sync-engine';

/**
 * 核对任务里平台给出的一张表（最近一次列出表得到的清单）：是否在同步范围内、不在湖里时平台判断的原因，
 * 以及同步用的设置（业务主键、软删除字段、已确认的水位线字段及其种类）
 */
export interface VerifyTableParam {
  name: string;
  inScope: boolean;
  reason: NotInLakeReason;
  key?: string[];
  softDelete?: string;
  column?: string;
  kind?: WatermarkKind;
}

/** 缺失与多出的主键各给出前几个样例 */
export const KEY_SAMPLES = 20;

/** 一项核对出错：只记下这一项的错误 */
export type FailedCheck = { ok: false; error: string };
type Failed = FailedCheck;

export interface LakeLocation {
  /** 原始层 schema 与表名 */
  schema: string;
  table: string;
  /** 这张表的数据文件所在的存储前缀 */
  prefix: string;
  /** 当前主键状态（有主键）或当前镜像（没有主键）的位置；都还没有时为 null */
  state: string | null;
}

export interface FileCheck {
  ok: boolean;
  /** 目录登记的数据文件与删除文件（含历史快照仍引用的） */
  registered: number;
  /** 当前快照的数据文件个数及其行数（目录登记的） */
  current: number;
  fileRows: number;
  /** 目录登记、存储上却没有的文件 */
  missing: string[];
  sizeMismatch: { path: string; expected: number; actual: number }[];
  /** 尾部元数据与目录不一致或读不出的当前数据文件 */
  footer: { path: string; problem: string }[];
  /** 表前缀下存在、目录未登记、也不在待删除清单里的文件（只报告不删除） */
  orphans: string[];
  /** 内联在目录库里、没有对应文件的行数（仍有效的） */
  inlinedRows: number;
}

export interface StructureCheck {
  ok: boolean;
  /** 源端有、原始层没有的列（源端新增字段，下次同步时加列） */
  missingInLake: { name: string; type: string }[];
  /** 原始层有、源端已没有的列（源端删除字段：保留旧列属预期，不算差异） */
  extraInLake: { name: string; type: string }[];
  /** 类型不同：widened 为真表示源端的类型是原始层类型的放宽（如 INTEGER → BIGINT），否则不兼容 */
  typeChanged: { name: string; lake: string; source: string; widened: boolean }[];
}

export type DataCheck =
  | {
    keyed: true;
    ok: boolean;
    keys: string[];
    /** 源端主键数（软删除字段标记为删除的不算）与原始层回放后的当前主键数 */
    sourceRows: number;
    lakeRows: number;
    /** 源端有、湖中没有的主键：missing 计为差异；pendingSync 是水位线晚于最近一次同步上界的（同步后新增，待下次同步），不计为差异 */
    missing: number;
    pendingSync: number;
    /** 湖中有、源端已没有的主键（源端已删、尚未比对出删除） */
    extra: number;
    /** 最近一次同步的水位线上界；没有水位线的表为 null */
    syncedThrough: string | null;
    samples: { missing: string[]; pendingSync: string[]; extra: string[] };
  }
  | { keyed: false; ok: boolean; sourceRows: number; lakeRows: number };

/** 一张源表的核对结果 */
export interface VerifyRecord {
  table: string;
  coverage: LakeCoverage;
  /** 源端行数：账号能读的表实时统计；读不了时为源端的估算行数（rowsEstimated），没有时为 null */
  sourceRows: number | null;
  rowsEstimated?: true;
  /** 已进湖、但已移出同步范围的表：湖中数据不再更新，只核对位置与文件 */
  outOfScope?: true;
  location?: LakeLocation;
  files?: FileCheck | Failed;
  structure?: StructureCheck | Failed;
  data?: DataCheck | Failed;
  /** 已进湖的表四项是否都一致（源端已删除或读不了的只看文件）；其余表为 null */
  ok: boolean | null;
  error?: string;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const columnsOf = (con: DuckDBConnection, relation: string) => rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${relation}`);
const message = (e: unknown) => (e as Error).message;

/** 核对的中间结果暂存在会话的本机库 stage 里：源端主键、原始层的主键历史、按桶回放出的当前主键、缺失与多出的主键 */
const SOURCE_KEYS = 'stage.verify_source';
const HISTORY = 'stage.verify_history';
const CURRENT = 'stage.verify_current';
const MISSING = 'stage.verify_missing';
const EXTRA = 'stage.verify_extra';
/** 源端主键旁带上的水位线列 */
const WM = '_verify_wm';

const INTEGERS = ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT'];
const UNSIGNED = ['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT'];
/** 各整数类型最多几位十进制数（放进 DECIMAL 时需要的整数位） */
const INTEGER_DIGITS: Record<string, number> = { TINYINT: 3, SMALLINT: 5, INTEGER: 10, BIGINT: 19, UTINYINT: 3, USMALLINT: 5, UINTEGER: 10, UBIGINT: 20 };
const decimal = (type: string) => type.match(/^DECIMAL\((\d+),(\d+)\)$/)?.slice(1).map(Number) as [number, number] | undefined;

/** 源端的类型 source 是否是原始层类型 lake 的放宽：已有的值都能无损地放进新类型 */
export function isWidened(lake: string, source: string) {
  if (source === 'VARCHAR') return true;
  for (const ranks of [INTEGERS, UNSIGNED]) {
    if (ranks.includes(lake) && ranks.includes(source)) return ranks.indexOf(source) > ranks.indexOf(lake);
  }
  if (UNSIGNED.includes(lake) && INTEGERS.includes(source)) return INTEGERS.indexOf(source) > UNSIGNED.indexOf(lake);
  if (lake === 'FLOAT' && source === 'DOUBLE') return true;
  if (lake === 'DATE' && /^TIMESTAMP/.test(source)) return true;
  const to = decimal(source);
  if (!to) return false;
  const from = decimal(lake);
  if (from) return to[1] >= from[1] && to[0] - to[1] >= from[0] - from[1];
  return lake in INTEGER_DIGITS && to[0] - to[1] >= INTEGER_DIGITS[lake];
}

/** 结构：以源端为基准与原始层的列对照（原始层里平台追加的列不算） */
async function checkStructure(con: DuckDBConnection, table: SourceTable, bronze: string): Promise<StructureCheck> {
  const source = await columnsOf(con, `SELECT * FROM ${table.from}`);
  const lake = (await columnsOf(con, bronze)).filter(c => !PLATFORM_COLUMNS.includes(c.column_name));
  const inLake = new Map(lake.map(c => [c.column_name, c.column_type]));
  const atSource = new Set(source.map(c => c.column_name));
  const missingInLake = source.filter(c => !inLake.has(c.column_name)).map(c => ({ name: c.column_name, type: c.column_type }));
  const extraInLake = lake.filter(c => !atSource.has(c.column_name)).map(c => ({ name: c.column_name, type: c.column_type }));
  const typeChanged = source
    .filter(c => inLake.has(c.column_name) && inLake.get(c.column_name) !== c.column_type)
    .map(c => ({ name: c.column_name, lake: inLake.get(c.column_name)!, source: c.column_type, widened: isWidened(inLake.get(c.column_name)!, c.column_type) }));
  return { ok: !missingInLake.length && !typeChanged.length, missingInLake, extraInLake, typeChanged };
}

/** 相对路径接在 base 后面，绝对路径原样 */
const resolvePath = (base: string, path: string, relative: boolean) => (relative ? `${base}${path}` : path);

interface TableMeta { table_id: string; schema_path: string | null; schema_relative: boolean; table_path: string | null; table_relative: boolean }
interface RegisteredFile {
  path: string; path_is_relative: boolean; file_size_bytes: string; record_count: string | null; encryption_key: string | null;
  current: boolean; kind: 'data' | 'delete';
}

/** 在 DuckLake 目录里找到原始层表的 ID 与数据文件所在的前缀 */
async function tableMeta(session: TenantLakeSession, schema: string, name: string) {
  const { con, lake } = session;
  const [meta] = await rows<TableMeta>(con, `
    SELECT t.table_id, s.path AS schema_path, s.path_is_relative AS schema_relative, t.path AS table_path, t.path_is_relative AS table_relative
    FROM ${lake.metadata}.ducklake_table t JOIN ${lake.metadata}.ducklake_schema s ON s.schema_id = t.schema_id
    WHERE s.schema_name = ${lit(schema)} AND t.table_name = ${lit(name)} AND s.end_snapshot IS NULL AND t.end_snapshot IS NULL`);
  if (!meta) throw new Error(`目录中没有原始层表 ${schema}.${name}`);
  const schemaPrefix = resolvePath(lake.dataPath, meta.schema_path ?? `${schema}/`, meta.schema_relative ?? true);
  return { id: meta.table_id, prefix: resolvePath(schemaPrefix, meta.table_path ?? `${name}/`, meta.table_relative ?? true) };
}

/** 目录里登记的文件与存储上实际的文件对照，读当前数据文件的尾部元数据，统计内联的行 */
async function checkFiles(session: TenantLakeSession, tableId: string, prefix: string): Promise<FileCheck> {
  const { con, lake } = session;
  const registered = (await rows<RegisteredFile>(con, `
    SELECT path, path_is_relative, file_size_bytes::VARCHAR AS file_size_bytes, record_count::VARCHAR AS record_count, encryption_key,
      end_snapshot IS NULL AS current, 'data' AS kind
    FROM ${lake.metadata}.ducklake_data_file WHERE table_id = ${tableId}
    UNION ALL
    SELECT path, path_is_relative, file_size_bytes::VARCHAR, NULL, NULL, end_snapshot IS NULL, 'delete'
    FROM ${lake.metadata}.ducklake_delete_file WHERE table_id = ${tableId}`))
    .map(f => ({ ...f, path: resolvePath(prefix, f.path, f.path_is_relative) }));
  const known = new Set(registered.map(f => f.path));
  // 待删除清单不带表 ID，相对路径相对于数据湖的存储前缀；按完整路径对照
  const scheduled = new Set((await rows<{ path: string; path_is_relative: boolean }>(con, `
    SELECT path, path_is_relative FROM ${lake.metadata}.ducklake_files_scheduled_for_deletion`))
    .map(f => resolvePath(lake.dataPath, f.path, f.path_is_relative)));

  const listed = (await rows<{ file: string }>(con, `SELECT file FROM glob(${lit(`${prefix}**`)})`)).map(f => f.file);
  const sizes = new Map(listed.length
    ? (await rows<{ filename: string; size: string }>(con, `SELECT filename, size::VARCHAR AS size FROM read_blob([${listed.map(lit).join(', ')}])`))
      .map(f => [f.filename, Number(f.size)])
    : []);
  const missing = registered.filter(f => !sizes.has(f.path)).map(f => f.path);
  const sizeMismatch = registered
    .filter(f => sizes.has(f.path) && sizes.get(f.path) !== Number(f.file_size_bytes))
    .map(f => ({ path: f.path, expected: Number(f.file_size_bytes), actual: sizes.get(f.path)! }));
  const orphans = listed.filter(f => !known.has(f) && !scheduled.has(f));

  const current = registered.filter(f => f.kind === 'data' && f.current);
  const fieldIds = new Set((await rows<{ id: string }>(con, `
    SELECT column_id::VARCHAR AS id FROM ${lake.metadata}.ducklake_column WHERE table_id = ${tableId}`)).map(c => c.id));
  const footer: FileCheck['footer'] = [];
  for (const f of current.filter(f => sizes.has(f.path))) {
    try {
      // parquet_file_metadata / parquet_schema 不接受密钥：加密文件用 read_parquet 带上目录里的文件密钥数行
      const [meta] = await rows<{ num_rows: string }>(con, f.encryption_key
        ? `SELECT count(*)::VARCHAR AS num_rows FROM read_parquet(${lit(f.path)}, encryption_config = {footer_key_value: from_base64(${lit(f.encryption_key)})})`
        : `SELECT num_rows::VARCHAR AS num_rows FROM parquet_file_metadata(${lit(f.path)})`);
      if (Number(meta.num_rows) !== Number(f.record_count)) {
        footer.push({ path: f.path, problem: `尾部记录 ${meta.num_rows} 行，目录登记 ${f.record_count} 行` });
      }
      if (f.encryption_key) continue;
      const unknown = (await rows<{ name: string; field_id: string }>(con, `
        SELECT name, field_id::VARCHAR AS field_id FROM parquet_schema(${lit(f.path)}) WHERE field_id IS NOT NULL`))
        .filter(c => !fieldIds.has(c.field_id));
      if (unknown.length) footer.push({ path: f.path, problem: `含目录中没有的字段：${unknown.map(c => `${c.name}（field_id ${c.field_id}）`).join('、')}` });
    } catch (e) {
      footer.push({ path: f.path, problem: `读不出尾部元数据：${message(e)}` });
    }
  }

  let inlinedRows = 0;
  for (const { table_name } of await rows<{ table_name: string }>(con, `
    SELECT table_name FROM ${lake.metadata}.ducklake_inlined_data_tables WHERE table_id = ${tableId}`)) {
    const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*)::VARCHAR AS n FROM ${lake.metadata}.${ident(table_name)} WHERE end_snapshot IS NULL`);
    inlinedRows += Number(n);
  }
  return {
    ok: !missing.length && !sizeMismatch.length && !footer.length && !orphans.length,
    registered: registered.length,
    current: current.length,
    fileRows: current.reduce((sum, f) => sum + Number(f.record_count), 0),
    missing,
    sizeMismatch,
    footer,
    orphans,
    inlinedRows,
  };
}

/** 源表的行数：PostgreSQL 与 MySQL 在源端统计，只传回结果 */
const countSource = async (con: DuckDBConnection, spec: SourceSpec, table: SourceTable) =>
  Number((await rows<{ n: string }>(con, `SELECT n::VARCHAR AS n FROM ${onSource(spec, table, (_q, from) => `SELECT COUNT(*) AS n FROM ${from}`)}`))[0].n);

/** 主键的展示：单列为取值，多列为“列=取值”的组合 */
const keyLabel = (keys: string[], alias: string) => (keys.length === 1
  ? `${alias}.${ident(keys[0])}::VARCHAR`
  : `concat_ws(', ', ${keys.map(k => `${lit(`${k}=`)} || ${alias}.${ident(k)}::VARCHAR`).join(', ')})`);

interface KeyedCompare {
  con: DuckDBConnection;
  spec: SourceSpec;
  table: SourceTable;
  bronze: string;
  schema: string;
  keys: string[];
  param?: VerifyTableParam;
  /** 源表当前的列（取软删除字段与水位线的类型） */
  columns: { column_name: string; column_type: string }[];
  limits: EngineLimits;
}

/**
 * 有主键的表：源端主键全集（软删除字段标记为删除的不算，PostgreSQL 与 MySQL 在源端执行）与原始层回放后的当前主键
 * （每个主键取最新一版，同一批次里一删一增时取新增，去掉最新一版是删除的）比对，两边按主键的哈希分桶。
 * 湖中缺失的主键里，水位线晚于最近一次同步上界的是同步后新增的，不计为差异
 */
async function compareKeys(c: KeyedCompare): Promise<DataCheck> {
  const { con, spec, table, keys, param } = c;
  const typeOf = (name: string) => c.columns.find(col => col.column_name === name)?.column_type;
  const soft = param?.softDelete && typeOf(param.softDelete) ? { column: param.softDelete, type: typeOf(param.softDelete)! } : null;
  const wm = param?.column && typeOf(param.column) ? { column: param.column, type: typeOf(param.column)! } : null;

  // 自增主键水位线就是主键本身
  const columns = [...new Set([...keys, ...(wm ? [wm.column] : [])])];
  const read = pushdown(spec, table, columns, soft ? q => liveCondition(q(soft.column), soft.type) : undefined)
    ?? `(SELECT ${keyList(columns)} FROM ${table.from}${soft ? ` WHERE ${liveCondition(ident(soft.column), soft.type)}` : ''})`;
  await con.run(`CREATE OR REPLACE TABLE ${SOURCE_KEYS} AS SELECT ${keyList(keys, 'r')}${wm ? `, r.${ident(wm.column)} AS ${WM}` : ''} FROM ${read} r`);
  await con.run(`CREATE OR REPLACE TABLE ${HISTORY} AS SELECT ${keyList(keys, 'b')}, b._batch, b._op FROM ${c.bronze} b`);
  await con.run(`CREATE OR REPLACE TABLE ${MISSING} AS SELECT * FROM ${SOURCE_KEYS} LIMIT 0`);
  await con.run(`CREATE OR REPLACE TABLE ${EXTRA} AS SELECT ${keyList(keys)} FROM ${HISTORY} LIMIT 0`);
  const count = async (relation: string) => Number((await rows<{ n: string }>(con, `SELECT count(*)::VARCHAR AS n FROM ${relation}`))[0].n);
  const sourceRows = await count(SOURCE_KEYS);
  const buckets = bucketCount(c.limits, sourceRows + await count(HISTORY));
  let lakeRows = 0;
  for (let b = 0; b < buckets; b++) {
    await con.run(`
      CREATE OR REPLACE TABLE ${CURRENT} AS SELECT ${keyList(keys, 'r')} FROM (
        SELECT h.*, row_number() OVER (PARTITION BY ${keyList(keys, 'h')} ORDER BY h._batch DESC, h._op = 'delete') AS _rn
        FROM ${HISTORY} h WHERE ${inBucket(keyHash(keys, 'h'), buckets, b)}) r
      WHERE r._rn = 1 AND r._op <> 'delete'`);
    const atSource = `(SELECT * FROM ${SOURCE_KEYS} s WHERE ${inBucket(keyHash(keys, 's'), buckets, b)})`;
    await con.run(`INSERT INTO ${MISSING} SELECT s.* FROM ${atSource} s ANTI JOIN ${CURRENT} l ON ${joinOn(keys, 's', 'l')}`);
    await con.run(`INSERT INTO ${EXTRA} SELECT l.* FROM ${CURRENT} l ANTI JOIN ${atSource} s ON ${joinOn(keys, 'l', 's')}`);
    lakeRows += await count(CURRENT);
  }

  // 最近一次同步的水位线上界：按当前水位线字段写入的最新批次
  const [last] = wm ? await rows<{ watermark_to: string | null }>(con, `
    SELECT watermark_to FROM ${ident(c.schema)}._batches
    WHERE table_name = ${lit(table.name)} AND watermark_column = ${lit(wm.column)} ORDER BY batch DESC LIMIT 1`) : [];
  const syncedThrough = last?.watermark_to ?? null;
  const later = wm && syncedThrough !== null ? `m.${WM} > CAST(${lit(syncedThrough)} AS ${wm.type})` : 'false';
  const sample = (relation: string, where = 'true') => rows<{ key: string }>(con, `
    SELECT ${keyLabel(keys, 'm')} AS key FROM ${relation} m WHERE ${where} ORDER BY ${keyList(keys, 'm')} LIMIT ${KEY_SAMPLES}`);
  const pendingSync = Number((await rows<{ n: string }>(con, `SELECT count(*)::VARCHAR AS n FROM ${MISSING} m WHERE ${later}`))[0].n);
  const missing = await count(MISSING) - pendingSync;
  const extra = await count(EXTRA);
  return {
    keyed: true,
    ok: !missing && !extra,
    keys,
    sourceRows,
    lakeRows,
    missing,
    pendingSync,
    extra,
    syncedThrough,
    samples: {
      missing: (await sample(MISSING, `NOT coalesce(${later}, false)`)).map(r => r.key),
      pendingSync: (await sample(MISSING, `coalesce(${later}, false)`)).map(r => r.key),
      extra: (await sample(EXTRA)).map(r => r.key),
    },
  };
}

/** 没有主键的表：源表行数与原始层回放后的行数（新增、更新加一，删除减一）比较 */
async function compareRows(con: DuckDBConnection, sourceRows: number, bronze: string): Promise<DataCheck> {
  const [{ n }] = await rows<{ n: string | null }>(con, `SELECT sum(CASE WHEN _op = 'delete' THEN -1 ELSE 1 END)::VARCHAR AS n FROM ${bronze}`);
  const lakeRows = Number(n ?? 0);
  return { keyed: false, ok: lakeRows === sourceRows, sourceRows, lakeRows };
}

/** 一项核对出错时只记下这一项的错误，其余照常核对 */
const attempt = async <T>(work: () => Promise<T>, redact: (m: string) => string): Promise<T | Failed> =>
  work().catch(e => ({ ok: false, error: redact(message(e)) }));

/**
 * 核对数据源：源端当前的全部表（含账号读不了的）每张一行，标出覆盖情况与源端行数；源端已没有、湖中仍有的表（或同步范围内的表）
 * 标为源端已删除。已进湖的表再核对位置、文件、结构与数据量（已移出同步范围的只核对位置与文件）。
 * 账号可写时整体拒绝。只读：不写数据湖，中间结果只在本机库 stage 里
 */
export async function verifySourceLake(
  session: TenantLakeSession, spec: SourceSpec, sourceId: string, params: VerifyTableParam[], limits: EngineLimits,
  redact: (message: string) => string,
): Promise<VerifyRecord[]> {
  const { con, source } = session;
  if (!source) throw new Error('数据源没有挂载');
  const writable = await writeGrants({ con, mongo: source.mongo }, spec);
  if (writable.length) throw new Error(`账号可以写入数据源（${writable.map(g => g.object).join('、')}），平台只使用只读账号，请更换账号`);
  const live = new Map((await source.tables()).map(t => [t.name, t]));
  const primary = await primaryKeys(con, spec, [...live.values()]);
  const estimates = await estimatedRows(con, spec);
  const schema = bronzeSchema(sourceId);
  const bronzeTables = new Set((await rows<{ name: string }>(con, `
    SELECT table_name AS name FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name <> '_batches'`))
    .map(t => t.name));
  const states = new Set((await rows<{ state: string }>(con, `
    SELECT table_schema || '.' || table_name AS state FROM information_schema.tables
    WHERE table_catalog = 'lake' AND table_schema IN (${lit(`${schema}_keys`)}, ${lit(`${schema}_mirror`)})`)).map(t => t.state));
  const planned = new Map(params.map(p => [p.name, p]));
  const names = [...new Set([...live.keys(), ...bronzeTables, ...params.filter(p => p.inScope).map(p => p.name)])].sort();

  const records: VerifyRecord[] = [];
  for (const name of names) {
    const table = live.get(name);
    const param = planned.get(name);
    const inLake = bronzeTables.has(name);
    const bronze = `${ident(schema)}.${ident(name)}`;
    const record: VerifyRecord = { table: name, coverage: 'in_lake', sourceRows: null, ok: null };
    records.push(record);
    try {
      if (inLake) {
        const meta = await tableMeta(session, schema, name);
        const state = [`${schema}_keys.${name}`, `${schema}_mirror.${name}`].find(s => states.has(s)) ?? null;
        record.location = { schema, table: name, prefix: meta.prefix, state };
        record.files = await attempt(() => checkFiles(session, meta.id, meta.prefix), redact);
      }
      // 源端已删除不算差异（主键比对修不了它），但湖中文件的问题照样计入
      if (inLake && (!table || !table.readable)) record.ok = record.files!.ok;
      if (!table) {
        record.coverage = 'gone';
        continue;
      }
      if (!table.readable) {
        record.coverage = 'unreadable';
        const estimate = estimates.get(table.table);
        if (estimate !== undefined) Object.assign(record, { sourceRows: estimate, rowsEstimated: true });
        continue;
      }
      record.sourceRows = await countSource(con, spec, table);
      if (!inLake) {
        record.coverage = param?.reason ?? 'out_of_scope';
        continue;
      }
      if (param && !param.inScope) {
        record.outOfScope = true;
        record.ok = record.files!.ok;
        continue;
      }
      record.structure = await attempt(() => checkStructure(con, table, bronze), redact);
      const keys = primary.get(name) ?? param?.key ?? [];
      const sourceRows = record.sourceRows;
      record.data = await attempt(async () => (keys.length
        ? compareKeys({ con, spec, table, bronze, schema, keys, param, columns: await columnsOf(con, `SELECT * FROM ${table.from}`), limits })
        : compareRows(con, sourceRows, bronze)), redact);
      record.ok = record.files!.ok && record.structure.ok && record.data.ok;
    } catch (e) {
      record.error = redact(message(e));
      if (inLake) record.ok = false;
    } finally {
      await con.run([SOURCE_KEYS, HISTORY, CURRENT, MISSING, EXTRA].map(r => `DROP TABLE IF EXISTS ${r};`).join(' '));
    }
  }
  return records;
}

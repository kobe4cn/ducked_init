// app/.server/pipeline/merge-engine.ts —— 标准层合并：按已发布的映射，把原始层里新的变更批次 MERGE 进标准层（ADR-0006、ADR-0015）。
// 在工作进程里运行，只挂载本租户的数据湖。每个标准实体（或自定义实体）一张标准层表 silver."<实体>"：实体的全部字段、扩展字段，
// 加上来自哪个映射 _mapping、哪个数据源 _source、映射版本 _version 与合并时间 _merged_at。
// 每个映射另在 silver_records 里保存源表当前每条记录转换后的结果（当前记录）：有主键的表每个主键一行，没有主键的表每种整行一行、
// 带出现次数 _n。变更批次先改当前记录（删除的移除，新增与更新的换成新版本），再对受影响的去重键重新取最新的一行写进标准层，
// 所以源端的重复行只计一次，删掉其中一行时标准层回落到剩下的行。合并日志 silver._merges 与这些写入在同一个 DuckLake 事务里，
// 记下每个映射合并到了原始层的哪个批次，是下一次合并起点的唯一依据（与 ADR-0012 的批次日志同理）。
// 敏感字段（标准实体的 pii 字段与标成敏感的扩展字段）在转换时就规范化并换成按租户加盐的哈希，当前记录与标准层里都没有明文（ADR-0005）
import type { DuckDBConnection } from '@duckdb/node-api';
import type { TenantLakeSession } from './lake-engine';
import { entityOf } from '../../lib/canonical-model';
import { resolveIdentities, type IdentitySummary } from './identity-engine';
import { compileExpression, parseExpression, referencedColumns } from '../../lib/mapping-expr';
import { sqlType, type MergePlan, type PlanColumn } from './mapping-spec';
import { bronzeSchema, PLATFORM_COLUMNS } from './sync-engine';

/** 合并任务里的一个已发布映射：合并计划加上映射、版本与数据源 */
export interface MergeMappingParam extends MergePlan { mapping: string; version: number; sourceId: string }

/**
 * 一列里落入兜底的取值：出现最多的几个取值与各自的行数，distinct 是共有几种取值，rows 是共有几行。
 * 行数按源表的行计（没有主键的表里重复的行各计一次）；增量合并只统计本次变更的记录
 */
export interface FallbackStat { column: string; values: { value: string; rows: number }[]; distinct: number; rows: number }

/** 一个映射一次合并的结果。时间为 ISO 字符串 */
export type MergeRecord = { mapping: string; entity: string; table: string; version: number; startedAt: string; durationMs: number } & (
  | {
    /** rebuild：首次合并、映射换了版本或源表的主键变了，由原始层全部批次重建 */
    mode: 'incremental' | 'rebuild';
    /** 合并了原始层 (batchFrom, batchTo] 的批次 */
    batchFrom: number;
    batchTo: number;
    inserted: number;
    updated: number;
    deleted: number;
    /** 合并后本映射在标准层的行数 */
    rows: number;
    /** 写了兜底值的列里落入兜底的取值（没有就不带） */
    fallback?: FallbackStat[];
  }
  /** skipped：源表还没有同步进原始层，等首次同步后再合并（不算失败） */
  | { skipped: string }
  | { error: string }
);

/** 合并后的身份打通：摘要与耗时，失败时是错误信息 */
export type IdentityRecord = { durationMs: number } & (IdentitySummary | { error: string });

export const SILVER = 'silver';
const RECORDS = 'silver_records';
const MERGES = `${SILVER}._merges`;
/**
 * 标准层的写法，记在合并日志里；上次合并的写法不同时由全部批次重建。
 * 2：敏感字段只存加盐哈希；之前的日志里没有这一列（为空），敏感字段是明文
 */
const SCHEME = 2;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const columnsOf = (con: DuckDBConnection, relation: string) => rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${relation}`);
const count = async (con: DuckDBConnection, relation: string) => Number((await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${relation}`))[0].n);
const tableExists = async (con: DuckDBConnection, schema: string, name: string) => (await rows(con, `
  SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).length > 0;
const keyList = (keys: string[], alias?: string) => keys.map(k => (alias ? `${alias}.${ident(k)}` : ident(k))).join(', ');
const joinOn = (keys: string[], a: string, b: string) => keys.map(k => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' AND ');
/** 整行哈希（与同步时的算法相同）：“列名=取值”按列名排序后拼接，空值不参与 */
const rowHash = (columns: string[], alias: string) =>
  `hash(concat_ws(chr(31), ${[...columns].sort().map(c => `${lit(`${c}=`)} || ${alias}.${ident(c)}::VARCHAR`).join(', ')}))`;

/** 标准层表：silver."<实体>" */
export const silverTable = (entity: string) => `${SILVER}.${ident(entity)}`;
/** 一个映射的当前记录 */
const recordsOf = (mapping: string) => `${RECORDS}.${ident(`m_${mapping.replace(/-/g, '')}`)}`;

/** 合并的中间结果，暂存在会话的本机库 stage 里（落盘时压缩，ADR-0010） */
const LATEST = 'stage.merge_latest';
const LIVE = 'stage.merge_live';
const ROWS = 'stage.merge_rows';
const KEYS = 'stage.merge_keys';
const BEFORE = 'stage.merge_before';
const WINNERS = 'stage.merge_winners';

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

/** 一列在源端的取值（表达式编译成 SQL，alias 是源表行的别名） */
export const rawValue = (c: PlanColumn, alias: string) => compileExpression(parseExpression(c.expr), alias);

/** 合并计划里的敏感字段：标成敏感的列，加上标准模型里的敏感字段（早先发布的合并计划里没有这个标记，照样适用） */
export const sensitiveColumns = (plan: MergePlan) =>
  new Set([...(entityOf(plan.entity)?.fields.filter(f => f.pii).map(f => f.name) ?? []), ...plan.columns.filter(c => c.sensitive).map(c => c.name)]);

/** 合并计划里映射出来的敏感字段列 */
export const sensitivePlanColumns = (plan: MergePlan) => {
  const pii = sensitiveColumns(plan);
  return plan.columns.filter(c => pii.has(c.name));
};

/** 源表的主键列，取自同步维护的当前主键状态（ADR-0012）；没有主键的表返回 null */
export async function sourceKeysOf(con: DuckDBConnection, sourceId: string, table: string) {
  const keys = `${bronzeSchema(sourceId)}_keys`;
  if (!await tableExists(con, keys, table)) return null;
  return (await columnsOf(con, `${ident(keys)}.${ident(table)}`)).map(c => c.column_name).filter(c => c !== '_hash');
}

/**
 * 敏感字段哈希前的规范化，让同一个值不论写法都得到同一个哈希：手机号只留数字并去掉 86 / 0086 前缀（后面是 1 开头的 11 位手机号时），
 * 邮箱去掉首尾空格并转小写，其余去掉首尾空格。规范化后为空串的记为空
 */
function normalizedPii(field: string, text: string) {
  if (field === 'phone') return `nullif(regexp_replace(regexp_replace(${text}, '[^0-9]', '', 'g'), '^(00)?86(1[0-9]{10})$', '\\2'), '')`;
  return `nullif(${field === 'email' ? `lower(trim(${text}))` : `trim(${text})`}, '')`;
}

/**
 * 一列写进标准层的值：敏感字段是规范化后加盐的 sha256（十六进制，与字段名无关，同一租户里同一个值的哈希相同）；
 * 其他列有值字典时按字典对应，否则转成标准字段的类型。
 * 写了兜底值时，对应不上的取值（没有值字典时是标准枚举之外的取值）写成兜底值；源端为空的仍为空
 */
function columnValue(c: PlanColumn, alias: string, salt: string | null) {
  const raw = rawValue(c, alias);
  if (salt !== null) return `sha256(${lit(salt)} || ${normalizedPii(c.name, `CAST(${raw} AS VARCHAR)`)})`;
  const dictionary = c.dictionary ?? (c.otherwise !== undefined && c.enum ? Object.fromEntries(c.enum.map(v => [v, v])) : undefined);
  if (!dictionary) return `CAST(${raw} AS ${sqlType(c.type)})`;
  const text = `CAST(${raw} AS VARCHAR)`;
  const otherwise = c.otherwise === undefined ? '' : ` ELSE ${c.otherwise === null ? 'NULL' : lit(c.otherwise)}`;
  return `CASE WHEN ${text} IS NULL THEN NULL ${Object.entries(dictionary).map(([from, to]) => `WHEN ${text} = ${lit(from)} THEN ${lit(to)}`).join(' ')}${otherwise} END`;
}

/**
 * 值字典里没有、或（没有值字典时）不是标准枚举的取值：没写兜底值时报错，不悄悄写进标准层，列出出现最多的几个取值与行数；
 * 写了兜底值时返回落入兜底的统计
 */
async function checkUnknownValues(con: DuckDBConnection, columns: PlanColumn[]) {
  const fallback: FallbackStat[] = [];
  for (const c of columns) {
    const allowed = c.dictionary ? Object.keys(c.dictionary) : c.enum;
    if (!allowed) continue;
    const raw = `CAST(${rawValue(c, 'l')} AS VARCHAR)`;
    // 没有主键的表一种整行一条当前记录，_n 是它出现的次数
    const unknown = await rows<{ v: string; n: string; distinct_values: string; total_rows: string }>(con, `
      SELECT v, n, count(*) OVER () AS distinct_values, sum(n) OVER () AS total_rows FROM (
        SELECT ${raw} AS v, sum(l._n) AS n FROM ${LIVE} l
        WHERE ${raw} IS NOT NULL AND ${raw} NOT IN (${allowed.map(lit).join(', ')}) GROUP BY 1)
      ORDER BY n DESC, v LIMIT 5`);
    if (!unknown.length) continue;
    if (c.otherwise !== undefined) {
      fallback.push({
        column: c.name, values: unknown.map(u => ({ value: u.v, rows: Number(u.n) })), distinct: Number(unknown[0].distinct_values), rows: Number(unknown[0].total_rows),
      });
      continue;
    }
    const shown = unknown.map(u => `'${u.v}'（${u.n} 行）`).join('、');
    throw new Error(c.dictionary
      ? `字段 ${c.name} 有值字典里没有的取值：${shown}，请在值字典里补上，或用 otherwise 写兜底值，再重新发布`
      : `字段 ${c.name} 有不是标准枚举的取值：${shown}，请用值字典对应到 ${c.enum!.join('、')}，或用 otherwise 写兜底值`);
  }
  return fallback;
}

/**
 * 转换出错时 DuckDB 的报错可能带出源端的取值：把敏感字段引用的源列里出现在报错中的取值（原样或去掉首尾空格后）抹掉，
 * 不区分大小写。只有一个字的取值不抹，免得把整条报错抹花
 */
async function withoutPii(con: DuckDBConnection, columns: PlanColumn[], message: string) {
  const sources = [...new Set(columns.flatMap(c => referencedColumns(parseExpression(c.expr)).map(r => r.name)))];
  if (!sources.length) return message;
  const found = await rows<{ v: string }>(con, `
    SELECT DISTINCT v FROM (${sources.map(s => `SELECT CAST(l.${ident(s)} AS VARCHAR) AS raw FROM ${LIVE} l`).join(' UNION ALL ')}), unnest([raw, trim(raw)]) AS t(v)
    WHERE length(v) > 1 AND contains(${lit(message.toLowerCase())}, lower(v))`);
  return found.map(f => f.v).sort((a, b) => b.length - a.length)
    .reduce((m, v) => m.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***'), message);
}

/** 标准层表不存在时按实体的全部字段建表，存在时补上新的扩展字段。敏感字段存哈希，类型总是 VARCHAR */
async function ensureSilverTable(con: DuckDBConnection, plan: MergeMappingParam) {
  const table = silverTable(plan.entity);
  const pii = sensitiveColumns(plan);
  const typeOf = (c: MergePlan['entityColumns'][number]) => (pii.has(c.name) ? 'VARCHAR' : sqlType(c.type));
  if (!await tableExists(con, SILVER, plan.entity)) {
    await con.run(`CREATE TABLE ${table} (
      ${plan.entityColumns.map(c => `${ident(c.name)} ${typeOf(c)}`).join(', ')},
      _mapping VARCHAR, _source VARCHAR, _version INTEGER, _merged_at TIMESTAMPTZ)`);
    return;
  }
  const known = new Set((await columnsOf(con, table)).map(c => c.column_name));
  for (const c of plan.entityColumns.filter(c => !known.has(c.name))) {
    await con.run(`ALTER TABLE ${table} ADD COLUMN ${ident(c.name)} ${typeOf(c)}`);
  }
}

interface LastMerge { version: number; source_keys: string; batch_to: string; scheme: number | null }

/**
 * 合并一个映射：读出原始层里上次合并之后的批次，改当前记录，再对受影响的去重键重新取最新的一行写进标准层。
 * 首次合并、映射换了版本、源表的主键变了或标准层的写法变了时由全部批次重建（当前记录与本映射在标准层的行都换掉）
 */
async function mergeMapping(con: DuckDBConnection, plan: MergeMappingParam, salt: string, now: Date): Promise<MergeRecord> {
  const startedAt = new Date();
  const base = { mapping: plan.mapping, entity: plan.entity, table: plan.table, version: plan.version, startedAt: startedAt.toISOString() };
  const schema = bronzeSchema(plan.sourceId);
  if (!await tableExists(con, schema, plan.table)) {
    return { ...base, durationMs: Date.now() - startedAt.getTime(), skipped: `源表 ${plan.table} 还没有同步进原始层，首次同步后再合并` };
  }
  const bronze = `${ident(schema)}.${ident(plan.table)}`;
  const records = recordsOf(plan.mapping);
  const silver = silverTable(plan.entity);
  // 没有主键的表按整行区分记录
  const sourceKeys = await sourceKeysOf(con, plan.sourceId, plan.table) ?? [];
  const keyed = sourceKeys.length > 0;
  const [last] = await rows<LastMerge>(con, `
    SELECT version, source_keys, batch_to, scheme FROM ${MERGES} WHERE mapping_id = ${lit(plan.mapping)} ORDER BY started_at DESC LIMIT 1`);
  const rebuild = !last || last.version !== plan.version || last.source_keys !== sourceKeys.join(',') || last.scheme !== SCHEME
    || !await tableExists(con, RECORDS, `m_${plan.mapping.replace(/-/g, '')}`);
  const from = rebuild ? 0 : Number(last.batch_to);
  const [{ top }] = await rows<{ top: string | null }>(con, `SELECT max(_batch) AS top FROM ${bronze}`);
  const to = Number(top ?? 0);
  const silverRows = async () => count(con, `${silver} WHERE _mapping = ${lit(plan.mapping)}`);
  if (!rebuild && to <= from) {
    return { ...base, durationMs: Date.now() - startedAt.getTime(), mode: 'incremental', batchFrom: from, batchTo: from, inserted: 0, updated: 0, deleted: 0, rows: await silverRows() };
  }

  const data = (await columnsOf(con, bronze)).map(c => c.column_name).filter(c => !PLATFORM_COLUMNS.includes(c));
  const window = `b._batch > ${from} AND b._batch <= ${to}`;
  // 每条源记录在这些批次里的最后一版：有主键时按主键取最新（同一批次里一删一增取新增）；没有主键时按整行累计出现次数的变化
  if (keyed) {
    await con.run(`CREATE OR REPLACE TABLE ${LATEST} AS SELECT * EXCLUDE (_rn) FROM (
      SELECT b.*, hash(${keyList(sourceKeys, 'b')}) AS _src, 0::BIGINT AS _delta,
        row_number() OVER (PARTITION BY ${keyList(sourceKeys, 'b')} ORDER BY b._batch DESC, b._op = 'delete') AS _rn
      FROM ${bronze} b WHERE ${window}) WHERE _rn = 1`);
    await con.run(`CREATE OR REPLACE TABLE ${LIVE} AS SELECT l.*, 1::BIGINT AS _n FROM ${LATEST} l WHERE l._op <> 'delete'`);
  } else {
    await con.run(`CREATE OR REPLACE TABLE ${LATEST} AS SELECT * EXCLUDE (_rn) FROM (
      SELECT h.*, sum(CASE WHEN h._op = 'delete' THEN -1 ELSE 1 END) OVER (PARTITION BY h._src) AS _delta,
        row_number() OVER (PARTITION BY h._src ORDER BY h._batch DESC) AS _rn
      FROM (SELECT b.*, ${rowHash(data, 'b')} AS _src FROM ${bronze} b WHERE ${window}) h) WHERE _rn = 1`);
    const held = rebuild ? `(SELECT NULL::UBIGINT AS _src, NULL::BIGINT AS _n LIMIT 0)` : records;
    await con.run(`CREATE OR REPLACE TABLE ${LIVE} AS SELECT * FROM (
      SELECT l.*, coalesce(r._n, 0) + l._delta AS _n FROM ${LATEST} l LEFT JOIN ${held} r ON r._src = l._src) WHERE _n > 0`);
  }

  // 转换：先查出值字典与标准枚举之外的取值（没写兜底值时报错；敏感字段不查，取值会进报错与兜底统计），再算出各列。
  // 敏感字段在这一步就换成哈希：ROWS 也是当前记录
  const pii = sensitiveColumns(plan);
  const fallback = await checkUnknownValues(con, plan.columns.filter(c => !pii.has(c.name)));
  await con.run(`CREATE OR REPLACE TABLE ${ROWS} AS
    SELECT l._src, l._n, l._batch, ${plan.columns.map(c => `${columnValue(c, 'l', pii.has(c.name) ? salt : null)} AS ${ident(c.name)}`).join(', ')} FROM ${LIVE} l`)
    .catch(async (e: Error) => { throw new Error(await withoutPii(con, plan.columns.filter(c => pii.has(c.name)), e.message)); });
  const key = plan.key;
  const [{ n: nullKeys }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${ROWS} WHERE ${key.map(k => `${ident(k)} IS NULL`).join(' OR ')}`);
  if (Number(nullKeys)) throw new Error(`去重键 ${key.join('、')} 有 ${nullKeys} 行为空，请检查映射或在源端补齐`);

  // 受影响的去重键：改动的源记录在旧版本与新版本里的去重键。重建时是全部的去重键（本映射在标准层的行都换掉）
  const changed = `(SELECT _src FROM ${LATEST})`;
  const previous = rebuild ? '' : `SELECT ${keyList(key, 'r')} FROM ${records} r WHERE r._src IN ${changed} UNION ALL `;
  await con.run(`CREATE OR REPLACE TABLE ${KEYS} AS SELECT DISTINCT * FROM (${previous}SELECT ${keyList(key)} FROM ${ROWS})`);
  const mine = `${silver} s WHERE s._mapping = ${lit(plan.mapping)}`;
  const silverExists = await tableExists(con, SILVER, plan.entity);
  await con.run(`CREATE OR REPLACE TABLE ${BEFORE} AS ${silverExists
    ? `SELECT DISTINCT ${keyList(key, 's')} FROM ${mine}${rebuild ? '' : ` AND EXISTS (SELECT 1 FROM ${KEYS} k WHERE ${joinOn(key, 'k', 's')})`}`
    : `SELECT * FROM ${KEYS} LIMIT 0`}`);
  // 每个受影响的去重键取最新的一行：取最新字段最大（空值最后），再按最近的批次，最后按记录的哈希，结果确定
  const kept = rebuild ? '' : `SELECT r.* FROM ${records} r SEMI JOIN ${KEYS} k ON ${joinOn(key, 'r', 'k')} WHERE r._src NOT IN ${changed} UNION ALL `;
  const order = [...(plan.latest ? [`c.${ident(plan.latest)} DESC NULLS LAST`] : []), 'c._batch DESC', 'c._src'].join(', ');
  await con.run(`CREATE OR REPLACE TABLE ${WINNERS} AS SELECT * EXCLUDE (_rn) FROM (
    SELECT c.*, row_number() OVER (PARTITION BY ${keyList(key, 'c')} ORDER BY ${order}) AS _rn FROM (${kept}SELECT * FROM ${ROWS}) c) WHERE _rn = 1`);
  const [stats] = await rows<{ inserted: string; updated: string; deleted: string }>(con, `
    SELECT (SELECT count(*) FROM ${WINNERS} w ANTI JOIN ${BEFORE} b ON ${joinOn(key, 'w', 'b')}) AS inserted,
           (SELECT count(*) FROM ${WINNERS} w SEMI JOIN ${BEFORE} b ON ${joinOn(key, 'w', 'b')}) AS updated,
           (SELECT count(*) FROM ${BEFORE} b ANTI JOIN ${WINNERS} w ON ${joinOn(key, 'w', 'b')}) AS deleted`);

  await inTransaction(con, async () => {
    await ensureSilverTable(con, plan);
    if (rebuild) {
      await con.run(`DROP TABLE IF EXISTS ${records}; CREATE TABLE ${records} AS SELECT * FROM ${ROWS}`);
      await con.run(`DELETE FROM ${silver} WHERE _mapping = ${lit(plan.mapping)}`);
    } else {
      await con.run(`DELETE FROM ${records} WHERE _src IN (SELECT _src FROM ${LATEST})`);
      await con.run(`INSERT INTO ${records} SELECT * FROM ${ROWS}`);
      await con.run(`DELETE FROM ${silver} USING ${KEYS} k WHERE ${silver}._mapping = ${lit(plan.mapping)} AND ${joinOn(key, silver, 'k')}`);
    }
    await con.run(`
      INSERT INTO ${silver} BY NAME SELECT w.* EXCLUDE (_src, _n, _batch),
        ${lit(plan.mapping)} AS _mapping, ${lit(plan.sourceId)} AS _source, ${plan.version} AS _version, TIMESTAMPTZ ${lit(now.toISOString())} AS _merged_at
      FROM ${WINNERS} w`);
    await con.run(`INSERT INTO ${MERGES} VALUES (
      ${lit(plan.mapping)}, ${plan.version}, ${lit(sourceKeys.join(','))}, ${from}, ${to},
      ${stats.inserted}, ${stats.updated}, ${stats.deleted}, TIMESTAMPTZ ${lit(startedAt.toISOString())}, TIMESTAMPTZ ${lit(new Date().toISOString())}, ${SCHEME})`);
  });
  return {
    ...base,
    durationMs: Date.now() - startedAt.getTime(),
    mode: rebuild ? 'rebuild' : 'incremental',
    batchFrom: from,
    batchTo: to,
    inserted: Number(stats.inserted),
    updated: Number(stats.updated),
    deleted: Number(stats.deleted),
    rows: await silverRows(),
    ...(fallback.length && { fallback }),
  };
}

/**
 * 按已发布的映射合并到标准层，每个映射各自一个事务：一个映射失败（表达式在数据上出错、值字典缺取值、去重键为空）
 * 只影响它自己，其他映射照常合并。之后本租户有 silver.customer 时整表重算身份打通（一次合并只带受影响的映射，增量会漏），
 * 失败同样只记在 identities 里。salt 是租户的敏感信息盐；redact 用来抹掉错误信息里的凭据与盐
 */
export async function mergeToSilver(session: TenantLakeSession, plans: MergeMappingParam[], salt: string, redact: (message: string) => string)
  : Promise<{ mappings: MergeRecord[]; identities?: IdentityRecord }> {
  const { con } = session;
  // 早于敏感字段哈希的数据湖里，合并日志还没有 scheme 列：补上后老的日志为空，各映射下次合并时重建
  await con.run(`CREATE SCHEMA IF NOT EXISTS ${SILVER}; CREATE SCHEMA IF NOT EXISTS ${RECORDS};
    CREATE TABLE IF NOT EXISTS ${MERGES} (
      mapping_id VARCHAR, version INTEGER, source_keys VARCHAR, batch_from BIGINT, batch_to BIGINT,
      inserted BIGINT, updated BIGINT, deleted BIGINT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, scheme INTEGER);
    ALTER TABLE ${MERGES} ADD COLUMN IF NOT EXISTS scheme INTEGER`);
  const now = new Date();
  const records: MergeRecord[] = [];
  for (const plan of plans) {
    const startedAt = new Date();
    try {
      records.push(await mergeMapping(con, plan, salt, now));
    } catch (e) {
      records.push({
        mapping: plan.mapping, entity: plan.entity, table: plan.table, version: plan.version,
        startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: redact((e as Error).message),
      });
    } finally {
      await con.run([LATEST, LIVE, ROWS, KEYS, BEFORE, WINNERS].map(t => `DROP TABLE IF EXISTS ${t};`).join(' '));
    }
  }
  if (!await tableExists(con, SILVER, 'customer')) return { mappings: records };
  const startedAt = Date.now();
  try {
    const summary = await resolveIdentities(con);
    return { mappings: records, identities: { ...summary, durationMs: Date.now() - startedAt } };
  } catch (e) {
    return { mappings: records, identities: { durationMs: Date.now() - startedAt, error: redact((e as Error).message) } };
  }
}

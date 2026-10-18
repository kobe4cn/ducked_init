// app/.server/pipeline/merge-engine.ts —— 标准层合并：按已发布的映射，把原始层里新的变更批次 MERGE 进标准层（ADR-0006、ADR-0015）。
// 在工作进程里运行，只挂载本租户的数据湖。每个标准实体（或自定义实体）一张标准层表 silver."<实体>"：实体的全部字段、扩展字段，
// 加上来自哪个映射 _mapping、哪个数据源 _source、映射版本 _version 与合并时间 _merged_at。
// 每个映射另在 silver_records 里保存源表当前每条记录转换后的结果（当前记录）：有主键的表每个主键一行，没有主键的表每种整行一行、
// 带出现次数 _n。变更批次先改当前记录（删除的移除，新增与更新的换成新版本），再对受影响的去重键重新取最新的一行写进标准层，
// 所以源端的重复行只计一次，删掉其中一行时标准层回落到剩下的行。合并日志 silver._merges 与这些写入在同一个 DuckLake 事务里，
// 记下每个映射合并到了原始层的哪个批次，是下一次合并起点的唯一依据（与 ADR-0012 的批次日志同理）。
// 敏感字段（标准实体的 pii 字段与标成敏感的扩展字段）在转换时就规范化并换成按租户加盐的哈希，当前记录与标准层里都没有明文（ADR-0005）。
// 输入是源视图的映射（ADR-0023）先把视图在原始层上执行的结果物化进会话的本机库，再照源表处理；视图的批次号来自不同的表、不能比较，
// 所以不增量：视图版本或它引用的表有新批次时由全部批次重建，否则不动。
// 映射写了自定义断言（ADR-0026）时合并里一并检查：not_null / range / in 查本批转换后的行，unique 在事务里查本映射在标准层的全部行；
// error 级不通过时这个映射合并失败、事务回滚（不写隔离区），否则结果追加进 silver._assertion_runs，记在合并任务名下
import type { DuckDBConnection } from '@duckdb/node-api';
import type { TenantLakeSession } from './lake-engine';
import { MERGES, RECORDS, SILVER } from './lake-schemas';
import { entityOf, type EntityRelation, type RelationStat } from '../../lib/canonical-model';
import { CONSUMER, CONSUMER_CONSENT, CONSUMER_IDS, consumerSensitive, DEFAULT_RULES, DEVICE_OWNER, IDENTITIES, resolveIdentities, type IdentitySummary } from './identity-engine';
import { compileExpression, parseExpression, referencedColumns } from '../../lib/mapping-expr';
import { customerSourceColumn } from '../../lib/customer-source';
import type { MergeRule } from '../../lib/merge-groups';
import { ensureCustomerSourceColumns } from './customer-source-columns';
import { referencedSourceColumns, sqlType, type MergePlan, type PlanColumn } from './mapping-spec';
import { breakingColumns, type ColumnType } from './schema-diff';
import { bronzeTablesOf, checkViewSql } from './source-view-engine';
import { bronzeSchema, PLATFORM_COLUMNS } from './sync-engine';
import { recordRuns, type AssertionResult } from './assertions';
import { customAssertionName, evalCustomAssertions } from './custom-assertions';

/**
 * 合并任务里的一个已发布映射：合并计划加上映射、版本与数据源；输入是源视图时另带视图最新的已发布版本
 * （版本号、SQL 与引用的原始层表，入队时取定）。rebuild 为真时强制由全部批次重建（数据地图上的重建合并，补上标准层缺的列）。
 * uniqueKey 是实体（customer 除外）的主键：合并后它在整个实体内跨映射唯一（ADR-0024「独占」），不是映射的去重键；
 * uniqueBySource 为真时（主键含指向 customer 的字段）只在同一个数据源内唯一。
 * group 是映射所在的已发布合并组（ADR-0032，可用组员至少 2 个时才带）：写标准层时按组的存活规则把组内同一主键并成一行
 */
export interface MergeMappingParam extends MergePlan {
  mapping: string; version: number; sourceId: string; sourceView?: SourceViewParam; rebuild?: boolean; uniqueKey?: string[]; uniqueBySource?: boolean;
  group?: MergeGroupParam;
}

/**
 * 合并任务里的合并组（ADR-0032）：组 ID、存活规则、实体主键 key（组内按它比较，不是各映射的去重键）与可用的组员（按优先级排，入队时取定）
 */
export interface MergeGroupParam { id: string; rule: MergeRule; key: string[]; members: GroupMemberParam[] }

/**
 * 合并组的一个组员：重算时从它的当前记录按去重键 key 与取最新字段 latest 取每个键最新的一行，
 * 系统列按映射、数据源、版本与键空间写，customer 引用列旁的数据源列按 refs（列 → 数据源 ID）写；
 * sensitive 是它的敏感列（统计不一致时只计数，#200 之前入队的合并没有这一项）
 */
export interface GroupMemberParam {
  mapping: string; sourceId: string; version: number; key: string[]; latest: string | null; keySpace?: string; refs: { column: string; source: string }[];
  sensitive?: string[];
}

/**
 * 合并任务里要撤下的停用映射（ADR-0031）：合并前删掉它写进标准层实体 entity 的行、它的当前记录与合并日志里的水位
 * （之后万一再合并它就走重建）
 */
export interface MergeDrop { mapping: string; entity: string }

/** 撤下的停用映射与从标准层删掉的行数 */
export type DroppedMapping = MergeDrop & { deleted: number };

/** 合并或空跑时源视图的已发布版本 */
export interface SourceViewParam { version: number; sql: string; tables: string[] }

/**
 * 一列里落入兜底的取值：出现最多的几个取值与各自的行数，distinct 是共有几种取值，rows 是共有几行。
 * 行数按源表的行计（没有主键的表里重复的行各计一次）；增量合并只统计本次变更的记录
 */
export interface FallbackStat { column: string; values: { value: string; rows: number }[]; distinct: number; rows: number }

/** 合并或空跑的中间表：每条源记录的最后一版 latest，与其中仍存在的记录 live（带出现次数 _n） */
export interface LiveTables { latest: string; live: string }

/**
 * 合并一个映射的各步骤（计时用）：input 判断源表与读主键（源视图另含物化），lastMerge 读合并日志，maxBatch 取原始层最新批次，
 * live 取每条源记录的最新一版（含行过滤），unknownValues 查兜底取值，transform 转换（含敏感字段哈希），keys 算受影响的键与胜出行；
 * 事务内 ensureTable、records（写当前记录）、deleteInsert（换掉本映射在标准层的行）、unique（跨映射唯一）、groupStats（合并组的重叠与不一致）、
 * mergeLog，commit 是提交本身；rows 数本映射在标准层的行数；assertions 是自定义断言（本批行与事务里的 unique 累加）
 */
export type MergeStep = 'input' | 'lastMerge' | 'maxBatch' | 'live' | 'unknownValues' | 'transform' | 'keys'
  | 'ensureTable' | 'records' | 'deleteInsert' | 'unique' | 'groupStats' | 'assertions' | 'mergeLog' | 'commit' | 'rows';

/**
 * 合并组这次重算的主键里组员之间的差异（ADR-0032）：overlap 是有至少 2 个组员的主键数；conflicts 是其中各字段两边都非空且取值不同的主键数
 * （只列有不一致的字段），带最多 5 个样本主键。敏感字段比较的是哈希，只计数、不带样本；主键里有敏感字段时都不带样本
 */
export interface GroupStat { overlap: number; conflicts: { field: string; count: number; samples: string[] }[] }

/** 一个映射一次合并的结果。时间为 ISO 字符串 */
export type MergeRecord = {
  mapping: string; entity: string; table: string; version: number; startedAt: string; durationMs: number;
  /** 各步骤的耗时（毫秒）；提前返回（跳过、没有新批次）时只有走过的步骤 */
  steps?: Partial<Record<MergeStep, number>>;
} & (
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
    /** 写了行过滤 where 时，不满足条件被滤掉的源表行数（增量合并只统计本次变更的记录） */
    filtered?: number;
    /** 映射在合并组里时，这次重算的主键里组员之间的重叠与不一致（增量合并只统计重算的主键） */
    group?: GroupStat;
    /** 映射写了自定义断言时各条的结果（都没有 error 级不通过，否则合并失败） */
    assertions?: AssertionResult[];
  }
  /** skipped：源表还没有同步进原始层，等首次同步后再合并（不算失败） */
  | { skipped: string }
  /** 报错原文（已 redact）。第一个全角冒号「：」之前不放取值：快照登记时只留这部分作原因摘要（snapshots.ts summarizeMergeError） */
  | { error: string }
);

/** 合并任务里的一条已发布关系（内置 ref 与已发布登记上的关系）；sensitive：起点是敏感字段，标准层里是哈希，入队时算好 */
export interface RelationParam extends EntityRelation { sensitive: boolean }

/** 合并后的身份打通：摘要与耗时，失败时是错误信息；这次没改到 customer、event 与 consent 时跳过（skipped 是原因），沿用上次的结果 */
export type IdentityRecord = { durationMs: number } & (IdentitySummary | { error: string } | { skipped: string });

/** 身份打通读的标准层表：customer、event（设备归属读登录事件）与 consent（统一消费者的同意） */
const IDENTITY_INPUTS = ['customer', 'event', 'consent'];

/**
 * 标准层的写法，记在合并日志里；上次合并的写法不同时由全部批次重建。
 * 2：敏感字段只存加盐哈希；之前的日志里没有这一列（为空），敏感字段是明文。
 * 3：合并组（ADR-0032）的组员按存活规则并成一行
 */
const SCHEME = 3;

export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const columnsOf = (con: DuckDBConnection, relation: string) => rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${relation}`);
const count = async (con: DuckDBConnection, relation: string) => Number((await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${relation}`))[0].n);
export const tableExists = async (con: DuckDBConnection, schema: string, name: string) => (await rows(con, `
  SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).length > 0;
export const keyList = (keys: string[], alias?: string) => keys.map(k => (alias ? `${alias}.${ident(k)}` : ident(k))).join(', ');
export const joinOn = (keys: string[], a: string, b: string) => keys.map(k => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' AND ');
/** 整行哈希（与同步时的算法相同）：“列名=取值”按列名排序后拼接，空值不参与 */
const rowHash = (columns: string[], alias: string) =>
  `hash(concat_ws(chr(31), ${[...columns].sort().map(c => `${lit(`${c}=`)} || ${alias}.${ident(c)}::VARCHAR`).join(', ')}))`;

export const columnExists = async (con: DuckDBConnection, entity: string, column: string) => (await rows(con, `
  SELECT 1 FROM information_schema.columns WHERE table_catalog = 'lake' AND table_schema = ${lit(SILVER)} AND table_name = ${lit(entity)}
    AND column_name = ${lit(column)}`)).length > 0;

/** 标准层表：silver."<实体>" */
export const silverTable = (entity: string) => `${SILVER}.${ident(entity)}`;
/** 一个映射的当前记录 */
const recordsName = (mapping: string) => `m_${mapping.replace(/-/g, '')}`;
const recordsOf = (mapping: string) => `${RECORDS}.${ident(recordsName(mapping))}`;

/** 合并组里一个组员的参数（入队时由它的合并参数得出） */
export const groupMemberOf = (plan: MergeMappingParam): GroupMemberParam => ({
  mapping: plan.mapping, sourceId: plan.sourceId, version: plan.version, key: plan.key, latest: plan.latest,
  ...(plan.keySpace && { keySpace: plan.keySpace }),
  refs: customerRefColumns(plan).map(c => ({ column: c.name, source: c.customerSource ?? plan.sourceId })),
  sensitive: [...sensitiveColumns(plan)],
});

/** 合并的中间结果，暂存在会话的本机库 stage 里（落盘时压缩，ADR-0010）。按实体并行合并时每条队列一组，表名带上队列的后缀，互不覆盖 */
const stageTables = (suffix: string) => ({
  latest: `stage.merge_latest_${suffix}`,
  live: `stage.merge_live_${suffix}`,
  rows: `stage.merge_rows_${suffix}`,
  keys: `stage.merge_keys_${suffix}`,
  groupKeys: `stage.merge_group_keys_${suffix}`,
  before: `stage.merge_before_${suffix}`,
  winners: `stage.merge_winners_${suffix}`,
  view: `stage.merge_view_${suffix}`,
});
type StageTables = ReturnType<typeof stageTables>;

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
 * 映射读的输入：keys 是记录标识列（源表的主键，源视图是映射写的 view_key；为空时按整行区分记录）；
 * rebuildTag 记在合并日志的 source_keys 里，与上次合并的不同时由全部批次重建：源表是主键，源视图另加视图版本与引用的各表最新的批次；
 * load 返回读变更批次的关系（源视图在这时物化进 into）
 */
export interface MappingInput { keys: string[]; rebuildTag: string; load: () => Promise<string> }

/**
 * 映射 plan 读的原始层：源表时是 bronze_<数据源 ID>."<表>"，源视图时是视图（sourceView）在本源原始层上执行的结果。
 * 源表或视图引用的表还没有同步进原始层时返回 skipped（step 是提示里的“合并”或“空跑”）。
 * 视图 SQL 执行前按保存时的规则再校验一次（只读本源原始层、只能是一条 SELECT），合并的会话不是只读挂载
 */
export async function mappingInput(
  con: DuckDBConnection, plan: MergePlan, sourceId: string, sourceView: SourceViewParam | undefined, into: string, step: string,
): Promise<MappingInput | { skipped: string }> {
  const schema = bronzeSchema(sourceId);
  if (!plan.view) {
    if (!await tableExists(con, schema, plan.table)) return { skipped: `源表 ${plan.table} 还没有同步进原始层，首次同步后再${step}` };
    const keys = await sourceKeysOf(con, sourceId, plan.table) ?? [];
    const bronze = `${ident(schema)}.${ident(plan.table)}`;
    return { keys, rebuildTag: keys.join(','), load: async () => bronze };
  }
  if (!sourceView) throw new Error(`源视图 ${plan.table} 没有已发布的版本`);
  const present = await bronzeTablesOf(con, sourceId);
  const missing = sourceView.tables.filter(t => !present.includes(t));
  if (missing.length) return { skipped: `源视图 ${plan.table} 引用的表 ${missing.join('、')} 还没有同步进原始层，首次同步后再${step}` };
  const tables = await checkViewSql(con, sourceView.sql, sourceId, present);
  const batches = [];
  for (const t of tables) {
    const [{ top }] = await rows<{ top: string | null }>(con, `SELECT max(_batch) AS top FROM ${ident(schema)}.${ident(t)}`);
    batches.push(`${t}=${top ?? 0}`);
  }
  const keys = plan.view.key;
  return {
    keys,
    rebuildTag: `${keys.join(',')}|view@${sourceView.version}|${batches.join(',')}`,
    load: async () => {
      // 不带 catalog 的表名按本源原始层解析（同源视图的预览）；换行再收尾，SQL 末尾的行注释不会吞掉右括号
      await con.run(`USE lake.${ident(schema)}`);
      try {
        await con.run(`CREATE OR REPLACE TABLE ${into} AS SELECT * FROM (\n${sourceView.sql}\n)`);
      } catch (e) {
        // 这里读的是明文原始层（不像预览读哈希过的同名视图），转换出错的报错会带出取值：引号里的字面量一律抹掉
        throw new Error(`源视图 ${plan.table} 执行出错：${(e as Error).message.replace(/'(?:[^']|'')*'/g, "'***'")}`);
      } finally {
        await con.run('USE lake');
      }
      return into;
    },
  };
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
 * 写了兜底值时，对应不上的取值（没有值字典时是标准枚举之外的取值）写成兜底值；源端为空的仍为空。
 * 带键空间的列（只会是不敏感的文本列）最后加上 <键空间>: 前缀，空值仍为空（ADR-0024）
 */
function columnValue(c: PlanColumn, alias: string, salt: string | null) {
  const raw = rawValue(c, alias);
  if (salt !== null) return `sha256(${lit(salt)} || ${normalizedPii(c.name, `CAST(${raw} AS VARCHAR)`)})`;
  const value = plainValue(c, raw);
  return c.keySpace ? `CASE WHEN ${value} IS NULL THEN NULL ELSE ${lit(`${c.keySpace}:`)} || CAST(${value} AS VARCHAR) END` : value;
}

/** 不敏感的列：按值字典对应，或转成标准字段的类型 */
function plainValue(c: PlanColumn, raw: string) {
  const dictionary = c.dictionary ?? (c.otherwise !== undefined && c.enum ? Object.fromEntries(c.enum.map(v => [v, v])) : undefined);
  if (!dictionary) return `CAST(${raw} AS ${sqlType(c.type)})`;
  const text = `CAST(${raw} AS VARCHAR)`;
  const otherwise = c.otherwise === undefined ? '' : ` ELSE ${c.otherwise === null ? 'NULL' : lit(c.otherwise)}`;
  return `CASE WHEN ${text} IS NULL THEN NULL ${Object.entries(dictionary).map(([from, to]) => `WHEN ${text} = ${lit(from)} THEN ${lit(to)}`).join(' ')}${otherwise} END`;
}

/**
 * 一列在 live 里值字典没有、或（没有值字典时）不是标准枚举的取值：出现最多的几个取值与行数（按 _n 计）。
 * 没有值字典也没有标准枚举，或没有这样的取值时返回 null
 */
export async function unknownValues(con: DuckDBConnection, c: PlanColumn, live: string): Promise<FallbackStat | null> {
  const allowed = c.dictionary ? Object.keys(c.dictionary) : c.enum;
  if (!allowed) return null;
  const raw = `CAST(${rawValue(c, 'l')} AS VARCHAR)`;
  // 没有主键的表一种整行一条当前记录，_n 是它出现的次数
  const unknown = await rows<{ v: string; n: string; distinct_values: string; total_rows: string }>(con, `
    SELECT v, n, count(*) OVER () AS distinct_values, sum(n) OVER () AS total_rows FROM (
      SELECT ${raw} AS v, sum(l._n) AS n FROM ${live} l
      WHERE ${raw} IS NOT NULL AND ${raw} NOT IN (${allowed.map(lit).join(', ')}) GROUP BY 1)
    ORDER BY n DESC, v LIMIT 5`);
  if (!unknown.length) return null;
  return { column: c.name, values: unknown.map(u => ({ value: u.v, rows: Number(u.n) })), distinct: Number(unknown[0].distinct_values), rows: Number(unknown[0].total_rows) };
}

/**
 * 值字典里没有、或（没有值字典时）不是标准枚举的取值：没写兜底值时报错，不悄悄写进标准层，列出出现最多的几个取值与行数；
 * 写了兜底值时返回落入兜底的统计
 */
async function checkUnknownValues(con: DuckDBConnection, columns: PlanColumn[], live: string) {
  const fallback: FallbackStat[] = [];
  for (const c of columns) {
    const unknown = await unknownValues(con, c, live);
    if (!unknown) continue;
    if (c.otherwise !== undefined) {
      fallback.push(unknown);
      continue;
    }
    const shown = unknown.values.map(u => `'${u.value}'（${u.rows} 行）`).join('、');
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
async function withoutPii(con: DuckDBConnection, columns: Pick<PlanColumn, 'expr'>[], message: string, live: string) {
  const sources = [...new Set(columns.flatMap(c => referencedColumns(parseExpression(c.expr)).map(r => r.name)))];
  if (!sources.length) return message;
  const found = await rows<{ v: string }>(con, `
    SELECT DISTINCT v FROM (${sources.map(s => `SELECT CAST(l.${ident(s)} AS VARCHAR) AS raw FROM ${live} l`).join(' UNION ALL ')}), unnest([raw, trim(raw)]) AS t(v)
    WHERE length(v) > 1 AND contains(${lit(message.toLowerCase())}, lower(v))`);
  return found.map(f => f.v).sort((a, b) => b.length - a.length)
    .reduce((m, v) => m.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***'), message);
}

/**
 * 每条源记录在原始层 (from, to] 批次里的最后一版写进 latest，其中仍存在的写进 live：有主键时按主键取最新（同一批次里一删一增取新增）；
 * 没有主键时按整行累计出现次数的变化，held 是之前的当前记录（带 _n，由全部批次重建时为 null）
 */
export async function liveRecords(
  con: DuckDBConnection, bronze: string, sourceKeys: string[], { from, to, held }: { from: number; to: number; held: string | null }, { latest, live }: LiveTables,
) {
  const window = `b._batch > ${from} AND b._batch <= ${to}`;
  if (sourceKeys.length) {
    await con.run(`CREATE OR REPLACE TABLE ${latest} AS SELECT * EXCLUDE (_rn) FROM (
      SELECT b.*, hash(${keyList(sourceKeys, 'b')}) AS _src, 0::BIGINT AS _delta,
        row_number() OVER (PARTITION BY ${keyList(sourceKeys, 'b')} ORDER BY b._batch DESC, b._op = 'delete') AS _rn
      FROM ${bronze} b WHERE ${window}) WHERE _rn = 1`);
    await con.run(`CREATE OR REPLACE TABLE ${live} AS SELECT l.*, 1::BIGINT AS _n FROM ${latest} l WHERE l._op <> 'delete'`);
    return;
  }
  const data = (await columnsOf(con, bronze)).map(c => c.column_name).filter(c => !PLATFORM_COLUMNS.includes(c));
  await con.run(`CREATE OR REPLACE TABLE ${latest} AS SELECT * EXCLUDE (_rn) FROM (
    SELECT h.*, sum(CASE WHEN h._op = 'delete' THEN -1 ELSE 1 END) OVER (PARTITION BY h._src) AS _delta,
      row_number() OVER (PARTITION BY h._src ORDER BY h._batch DESC) AS _rn
    FROM (SELECT b.*, ${rowHash(data, 'b')} AS _src FROM ${bronze} b WHERE ${window}) h) WHERE _rn = 1`);
  await con.run(`CREATE OR REPLACE TABLE ${live} AS SELECT * FROM (
    SELECT l.*, coalesce(r._n, 0) + l._delta AS _n FROM ${latest} l LEFT JOIN ${held ?? '(SELECT NULL::UBIGINT AS _src, NULL::BIGINT AS _n LIMIT 0)'} r ON r._src = l._src) WHERE _n > 0`);
}

/**
 * 把 live 里的记录按合并计划转换成各列，写进 into（带 _src、_n、_batch）。敏感字段在这一步就换成按租户加盐的哈希；
 * 转换出错时报错里抹掉敏感字段引用的源端取值
 */
export async function transformRows(con: DuckDBConnection, plan: MergePlan, salt: string, { live, into }: { live: string; into: string }) {
  const pii = sensitiveColumns(plan);
  await con.run(`CREATE OR REPLACE TABLE ${into} AS
    SELECT l._src, l._n, l._batch, ${plan.columns.map(c => `${columnValue(c, 'l', pii.has(c.name) ? salt : null)} AS ${ident(c.name)}`).join(', ')} FROM ${live} l`)
    .catch(async (e: Error) => { throw new Error(await withoutPii(con, plan.columns.filter(c => pii.has(c.name)), e.message, live)); });
}

/** 合并写进每张标准层表的系统列：来自哪个映射、哪个数据源、映射版本、合并时间与映射的键空间（没声明时为空） */
export const SILVER_SYSTEM_COLUMNS = { _mapping: 'VARCHAR', _source: 'VARCHAR', _version: 'INTEGER', _merged_at: 'TIMESTAMPTZ', _key_space: 'VARCHAR' } as const;

/**
 * 本映射里指向 customer 的引用列（ADR-0030）：计划里带 customerRef 的，以及名为 customer_id 的列
 * （customer 自己的主键也记数据源；早于 customerRef 的老计划只能这样认）。每列旁边落一列 customerSourceColumn
 */
const customerRefColumns = (plan: MergePlan) => plan.columns.filter(c => c.customerRef || c.name === 'customer_id');

/** 标准层表上本映射要有的数据源列：实体有 customer_id 就有 _customer_source（不论本映射映不映射它），再加上本映射其他引用列的 */
export const sourceColumnsForPlan = (plan: MergePlan) => [...new Set([
  ...(plan.entityColumns.some(c => c.name === 'customer_id') ? ['customer_id'] : []), ...customerRefColumns(plan).map(c => c.name),
])].map(customerSourceColumn);

/**
 * 标准层表不存在时按实体的全部字段建表，存在时补上新的扩展字段、后来加的系统列（如 _key_space）与本映射引用列的数据源列。
 * 敏感字段存哈希，类型总是 VARCHAR
 */
async function ensureSilverTable(con: DuckDBConnection, plan: MergeMappingParam) {
  const table = silverTable(plan.entity);
  const pii = sensitiveColumns(plan);
  const typeOf = (c: MergePlan['entityColumns'][number]) => (pii.has(c.name) ? 'VARCHAR' : sqlType(c.type));
  const sourceColumns = sourceColumnsForPlan(plan);
  if (!await tableExists(con, SILVER, plan.entity)) {
    await con.run(`CREATE TABLE ${table} (
      ${plan.entityColumns.map(c => `${ident(c.name)} ${typeOf(c)}`).join(', ')},
      ${Object.entries(SILVER_SYSTEM_COLUMNS).map(([name, type]) => `${name} ${type}`).join(', ')}${sourceColumns.map(name => `, ${ident(name)} VARCHAR`).join('')})`);
    return;
  }
  for (const [name, type] of Object.entries(SILVER_SYSTEM_COLUMNS)) await con.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  const known = new Set((await columnsOf(con, table)).map(c => c.column_name));
  for (const c of plan.entityColumns.filter(c => !known.has(c.name))) {
    await con.run(`ALTER TABLE ${table} ADD COLUMN ${ident(c.name)} ${typeOf(c)}`);
  }
  for (const name of sourceColumns.filter(name => !known.has(name))) await con.run(`ALTER TABLE ${table} ADD COLUMN ${ident(name)} VARCHAR`);
}

/**
 * 合并前对照源表最近一次同步记下的结构指纹（ADR-0034）：映射引用的列在源端被删除或破坏性改类型（对照原始层的列类型）时报错，
 * 不把这些列悄悄写成空值。源端恢复或映射改版之前每次合并都失败。还没记过结构（老湖还没同步过）时跳过；源视图的映射不查
 */
async function checkSourceSchema(con: DuckDBConnection, plan: MergeMappingParam) {
  const schema = bronzeSchema(plan.sourceId);
  if (!await tableExists(con, schema, '_schemas')) return;
  const [latest] = await rows<{ columns: string }>(con, `
    SELECT columns::VARCHAR AS columns FROM ${ident(schema)}._schemas WHERE table_name = ${lit(plan.table)} ORDER BY batch DESC LIMIT 1`);
  if (!latest) return;
  const bronze = (await columnsOf(con, `${ident(schema)}.${ident(plan.table)}`))
    .filter(c => !PLATFORM_COLUMNS.includes(c.column_name)).map(c => ({ name: c.column_name, type: c.column_type }));
  const { removed, typeChanged } = breakingColumns(referencedSourceColumns(plan), bronze, JSON.parse(latest.columns) as ColumnType[]);
  const broken = [...removed.map(c => `${c} 已被删除`), ...typeChanged.map(c => `${c.name} 的类型由 ${c.from} 改成了 ${c.to}`)];
  // 摘要只留冒号之前（summarizeMergeError），列名写在冒号前
  if (broken.length) throw new Error(`映射引用的源列 ${broken.join('、')}：源表 ${plan.table} 的结构变了，请修改映射后重新发布，或在源端恢复`);
}

interface LastMerge { version: number; source_keys: string; batch_to: string; scheme: number | null }

/**
 * 合并一个映射：读出原始层里上次合并之后的批次，改当前记录，再对受影响的去重键重新取最新的一行写进标准层。
 * 首次合并、映射换了版本、源表的主键变了、标准层的写法变了或带了强制重建标记时由全部批次重建（当前记录与本映射在标准层的行都换掉）
 */
async function mergeMapping(con: DuckDBConnection, plan: MergeMappingParam, salt: string, now: Date, stage: StageTables, taskId: string): Promise<MergeRecord> {
  const startedAt = new Date();
  // 分步计时：lap(步骤) 把上一次打点以来的耗时累加到这一步
  const steps: Partial<Record<MergeStep, number>> = {};
  let mark = startedAt.getTime();
  const lap = (step: MergeStep) => {
    const t = Date.now();
    steps[step] = (steps[step] ?? 0) + t - mark;
    mark = t;
  };
  const base = { mapping: plan.mapping, entity: plan.entity, table: plan.table, version: plan.version, startedAt: startedAt.toISOString(), steps };
  const input = await mappingInput(con, plan, plan.sourceId, plan.sourceView, stage.view, '合并');
  lap('input');
  if ('skipped' in input) return { ...base, durationMs: Date.now() - startedAt.getTime(), skipped: input.skipped };
  if (!plan.view) await checkSourceSchema(con, plan);
  const records = recordsOf(plan.mapping);
  const silver = silverTable(plan.entity);
  // 没有主键的表按整行区分记录
  const sourceKeys = input.keys;
  const [last] = await rows<LastMerge>(con, `
    SELECT version, source_keys, batch_to, scheme FROM ${MERGES} WHERE mapping_id = ${lit(plan.mapping)} ORDER BY started_at DESC LIMIT 1`);
  const rebuild = plan.rebuild || !last || last.version !== plan.version || last.source_keys !== input.rebuildTag || last.scheme !== SCHEME
    || !await tableExists(con, RECORDS, recordsName(plan.mapping));
  lap('lastMerge');
  const from = rebuild ? 0 : Number(last.batch_to);
  const silverRows = async () => count(con, `${silver} WHERE _mapping = ${lit(plan.mapping)}`);
  const unchanged = async (): Promise<MergeRecord> =>
    ({ ...base, durationMs: Date.now() - startedAt.getTime(), mode: 'incremental', batchFrom: from, batchTo: from, inserted: 0, updated: 0, deleted: 0, rows: await silverRows() });
  // 源视图不增量：没有要重建的变化时不读视图
  if (!rebuild && plan.view) return unchanged();
  const bronze = await input.load();
  // 源视图在这时物化，与上面的 input 累加
  lap('input');
  const [{ top }] = await rows<{ top: string | null }>(con, `SELECT max(_batch) AS top FROM ${bronze}`);
  const to = Number(top ?? 0);
  lap('maxBatch');
  if (!rebuild && to <= from) return unchanged();

  await liveRecords(con, bronze, sourceKeys, { from, to, held: rebuild ? null : records }, { latest: stage.latest, live: stage.live });
  // 行过滤：不满足（含取值为空）的记录从 live 里去掉，视为当前记录里不存在；latest 不动，它们的旧版本照常删除、受影响的去重键回落（ADR-0024）
  const filtered = plan.where ? await filterLive(con, plan, stage.live) : undefined;
  lap('live');
  // 先查出值字典与标准枚举之外的取值（没写兜底值时报错；敏感字段不查，取值会进报错与兜底统计），再转换
  const pii = sensitiveColumns(plan);
  const fallback = await checkUnknownValues(con, plan.columns.filter(c => !pii.has(c.name)), stage.live);
  lap('unknownValues');
  await transformRows(con, plan, salt, { live: stage.live, into: stage.rows });
  lap('transform');
  const key = plan.key;
  const [{ n: nullKeys }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${stage.rows} WHERE ${key.map(k => `${ident(k)} IS NULL`).join(' OR ')}`);
  if (Number(nullKeys)) throw new Error(`去重键 ${key.join('、')} 有 ${nullKeys} 行为空，请检查映射或在源端补齐`);
  // 自定义断言的行级检查只看本批转换后的行（增量时是变更的记录）；unique 要看合并后的全部行，在事务里查
  const custom = plan.assertions ?? [];
  const rowChecks = await evalCustomAssertions(con, stage.rows, plan.entity, custom.filter(a => a.check !== 'unique'));
  failOnCustomErrors(rowChecks);
  if (custom.length) lap('assertions');

  // 受影响的去重键：改动的源记录在旧版本与新版本里的去重键。重建时是全部的去重键（本映射在标准层的行都换掉），不建 stage.keys
  const changed = `(SELECT _src FROM ${stage.latest})`;
  if (!rebuild) {
    await con.run(`CREATE OR REPLACE TABLE ${stage.keys} AS SELECT DISTINCT * FROM (
      SELECT ${keyList(key, 'r')} FROM ${records} r WHERE r._src IN ${changed} UNION ALL SELECT ${keyList(key)} FROM ${stage.rows})`);
  }
  // 标准层里本映射受影响的旧键，只用于统计。保留 DISTINCT：换过去重键后旧行可能重复或有空键，空键连不上 stage.winners，算进 deleted
  const mine = `${silver} s WHERE s._mapping = ${lit(plan.mapping)}`;
  const silverExists = await tableExists(con, SILVER, plan.entity);
  if (silverExists) {
    await con.run(`CREATE OR REPLACE TABLE ${stage.before} AS SELECT DISTINCT ${keyList(key, 's')} FROM ${mine}${rebuild
      ? '' : ` AND EXISTS (SELECT 1 FROM ${stage.keys} k WHERE ${joinOn(key, 'k', 's')})`}`);
  }
  // 每个受影响的去重键取最新的一行：取最新字段最大（空值最后），再按最近的批次，最后按记录的哈希，结果确定
  const kept = rebuild ? '' : `SELECT r.* FROM ${records} r SEMI JOIN ${stage.keys} k ON ${joinOn(key, 'r', 'k')} WHERE r._src NOT IN ${changed} UNION ALL `;
  const order = [...(plan.latest ? [`c.${ident(plan.latest)} DESC NULLS LAST`] : []), 'c._batch DESC', 'c._src'].join(', ');
  await con.run(`CREATE OR REPLACE TABLE ${stage.winners} AS SELECT * EXCLUDE (_rn) FROM (
    SELECT c.*, row_number() OVER (PARTITION BY ${keyList(key, 'c')} ORDER BY ${order}) AS _rn FROM (${kept}SELECT * FROM ${stage.rows}) c) WHERE _rn = 1`);
  // 三个统计一次扫描：stage.winners 的键不重复、stage.before 去过重，全连接后每个键至多一行；joinOn 用 =，空键两边都连不上
  const [stats] = silverExists
    ? await rows<{ inserted: string; updated: string; deleted: string }>(con, `
      SELECT count(*) FILTER (WHERE w._in_winners AND b._in_before IS NULL) AS inserted,
        count(*) FILTER (WHERE w._in_winners AND b._in_before) AS updated, count(*) FILTER (WHERE w._in_winners IS NULL) AS deleted
      FROM (SELECT ${keyList(key)}, true AS _in_winners FROM ${stage.winners}) w
      FULL OUTER JOIN (SELECT *, true AS _in_before FROM ${stage.before}) b ON ${joinOn(key, 'w', 'b')}`)
    : [{ inserted: String(await count(con, stage.winners)), updated: '0', deleted: '0' }];
  // 合并组：事务里按存活规则从全部组员的当前记录重算（各组员的列在这时读好，本映射的列与 stage.rows 相同）。
  // 增量时只重算受影响的主键：受影响的去重键下全部记录（含没改动的，去重键的胜出行换了，它们的主键也受影响）在旧版本与新版本里的实体主键；
  // 主键有空值的行不并，按去重键 stage.keys 只重算本映射的
  let scope: GroupScope | undefined;
  if (plan.group && !rebuild) {
    const groupKey = plan.group.key;
    const writesGroupKey = groupKey.every(k => plan.columns.some(c => c.name === k));
    await con.run(`CREATE OR REPLACE TABLE ${stage.groupKeys} AS ${writesGroupKey ? `SELECT DISTINCT * FROM (
      SELECT ${keyList(groupKey, 'r')} FROM ${records} r SEMI JOIN ${stage.keys} k ON ${joinOn(key, 'r', 'k')} UNION ALL SELECT ${keyList(groupKey)} FROM ${stage.rows})
      WHERE NOT (${anyNull(groupKey)})` : `SELECT ${groupKey.map(k => `NULL AS ${ident(k)}`).join(', ')} LIMIT 0`}`);
    scope = { groupKeysTable: stage.groupKeys, ownKeysTable: stage.keys };
  }
  const grouped = plan.group && {
    key: plan.group.key, members: plan.group.members.map(m => lit(m.mapping)).join(', '), memberSensitive: plan.group.members.flatMap(m => m.sensitive ?? []),
    ...await groupRowsSql(con, plan, plan.group, stage.rows, now, scope),
  };
  let groupStat: GroupStat | undefined;
  let customResults: AssertionResult[] | undefined;
  lap('keys');

  await inTransaction(con, async () => {
    await ensureSilverTable(con, plan);
    lap('ensureTable');
    // 主键有列没映射时（声明了 dedupe.key）本映射的主键在标准层全为空，不会重复
    const unique = plan.uniqueKey?.every(k => plan.columns.some(c => c.name === k)) && plan.uniqueKey;
    // 同组的映射不查：它们的同一主键要并成一行
    if (unique) {
      await assertUniqueAcrossMappings(con, silver, plan.mapping, unique, stage.winners, {
        source: plan.uniqueBySource ? plan.sourceId : undefined, grouped: plan.group?.members.map(m => m.mapping),
      });
    }
    lap('unique');
    if (rebuild) {
      await con.run(`DROP TABLE IF EXISTS ${records}; CREATE TABLE ${records} AS SELECT * FROM ${stage.rows}`);
      lap('records');
      if (!grouped) await con.run(`DELETE FROM ${silver} WHERE _mapping = ${lit(plan.mapping)}`);
    } else {
      await con.run(`DELETE FROM ${records} WHERE _src IN (SELECT _src FROM ${stage.latest})`);
      await con.run(`INSERT INTO ${records} SELECT * FROM ${stage.rows}`);
      lap('records');
      if (!grouped) await con.run(`DELETE FROM ${silver} USING ${stage.keys} k WHERE ${silver}._mapping = ${lit(plan.mapping)} AND ${joinOn(key, silver, 'k')}`);
    }
    if (grouped && scope) {
      // 增量：删掉全部组员在受影响主键上的行与本映射受影响的去重键上主键有空值的行，再按规则写回
      const groupKey = grouped.key;
      await con.run(`DELETE FROM ${silver} USING ${scope.groupKeysTable} g WHERE ${silver}._mapping IN (${grouped.members}) AND ${joinOn(groupKey, silver, 'g')}`);
      await con.run(`DELETE FROM ${silver} USING ${scope.ownKeysTable} k
        WHERE ${silver}._mapping = ${lit(plan.mapping)} AND (${anyNull(groupKey, silver)}) AND ${joinOn(key, silver, 'k')}`);
      await con.run(`INSERT INTO ${silver} BY NAME ${grouped.select}`);
    } else if (grouped) {
      // 重建时整组重算：删掉全部组员在标准层的行，再按规则写回每个主键一行
      await con.run(`DELETE FROM ${silver} WHERE _mapping IN (${grouped.members})`);
      await con.run(`INSERT INTO ${silver} BY NAME ${grouped.select}`);
    } else {
      await con.run(`
      INSERT INTO ${silver} BY NAME SELECT w.* EXCLUDE (_src, _n, _batch),
        ${lit(plan.mapping)} AS _mapping, ${lit(plan.sourceId)} AS _source, ${plan.version} AS _version, TIMESTAMPTZ ${lit(now.toISOString())} AS _merged_at,
        ${plan.keySpace ? lit(plan.keySpace) : 'NULL'} AS _key_space${customerRefColumns(plan).map(c => `,
        ${lit(c.customerSource ?? plan.sourceId)} AS ${ident(customerSourceColumn(c.name))}`).join('')}
      FROM ${stage.winners} w`);
    }
    lap('deleteInsert');
    // 写回之后统计：候选行读的是事务里已换成新版本的当前记录
    if (grouped) {
      // 本映射的敏感列另算：#200 之前入队的合并里组员没有 sensitive
      const sensitive = new Set([...sensitiveColumns(plan), ...grouped.memberSensitive]);
      groupStat = await groupStats(con, grouped, sensitive);
      lap('groupStats');
    }
    if (custom.length) {
      const uniqueChecks = await evalCustomAssertions(con, `(SELECT * FROM ${silver} WHERE _mapping = ${lit(plan.mapping)})`, plan.entity, custom.filter(a => a.check === 'unique'));
      failOnCustomErrors(uniqueChecks);
      // 按 YAML 里的顺序；行数与内置断言一样记实体在标准层的总行数（行数骤降以它为基准）
      const byName = new Map([...rowChecks, ...uniqueChecks].map(r => [r.name, r]));
      customResults = custom.map(a => byName.get(customAssertionName(a))!);
      await recordRuns(con, taskId, new Map([[plan.entity, await count(con, silver)]]), customResults);
      lap('assertions');
    }
    await con.run(`INSERT INTO ${MERGES} VALUES (
      ${lit(plan.mapping)}, ${plan.version}, ${lit(input.rebuildTag)}, ${from}, ${to},
      ${stats.inserted}, ${stats.updated}, ${stats.deleted}, TIMESTAMPTZ ${lit(startedAt.toISOString())}, TIMESTAMPTZ ${lit(new Date().toISOString())}, ${SCHEME})`);
    lap('mergeLog');
  });
  lap('commit');
  const silverCount = await silverRows();
  lap('rows');
  const durationMs = Date.now() - startedAt.getTime();
  console.log(`${new Date().toISOString()} [合并] ${plan.table} → ${plan.entity}（${plan.mapping}）：${silverCount} 行，${durationMs} ms（${Object.entries(steps).map(([k, v]) => `${k} ${v}`).join('、')}）`);
  return {
    ...base,
    durationMs,
    mode: rebuild ? 'rebuild' : 'incremental',
    batchFrom: from,
    batchTo: to,
    inserted: Number(stats.inserted),
    updated: Number(stats.updated),
    deleted: Number(stats.deleted),
    rows: silverCount,
    ...(fallback.length && { fallback }),
    ...(filtered !== undefined && { filtered }),
    ...(groupStat && { group: groupStat }),
    ...(customResults && { assertions: customResults }),
  };
}

/** 有 error 级自定义断言不通过时报错（只带断言名与行数，不带取值），映射合并失败、事务回滚 */
function failOnCustomErrors(results: readonly AssertionResult[]) {
  const failed = results.filter(r => r.level === 'error' && r.failed > 0);
  if (failed.length) throw new Error(`自定义断言 ${failed.map(r => `${r.name} 不通过：${r.failed} 行`).join('；')}`);
}

/**
 * 增量合并时合并组只重算的范围：实体主键在 groupKeysTable 里的行，与本映射去重键在 ownKeysTable 里、主键有空值的行
 */
interface GroupScope { groupKeysTable: string; ownKeysTable: string }

/** 主键有空值（alias 给出时带上表别名） */
const anyNull = (keys: string[], alias?: string) => keys.map(k => `${alias ? `${alias}.` : ''}${ident(k)} IS NULL`).join(' OR ');

/**
 * 合并组按存活规则重算标准层的 SELECT（ADR-0032）。每个组员从当前记录按自己的去重键取最新的一行（与单独合并时一样），带上系统列、
 * 优先级 _rank 与组员内同一主键的次序 _within；再按实体主键并成一行：priority 整行取优先级最前的，latest 整行取 field 最新的（一样新时按优先级），
 * coalesce 逐列取优先级最前的非空值，系统列记有这个键的最高优先级组员，customer 引用列旁的数据源列跟该列取值的组员（ADR-0030）。
 * 主键有空值的行不并，各自一行。还没有当前记录的组员（没合并过或合并失败）视为空；本映射的列取 rows（与事务里写入的当前记录同构）。
 * 给了 scope 时只算其中的行（各组员先取好每个去重键最新的一行再筛，与整组重算的结果一致）
 */
async function groupRowsSql(con: DuckDBConnection, plan: MergeMappingParam, group: MergeGroupParam, rows: string, now: Date, scope?: GroupScope) {
  const { key, rule } = group;
  const nullKey = anyNull(key);
  const parts: string[] = [];
  const data = new Set<string>();
  // 数据源列 → 它旁边的 customer 引用列
  const refOf = new Map<string, string>();
  for (const [rank, m] of group.members.entries()) {
    const own = m.mapping === plan.mapping;
    if (!own && !await tableExists(con, RECORDS, recordsName(m.mapping))) continue;
    const columns = (await columnsOf(con, own ? rows : recordsOf(m.mapping))).map(c => c.column_name).filter(c => !['_src', '_n', '_batch'].includes(c));
    columns.filter(c => !key.includes(c)).forEach(c => data.add(c));
    m.refs.forEach(r => refOf.set(customerSourceColumn(r.column), r.column));
    const order = [...(m.latest ? [`${ident(m.latest)} DESC NULLS LAST`] : []), '_batch DESC', '_src'].join(', ');
    parts.push(`SELECT *, ${rank} AS _rank, row_number() OVER (PARTITION BY ${keyList(key)}, CASE WHEN ${nullKey} THEN _src END ORDER BY ${order}) AS _within,
      ${lit(m.mapping)} AS _mapping, ${lit(m.sourceId)} AS _source, ${m.version} AS _version, ${m.keySpace ? lit(m.keySpace) : 'NULL'} AS _key_space${m.refs.map(r => `,
      ${lit(r.source)} AS ${ident(customerSourceColumn(r.column))}`).join('')}
      FROM (SELECT r.* EXCLUDE (_n)${key.filter(k => !columns.includes(k)).map(k => `, NULL AS ${ident(k)}`).join('')} FROM ${recordsOf(m.mapping)} r
        QUALIFY row_number() OVER (PARTITION BY ${keyList(m.key)} ORDER BY ${order}) = 1) deduped${scope ? `
      WHERE EXISTS (SELECT 1 FROM ${scope.groupKeysTable} g WHERE ${joinOn(key, 'g', 'deduped')})${own ? `
        OR ((${anyNull(key, 'deduped')}) AND EXISTS (SELECT 1 FROM ${scope.ownKeysTable} k WHERE ${joinOn(plan.key, 'k', 'deduped')}))` : ''}` : ''}`);
  }
  const candidates = `(${parts.join(' UNION ALL BY NAME ')}) c`;
  const groupKey = `${keyList(key)}, CASE WHEN ${nullKey} THEN _mapping || ':' || _src::VARCHAR END`;
  const mergedAt = `TIMESTAMPTZ ${lit(now.toISOString())} AS _merged_at`;
  if (rule.kind !== 'coalesce') {
    const order = [...(rule.kind === 'latest' && data.has(rule.field) ? [`${ident(rule.field)} DESC NULLS LAST`] : []), '_rank', '_within'].join(', ');
    return { candidates, data: [...data], select: `SELECT * EXCLUDE (_src, _batch, _rank, _within), ${mergedAt} FROM ${candidates}
      QUALIFY row_number() OVER (PARTITION BY ${groupKey} ORDER BY ${order}) = 1` };
  }
  const first = (column: string, when?: string) => `first(${ident(column)} ORDER BY _rank, _within)${when ? ` FILTER (WHERE ${ident(when)} IS NOT NULL)` : ''} AS ${ident(column)}`;
  const columns = [
    ...[...data].map(c => first(c, c)),
    ...Object.keys(SILVER_SYSTEM_COLUMNS).filter(c => c !== '_merged_at').map(c => first(c)),
    ...[...refOf].map(([source, ref]) => first(source, ref)),
  ];
  return { candidates, data: [...data], select: `SELECT ${keyList(key)}, ${columns.join(', ')}, ${mergedAt} FROM ${candidates} GROUP BY ${groupKey}` };
}

/** 合并组每个不一致的字段最多带几个样本主键 */
const GROUP_SAMPLES = 5;

/**
 * 合并组的重叠与不一致（GroupStat）：候选行 candidates 里每个组员每个主键取并组时排第一的一行（_within = 1），主键有空值的不算；
 * 一个主键有至少 2 个组员时算重叠，某个字段在这些行里有至少两种非空取值时算不一致。样本按主键排序取前 GROUP_SAMPLES 个。
 * 第 i 个字段的别名：_d 是一个主键下的非空取值种数，_n 是不一致的主键数，_s 是样本主键
 */
async function groupStats(con: DuckDBConnection, { key, candidates, data }: { key: string[]; candidates: string; data: string[] }, sensitive: Set<string>) {
  const withSamples = !key.some(k => sensitive.has(k));
  const [stat] = await rows<Record<string, string | string[] | null>>(con, `
    SELECT count(*) AS overlap${data.map((c, i) => `, count(*) FILTER (WHERE _d${i} >= 2) AS _n${i}${withSamples && !sensitive.has(c) ? `,
      list(_k ORDER BY _k) FILTER (WHERE _d${i} >= 2)[1:${GROUP_SAMPLES}] AS _s${i}` : ''}`).join('')}
    FROM (
      SELECT concat_ws(', ', ${key.map(k => `${ident(k)}::VARCHAR`).join(', ')}) AS _k, count(*) AS _members${data.map((c, i) => `, count(DISTINCT ${ident(c)}) AS _d${i}`).join('')}
      FROM ${candidates} WHERE _within = 1 AND NOT (${anyNull(key)}) GROUP BY ${keyList(key)})
    WHERE _members >= 2`);
  return {
    overlap: Number(stat.overlap),
    conflicts: data.map((field, i) => ({ field, count: Number(stat[`_n${i}`]), samples: (stat[`_s${i}`] as string[] | undefined) ?? [] })).filter(c => c.count > 0),
  };
}

/**
 * 从 live 里删掉不满足 where 的记录，返回删掉的源表行数（没有主键的表一条记录可代表多行）。
 * 报错里抹掉敏感字段与 where 引用的源端取值（where 可能引用没映射的敏感列）
 */
async function filterLive(con: DuckDBConnection, plan: MergeMappingParam, live: string) {
  const failing = `(${compileExpression(parseExpression(plan.where!), live)}) IS NOT TRUE`;
  const pii = sensitiveColumns(plan);
  const scrubbed = [...plan.columns.filter(c => pii.has(c.name)), { expr: plan.where! }];
  const clean = async (e: Error) => { throw new Error(await withoutPii(con, scrubbed, e.message, live)); };
  const [{ n }] = await rows<{ n: string }>(con, `SELECT coalesce(sum(_n), 0) AS n FROM ${live} WHERE ${failing}`).catch(clean);
  await con.run(`DELETE FROM ${live} WHERE ${failing}`).catch(clean);
  return Number(n);
}

/**
 * 本映射这次要写入的主键（winners）不能和别的映射在标准层的行重复（ADR-0024「独占」）；grouped 是同一合并组的映射，不比较（ADR-0032）；
 * source 给出时只和同一个数据源的映射比较。主键为空的行不算重复。
 * 只拿本次写入的键去连接其他映射的行，不对整个实体表分组，耗时随本映射的行数增长；增量时后写进来的冲突键在别的映射合并时已经查过。
 * 要在本事务改 silver 之前调用：改过之后 DuckLake 的基数估计不准，哈希表会建在 silver 一侧，小映射要全表扫大共享表（见 crmlab-10m-baseline.md #164）。
 * 先到先得，重复时报错让本映射的事务回滚；报错列出最多 5 个冲突的键与所在的映射
 */
async function assertUniqueAcrossMappings(
  con: DuckDBConnection, silver: string, mapping: string, key: string[], winners: string, { source, grouped = [] }: { source?: string; grouped?: string[] },
) {
  const conflicts = await rows<{ k: string; mappings: string[]; total: string }>(con, `
    SELECT concat_ws(', ', ${key.map(k => `w.${ident(k)}::VARCHAR`).join(', ')}) AS k,
      list_sort(list_distinct(list(o._mapping)) || [${lit(mapping)}]) AS mappings, count(*) OVER () AS total
    FROM (SELECT DISTINCT ${keyList(key)} FROM ${winners}) w
    JOIN (SELECT ${keyList(key)}, _mapping FROM ${silver} WHERE _mapping NOT IN (${[...new Set([mapping, ...grouped])].map(lit).join(', ')})${source ? ` AND _source = ${lit(source)}` : ''}) o ON ${joinOn(key, 'w', 'o')}
    GROUP BY ${keyList(key, 'w')} ORDER BY k LIMIT 5`);
  if (!conflicts.length) return;
  const total = Number(conflicts[0].total);
  throw new Error(`主键 ${key.join('、')} 跨映射重复：${conflicts.map(c => `${c.k}（映射 ${c.mappings.join('、')}）`).join('；')}${total > conflicts.length ? `等，共 ${total} 个` : ''}，`
    + '请在映射里用字段表达式对齐（如加前缀）或去掉一边的映射');
}

/**
 * 统计每条关系的孤儿：起点有值、在终点主键里找不到的行（ADR-0019，左连接）。键空间两端一致，直接比较（ADR-0024）；
 * 终点是 customer 时只在起点的数据源列（customerSourceColumn，跨源引用时是目标数据源）指向的数据源内找（customer 不做跨映射唯一）。一条关系出错只记在它自己身上（只留报错摘要，不带取值）
 */
export async function relationStats(con: DuckDBConnection, relations: RelationParam[], redact: (message: string) => string): Promise<RelationStat[]> {
  const present = async ({ entity, field }: EntityRelation['from']) => await tableExists(con, SILVER, entity) && await columnExists(con, entity, field);
  const stats: RelationStat[] = [];
  for (const { from, ref, sensitive } of relations) {
    try {
      if (!await present(from) || !await present(ref)) {
        stats.push({ from, ref, status: 'unmerged' });
        continue;
      }
      const bySource = ref.entity === 'customer';
      // 起点的数据源列（ADR-0030）：老湖里还没有这一列时退回行自己的 _source
      const fromSource = bySource && await columnExists(con, from.entity, customerSourceColumn(from.field)) ? customerSourceColumn(from.field) : '_source';
      const fromValue = `f.${ident(from.field)}`;
      // f：起点表；t：终点去重后的主键 k
      const joined = `${silverTable(from.entity)} f LEFT JOIN (SELECT DISTINCT ${ident(ref.field)} AS k${bySource ? ', _source' : ''} FROM ${silverTable(ref.entity)}) t
        ON ${fromValue} = t.k${bySource ? ` AND f.${ident(fromSource)} = t._source` : ''}`;
      const [counts] = await rows<{ with_value: string; orphans: string }>(con, `
        SELECT count(*) FILTER (WHERE ${fromValue} IS NOT NULL) AS with_value, count(*) FILTER (WHERE ${fromValue} IS NOT NULL AND t.k IS NULL) AS orphans FROM ${joined}`);
      const orphans = Number(counts.orphans);
      const samples = sensitive || !orphans ? [] : (await rows<{ v: string }>(con, `
        SELECT DISTINCT ${fromValue}::VARCHAR AS v FROM ${joined} WHERE ${fromValue} IS NOT NULL AND t.k IS NULL ORDER BY v LIMIT 5`)).map(r => r.v);
      stats.push({ from, ref, withValue: Number(counts.with_value), orphans, samples });
    } catch (e) {
      // 只留第一个冒号之前的摘要：DuckDB 的报错可能带上取值，统计结果给只读成员看
      stats.push({ from, ref, error: redact((e as Error).message).split(/[:：]/)[0] });
    }
  }
  return stats;
}

/**
 * 这次合并是否改到了身份打通读的表：customer、event 或 consent 的映射有插入、更新、删除或重建过，或撤下了这些实体的停用映射。
 * 跳过与出错的映射不算（出错的已回滚）
 */
const changedIdentityInputs = (records: MergeRecord[], drop: MergeDrop[]) => drop.some(d => IDENTITY_INPUTS.includes(d.entity)) || records.some(r =>
  IDENTITY_INPUTS.includes(r.entity) && 'mode' in r && (r.mode === 'rebuild' || r.inserted + r.updated + r.deleted > 0));

/**
 * 撤下停用的映射（ADR-0031）：一个事务里删掉它写进标准层的行（表不在时没有可删的）、它的当前记录与合并日志里的水位，返回删掉的行数
 */
async function dropMapping(con: DuckDBConnection, { mapping, entity }: MergeDrop): Promise<DroppedMapping> {
  return inTransaction(con, async () => {
    let deleted = 0;
    if (await tableExists(con, SILVER, entity)) {
      const rowsOfMapping = `${silverTable(entity)} WHERE _mapping = ${lit(mapping)}`;
      deleted = await count(con, rowsOfMapping);
      await con.run(`DELETE FROM ${rowsOfMapping}`);
    }
    await con.run(`DROP TABLE IF EXISTS ${recordsOf(mapping)}`);
    await con.run(`DELETE FROM ${MERGES} WHERE mapping_id = ${lit(mapping)}`);
    console.log(`${new Date().toISOString()} [合并] 撤下停用的映射 ${mapping}（${entity}）：删掉 ${deleted} 行`);
    return { mapping, entity, deleted };
  });
}

/** 提交冲突（不同实体的事务同时提交，DuckLake 报错含 conflict，ADR-0015）时回滚后整个映射再试的次数 */
const CONFLICT_RETRIES = 2;

/** 合并一个映射，出错只记在它自己的合并记录上；提交冲突时重试。每次尝试之后删掉本队列的中间表（后缀是队列序号） */
async function mergeOne(
  con: DuckDBConnection, plan: MergeMappingParam, salt: string, now: Date, stage: StageTables, redact: (message: string) => string, taskId: string,
): Promise<MergeRecord> {
  const startedAt = new Date();
  for (let attempt = 0; ; attempt++) {
    try {
      return await mergeMapping(con, plan, salt, now, stage, taskId);
    } catch (e) {
      const message = redact((e as Error).message);
      if (attempt < CONFLICT_RETRIES && /conflict/i.test(message)) {
        console.log(`${new Date().toISOString()} [合并] ${plan.table} → ${plan.entity}（${plan.mapping}）提交冲突，重试：${message}`);
        continue;
      }
      return {
        mapping: plan.mapping, entity: plan.entity, table: plan.table, version: plan.version,
        startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: message,
      };
    } finally {
      // 删不掉也不影响下一个映射（中间表都是 CREATE OR REPLACE），不让它中断本队列
      await con.run(Object.values(stage).map(t => `DROP TABLE IF EXISTS ${t};`).join(' ')).catch(() => undefined);
    }
  }
}

/**
 * 按已发布的映射合并到标准层，每个映射各自一个事务：一个映射失败（表达式在数据上出错、值字典缺取值、去重键为空）
 * 只影响它自己，其他映射照常合并。不同实体的映射并行合并，同一实体的串行（ADR-0015）。之后本租户有 silver.customer、且这次改到了 customer、event 或 consent 时整表重算身份打通
 * （一次合并只带受影响的映射，增量会漏）；打通结果表不在或 forceIdentities（入队时发现匹配规则变了或上次打通失败）时同样重算，
 * 否则沿用上次的结果，identities 记成跳过。失败同样只记在 identities 里。rules 是租户全部 customer 映射汇总出的匹配规则（入队合并时算好，不只是这次带的映射）；
 * 打通之前统计 relations（租户全部已发布关系，同样入队时算好）的孤儿，记在 relations 里（耗时记在 relationsMs），出错不算合并失败；salt 是租户的敏感信息盐；redact 用来抹掉错误信息里的凭据与盐；
 * priority 是属性取舍的名次（映射 ID → 名次，同样入队时由全部 customer 映射汇总，ADR-0027）。
 * drop 是要撤下的停用映射（ADR-0031）：各实体的映射开始合并之前先逐个撤下（不论这次有没有带该实体的映射），记在 dropped 里；
 * 撤下了 customer、event 或 consent 的映射时同样重算身份打通。taskId 是合并任务，自定义断言的运行记录记在它名下
 */
export async function mergeToSilver(
  session: TenantLakeSession, plans: MergeMappingParam[], salt: string, redact: (message: string) => string, rules: readonly string[] = DEFAULT_RULES,
  relations: RelationParam[] = [], forceIdentities = false, sensitive: readonly string[] = [], priority: Record<string, number> = {},
  drop: MergeDrop[] = [], taskId: string,
): Promise<{
  mappings: MergeRecord[]; dropped?: DroppedMapping[]; relations?: RelationStat[]; relationsMs?: number; identities?: IdentityRecord;
}> {
  const { con } = session;
  const now = new Date();
  // 老湖补 _customer_source 并回填（lake:ensure 之前的数据湖），之后各映射与身份打通都按它解析
  await ensureCustomerSourceColumns(con);
  // 并行合并之前串行撤下，不与各实体的事务冲突
  const dropped: DroppedMapping[] = [];
  for (const d of drop) dropped.push(await dropMapping(con, d));
  // 每个实体一条队列，组内按 plans 的顺序串行（同一实体的映射有跨映射唯一检查，ADR-0024），组间各用一个连接并发；结果按 plans 的顺序回填
  const queues = new Map<string, number[]>();
  plans.forEach((plan, i) => queues.set(plan.entity, [...(queues.get(plan.entity) ?? []), i]));
  const records: MergeRecord[] = new Array(plans.length);
  const settled = await Promise.allSettled([...queues.values()].map(async (indexes, q) => {
    const queueCon = await session.connect();
    try {
      for (const i of indexes) records[i] = await mergeOne(queueCon, plans[i], salt, now, stageTables(String(q)), redact, taskId);
    } finally {
      queueCon.closeSync();
    }
  }));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  const relationsFrom = Date.now();
  const orphans = relations.length > 0 ? await relationStats(con, relations, redact) : undefined;
  const merged = { mappings: records, ...(dropped.length > 0 && { dropped }), ...(orphans && { relations: orphans, relationsMs: Date.now() - relationsFrom }) };
  if (!await tableExists(con, SILVER, 'customer')) return merged;
  const resultsExist = async () => {
    for (const t of [IDENTITIES, DEVICE_OWNER, CONSUMER, CONSUMER_CONSENT, CONSUMER_IDS]) if (!await tableExists(con, SILVER, t.split('.')[1])) return false;
    return true;
  };
  if (!forceIdentities && !changedIdentityInputs(records, drop) && await resultsExist()) {
    return { ...merged, identities: { durationMs: 0, skipped: '本次合并没有改到 customer、event 与 consent，沿用上次的身份打通结果' } };
  }
  const startedAt = Date.now();
  try {
    const summary = await resolveIdentities(con, rules, {
      sensitive: [...new Set([...sensitive, ...consumerSensitive(plans)])],
      priority,
    });
    return { ...merged, identities: { ...summary, durationMs: Date.now() - startedAt } };
  } catch (e) {
    return { ...merged, identities: { durationMs: Date.now() - startedAt, error: redact((e as Error).message) } };
  }
}

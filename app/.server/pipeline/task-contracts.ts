// app/.server/pipeline/task-contracts.ts —— 任务契约（ADR-0052）：每个任务的 kind、label、参数 schema、结果类型、挂载标志与领取时要准备的凭据（needs）。
// 工作进程的 HANDLERS 按契约实现 run；入队侧的参数校验也按契约来（下一张子票）。参数校验发生在工作进程的 run 里，
// 不合法时报一句话。本文件不连平台库、不建 DuckDB：只运行时依赖 zod 与纯模块（templates、sources），
// engine 一律 import type（ADR-0008），所以入队侧也能安全地引它
import { z } from 'zod';
import { MERGE_RULE_KINDS, type MergeRule } from '../../lib/merge-groups';
import { LAKE_COVERAGE, type NotInLakeReason } from '../../lib/sources';
import { TASK_KINDS, TEMPLATES, templateAt, type TemplateId } from './templates';
import type { AssertionResult } from './assertions';
import type { profileSource } from './source-engine';
import type { syncSourceTables } from './sync-engine';
import type { verifySourceLake } from './verify-engine';
import type { InspectResult } from './inspect-engine';
import type { KeyCheckResult } from './key-check-engine';
import type { mergeToSilver, SourceViewParam } from './merge-engine';
import type { MergePlan, PlanColumn, PublishedPlan } from './mapping-spec';
import type { buildServingStore } from './serving-engine';
import type { KeyCheckTaskResult } from '../source-key-check';

z.config(z.locales.zhCN());

/**
 * attachSource：数据源与数据湖挂同一个 DuckDB 里（在两者之间搬数据或对照的任务）；
 * readOnlyLake：数据湖只读挂载（只出报告、不写湖的任务）；servingFile：另挂一个本机库 serving（生成服务库，ADR-0033）。
 * needs 是领取时（tasks.ts 的 claimNextTask）要准备什么：源连接、piiSalt、servingKey。契约只声明，自己去读平台库的
 * 是 tasks.ts（ADR-0008），工作进程与入队侧 import 本文件不会带进平台模块
 */
export interface TaskContract<P, R> {
  /** 任务页显示的名称 */
  label: string;
  params: { parse(raw: unknown): P };
  /** 只带出结果类型（ResultOf 从这里取），运行时是空对象，不做运行时校验 */
  result: ResultType<R>;
  attachSource?: boolean;
  readOnlyLake?: boolean;
  servingFile?: boolean;
  /** 领取任务时要由 tasks.ts 准备的凭据：源连接（照参数 sourceId 解密）、敏感信息盐、服务库密钥 */
  needs?: TaskNeeds;
}

/** 契约声明的领取时凭据：字段为 true 才准备，没声明的什么都不读 */
export interface TaskNeeds { source?: true; piiSalt?: true; servingKey?: true }

/** ResultType 的载体，见 TaskContract.result */
export interface ResultType<R> { readonly __result?: R }
const resultType = <R>(): ResultType<R> => ({});

/** 同一句话写死的报错参数：原手写校验对一种参数只报一句话，不区分哪一项不合法，这里保持一致 */
const error = (message: string) => ({ error: message });

/**
 * 契约的参数 schema：zod 校验，不合法时抛第一条文案；通过后按 T（工作进程要用的参数类型）返回。
 * 深层形状（如合并计划里各列的表达式）发布时已校验过，这里与原手写校验一样只核对形状，T 里更深的类型由发布侧保证。
 * I 是入参类型（insertTask / enqueueTask 的参数，InputOf 从这里取）：schema 里带 .default 的项在入参上可省略，
 * 只是个类型载体，运行时不变
 */
const params = <T, I = T>(schema: z.ZodType): { parse(raw: unknown): T; readonly __input?: I } => ({
  parse(raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '参数不合法');
    return parsed.data as T;
  },
});

/**
 * 同 params，但参数类型不用手写，直接从 schema 推出（参数 schema 是具名常量时用，如 source.sync 的 syncParams）：
 * parse 的返回与 __input（入参类型，InputOf 从这里取）分别是 z.output / z.input。z.looseObject 推出的类型带索引签名，
 * Known 把顶层的索引签名去掉，只留具名字段——Omit 这类按键操作对索引签名会把具名字段全丢掉，且不报错
 */
const schemaParams = <S extends z.ZodType>(schema: S): { parse(raw: unknown): Known<z.output<S>>; readonly __input?: Known<z.input<S>> } => ({
  parse(raw: unknown): Known<z.output<S>> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '参数不合法');
    return parsed.data as Known<z.output<S>>;
  },
});

/** 去掉顶层的字符串与数字索引签名（运行时照旧 .loose() 放行多余键，这只是类型层面的收窄） */
type Known<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

/** 非空字符串列表（原 isStrings）：任何形状不对都报同一句话 */
const strings = (message: string) => z.array(z.string(error(message)), error(message)).min(1, error(message));
/** 字符串列表，可以为空（原 consumerSensitive 的检查） */
const stringList = (message: string) => z.array(z.string(error(message)), error(message));
/** 1 到 max 之间的整数（原 positiveInt） */
const intInRange = (key: string, max: number) => {
  const message = `参数 ${key} 必须是 1 到 ${max} 之间的整数`;
  return z.number(error(message)).int(error(message)).min(1, error(message)).max(max, error(message));
};
/** 全是字符串字段的对象（如要撤下的停用映射），整个对象不合法时报同一句话。keys 的字面量定出字段名：
 * 推出的类型是具名字段而不是 Record<string, string>，对得上 EntityRelation 这类手写形状 */
const stringFields = <K extends string>(keys: readonly K[], message: string) =>
  z.object(Object.fromEntries(keys.map(k => [k, z.string(error(message))])) as Record<K, z.ZodString>, error(message)).loose();

/** 没有参数的任务（入队时是空对象）：只要求是个对象，别的什么都不查 */
const noParams = params<Record<string, unknown>>(z.record(z.string(), z.unknown()));

/** 结果层快照表名 gold.<种类>__<任务 ID> */
export const SNAPSHOT_TABLE = /^gold\.([a-z][a-z0-9]*)__[0-9a-f-]{36}$/;

/** 人群导出文件在存储前缀下的目录（ADR-0040），不是 DuckLake 登记的文件 */
export const EXPORT_DIR = '_exports/';
export const EXPORT_FORMATS = ['parquet', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 平台判断的未进湖原因：账号读不了、源端已删除由工作进程实时判断，不在参数里 */
const NOT_IN_LAKE_REASONS = Object.keys(LAKE_COVERAGE).filter(c => !['in_lake', 'unreadable', 'gone'].includes(c)) as NotInLakeReason[];

/** 水位线字段的种类 */
const WATERMARKS = ['updated_at', 'increment'] as const;

const SURVIVORSHIP = '参数 survivorship 必须是映射 ID 到正整数名次的对照';

/** 同步 / 核对一张表的公共字段（key 两边形状不同，各自带）：表名、已确认的水位线字段及其种类、软删除字段 */
const tableFields = (message: string) => ({
  name: z.string(error(message)),
  column: z.string(error(message)).optional(),
  kind: z.enum(WATERMARKS, error(message)).optional(),
  softDelete: z.string(error(message)).optional(),
});

/** 可空字符串（如取最新字段 latest）：null 表示没有 */
const nullableString = (message: string) => z.union([z.string(error(message)), z.null(error(message))], error(message));

/** 合并参数里的映射（原 mergeMappings + isMergeGroup）：已发布的版本及其合并计划，发布时已校验过，这里只核对形状 */
const MAPPINGS = '参数 mappings 必须是非空的已发布映射列表';
/**
 * 合并组的存活规则（ADR-0032）：latest 另带取最新的字段。末尾把类型交叉成 MergeRule（联合类型），
 * 校验与报错仍是上面的 object + refine（文案不变），不用 discriminatedUnion（会换报错路径和文案）
 */
const mergeRule = z.object({ kind: z.enum(MERGE_RULE_KINDS, error(MAPPINGS)), field: z.unknown().optional() }, error(MAPPINGS))
  .refine(r => r.kind !== 'latest' || typeof r.field === 'string', error(MAPPINGS))
  .loose()
  .transform(r => r as typeof r & MergeRule);
/**
 * 合并组的一个组员（ADR-0032）：从它的当前记录按去重键与取最新字段取每个键最新的一行，refs 是引用列旁的数据源列；
 * sensitive 是它的敏感列（统计不一致时只计数，#200 之前入队的合并没有这一项）
 */
const groupMember = z.object({
  mapping: z.string(error(MAPPINGS)),
  sourceId: z.string(error(MAPPINGS)),
  version: z.number(error(MAPPINGS)).int(error(MAPPINGS)),
  key: strings(MAPPINGS),
  latest: nullableString(MAPPINGS),
  keySpace: z.string(error(MAPPINGS)).optional(),
  refs: z.array(stringFields(['column', 'source'], MAPPINGS), error(MAPPINGS)),
  sensitive: stringList(MAPPINGS).optional(),
}, error(MAPPINGS)).loose();
/** 合并组的一个组员的参数类型：由 groupMember schema 推出（Known 去掉 .loose() 的索引签名），merge-engine 转出 */
export type GroupMemberParam = Known<z.infer<typeof groupMember>>;
/** 合并组（ADR-0032）：组 ID、存活规则、实体主键 key（组内按它比较，不是各映射的去重键）与可用的组员（按优先级排，入队时取定） */
const mergeGroup = z.object({
  id: z.string(error(MAPPINGS)),
  rule: mergeRule,
  key: strings(MAPPINGS),
  members: z.array(groupMember, error(MAPPINGS)).min(1, error(MAPPINGS)),
}, error(MAPPINGS)).loose();
/** 合并组的参数类型：由 mergeGroup schema 推出（Known 去掉顶层的索引签名），merge-engine 转出 */
export type MergeGroupParam = Known<z.infer<typeof mergeGroup>>;
/**
 * 合并任务里的一个已发布映射：合并计划（transform 交叉成 PublishedPlan，深层形状发布时已校验过，这里与原手写校验一样只核对形状，
 * 不把 PublishedPlan 的字段逐个抄进 schema——那是第二份定义）加上映射、版本与数据源；输入是源视图时另带视图最新的已发布版本
 * （版本号、SQL 与引用的原始层表，入队时取定）。rebuild 为真时强制由全部批次重建（数据地图上的重建合并，补上标准层缺的列）。
 * uniqueKey 是实体（customer 除外）的主键：合并后它在整个实体内跨映射唯一（ADR-0024「独占」），不是映射的去重键；
 * uniqueBySource 为真时（主键含指向 customer 的字段）只在同一个数据源内唯一。
 * group 是映射所在的已发布合并组（可用组员至少 2 个时才带）：写标准层时按组的存活规则把组内同一主键并成一行
 */
const mergeMapping = z.object({
  mapping: z.string(error(MAPPINGS)),
  version: z.number(error(MAPPINGS)).int(error(MAPPINGS)),
  sourceId: z.string(error(MAPPINGS)),
  sourceView: z.custom<SourceViewParam>().optional(),
  entity: z.string(error(MAPPINGS)),
  table: z.string(error(MAPPINGS)),
  // 深层形状发布时已校验过：元素用 z.custom 只定型（对值不设限，与原 z.unknown 等价），避免 transform 交叉后元素成了 unknown
  columns: z.array(z.custom<PlanColumn>(), error(MAPPINGS)).min(1, error(MAPPINGS)),
  entityColumns: z.array(z.custom<MergePlan['entityColumns'][number]>(), error(MAPPINGS)),
  key: strings(MAPPINGS),
  latest: nullableString(MAPPINGS),
  rebuild: z.boolean(error(MAPPINGS)).optional(),
  uniqueKey: strings(MAPPINGS).optional(),
  uniqueBySource: z.boolean(error(MAPPINGS)).optional(),
  group: mergeGroup.optional(),
}, error(MAPPINGS)).loose()
  .transform(m => m as typeof m & PublishedPlan);
/** 合并任务里一个已发布映射的参数类型：由 mergeMapping schema 推出（Known 去掉 .loose() 的索引签名），merge-engine 转出 */
export type MergeMappingParam = Known<z.infer<typeof mergeMapping>>;

/** 合并任务里要撤下的停用映射（ADR-0031）：合并前删掉它写进标准层实体 entity 的行、它的当前记录与合并日志里的水位（之后万一再合并它就走重建） */
const mergeDrop = stringFields(['mapping', 'entity'], '参数 drop 必须是 { mapping, entity } 列表');
/** 要撤下的停用映射的参数类型：由 mergeDrop schema 推出（Known 去掉 .loose() 的索引签名），merge-engine 转出 */
export type MergeDrop = Known<z.infer<typeof mergeDrop>>;

/** 关系列表的报错文案（from、ref 与 sensitive 同一句话） */
const RELATIONS = '参数 relations 必须是关系列表（from、ref 与 sensitive）';
/** 合并任务里的一条已发布关系（内置 ref 与已发布登记上的关系）；sensitive：起点是敏感字段，标准层里是哈希，入队时算好 */
const relation = z.looseObject({
  from: stringFields(['entity', 'field'], RELATIONS),
  ref: stringFields(['entity', 'field'], RELATIONS),
  sensitive: z.boolean(error(RELATIONS)),
}, error(RELATIONS));
/** 要统计孤儿的关系的参数类型：由 relation schema 推出（Known 去掉顶层的索引签名），merge-engine 转出 */
export type RelationParam = Known<z.infer<typeof relation>>;

/**
 * silver.merge 的参数 schema（参数与入参类型都从这里推出，带缺省值的项入参可省略）：早先入队的合并没有 identity 之后的项，按缺省处理。
 * 带了要撤下的停用映射时 mappings 可以为空（停用的是实体最后一个映射）
 */
const mergeParams = z.looseObject({
  drop: z.array(mergeDrop, error('参数 drop 必须是 { mapping, entity } 列表')).default([]),
  mappings: z.array(mergeMapping, error(MAPPINGS)),
  /** 身份打通的匹配规则（入队时由全部 customer 映射汇总） */
  identity: strings('参数 identity 必须是非空的字段名列表').optional(),
  relations: z.array(relation, error(RELATIONS)).default([]),
  identityForce: z.boolean(error('参数 identityForce 必须是布尔值')).default(false),
  /** 不进 _consumer 的敏感字段 */
  consumerSensitive: stringList('参数 consumerSensitive 必须是字段名列表').default([]),
  /** 属性取舍的名次：映射 ID → 正整数名次 */
  survivorship: z.record(z.string(error(SURVIVORSHIP)), z.number(error(SURVIVORSHIP)).int(error(SURVIVORSHIP)).min(1, error(SURVIVORSHIP)), error(SURVIVORSHIP)).default({}),
  /** 不参与身份匹配的值（规范化后的加盐哈希，只收 64 位十六进制，挡住误传的明文） */
  identityExclude: z.array(z.string(error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')).regex(/^[0-9a-f]{64}$/, error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')), error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')).default([]),
}).refine(p => p.mappings.length > 0 || p.drop.length > 0, { error: MAPPINGS, path: ['mappings'] });
/** silver.merge 的参数类型：由 mergeParams schema 推出（Known 去掉 .loose() 的索引签名） */
export type MergeParams = Known<z.infer<typeof mergeParams>>;

/** 漂移检查参数里的应有结构：表名 → 列名 → 类型（入队时由已发布映射算出） */
const EXPECTED = '参数 expected 必须是 表名 → 列名 → 类型 的对象';
/** 漂移检查的参数 schema：应有结构在入队时由平台算好放进参数（工作进程不连平台库），参数类型（z.infer）从这里导出 */
const inspectParams = z.object({
  expected: z.record(z.string(error(EXPECTED)), z.record(z.string(error(EXPECTED)), z.string(error(EXPECTED)), error(EXPECTED)), error(EXPECTED)),
});

/**
 * 主键冲突体检参数里的实体（入队时由已发布映射算出）：主键、是否按数据源比较、各映射（各带映射出来的列名）与所在的合并组。
 * bySource 为真时（主键含指向 customer 的字段）只在该字段指向的同一个数据源（数据源列 _customer_source / _<字段>_source）内比较主键；
 * 同一合并组的映射对不报（ADR-0032）
 */
const KEYCHECK = '参数 entities 必须是 { entity, key, bySource, mappings: { mapping, columns, group? }[] } 列表';
const keyCheckEntity = z.object({
  entity: z.string(error(KEYCHECK)),
  key: strings(KEYCHECK),
  bySource: z.boolean(error(KEYCHECK)),
  mappings: z.array(z.object({
    mapping: z.string(error(KEYCHECK)),
    columns: strings(KEYCHECK),
    group: z.string(error(KEYCHECK)).optional(),
  }, error(KEYCHECK)).loose(), error(KEYCHECK)),
}, error(KEYCHECK)).loose();
/** 主键冲突体检的参数 schema：KeyCheckEntity / KeyCheckParams 的类型（z.infer）从这里导出 */
const silverKeyCheckParams = z.object({ entities: z.array(keyCheckEntity, error(KEYCHECK)) });

/** 快照列表的报错文案：table 是结果层快照表名 */
const SNAPSHOTS = '参数 snapshots 必须是 { id, template, table } 列表，table 是结果层快照表名';
/** 一个要放进服务库的快照：快照 ID、模板（rfm、metric:<键>、tag:<键>）与结果层表名；其余字段（定义版本等）由调用方记在指针上 */
const servingSnapshot = z.looseObject({
  id: z.string(error(SNAPSHOTS)),
  template: z.string(error(SNAPSHOTS)),
  table: z.string(error(SNAPSHOTS)).regex(SNAPSHOT_TABLE, error(SNAPSHOTS)),
}, error(SNAPSHOTS));
/** 生成服务库的参数：版本、上传位置（与 session.lake.dataPath 的比对留在 run 里，schema 只查形状）与要放进去的快照 */
const servingParams = z.looseObject({
  version: z.number(error('参数 version 必须是正整数')).int(error('参数 version 必须是正整数')).min(1, error('参数 version 必须是正整数')),
  target: z.string(error('参数 target 必须是本租户存储前缀下这一版服务库的位置')),
  snapshots: z.array(servingSnapshot, error(SNAPSHOTS)),
});

/** 人群导出的参数：格式与条件（入队时由平台库查出快照表） */
const CONDITIONS = '参数 conditions 必须是非空的 { tag, value, table } 列表，table 是标签快照表名';
const FORMAT = `参数 format 只能是 ${EXPORT_FORMATS.join(' / ')}`;

/** 人群导出的一个条件：标签、取值与入队时定下的快照表（结果层里不带 schema 的表名） */
const exportCondition = z.looseObject({
  tag: z.string(error(CONDITIONS)),
  value: z.string(error(CONDITIONS)),
  table: z.string(error(CONDITIONS)).regex(/^tag__[0-9a-f-]{36}$/, error(CONDITIONS)),
}, error(CONDITIONS));
/** 人群导出条件的类型：由 exportCondition schema 推出（Known 去掉 .loose() 的索引签名，exports.ts 的 Omit 才不丢具名字段） */
export type ExportCondition = Known<z.output<typeof exportCondition>>;

/** 模板任务（ADR-0004）公共参数的报错文案：asOf 的这句与各模板 parseAsOf 的一字不差 */
const ASOF = '参数 asOf 必须是 YYYY-MM-DD 格式的日期';
const TV = '参数 templateVersion 必须是整数';

/**
 * 模板任务的公共参数：asOf 必填（日期格式由模板的 parse 校验），定义版本与来源可缺省（老任务不带，ADR-0021），
 * 模板版本缺省第 1 版；多余键（模板参数）原样放行，交给模板自己的 parse
 */
export const TEMPLATE_COMMON = z.looseObject({
  asOf: z.string(error(ASOF)),
  definitionVersion: z.number().int().optional(),
  trigger: z.string().optional(),
  templateVersion: z.number(error(TV)).int(error(TV)).default(1),
});

/** 模板任务的参数类型：公共部分 & 模板参数 P（P 已含 asOf） */
type TemplateParams<T extends TemplateId> = z.output<typeof TEMPLATE_COMMON> & ReturnType<(typeof TEMPLATES)[T]['parse']>;
/** 模板任务的入参类型：公共部分在编译期检查，模板部分入队时由契约 parse 检查（定义参数来自 jsonb，只能是 Record） */
type TemplateInput = { asOf: string; definitionVersion?: number; trigger?: string; templateVersion?: number } & Record<string, unknown>;

/**
 * 模板任务的参数契约（ADR-0004：加模板仍只改 TEMPLATES 与 TASK_KINDS 两处）：公共部分按 TEMPLATE_COMMON，
 * 模板部分按 templateAt(id, 版本).parse。公共三项先剥掉再传给模板（模板的 parse 拒绝不认识的键），
 * 注册表里没有这个版本时在这里抛错（入队时被 insertTask 包成 TaskError）
 */
const templateParams = <T extends TemplateId>(id: T): { parse(raw: unknown): TemplateParams<T>; readonly __input?: TemplateInput } => ({
  parse(raw: unknown): TemplateParams<T> {
    const common = TEMPLATE_COMMON.safeParse(raw);
    if (!common.success) throw new Error(common.error.issues[0]?.message ?? '参数不合法');
    const { definitionVersion, trigger, templateVersion, ...rest } = common.data;
    const p = templateAt(id, templateVersion).parse(rest) as ReturnType<(typeof TEMPLATES)[T]['parse']>;
    return { ...p, definitionVersion, trigger, templateVersion } as TemplateParams<T>;
  },
});

/**
 * 模板任务（ADR-0004）的契约：由注册表（TEMPLATES 与 TASK_KINDS）生成，label 沿用模板的 label；
 * 结果类型仍是普通对象，不做运行时校验（ADR-0052）
 */
const TEMPLATE_CONTRACTS = Object.fromEntries((Object.keys(TASK_KINDS) as TemplateId[]).map(id => [TASK_KINDS[id], {
  label: TEMPLATES[id].label, params: templateParams(id), result: resultType<Record<string, unknown>>(),
}])) as { [K in TemplateId as (typeof TASK_KINDS)[K]]: TaskContract<TemplateParams<K>, Record<string, unknown>> & { params: { readonly __input?: TemplateInput } } };

/** 同步 / 核对 / 业务主键校验的参数 schema：抽成具名常量，参数类型（z.infer）从这里导出，引擎不再手写（ADR-0052）；
 * 漂移检查、主键冲突体检与服务库的具名常量见上方 EXPECTED / KEYCHECK / SNAPSHOTS 三段 */
const SYNC_TABLES = '参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表';
/** 同步任务里的一张表（原 syncTables，sync-engine 的 SyncTableParam 从它推出）：成员确认的水位线字段及其种类
 * （没有时全量比对）、软删除字段；源表没有主键时可带成员声明的业务主键——旧任务里是单个字段，schema 里转成列表
 * （入参类型仍是 string | string[]）。key 的 .optional() 必须在 .transform() 外面：转列表是 pipe，pipe 里再包
 * optional 时 zod 不把 key 标成可选，推出的类型就成了必填的 string[] | undefined，与原来手写的 key?: string[] 不符。
 * 水位线字段与种类要么都有、要么都没有 */
const syncTable = z.object({
  ...tableFields(SYNC_TABLES),
  key: z.union([z.string(error(SYNC_TABLES)), strings(SYNC_TABLES)], error(SYNC_TABLES))
    .transform(k => (typeof k === 'string' ? [k] : k))
    .optional(),
}, error(SYNC_TABLES))
  .refine(t => (t.column === undefined) === (t.kind === undefined), error(SYNC_TABLES))
  .loose();
const syncParams = z.looseObject({
  sourceId: z.string(error('缺少参数 sourceId')),
  tables: z.array(syncTable, error(SYNC_TABLES)).min(1, error(SYNC_TABLES)),
  // 原 run 只认 true，别的取值照原样放行
  reconcile: z.unknown().optional(),
});

/** 业务主键校验的参数（原 source-key-check 的 KeyCheckTaskParams）：tableName 与 keyColumns 校验形状并定文案，
 * 其余四个只定型（不带检查函数的 z.custom 对值不设限，与原来的原样放行等价），调度器与 run 自己读。
 * 必须排在 keyColumns 之后：报错只取第一条，不带这几个字段的失败用例先轮到 tableName / keyColumns 的文案 */
const keyCheckParams = z.looseObject({
  tableName: z.string(error('缺少参数 tableName')),
  keyColumns: strings('参数 keyColumns 必须是非空的字段列表'),
  sourceId: z.custom<string>(),
  memberId: z.custom<string>(),
  email: z.custom<string>(),
  sensitive: z.custom<boolean>(),
});

const VERIFY_TABLES = '参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表';
/** 核对任务里平台给出的一张表（原 verify-engine 的 VerifyTableParam）：是否在同步范围内、不在湖里时平台判断的原因，
 * 以及同步用的设置（业务主键、软删除字段、已确认的水位线字段及其种类）。水位线字段与种类要么都有、要么都没有 */
const verifyTable = z.object({
  ...tableFields(VERIFY_TABLES),
  key: strings(VERIFY_TABLES).optional(),
  inScope: z.boolean(error(VERIFY_TABLES)),
  reason: z.enum(NOT_IN_LAKE_REASONS, error(VERIFY_TABLES)),
}, error(VERIFY_TABLES))
  .refine(t => (t.column === undefined) === (t.kind === undefined), error(VERIFY_TABLES))
  .loose();
const verifyParams = z.looseObject({
  sourceId: z.string(error('缺少参数 sourceId')),
  tables: z.array(verifyTable, error(VERIFY_TABLES)),
});

/** 同步任务里的一张表的参数类型：由 syncTable schema 推出（Known 去掉 .loose() 的索引签名），sync-engine 转出 */
export type SyncTableParam = Known<z.infer<typeof syncTable>>;
/** 业务主键校验的入队参数类型：由 keyCheckParams schema 推出，source-key-check.ts 转出 */
export type KeyCheckTaskParams = Known<z.infer<typeof keyCheckParams>>;
/** 核对任务里一张表的参数类型：由 verifyTable schema 推出（保留 inScope 与 reason），verify-engine 转出 */
export type VerifyTableParam = Known<z.infer<typeof verifyTable>>;
/** 漂移检查的参数类型：由 inspectParams schema 推出（z.object 不带索引签名，不用包 Known），inspect-engine 转出 */
export type InspectParams = z.infer<typeof inspectParams>;
/** 主键冲突体检里一个实体的参数类型：由 keyCheckEntity schema 推出（Known 去掉 .loose() 的索引签名；mappings 元素那层留着），key-check-engine 转出 */
export type KeyCheckEntity = Known<z.infer<typeof keyCheckEntity>>;
/** 主键冲突体检的参数类型：由 silverKeyCheckParams schema 推出，key-check-engine 转出 */
export type KeyCheckParams = z.infer<typeof silverKeyCheckParams>;
/** 要放进服务库的一个快照的参数类型：由 servingSnapshot schema 推出（Known 去掉 .loose() 的索引签名），serving-engine 转出 */
export type ServingSnapshot = Known<z.infer<typeof servingSnapshot>>;
/** 生成服务库的参数类型：由 servingParams schema 推出（Known 去掉 .loose() 的索引签名），serving-engine 转出 */
export type ServingParams = Known<z.infer<typeof servingParams>>;

/**
 * 全部任务的契约表。新增任务先在这里登记契约，再去 handlers.ts 实现 run。
 * 拿不准入队侧会不会带上多余字段时，schema 用 .loose()：zod 对象默认会剥掉未声明的字段
 */
export const CONTRACTS = {
  // 检索投影刷新（ADR-0047）：工作进程里没有平台库，什么也不做；成功后由调度器结束钩子从零重建投影
  'catalog.projection': { label: '刷新检索投影', readOnlyLake: true, params: noParams, result: resultType<Record<string, unknown>>() },
  // 检索向量补算（ADR-0047、0049）：同上，工作进程里没有平台库；成功后由调度器结束钩子补齐当前模型缺的向量
  'catalog.embed': { label: '补算检索向量', readOnlyLake: true, params: noParams, result: resultType<Record<string, unknown>>() },
  'lake.inventory': { label: '盘点数据湖', params: noParams, result: resultType<{ tables: { name: string; rows: number }[] }>() },
  // 造数夹具：与 src/01_seed.ts 相同，用 hash() 确定性生成消费者与订单，同样的参数每次得到同样的数据
  'demo.seed': {
    label: '生成演示数据',
    params: params<{ customers: number }>(z.object({ customers: intInRange('customers', 1_000_000) })),
    result: resultType<{ tables: { name: string; rows: number }[] }>(),
  },
  // 采集数据源：同步范围内的表（参数 tables）的行数、列统计与水位线候选，范围外的表不碰。
  // 数据源只读挂载在另一个 DuckDB 里，不碰本租户的数据湖。repairFor 是告警后重新采集的来源（调度器读）
  'source.profile': {
    label: '采集数据源',
    needs: { source: true },
    params: params<{ sourceId: string; tables: string[]; repairFor?: string }>(z.looseObject({ tables: strings('参数 tables 必须是非空的表名列表') })),
    result: resultType<Awaited<ReturnType<typeof profileSource>>>(),
  },
  // 同步：每张表一个变更批次追加到原始层。有水位线的表增量读取，到了比对周期再比对一次主键全集（没有主键时整行全量比对）；
  // 没有水位线的表全量比对。参数 reconcile 为真时（成员在核对发现差异后触发）不等比对周期，增量之后都比对一次。
  // 有表失败时任务记为失败，结果里保留各表的批次与错误；源端已经没有的表跳过，不算失败
  'source.sync': {
    label: '同步数据源',
    needs: { source: true },
    attachSource: true,
    params: schemaParams(syncParams),
    result: resultType<{ tables: Awaited<ReturnType<typeof syncSourceTables>> }>(),
  },
  // 校验业务主键：成员声明的组合在源表全表上是否非空且唯一，按租户配额分桶检查（源端只读，数据湖只给溢写目录）。
  // 有空值或重复时任务仍记为成功，ok 为假；通过时调度器写回声明（source-key-check.ts）。主键列像敏感信息时重复键不带取值（ADR-0005）
  'source.keycheck': {
    label: '校验业务主键',
    needs: { source: true },
    attachSource: true,
    readOnlyLake: true,
    params: schemaParams(keyCheckParams),
    result: resultType<KeyCheckTaskResult>(),
  },
  // 核对湖中数据：源端的全部表标出是否进湖与源端行数，已进湖的表再核对位置、文件、结构与数据量。
  // 数据湖只读挂载，只出报告不写湖；differences 是已进湖、四项有不一致的表数
  'source.verify': {
    label: '核对湖中数据',
    needs: { source: true },
    attachSource: true,
    readOnlyLake: true,
    params: schemaParams(verifyParams),
    result: resultType<{ tables: Awaited<ReturnType<typeof verifySourceLake>>; differences: number }>(),
  },
  // 漂移检查：对比标准层表的实际结构与参数里的应有结构（入队时由已发布映射算出），报告缺列、多列、类型不一致与孤表。
  // 数据湖只读挂载，只出报告不写湖；修复走合并
  'lake.inspect': {
    label: '漂移检查',
    readOnlyLake: true,
    params: schemaParams(inspectParams),
    result: resultType<InspectResult>(),
  },
  // 主键冲突体检：对每个实体里主键撞上的每对映射，统计重叠的键数、样本键与字段一致的比例，给出建议（ADR-0024）。
  // 数据湖只读挂载，只出报告不改标准层
  'silver.keycheck': {
    label: '主键冲突体检',
    readOnlyLake: true,
    params: schemaParams(silverKeyCheckParams),
    result: resultType<KeyCheckResult>(),
  },
  // 合并到标准层：按已发布的映射把原始层里新的变更批次合并进标准层，每个映射各自一个事务，之后按参数里的匹配规则重算身份打通。
  // 有映射或打通失败时任务记为失败，结果里保留各映射的合并结果、打通摘要与错误；参数带 drop 时先撤下这些停用的映射（ADR-0031）
  'silver.merge': {
    label: '合并到标准层',
    needs: { piiSalt: true },
    params: schemaParams(mergeParams),
    result: resultType<Awaited<ReturnType<typeof mergeToSilver>>>(),
  },
  // 指标或标签（ADR-0025）：发布定义时入队，参数里带上入队时按当天编译好的 SQL 与它用到的实体（不再访问平台库）。
  // 标准层有这些实体与身份打通结果时，把 SQL 的结果写进结果层的一张快照表 gold."<种类>__<任务 ID>"。
  // key、asOf、definitionId（调度器读）与 definitionVersion、trigger（登记快照时记下）原样放行
  'gold.dsl': {
    label: '指标与标签',
    params: params<{ kind: string; sql: string; entities: string[] } & Record<string, unknown>>(z.looseObject({
      kind: z.string(error('参数 kind 不合法')).regex(/^[a-z]+$/, error('参数 kind 不合法')),
      sql: z.string(error('缺少参数 sql')).min(1, error('缺少参数 sql')),
      entities: strings('参数 entities 必须是非空的实体名列表'),
    })),
    result: resultType<{ table: string; rows: number; params: Record<string, unknown>; assertions: AssertionResult[] }>(),
  },
  // 快照过期：删掉参数里到期快照的表（已删的跳过，重复执行不报错），再按 ADR-0020 擦除湖里的数据
  'gold.expire': {
    label: '快照过期',
    params: params<{ tables: string[] }>(z.object({
      tables: z.array(z.string(error('参数 tables 必须是非空的结果层快照表名列表')).regex(/^gold\.[a-z][a-z0-9]*__[0-9a-f-]{36}$/, error('参数 tables 必须是非空的结果层快照表名列表')), error('参数 tables 必须是非空的结果层快照表名列表')).min(1, error('参数 tables 必须是非空的结果层快照表名列表')),
    })),
    result: resultType<{ tables: string[] }>(),
  },
  // 删除原始层（ADR-0044）：删掉已删除数据源在湖里的 <schema>、<schema>_keys、<schema>_mirror 下的全部表，再删掉这三个 schema，
  // 并与 gold.expire 一样擦除湖里的数据。没有声明 needs.source，领取时不读凭据（数据源已删）
  'source.drop': {
    label: '删除原始层',
    params: params<{ schema: string }>(z.object({
      schema: z.string(error('参数 schema 必须是原始层 schema 名')).regex(/^bronze_[0-9a-f]{32}$/, error('参数 schema 必须是原始层 schema 名')),
    })),
    result: resultType<{ schemas: string[]; tables: string[] }>(),
  },
  // 沙箱表过期（ADR-0036）：删掉参数里到期的沙箱表 sandbox_<成员>.<表名>（已删的跳过，重复执行不报错），再与 gold.expire 一样擦除湖里的数据。
  // 表名正则是防注入的最后一道，只认沙箱 schema
  'sandbox.expire': {
    label: '沙箱表过期',
    params: params<{ tables: string[] }>(z.object({
      tables: z.array(z.string(error('参数 tables 必须是非空的沙箱表名列表')).regex(/^sandbox_[0-9a-f]{32}\.[a-z][a-z0-9_]{0,62}$/, error('参数 tables 必须是非空的沙箱表名列表')), error('参数 tables 必须是非空的沙箱表名列表')).min(1, error('参数 tables 必须是非空的沙箱表名列表')),
    })),
    result: resultType<{ tables: string[] }>(),
  },
  // 生成服务库（ADR-0033）：把参数里的快照表（各已发布定义最新、未过期的快照，调用方从平台库查出）合成一个 DuckDB 文件，
  // 表都按 consumer_id 排序写入，再上传到本租户存储前缀下的 _serving/v<版本>.duckdb。数据湖只读挂载；表名不合规或表不在时失败、不上传。
  // target 是否本租户这一版的位置要和 session.lake.dataPath 比对，留在 run 里
  'serving.build': {
    label: '生成服务库',
    needs: { servingKey: true },
    readOnlyLake: true,
    servingFile: true,
    params: schemaParams(servingParams),
    result: resultType<{ version: number; path: string; rows: Awaited<ReturnType<typeof buildServingStore>> }>(),
  },
  // 人群导出（ADR-0040）：按入队时定下的标签快照表筛出所有条件同时满足的 consumer_id，按它排序写到本租户存储前缀下的 _exports/<任务 ID>.<格式>。
  // 数据湖只读挂载；排队期间快照表被删掉（快照过期）时失败、不写文件。snapshots 只声明不校验（清理与审计读）。
  // 结果里的 path 在导出文件过了保留期被清理后会从结果里删掉（exports.ts），所以可选
  'export.tags': {
    label: '人群导出',
    readOnlyLake: true,
    params: schemaParams(z.looseObject({
      format: z.enum(EXPORT_FORMATS, error(FORMAT)),
      conditions: z.array(exportCondition, error(CONDITIONS)).min(1, error(CONDITIONS)),
      snapshots: z.unknown().optional(),
    })),
    result: resultType<{ rows: number; path?: string; format: ExportFormat }>(),
  },
  ...TEMPLATE_CONTRACTS,
} satisfies Record<string, TaskContract<unknown, unknown>>;

/** 全部任务的 kind */
export type TaskKind = keyof typeof CONTRACTS;

/** 是否登记过的任务 kind */
export const isTaskKind = (kind: string): kind is TaskKind => Object.hasOwn(CONTRACTS, kind);

/** 一个任务的参数类型：契约 schema 解析出的 */
export type ParamsOf<K extends TaskKind> = (typeof CONTRACTS)[K]['params'] extends { parse(raw: unknown): infer P } ? P : never;

/** 一个任务的入参类型（insertTask / enqueueTask 的参数）：契约接受的原始形状，带缺省值的项可省略；
 * 模板任务只按公共部分定型，模板参数是宽松的 Record，真正的校验在入队时由契约 parse 做 */
export type InputOf<K extends TaskKind> = (typeof CONTRACTS)[K]['params'] extends { readonly __input?: infer I } ? NonNullable<I> : ParamsOf<K>;

/** 声明了 needs.source 的任务 kind：领取时照参数 sourceId 解密源连接 */
type SourceNeedKinds = { [K in TaskKind]: (typeof CONTRACTS)[K] extends { needs: { source: true } } ? K : never }[TaskKind];

// 编译期断言（只在这里核对，不出现在运行时）：声明了 needs.source 的任务，参数里都带 sourceId（claimNextTask 照它读连接，
// 不再按参数名判断）；attachSource 的任务都声明了 needs.source（挂载数据源之前先得有连接）。哪条不满足，取值出现 false、这里编译报错
type AssertTrue<T extends true> = T;
type _needsSourceInParams = AssertTrue<{ [K in SourceNeedKinds]: [ParamsOf<K>] extends [{ sourceId: string }] ? true : false }[SourceNeedKinds] extends true ? true : false>;
type _attachDeclaresSource = AssertTrue<{ [K in TaskKind]: (typeof CONTRACTS)[K] extends { attachSource: true } ? (K extends SourceNeedKinds ? true : false) : true }[TaskKind] extends true ? true : false>;
// schemaParams 推出的类型（z.custom 定型、Known 去索引签名）：keycheck 的 sensitive 推出必填 boolean（不是 boolean | undefined）；
// sync 的入参不带字符串索引签名——带了的话 source-sync 的 Omit<InputOf<K>, 'sourceId'> 会丢掉全部具名字段，入队参数不再做类型检查；
// export 的条件与入参同理（exports.ts 的 Omit<ExportCondition, 'table'>、入队时带的 snapshots）
type _keycheckSensitive = AssertTrue<[ParamsOf<'source.keycheck'>['sensitive']] extends [boolean] ? true : false>;
type _syncInputKnown = AssertTrue<string extends keyof InputOf<'source.sync'> ? false : true>;
type _mergeInputKnown = AssertTrue<string extends keyof InputOf<'silver.merge'> ? false : true>;
type _exportConditionKnown = AssertTrue<string extends keyof ExportCondition ? false : true>;
type _exportInputKnown = AssertTrue<string extends keyof InputOf<'export.tags'> ? false : true>;

/** 一个任务的结果类型 */
export type ResultOf<K extends TaskKind> = NonNullable<(typeof CONTRACTS)[K]['result']['__result']>;

/**
 * 读一行任务的结果（ADR-0052）：结果只有类型、不做运行时校验（结果由本仓库的工作进程写出），
 * 这里只核对是哪种任务的结果。row 是 tasks 表的行（或只 select 了 result 的部分行）：
 * row 或 row.result 为空（还没有成功结果）返回 null；row 带 kind 且与参数不一致说明读错了行，抛错（程序错误）。
 * engine 是工作进程往每个结果里加的运行配额（worker.ts），原样带出
 */
export function readResult<K extends TaskKind>(
  kind: K,
  row: { kind?: string; result: unknown } | null | undefined,
): (ResultOf<K> & { engine?: { memoryLimit: string; threads: number } }) | null {
  if (row?.result == null) return null;
  if (row.kind !== undefined && row.kind !== kind) throw new Error(`readResult(${kind}) 读到的任务 kind 是 ${row.kind}`);
  return row.result as ResultOf<K> & { engine?: { memoryLimit: string; threads: number } };
}

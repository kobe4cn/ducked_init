// app/.server/pipeline/task-contracts.ts —— 任务契约（ADR-0052）：每个任务的 kind、label、参数 schema、结果类型、挂载标志与领取时要准备的凭据（needs）。
// 工作进程的 HANDLERS 按契约实现 run；入队侧的参数校验也按契约来（下一张子票）。参数校验发生在工作进程的 run 里，
// 不合法时报一句话。本文件不连平台库、不建 DuckDB：只运行时依赖 zod 与纯模块（templates、sources），
// engine 一律 import type（ADR-0008），所以入队侧也能安全地引它
import { z } from 'zod';
import { MERGE_RULE_KINDS } from '../../lib/merge-groups';
import { LAKE_COVERAGE, type NotInLakeReason } from '../../lib/sources';
import { TASK_KINDS, TEMPLATES, templateAt, type TemplateId } from './templates';
import type { AssertionResult } from './assertions';
import type { profileSource } from './source-engine';
import type { syncSourceTables } from './sync-engine';
import type { verifySourceLake } from './verify-engine';
import type { InspectParams, InspectResult } from './inspect-engine';
import type { KeyCheckParams, KeyCheckResult } from './key-check-engine';
import type { mergeToSilver, MergeDrop, MergeMappingParam, RelationParam } from './merge-engine';
import type { buildServingStore, ServingParams } from './serving-engine';
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

/** 非空字符串列表（原 isStrings）：任何形状不对都报同一句话 */
const strings = (message: string) => z.array(z.string(error(message)), error(message)).min(1, error(message));
/** 字符串列表，可以为空（原 consumerSensitive 的检查） */
const stringList = (message: string) => z.array(z.string(error(message)), error(message));
/** 1 到 max 之间的整数（原 positiveInt） */
const intInRange = (key: string, max: number) => {
  const message = `参数 ${key} 必须是 1 到 ${max} 之间的整数`;
  return z.number(error(message)).int(error(message)).min(1, error(message)).max(max, error(message));
};
/** 全是字符串字段的对象（如要撤下的停用映射），整个对象不合法时报同一句话 */
const stringFields = (keys: string[], message: string) =>
  z.object(Object.fromEntries(keys.map(k => [k, z.string(error(message))])), error(message)).loose();

/** 没有参数的任务（入队时是空对象）：只要求是个对象，别的什么都不查 */
const noParams = params<Record<string, unknown>>(z.record(z.string(), z.unknown()));

/** 结果层快照表名 gold.<种类>__<任务 ID> */
export const SNAPSHOT_TABLE = /^gold\.([a-z][a-z0-9]*)__[0-9a-f-]{36}$/;

/** 人群导出文件在存储前缀下的目录（ADR-0040），不是 DuckLake 登记的文件 */
export const EXPORT_DIR = '_exports/';
export const EXPORT_FORMATS = ['parquet', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** 人群导出的一个条件：标签、取值与入队时定下的快照表（结果层里不带 schema 的表名） */
export interface ExportCondition { tag: string; value: string; table: string }

/** 平台判断的未进湖原因：账号读不了、源端已删除由工作进程实时判断，不在参数里 */
const NOT_IN_LAKE_REASONS = Object.keys(LAKE_COVERAGE).filter(c => !['in_lake', 'unreadable', 'gone'].includes(c)) as NotInLakeReason[];

/** 水位线字段的种类 */
const WATERMARKS = ['updated_at', 'increment'] as const;

const SURVIVORSHIP = '参数 survivorship 必须是映射 ID 到正整数名次的对照';

/** 同步的一张表（原 syncTables）：水位线字段与种类要么都有、要么都没有；业务主键在旧任务里是单个字段，这里转成数组。
 * extra 补核对任务（source.verify）另带的字段：是否在同步范围内与平台判断的未进湖原因 */
function tableWithWatermark(message: string, keyAsString: boolean, extra: Record<string, z.ZodType> = {}) {
  return z.object({
    name: z.string(error(message)),
    column: z.string(error(message)).optional(),
    kind: z.enum(WATERMARKS, error(message)).optional(),
    key: (keyAsString
      ? z.union([z.string(error(message)), strings(message)], error(message))
        .optional()
        .transform(k => (typeof k === 'string' ? [k] : k))
      : strings(message).optional()),
    softDelete: z.string(error(message)).optional(),
    ...extra,
  }, error(message))
    .refine(t => (t.column === undefined) === (t.kind === undefined), error(message))
    .loose();
}

/** 可空字符串（如取最新字段 latest）：null 表示没有 */
const nullableString = (message: string) => z.union([z.string(error(message)), z.null(error(message))], error(message));

/** 合并参数里的映射（原 mergeMappings + isMergeGroup）：已发布的版本及其合并计划，发布时已校验过，这里只核对形状 */
const MAPPINGS = '参数 mappings 必须是非空的已发布映射列表';
/** 合并组的存活规则（ADR-0032）：latest 另带取最新的字段 */
const mergeRule = z.object({ kind: z.enum(MERGE_RULE_KINDS, error(MAPPINGS)), field: z.unknown().optional() }, error(MAPPINGS))
  .refine(r => r.kind !== 'latest' || typeof r.field === 'string', error(MAPPINGS))
  .loose();
/** 合并组的一个组员（ADR-0032）：从它的当前记录按去重键与取最新字段取每个键最新的一行，refs 是引用列旁的数据源列 */
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
const mergeGroup = z.object({
  id: z.string(error(MAPPINGS)),
  rule: mergeRule,
  key: strings(MAPPINGS),
  members: z.array(groupMember, error(MAPPINGS)).min(1, error(MAPPINGS)),
}, error(MAPPINGS)).loose();
const mergeMapping = z.object({
  mapping: z.string(error(MAPPINGS)),
  version: z.number(error(MAPPINGS)).int(error(MAPPINGS)),
  sourceId: z.string(error(MAPPINGS)),
  entity: z.string(error(MAPPINGS)),
  table: z.string(error(MAPPINGS)),
  columns: z.array(z.unknown(), error(MAPPINGS)).min(1, error(MAPPINGS)),
  entityColumns: z.array(z.unknown(), error(MAPPINGS)),
  key: strings(MAPPINGS),
  latest: nullableString(MAPPINGS),
  rebuild: z.boolean(error(MAPPINGS)).optional(),
  uniqueKey: strings(MAPPINGS).optional(),
  uniqueBySource: z.boolean(error(MAPPINGS)).optional(),
  group: mergeGroup.optional(),
}, error(MAPPINGS)).loose();

/** silver.merge 的参数：早先入队的合并没有 identity 之后的项，按缺省处理 */
export interface MergeParams {
  mappings: MergeMappingParam[];
  drop: MergeDrop[];
  /** 身份打通的匹配规则（入队时由全部 customer 映射汇总） */
  identity?: string[];
  identityForce: boolean;
  /** 不参与身份匹配的值（规范化后的加盐哈希，只收 64 位十六进制，挡住误传的明文） */
  identityExclude: string[];
  /** 属性取舍的名次：映射 ID → 正整数名次 */
  survivorship: Record<string, number>;
  /** 不进 _consumer 的敏感字段 */
  consumerSensitive: string[];
  /** 要统计孤儿的已发布关系（from、ref 与起点是否敏感） */
  relations: RelationParam[];
}

/** silver.merge 的入参（insertTask 用）：schema 里带缺省值的项可省略；identity 是入队时汇总出的只读列表 */
export type MergeInput = Omit<MergeParams, 'identity' | 'drop' | 'identityForce' | 'consumerSensitive' | 'survivorship' | 'identityExclude' | 'relations'> & {
  identity?: readonly string[];
  drop?: MergeDrop[];
  identityForce?: boolean;
  consumerSensitive?: string[];
  survivorship?: Record<string, number>;
  identityExclude?: string[];
  relations?: RelationParam[];
};

/** 漂移检查参数里的应有结构：表名 → 列名 → 类型（入队时由已发布映射算出） */
const EXPECTED = '参数 expected 必须是 表名 → 列名 → 类型 的对象';

/** 主键冲突体检参数里的实体（入队时由已发布映射算出）：主键、是否按数据源比较、各映射与映射出来的列、所在的合并组 */
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

/** 生成服务库的参数：版本、上传位置（与 session.lake.dataPath 的比对留在 run 里，schema 只查形状）与要放进去的快照 */
const SNAPSHOTS = '参数 snapshots 必须是 { id, template, table } 列表，table 是结果层快照表名';

/** 人群导出的参数：格式与条件（入队时由平台库查出快照表） */
const CONDITIONS = '参数 conditions 必须是非空的 { tag, value, table } 列表，table 是标签快照表名';
const FORMAT = `参数 format 只能是 ${EXPORT_FORMATS.join(' / ')}`;

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
 * 结果类型仍是普通对象，收紧留给 #474、#477（钩子与 readResult）
 */
const TEMPLATE_CONTRACTS = Object.fromEntries((Object.keys(TASK_KINDS) as TemplateId[]).map(id => [TASK_KINDS[id], {
  label: TEMPLATES[id].label, params: templateParams(id), result: resultType<Record<string, unknown>>(),
}])) as { [K in TemplateId as (typeof TASK_KINDS)[K]]: TaskContract<TemplateParams<K>, Record<string, unknown>> & { params: { readonly __input?: TemplateInput } } };

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
    params: params<{ sourceId: string; tables: import('./sync-engine').SyncTableParam[]; reconcile?: unknown }>(z.looseObject({
      sourceId: z.string(error('缺少参数 sourceId')),
      tables: z.array(tableWithWatermark('参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表', true), error('参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表')).min(1, error('参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表')),
      // 原 run 只认 true，别的取值照原样放行
      reconcile: z.unknown().optional(),
    })),
    result: resultType<{ tables: Awaited<ReturnType<typeof syncSourceTables>> }>(),
  },
  // 校验业务主键：成员声明的组合在源表全表上是否非空且唯一，按租户配额分桶检查（源端只读，数据湖只给溢写目录）。
  // 有空值或重复时任务仍记为成功，ok 为假；通过时调度器写回声明（source-key-check.ts）。主键列像敏感信息时重复键不带取值（ADR-0005）
  'source.keycheck': {
    label: '校验业务主键',
    needs: { source: true },
    attachSource: true,
    readOnlyLake: true,
    params: params<import('../source-key-check').KeyCheckTaskParams>(z.looseObject({
      tableName: z.string(error('缺少参数 tableName')),
      keyColumns: strings('参数 keyColumns 必须是非空的字段列表'),
      // memberId、email（写回时记审计）与 sourceId、sensitive 原样放行，调度器与 run 自己读
      sensitive: z.unknown().optional(),
    })),
    result: resultType<KeyCheckTaskResult>(),
  },
  // 核对湖中数据：源端的全部表标出是否进湖与源端行数，已进湖的表再核对位置、文件、结构与数据量。
  // 数据湖只读挂载，只出报告不写湖；differences 是已进湖、四项有不一致的表数
  'source.verify': {
    label: '核对湖中数据',
    needs: { source: true },
    attachSource: true,
    readOnlyLake: true,
    params: params<{ sourceId: string; tables: import('./verify-engine').VerifyTableParam[] }>(z.looseObject({
      sourceId: z.string(error('缺少参数 sourceId')),
      tables: z.array(tableWithWatermark('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表', false, {
        inScope: z.boolean(error('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表')),
        reason: z.enum(NOT_IN_LAKE_REASONS, error('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表')),
      }), error('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表')),
    })),
    result: resultType<{ tables: Awaited<ReturnType<typeof verifySourceLake>>; differences: number }>(),
  },
  // 漂移检查：对比标准层表的实际结构与参数里的应有结构（入队时由已发布映射算出），报告缺列、多列、类型不一致与孤表。
  // 数据湖只读挂载，只出报告不写湖；修复走合并
  'lake.inspect': {
    label: '漂移检查',
    readOnlyLake: true,
    params: params<InspectParams>(z.object({
      expected: z.record(z.string(error(EXPECTED)), z.record(z.string(error(EXPECTED)), z.string(error(EXPECTED)), error(EXPECTED)), error(EXPECTED)),
    })),
    result: resultType<InspectResult>(),
  },
  // 主键冲突体检：对每个实体里主键撞上的每对映射，统计重叠的键数、样本键与字段一致的比例，给出建议（ADR-0024）。
  // 数据湖只读挂载，只出报告不改标准层
  'silver.keycheck': {
    label: '主键冲突体检',
    readOnlyLake: true,
    params: params<KeyCheckParams>(z.object({ entities: z.array(keyCheckEntity, error(KEYCHECK)) })),
    result: resultType<KeyCheckResult>(),
  },
  // 合并到标准层：按已发布的映射把原始层里新的变更批次合并进标准层，每个映射各自一个事务，之后按参数里的匹配规则重算身份打通。
  // 有映射或打通失败时任务记为失败，结果里保留各映射的合并结果、打通摘要与错误；参数带 drop 时先撤下这些停用的映射（ADR-0031）
  'silver.merge': {
    label: '合并到标准层',
    needs: { piiSalt: true },
    params: params<MergeParams, MergeInput>(z.looseObject({
      drop: z.array(stringFields(['mapping', 'entity'], '参数 drop 必须是 { mapping, entity } 列表'), error('参数 drop 必须是 { mapping, entity } 列表')).default([]),
      mappings: z.array(mergeMapping, error(MAPPINGS)),
      identity: strings('参数 identity 必须是非空的字段名列表').optional(),
      relations: z.array(z.looseObject({
        from: stringFields(['entity', 'field'], '参数 relations 必须是关系列表（from、ref 与 sensitive）'),
        ref: stringFields(['entity', 'field'], '参数 relations 必须是关系列表（from、ref 与 sensitive）'),
        sensitive: z.boolean(error('参数 relations 必须是关系列表（from、ref 与 sensitive）')),
      }, error('参数 relations 必须是关系列表（from、ref 与 sensitive）')), error('参数 relations 必须是关系列表（from、ref 与 sensitive）')).default([]),
      identityForce: z.boolean(error('参数 identityForce 必须是布尔值')).default(false),
      consumerSensitive: stringList('参数 consumerSensitive 必须是字段名列表').default([]),
      survivorship: z.record(z.string(error(SURVIVORSHIP)), z.number(error(SURVIVORSHIP)).int(error(SURVIVORSHIP)).min(1, error(SURVIVORSHIP)), error(SURVIVORSHIP)).default({}),
      identityExclude: z.array(z.string(error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')).regex(/^[0-9a-f]{64}$/, error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')), error('参数 identityExclude 必须是哈希（64 位小写十六进制）列表')).default([]),
      // 带了要撤下的停用映射时 mappings 可以为空（停用的是实体最后一个映射）
    }).refine(p => p.mappings.length > 0 || p.drop.length > 0, { error: MAPPINGS, path: ['mappings'] })),
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
    params: params<ServingParams>(z.looseObject({
      version: z.number(error('参数 version 必须是正整数')).int(error('参数 version 必须是正整数')).min(1, error('参数 version 必须是正整数')),
      target: z.string(error('参数 target 必须是本租户存储前缀下这一版服务库的位置')),
      snapshots: z.array(z.looseObject({
        id: z.string(error(SNAPSHOTS)),
        template: z.string(error(SNAPSHOTS)),
        table: z.string(error(SNAPSHOTS)).regex(SNAPSHOT_TABLE, error(SNAPSHOTS)),
      }, error(SNAPSHOTS)), error(SNAPSHOTS)),
    })),
    result: resultType<{ version: number; path: string; rows: Awaited<ReturnType<typeof buildServingStore>> }>(),
  },
  // 人群导出（ADR-0040）：按入队时定下的标签快照表筛出所有条件同时满足的 consumer_id，按它排序写到本租户存储前缀下的 _exports/<任务 ID>.<格式>。
  // 数据湖只读挂载；排队期间快照表被删掉（快照过期）时失败、不写文件。snapshots（清理与审计读）原样放行
  'export.tags': {
    label: '人群导出',
    readOnlyLake: true,
    params: params<{ format: ExportFormat; conditions: ExportCondition[] } & Record<string, unknown>>(z.looseObject({
      format: z.enum(EXPORT_FORMATS, error(FORMAT)),
      conditions: z.array(z.looseObject({
        tag: z.string(error(CONDITIONS)),
        value: z.string(error(CONDITIONS)),
        table: z.string(error(CONDITIONS)).regex(/^tag__[0-9a-f-]{36}$/, error(CONDITIONS)),
      }, error(CONDITIONS)), error(CONDITIONS)).min(1, error(CONDITIONS)),
    })),
    result: resultType<{ rows: number; path: string; format: ExportFormat }>(),
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

/** 一个任务的结果类型 */
export type ResultOf<K extends TaskKind> = NonNullable<(typeof CONTRACTS)[K]['result']['__result']>;

// app/.server/pipeline/templates/index.ts —— 分析模板注册表（ADR-0004）：模板 ID → 名称、默认参数、参数校验与编译函数，以及运行它的任务类型。
// 编译函数是纯函数，同样的参数得到同样的 SQL；SQL 只读标准层，产出写进结果层由任务负责（handlers.ts 按注册表通用地登记任务）。
// 加一个模板：新建模板文件，在 TEMPLATES 与 TASK_KINDS 各加一行；模板 ID 以小写字母开头、只含小写字母与数字（快照表名 <模板 ID>__<任务 ID>）
import { CHURN_DEFAULTS, compileChurn, parseChurnDefinition, parseChurnParams, type ChurnParams } from './churn';
import { CLV_DEFAULTS, compileClv, parseClvDefinition, parseClvParams, type ClvParams } from './clv';
import { COHORT_DEFAULTS, compileCohort, parseCohortDefinition, parseCohortParams, type CohortParams } from './cohort';
import { compileRepurchase, parseRepurchaseDefinition, parseRepurchaseParams, REPURCHASE_DEFAULTS, type RepurchaseParams } from './repurchase';
import { compileRfm, compileRfmUnlinked, parseRfmDefinition, parseRfmParams, RFM_DEFAULTS, type RfmParams } from './rfm';
import { TEST_VERSIONS } from './test-versions';
import { compileUser360, parseUser360Definition, parseUser360Params, USER360_DEFAULTS, type User360Params } from './user360';

/** 通用参数表单的一项：int 是整数输入框，statuses 是订单状态多选，enum 是 options 里的单选 */
export interface ParamField {
  key: string;
  label: string;
  kind: 'int' | 'statuses' | 'enum';
  min?: number;
  max?: number;
  options?: readonly { value: string; label: string }[];
}

export interface Template<P, D = Partial<P>> {
  label: string;
  /** 模板版本：定义的每一版锁定一个模板版本，任务按它编译（ADR-0021）；改了编译结果就升一版，旧版本移进 TEMPLATE_HISTORY */
  version: number;
  /** 模板读到的实体（含维度路径上经过的实体）：登记快照时查这些实体的映射有没有合并失败，计算前对它们跑断言 */
  entities: readonly string[];
  /** 计算前标准层（silver）里必须有的表，按顺序检查，缺了任务失败并说明先做什么 */
  requires: readonly string[];
  /** 可以没有的表：编译时告诉 compile 哪些在 */
  optional?: readonly string[];
  /** 除必填参数以外的默认参数 */
  defaults: D;
  /** 通用参数表单的各项（定义的参数）；不填的模板有专用表单 */
  form?: readonly ParamField[];
  /** 校验任务参数并补上默认值，不合法时抛出说明原因的错误 */
  parse(params: Record<string, unknown>): P;
  /** 校验模板定义的参数（不含每次运行时给定的参数）并补上默认值，不合法时抛出说明原因的错误 */
  parseDefinition(params: Record<string, unknown>): D;
  /** 编译成一条 SELECT，每个统一消费者一行；has 判断 optional 里的表在不在 */
  compile(params: P, has: (table: string) => boolean): string;
  /** 任务结果里另报的计数：结果键 → 返回一行 n 的 SELECT */
  counts?(params: P): Record<string, string>;
}

export const TEMPLATES = {
  // customer：RFM 按 _identities 归到统一消费者，_identities 由 customer 映射算出
  rfm: {
    label: 'RFM 分层', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities'], defaults: RFM_DEFAULTS,
    parse: parseRfmParams, parseDefinition: parseRfmDefinition, compile: compileRfm, counts: p => ({ unlinkedOrders: compileRfmUnlinked(p) }),
  } satisfies Template<RfmParams, Omit<RfmParams, 'asOf'>>,
  // 以 _consumer 为粒度，同意来自 _consumer_consent（老湖没有时同意列全为 false）
  user360: {
    label: '用户 360', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities', '_consumer'], optional: ['_consumer_consent'],
    defaults: USER360_DEFAULTS,
    form: [
      { key: 'lookbackDays', label: '回看天数', kind: 'int', min: 1, max: 3650 },
      { key: 'statuses', label: '计入的订单状态', kind: 'statuses' },
    ],
    parse: parseUser360Params, parseDefinition: parseUser360Definition,
    compile: (p, has) => compileUser360(p, { consent: has('_consumer_consent') }),
  } satisfies Template<User360Params, Omit<User360Params, 'asOf'>>,
  // 首单取全部历史里的第一单，只收首单在最近 periods 个周期里的消费者
  cohort: {
    label: '同期群', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities'], defaults: COHORT_DEFAULTS,
    form: [
      { key: 'granularity', label: '周期', kind: 'enum', options: [{ value: 'month', label: '按月' }, { value: 'week', label: '按周' }] },
      { key: 'periods', label: '周期数', kind: 'int', min: 1, max: 60 },
      { key: 'statuses', label: '计入的订单状态', kind: 'statuses' },
    ],
    parse: parseCohortParams, parseDefinition: parseCohortDefinition, compile: compileCohort,
  } satisfies Template<CohortParams, Omit<CohortParams, 'asOf'>>,
  // 首单与第二单都取回看窗口内的
  repurchase: {
    label: '复购', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities'], defaults: REPURCHASE_DEFAULTS,
    form: [
      { key: 'lookbackDays', label: '回看天数', kind: 'int', min: 1, max: 3650 },
      { key: 'windowDays', label: '复购窗口（天）', kind: 'int', min: 1, max: 730 },
      { key: 'statuses', label: '计入的订单状态', kind: 'statuses' },
    ],
    parse: parseRepurchaseParams, parseDefinition: parseRepurchaseDefinition, compile: compileRepurchase,
  } satisfies Template<RepurchaseParams, Omit<RepurchaseParams, 'asOf'>>,
  // 窗口内至少一单的消费者，按个人购买节奏衰减的存活概率预测未来价值
  clv: {
    label: 'CLV', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities'], defaults: CLV_DEFAULTS,
    form: [
      { key: 'lookbackDays', label: '回看天数', kind: 'int', min: 1, max: 3650 },
      { key: 'horizonDays', label: '预测天数', kind: 'int', min: 1, max: 3650 },
      { key: 'minTenureDays', label: '最短客龄（天）', kind: 'int', min: 1, max: 365 },
      { key: 'decay', label: '衰减系数', kind: 'int', min: 1, max: 10 },
      { key: 'statuses', label: '计入的订单状态', kind: 'statuses' },
    ],
    parse: parseClvParams, parseDefinition: parseClvDefinition, compile: compileClv,
  } satisfies Template<ClvParams, Omit<ClvParams, 'asOf'>>,
  // 窗口内订单数够多的消费者都在，at_risk 标出沉默超过自身节奏若干倍的；不读其他快照
  churn: {
    label: '流失预警', version: 1, entities: ['order', 'customer'], requires: ['order', '_identities'], defaults: CHURN_DEFAULTS,
    form: [
      { key: 'lookbackDays', label: '回看天数', kind: 'int', min: 1, max: 3650 },
      { key: 'minOrders', label: '最少订单数', kind: 'int', min: 2, max: 100 },
      { key: 'silenceMultiplier', label: '沉默倍数', kind: 'int', min: 1, max: 10 },
      { key: 'minGapDays', label: '最短间隔（天）', kind: 'int', min: 1, max: 365 },
      { key: 'statuses', label: '计入的订单状态', kind: 'statuses' },
    ],
    parse: parseChurnParams, parseDefinition: parseChurnDefinition, compile: compileChurn,
  } satisfies Template<ChurnParams, Omit<ChurnParams, 'asOf'>>,
};

export type TemplateId = keyof typeof TEMPLATES;

/** 模板 → 运行它的任务类型 */
export const TASK_KINDS = { rfm: 'gold.rfm', user360: 'gold.user360', cohort: 'gold.cohort', repurchase: 'gold.repurchase', clv: 'gold.clv', churn: 'gold.churn' } as const satisfies Record<TemplateId, `gold.${TemplateId}`>;

/** 任务类型 → 模板，不是模板任务时为 undefined */
export const templateOfKind = (kind: string) =>
  (Object.keys(TASK_KINDS) as TemplateId[]).find(id => TASK_KINDS[id] === kind);

/** 各模板退役的旧版本（当前版本在 TEMPLATES 里），锁定了旧版本的定义仍按它编译 */
export const TEMPLATE_HISTORY: Partial<Record<TemplateId, readonly Template<unknown, unknown>[]>> = {};

/** 注册表里的当前版本（不看测试开关） */
const registered = (id: TemplateId) => TEMPLATES[id] as unknown as Template<unknown, unknown>;

/** 测试开关打开时（TEMPLATE_TEST_VERSIONS=1）模板的测试版本；每次调用时读环境变量，测试在 import 之后才设 */
const testVersion = (id: TemplateId) => {
  if (process.env.TEMPLATE_TEST_VERSIONS !== '1') return undefined;
  return TEST_VERSIONS[id]?.(registered(id));
};

/** 模板的当前版本：新建定义锁定它。取当前版本一律经过这里 */
export const latestTemplate = (id: TemplateId) => testVersion(id) ?? registered(id);

/** 模板的某个版本，注册表里没有时抛错 */
export function templateAt(id: TemplateId, version: number) {
  const found = [testVersion(id), registered(id), ...TEMPLATE_HISTORY[id] ?? []].find(t => t?.version === version);
  if (!found) throw new Error(`模板 ${TEMPLATES[id].label} 没有第 ${version} 版`);
  return found;
}

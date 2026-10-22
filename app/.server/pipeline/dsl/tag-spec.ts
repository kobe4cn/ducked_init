// app/.server/pipeline/dsl/tag-spec.ts —— 标签定义（YAML，ADR-0025）：引用已发布、没有维度、取值为数字的指标，按规则给每个统一消费者一个取值。
// 两种写法：单指标（顶层 metric，when 是它上面的比较）与多指标（不写 metric，when 是 all / any 里的「指标 + 比较」，只一层）。
// 规则按顺序取第一条命中的，都没命中的取 default；取值是分析师写的常量。消费者不在某指标结果里时按 missing 或缺省（计数与求和记 0，其余记空）比较。
// 标签只认指标最新的已发布版本（DslContext.metrics），指标草稿不影响标签（发布前的影响预览用 withMetric 换成草稿来算）。编译时把这些指标的 SQL 内联成 CTE（不读指标快照），
// 人群是全部统一消费者（silver._identities），列为 consumer_id、tag_key、tag_value；tag_key 是定义行上不变的键，写成字面量。
// 纯函数：不碰平台库与数据湖，同样的定义与 asOf 编译出同样的 SQL
import { Ajv } from 'ajv';
import { IDENTITIES } from '../identity-engine';
import { lit } from '../merge-engine';
import { compileMetric, DESCRIPTION_SCHEMA, isNumericMetric, metricEntities, parseDsl, type Dependencies, type DslCheck, type DslContext, type MetricSpec } from './metric-spec';

export const TAG_CONDITIONS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
type Condition = (typeof TAG_CONDITIONS)[number];
type Comparison = Partial<Record<Condition, number>>;

/** 多指标写法的一项：引用的指标键与它上面的比较（至少一个） */
export interface MetricCondition extends Comparison { metric: string }

/** 规则的条件：单指标写法是顶层 metric 上的比较；多指标写法是 all（全部满足）或 any（任一满足），只一层 */
export type TagWhen = Comparison | MultiWhen;
type MultiWhen = { all?: MetricCondition[]; any?: MetricCondition[] };

export interface TagSpec {
  /** 单指标写法引用的指标键；多指标写法不写，指标写在每条规则的 all / any 里 */
  metric?: string;
  /** 按顺序第一条命中的规则给出取值 */
  rules: { value: string | number; when: TagWhen }[];
  /** 消费者不在某指标结果里（或取值为空）时按这里的取值比较；键是引用到的指标。没写的指标按 agg 取缺省（missingDefault） */
  missing?: Record<string, number | null>;
  /** 没命中任何规则时的取值 */
  default: string | number;
  /** 说明（可选，最多 500 字），目录接口返回 */
  description?: string;
}

const tagValue = { type: ['string', 'number'] };
const comparisons = Object.fromEntries(TAG_CONDITIONS.map(c => [c, { type: 'number' }]));
const comparison = { type: 'object', minProperties: 1, additionalProperties: false, properties: comparisons } as const;
const metricConditions = {
  type: 'array',
  minItems: 1,
  items: { type: 'object', required: ['metric'], additionalProperties: false, properties: { metric: { type: 'string', minLength: 1 }, ...comparisons } },
} as const;
const rulesOf = (when: object) => ({
  type: 'array',
  minItems: 1,
  items: { type: 'object', required: ['value', 'when'], additionalProperties: false, properties: { value: tagValue, when } },
});

/** 单指标写法的 JSON Schema（模型生成标签草稿只出这种写法） */
export const SINGLE_TAG_SCHEMA = {
  type: 'object',
  required: ['metric', 'rules', 'default'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', minLength: 1 },
    rules: rulesOf(comparison),
    default: tagValue,
    description: DESCRIPTION_SCHEMA,
  },
} as const;

/** 标签定义的 JSON Schema：写了 metric 是单指标写法（when 为比较），没写是多指标写法（when 为 all / any） */
export const TAG_SCHEMA = {
  type: 'object',
  required: ['rules', 'default'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', minLength: 1 },
    rules: rulesOf({ type: 'object' }),
    missing: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
    default: tagValue,
    description: DESCRIPTION_SCHEMA,
  },
  if: { required: ['metric'] },
  then: { properties: { rules: rulesOf(comparison) } },
  else: {
    properties: {
      rules: rulesOf({ type: 'object', minProperties: 1, additionalProperties: false, properties: { all: metricConditions, any: metricConditions } }),
    },
  },
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(TAG_SCHEMA);

/** 引用的指标：最新的已发布版本；不能用时返回原因（模型生成标签草稿时也按它挑可引用的指标） */
export function metricOf(key: string, ctx: DslContext): MetricSpec | string {
  const metric = ctx.metrics.get(key);
  if (!metric) return `没有已发布的指标 ${key}`;
  if (!metric.ok) return `指标 ${key} 的已发布版本对照当前的登记与映射不再通过校验`;
  if (metric.spec.dimensions?.length) return `指标 ${key} 带维度，标签只能引用没有维度（每个消费者一行）的指标`;
  if (!isNumericMetric(metric.spec, ctx)) return `指标 ${key} 的取值不是数字，标签的规则比不了大小`;
  return metric.spec;
}

/** 把一个指标换成指定的版本（如草稿）后的上下文：影响预览按它校验、编译下游标签 */
export const withMetric = (ctx: DslContext, key: string, metric: DslCheck<MetricSpec>): DslContext =>
  ({ ...ctx, metrics: new Map(ctx.metrics).set(key, metric) });

/** 编译用：引用的指标（校验已通过，不能用时说明调用方传错了定义） */
function requireMetric(key: string, ctx: DslContext): MetricSpec {
  const metric = metricOf(key, ctx);
  if (typeof metric === 'string') throw new Error(metric);
  return metric;
}

const COMBINATORS = ['all', 'any'] as const;

/** 规则的条件统一成多指标写法：单指标写法即 all 里一项、指标为顶层 metric */
function ruleConditions(spec: TagSpec, when: TagWhen): { combinator: (typeof COMBINATORS)[number]; items: MetricCondition[] } {
  if (spec.metric !== undefined) return { combinator: 'all', items: [{ ...(when as Comparison), metric: spec.metric }] };
  const w = when as MultiWhen;
  return w.any ? { combinator: 'any', items: w.any } : { combinator: 'all', items: w.all ?? [] };
}

/** 引用的全部指标键，去重排序。已发布版本的 YAML 不经 Schema 直接交来（依赖解析），结构不全时跳过 */
export function tagMetrics(spec: TagSpec): string[] {
  const keys = new Set<string>();
  if (typeof spec?.metric === 'string') keys.add(spec.metric);
  for (const rule of Array.isArray(spec?.rules) ? spec.rules : []) {
    for (const combinator of COMBINATORS) {
      const items: unknown = (rule?.when as Record<string, unknown> | undefined)?.[combinator];
      for (const item of Array.isArray(items) ? items : []) {
        if (typeof (item as MetricCondition | null)?.metric === 'string') keys.add((item as MetricCondition).metric);
      }
    }
  }
  return [...keys].sort();
}

const blank = (v: string | number) => String(v).trim() === '';

/**
 * 校验标签定义：YAML 语法、JSON Schema，再检查引用的指标、条件与取值。
 * 通过时返回定义，否则返回全部问题（按位置排序）
 */
export function checkTag(text: string, ctx: DslContext): DslCheck<TagSpec> {
  const parsed = parseDsl(text, validateSchema);
  if ('ok' in parsed) return parsed;
  const { value, issue, done } = parsed;
  const spec = value as TagSpec;

  if (spec.metric !== undefined) {
    const metric = metricOf(spec.metric, ctx);
    if (typeof metric === 'string') issue(['metric'], metric);
  }
  for (const [i, rule] of spec.rules.entries()) {
    if (blank(rule.value)) issue(['rules', i, 'value'], '取值不能为空');
    if (spec.metric !== undefined) continue;
    const when = rule.when as MultiWhen;
    if (when.all && when.any) issue(['rules', i, 'when'], 'all 与 any 只能写一个');
    for (const combinator of COMBINATORS) {
      for (const [j, item] of (when[combinator] ?? []).entries()) {
        const metric = metricOf(item.metric, ctx);
        if (typeof metric === 'string') issue(['rules', i, 'when', combinator, j, 'metric'], metric);
        if (!TAG_CONDITIONS.some(c => item[c] !== undefined)) issue(['rules', i, 'when', combinator, j], `至少写一个比较（${TAG_CONDITIONS.join('、')}）`);
      }
    }
  }
  const referenced = tagMetrics(spec);
  for (const key of Object.keys(spec.missing ?? {})) {
    if (!referenced.includes(key)) issue(['missing', key], `规则里没有引用指标 ${key}`);
  }
  if (blank(spec.default)) issue(['default'], '取值不能为空');
  return done(spec);
}

/** 标签用到的实体：各引用指标用到的实体的并集，排好序 */
export function tagEntities(spec: TagSpec, ctx: DslContext): string[] {
  return [...new Set(tagMetrics(spec).flatMap(key => metricEntities(requireMetric(key, ctx), ctx)))].sort();
}

/** 标签的依赖：引用的全部指标键（实体与字段经由指标，指标在就删不掉） */
export const tagDependencies = (spec: TagSpec): Dependencies => ({ metrics: tagMetrics(spec), entities: [], fields: [] });

const ZERO_WHEN_MISSING: readonly string[] = ['count', 'count_distinct', 'sum'];
/** 没在 missing 里写的指标：不在结果里的消费者按 agg 取值——计数与求和记 0，其余记空（比较为假） */
const missingDefault = (metric: MetricSpec): number | null => (ZERO_WHEN_MISSING.includes(metric.measure.agg) ? 0 : null);

const COMPARE: Record<Condition, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' };

/**
 * 编译校验通过的标签定义：人群是全部统一消费者（silver._identities），每人一行，列为 consumer_id、tag_key（键 key）、tag_value。
 * 每个引用指标的 SQL 内联成一个 CTE 左连接进来，不在结果里（或取值为空）的按 missing 或缺省取值；规则按顺序写成 CASE WHEN，都没命中取 default
 */
export function compileTag(spec: TagSpec, ctx: DslContext, asOf: string, key: string): string {
  const metricKeys = tagMetrics(spec);
  const metrics = metricKeys.map(k => requireMetric(k, ctx));
  const valueOf = (metricKey: string) => {
    const i = metricKeys.indexOf(metricKey);
    const missing = spec.missing && metricKey in spec.missing ? spec.missing[metricKey]! : missingDefault(metrics[i]!);
    return missing === null ? `m${i}.value` : `COALESCE(m${i}.value, ${Number(missing)})`;
  };
  const whens = spec.rules.map(rule => {
    const { combinator, items } = ruleConditions(spec, rule.when);
    const terms = items.map(item => TAG_CONDITIONS.filter(c => item[c] !== undefined).map(c => `${valueOf(item.metric)} ${COMPARE[c]} ${Number(item[c])}`).join(' AND '));
    const condition = terms.length === 1 ? terms[0]! : terms.map(t => `(${t})`).join(combinator === 'all' ? ' AND ' : ' OR ');
    return `  WHEN ${condition} THEN ${lit(String(rule.value))}`;
  });
  return [
    `WITH u AS (SELECT DISTINCT consumer_id FROM ${IDENTITIES})`,
    ...metrics.flatMap((metric, i) => [`, m${i} AS (`, compileMetric(metric, ctx, asOf), ')']),
    `SELECT u.consumer_id, ${lit(key)} AS tag_key, CASE`,
    ...whens,
    `  ELSE ${lit(String(spec.default))}`,
    'END AS tag_value',
    'FROM u',
    ...metrics.map((_, i) => `LEFT JOIN m${i} ON m${i}.consumer_id = u.consumer_id`),
    'ORDER BY ALL',
  ].join('\n');
}

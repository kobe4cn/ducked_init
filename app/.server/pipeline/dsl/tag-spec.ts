// app/.server/pipeline/dsl/tag-spec.ts —— 标签定义（YAML，ADR-0025）：引用一个已发布、没有维度、取值为数字的指标，按规则给每个消费者一个取值。
// 规则按顺序取第一条命中的（when 里的条件全部满足才算命中），都没命中的取 default；取值是分析师写的常量。
// 标签只认指标最新的已发布版本（DslContext.metrics），指标草稿不影响标签（发布前的影响预览用 withMetric 换成草稿来算）。编译时把这一版指标的 SQL 内联成 CTE（不读指标快照），
// 结果覆盖指标结果里的每个消费者，列为 consumer_id、tag_key、tag_value；tag_key 是定义行上不变的键，写成字面量。
// 纯函数：不碰平台库与数据湖，同样的定义与 asOf 编译出同样的 SQL
import { Ajv } from 'ajv';
import { lit } from '../merge-engine';
import { compileMetric, isNumericMetric, metricEntities, parseDsl, type Dependencies, type DslCheck, type DslContext, type MetricSpec } from './metric-spec';

export const TAG_CONDITIONS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
type Condition = (typeof TAG_CONDITIONS)[number];

export interface TagSpec {
  /** 引用的指标键 */
  metric: string;
  /** 按顺序第一条命中的规则给出取值；when 里的条件全部满足才命中 */
  rules: { value: string | number; when: Partial<Record<Condition, number>> }[];
  /** 没命中任何规则时的取值 */
  default: string | number;
}

const tagValue = { type: ['string', 'number'] };

/** 标签定义的 JSON Schema */
export const TAG_SCHEMA = {
  type: 'object',
  required: ['metric', 'rules', 'default'],
  additionalProperties: false,
  properties: {
    metric: { type: 'string', minLength: 1 },
    rules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['value', 'when'],
        additionalProperties: false,
        properties: {
          value: tagValue,
          when: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: Object.fromEntries(TAG_CONDITIONS.map(c => [c, { type: 'number' }])),
          },
        },
      },
    },
    default: tagValue,
  },
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(TAG_SCHEMA);

/** 引用的指标：最新的已发布版本；不能用时返回原因 */
function metricOf(key: string, ctx: DslContext): MetricSpec | string {
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
function requireMetric(spec: TagSpec, ctx: DslContext): MetricSpec {
  const metric = metricOf(spec.metric, ctx);
  if (typeof metric === 'string') throw new Error(metric);
  return metric;
}

const blank = (v: string | number) => String(v).trim() === '';

/**
 * 校验标签定义：YAML 语法、JSON Schema，再检查引用的指标与取值。
 * 通过时返回定义，否则返回全部问题（按位置排序）
 */
export function checkTag(text: string, ctx: DslContext): DslCheck<TagSpec> {
  const parsed = parseDsl(text, validateSchema);
  if ('ok' in parsed) return parsed;
  const { value, issue, done } = parsed;
  const spec = value as TagSpec;

  const metric = metricOf(spec.metric, ctx);
  if (typeof metric === 'string') issue(['metric'], metric);
  for (const [i, rule] of spec.rules.entries()) if (blank(rule.value)) issue(['rules', i, 'value'], '取值不能为空');
  if (blank(spec.default)) issue(['default'], '取值不能为空');
  return done(spec);
}

/** 标签用到的实体：引用的指标用到的实体 */
export function tagEntities(spec: TagSpec, ctx: DslContext): string[] {
  return metricEntities(requireMetric(spec, ctx));
}

/** 标签的依赖：引用的指标键（实体与字段经由指标，指标在就删不掉） */
export const tagDependencies = (spec: TagSpec): Dependencies => ({ metrics: [spec.metric], entities: [], fields: [] });

const COMPARE: Record<Condition, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' };

/**
 * 编译校验通过的标签定义：引用指标的 SQL 内联成 CTE，每个消费者一行，列为 consumer_id、tag_key（键 key）、tag_value。
 * 规则按顺序写成 CASE WHEN，指标值为空时取 default
 */
export function compileTag(spec: TagSpec, ctx: DslContext, asOf: string, key: string): string {
  const metric = requireMetric(spec, ctx);
  const whens = spec.rules.map(rule => {
    const conditions = TAG_CONDITIONS.filter(c => rule.when[c] !== undefined).map(c => `m.value ${COMPARE[c]} ${Number(rule.when[c])}`);
    return `  WHEN ${conditions.join(' AND ')} THEN ${lit(String(rule.value))}`;
  });
  return [
    'WITH m AS (',
    compileMetric(metric, ctx, asOf),
    ')',
    `SELECT m.consumer_id, ${lit(key)} AS tag_key, CASE`,
    ...whens,
    `  ELSE ${lit(String(spec.default))}`,
    'END AS tag_value',
    'FROM m',
    'ORDER BY ALL',
  ].join('\n');
}

// app/lib/metric-vocab.ts —— 指标 DSL 的词汇表（前后端共用）：聚合、过滤运算与上限的常量，和它们的中文说明。
// 常量原在 .server/pipeline/dsl/metric-spec.ts、说明表原在 .server/catalog/capabilities.ts；指标表单（metric-form.ts，客户端也要用）
// 需要同一份，又不能从 .server 值 import（React Router 会拦客户端对 .server 的值 import），所以搬到这里，两边原名 re-export / import。
// 只能 import app/lib 里的东西（.server 的只能 import type）；说明表的文字是写给 DSL 能力说明的（如「为空（不写 value）」），表单下拉直接用，不另写一套
import type { FieldType } from './canonical-model';

export const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'ratio', 'latest', 'earliest', 'days_since'] as const;
/** ratio 的分子、分母能用的聚合 */
export const RATIO_AGGS = ['count', 'count_distinct', 'sum'] as const;
export const FILTER_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'] as const;
/** 维度最多几个、维度路径最多几跳 */
export const MAX_DIMENSIONS = 3;
export const MAX_HOPS = 3;

/** sum / avg 与 latest / earliest 的度量字段要用的类型 */
export const NUMERIC_TYPES: readonly FieldType[] = ['integer', 'decimal'];
/** 时间窗口、latest / earliest 的 by 与 days_since 的度量字段要用的类型 */
export const TEMPORAL_TYPES: readonly FieldType[] = ['timestamp', 'date'];

export const AGG_TEXT = {
  count: '行数；写了 field 时只数 field 不为空的行',
  count_distinct: 'field 的不同取值个数',
  sum: 'field（数字）求和',
  avg: 'field（数字）平均值',
  min: 'field 的最小值（数字、日期或时间）',
  max: 'field 的最大值（数字、日期或时间）',
  ratio: '比率：numerator / denominator，分子、分母各写 agg（只能是 count、count_distinct、sum）、field 与自己的 filter，与顶层 filter、window 叠加',
  latest: '按 by（日期或时间）取最新一行的 field（数字）',
  earliest: '按 by（日期或时间）取最早一行的 field（数字）',
  days_since: 'asOf 减 field（日期或时间）最近一天的天数',
} satisfies Record<(typeof AGGS)[number], string>;

export const RATIO_AGG_TEXT = {
  count: '分子或分母为行数',
  count_distinct: '分子或分母为 field 的不同取值个数',
  sum: '分子或分母为 field 求和',
} satisfies Record<(typeof RATIO_AGGS)[number], string>;

export const FILTER_OP_TEXT = {
  eq: '等于 value',
  ne: '不等于 value',
  in: '在 value 列表里',
  not_in: '不在 value 列表里',
  gt: '大于 value',
  gte: '大于等于 value',
  lt: '小于 value',
  lte: '小于等于 value',
  is_null: '为空（不写 value）',
  not_null: '不为空（不写 value）',
} satisfies Record<(typeof FILTER_OPS)[number], string>;

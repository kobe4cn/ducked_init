// app/.server/catalog/capabilities.ts —— 语义目录（ADR-0041）的平台能力说明：指标 DSL、标签 DSL 与分析模板三个条目，
// 内容从代码注册表（AGGS、RATIO_AGGS、FILTER_OPS、MAX_DIMENSIONS、MAX_HOPS、METRIC_SCHEMA、TAG_CONDITIONS、TEMPLATES）生成，
// 每项的说明写成 satisfies Record<注册表的项, …>，注册表新增一项却没写说明时类型检查不通过。
// 手写示例只用标准实体的非敏感字段，测试里逐个过 checkMetric / checkTag；模板产出列按各模板 compile 出来的 SELECT 写，测试里对照 DESCRIBE
import { CHANNELS } from '../../lib/canonical-model';
import { AGGS, FILTER_OPS, MAX_DIMENSIONS, MAX_HOPS, METRIC_SCHEMA, RATIO_AGGS } from '../pipeline/dsl/metric-spec';
import { TAG_CONDITIONS, TAG_SCHEMA } from '../pipeline/dsl/tag-spec';
import { TEMPLATES, type TemplateId } from '../pipeline/templates';
import type { DslKind } from '../pipeline/dsl';
import type { CapabilityEntry, CapabilityItem, OutputColumn } from './index';

const AGG_TEXT = {
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

const RATIO_AGG_TEXT = {
  count: '分子或分母为行数',
  count_distinct: '分子或分母为 field 的不同取值个数',
  sum: '分子或分母为 field 求和',
} satisfies Record<(typeof RATIO_AGGS)[number], string>;

const FILTER_OP_TEXT = {
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

const METRIC_KEY_TEXT = {
  base: '基础实体：customer，或有指向 customer 的 customer_id 的实体，或经一跳引用关联到这样的实体',
  consumer_via: '基础实体经哪个引用字段一跳关联消费者：只在有多条一跳可走时写',
  measure: '度量：agg 与 field（ratio 写 numerator / denominator，latest / earliest 另写 by）',
  filter: '过滤条件列表，全部满足才计入：每项 field、op、value；field 可以写维度路径',
  window: '时间窗口：field（日期或时间）落在 (asOf - days, asOf] 里才计入',
  dimensions: `维度，最多 ${MAX_DIMENSIONS} 个：每项 name（小写字母开头）与 path；path 沿关系走，最多 ${MAX_HOPS} 跳、不能成环，如 order.store_id -> store.name，consumer.<字段> 取统一消费者的属性`,
  device_attribution: '只有 base 为 event 时能写：匿名事件经 device_id 按设备归属计入，缺省为 true',
  description: '说明（可选，最多 500 字），目录与目录接口返回',
} satisfies Record<keyof typeof METRIC_SCHEMA.properties, string>;

const TAG_CONDITION_TEXT = {
  gte: '指标取值大于等于',
  gt: '指标取值大于',
  lte: '指标取值小于等于',
  lt: '指标取值小于',
  eq: '指标取值等于',
} satisfies Record<(typeof TAG_CONDITIONS)[number], string>;

const TAG_KEY_TEXT = {
  metric: '单指标写法引用的指标键：已发布、没有维度、取值为数字；多指标写法不写，指标写在每条规则的 all / any 里',
  rules: '规则列表，按顺序取第一条命中的：每条 value（取值）与 when（单指标写法是比较，多指标写法是 all / any 里的「metric + 比较」，只一层）',
  missing: '多指标写法里，消费者不在某指标结果里时按这里的取值比较（键是指标）；没写的计数与求和记 0、其余记空',
  default: '没命中任何规则时的取值',
  description: '说明（可选，最多 500 字），目录与目录接口返回',
} satisfies Record<keyof typeof TAG_SCHEMA.properties, string>;

/** 模板的产出：每个统一消费者一行，列按 compile 出来的 SELECT；快照表名为 gold.<模板 ID>__<任务 ID> */
export const TEMPLATE_OUTPUTS = {
  rfm: {
    description: '最近一次购买距 asOf 的天数（R）、单数（F）、金额（M），打 1–5 分后按分群规则归入人群',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'recency_days', type: 'INTEGER', description: '最近一次购买距 asOf 的天数' },
      { name: 'frequency', type: 'INTEGER', description: '回看窗口内的订单数' },
      { name: 'monetary', type: 'DECIMAL(38,2)', description: '回看窗口内的金额（元）' },
      { name: 'r', type: 'INTEGER', description: 'R 分（1–5）' },
      { name: 'f', type: 'INTEGER', description: 'F 分（1–5）' },
      { name: 'm', type: 'INTEGER', description: 'M 分（1–5）' },
      { name: 'segment', type: 'VARCHAR', description: '人群（按分群规则）' },
    ],
  },
  user360: {
    description: '每个统一消费者（没下过单的也在）回看窗口内的订单汇总与各渠道的营销同意',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'orders', type: 'INTEGER', description: '回看窗口内的订单数（0 单为 0）' },
      { name: 'monetary', type: 'DECIMAL(38,2)', description: '回看窗口内的金额（元，0 单为 0）' },
      { name: 'avg_order_value', type: 'DOUBLE', description: '客单价（元），0 单为空' },
      { name: 'first_order_date', type: 'DATE', description: '回看窗口内第一单的日期' },
      { name: 'last_order_date', type: 'DATE', description: '回看窗口内最后一单的日期' },
      { name: 'recency_days', type: 'INTEGER', description: '最后一单距 asOf 的天数' },
      { name: 'tenure_days', type: 'INTEGER', description: '第一单距 asOf 的天数' },
      ...CHANNELS.map(ch => ({ name: `consent_${ch}`, type: 'BOOLEAN', description: `${ch} 渠道最新的同意状态是 granted` })),
    ],
  },
  cohort: {
    description: '按首单所在周期（月或周）分群，每个消费者一行，用来聚合成留存矩阵',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'cohort_start', type: 'DATE', description: '首单所在周期的第一天' },
      { name: 'orders', type: 'INTEGER', description: '最近若干周期里的订单数' },
      { name: 'active_periods', type: 'INTEGER[]', description: '有订单的周期（距首单周期的偏移，0 为首单周期）' },
    ],
  },
  repurchase: {
    description: '回看窗口内至少一单的消费者：首单、第二单与第二单是否在首单后复购窗口内',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'orders', type: 'INTEGER', description: '回看窗口内的订单数' },
      { name: 'first_order_date', type: 'DATE', description: '首单日期' },
      { name: 'second_order_date', type: 'DATE', description: '第二单日期，没有为空' },
      { name: 'days_to_second', type: 'INTEGER', description: '首单到第二单的天数' },
      { name: 'repurchased', type: 'BOOLEAN', description: '第二单在首单后复购窗口内' },
    ],
  },
  clv: {
    description: '回看窗口内至少一单的消费者：历史频率与客单乘上按购买节奏衰减的存活概率，预测未来价值',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'orders', type: 'INTEGER', description: '回看窗口内的订单数' },
      { name: 'monetary', type: 'DOUBLE', description: '回看窗口内的金额（元）' },
      { name: 'avg_order_value', type: 'DOUBLE', description: '客单价（元）' },
      { name: 'recency_days', type: 'INTEGER', description: '最后一单距 asOf 的天数' },
      { name: 'tenure_days', type: 'INTEGER', description: '客龄（天，不小于最短客龄）' },
      { name: 'freq_per_year', type: 'DOUBLE', description: '年化购买频率' },
      { name: 'p_alive', type: 'DOUBLE', description: '存活概率（0–1）' },
      { name: 'clv', type: 'DECIMAL(18,2)', description: '预测天数内的价值（元）' },
    ],
  },
  churn: {
    description: '回看窗口内订单数够多的消费者：沉默天数超过平均间隔若干倍的标为有流失风险',
    columns: [
      { name: 'consumer_id', type: 'VARCHAR', description: '统一消费者 ID' },
      { name: 'orders', type: 'INTEGER', description: '回看窗口内的订单数' },
      { name: 'avg_gap_days', type: 'DOUBLE', description: '平均下单间隔（天）' },
      { name: 'recency_days', type: 'INTEGER', description: '最后一单距 asOf 的天数' },
      { name: 'silence_ratio', type: 'DOUBLE', description: '沉默天数 / 平均间隔（间隔不小于最短间隔）' },
      { name: 'at_risk', type: 'BOOLEAN', description: '有流失风险' },
    ],
  },
} satisfies Record<TemplateId, { description: string; columns: OutputColumn[] }>;

/** 手写示例：只用标准实体的非敏感字段；metric 示例的 key 供 tag 示例引用 */
export interface CapabilityExample { kind: DslKind; key: string; yaml: string; note: string }

export const CAPABILITY_EXAMPLES: CapabilityExample[] = [
  {
    kind: 'metric', key: 'revenue_30d', note: '近 30 天已支付订单的消费金额（每个消费者一个数，标签能引用）',
    yaml: `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, shipped, completed] }
window: { field: created_at, days: 30 }
description: 近 30 天消费金额
`,
  },
  {
    kind: 'metric', key: 'orders_by_channel', note: '各下单渠道的订单数（带维度，标签不能引用）',
    yaml: `base: order
measure: { agg: count }
dimensions:
  - { name: channel, path: order.channel }
`,
  },
  {
    kind: 'metric', key: 'category_spend_365d', note: '近 365 天各品类消费金额：订单明细经订单一跳关联消费者，品类经维度路径取自商品',
    yaml: `base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
window: { field: order_item.order_id -> order.created_at, days: 365 }
dimensions:
  - { name: category, path: order_item.product_id -> product.category }
`,
  },
  {
    kind: 'metric', key: 'paid_rate', note: '已支付订单占比（ratio）',
    yaml: `base: order
measure:
  agg: ratio
  numerator:
    agg: count
    filter:
      - { field: status, op: eq, value: paid }
  denominator: { agg: count }
`,
  },
  {
    kind: 'metric', key: 'days_since_last_order', note: '距最近一次下单的天数（days_since）',
    yaml: `base: order
measure: { agg: days_since, field: created_at }
`,
  },
  {
    kind: 'tag', key: 'spend_tier', note: '单指标写法：按近 30 天消费金额分层',
    yaml: `metric: revenue_30d
rules:
  - value: high
    when: { gte: 1000 }
  - value: mid
    when: { gte: 100, lt: 1000 }
default: low
`,
  },
  {
    kind: 'tag', key: 'active_buyer', note: '多指标写法：近 30 天有消费且距最近下单不超过 30 天',
    yaml: `rules:
  - value: active
    when:
      all:
        - { metric: revenue_30d, gt: 0 }
        - { metric: days_since_last_order, lte: 30 }
missing:
  days_since_last_order: 9999
default: inactive
`,
  },
];

const items = (texts: Record<string, string>): CapabilityItem[] => Object.entries(texts).map(([name, description]) => ({ name, description }));
const examplesOf = (kind: CapabilityExample['kind']) => CAPABILITY_EXAMPLES.filter(e => e.kind === kind).map(e => ({ key: e.key, yaml: e.yaml, note: e.note }));

const templateIds = Object.keys(TEMPLATES) as TemplateId[];

/** 三个能力说明条目 */
export const CAPABILITIES: CapabilityEntry[] = [
  {
    kind: 'capability', id: 'capability:metric-dsl', name: '指标 DSL',
    description: `用 YAML 在基础实体上定义一个度量，可带过滤、时间窗口与最多 ${MAX_DIMENSIONS} 个维度；维度路径最多 ${MAX_HOPS} 跳。不能用敏感字段`,
    sections: [
      { title: '顶层键', items: items(METRIC_KEY_TEXT) },
      { title: '度量 measure.agg', items: items(AGG_TEXT) },
      { title: 'ratio 分子 / 分母的 agg', items: items(RATIO_AGG_TEXT) },
      { title: '过滤运算 op', items: items(FILTER_OP_TEXT) },
      {
        title: '上限',
        items: [
          { name: 'dimensions', description: `最多 ${MAX_DIMENSIONS} 个维度` },
          { name: 'path', description: `维度路径最多 ${MAX_HOPS} 跳，每一跳是指向下一实体单列主键的关系，不能成环` },
        ],
      },
    ],
    examples: examplesOf('metric'),
  },
  {
    kind: 'capability', id: 'capability:tag-dsl', name: '标签 DSL',
    description: '用 YAML 按规则给每个统一消费者一个取值：引用已发布、没有维度、取值为数字的指标，规则按顺序取第一条命中的，都没命中取 default',
    sections: [
      { title: '顶层键', items: items(TAG_KEY_TEXT) },
      { title: '比较 when', items: items(TAG_CONDITION_TEXT) },
    ],
    examples: examplesOf('tag'),
  },
  {
    kind: 'capability', id: 'capability:templates', name: '分析模板',
    description: `平台内置的分析模板（${templateIds.join('、')}），读标准层、每个统一消费者一行，产出写进结果层快照 gold.<模板 ID>__<任务 ID>`,
    sections: templateIds.flatMap(id => [
      {
        title: `${id} ${TEMPLATES[id].label}：${TEMPLATE_OUTPUTS[id].description}；读 ${TEMPLATES[id].entities.join('、')}`,
        items: Object.entries(TEMPLATES[id].defaults).map(([name, value]) => ({ name, description: `参数，默认 ${JSON.stringify(value)}` })),
      },
      { title: `${id} 产出列`, items: TEMPLATE_OUTPUTS[id].columns },
    ]),
    examples: [],
  },
];

// test/knowledge-derive.test.ts —— 系统事实（ADR-0046 入口①）：指标与标签 DSL 确定性转口径文字。
// 每种度量（AGGS，含 ratio 的分子分母）、每种过滤运算（FILTER_OPS）、窗口、每种标签条件（TAG_CONDITIONS）、all / any、missing、default 各一条，断言整句；
// 同一份定义两次结果相同、键顺序不同的 yaml 结果相同（纯函数，不碰库）
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { metricClaims, metricText, tagClaims, tagText, TIME_FIELDS } from '../app/.server/knowledge/derive';
import { CANONICAL_ENTITIES } from '../app/lib/canonical-model';
import { CLAIM_TYPE_ORDER } from '../app/lib/semantic-claims';
import { AGGS, FILTER_OPS, type MetricSpec } from '../app/.server/pipeline/dsl/metric-spec';
import { TAG_CONDITIONS, type TagSpec } from '../app/.server/pipeline/dsl/tag-spec';

const metric = (yaml: string) => metricText(parse(yaml) as MetricSpec);
const tag = (yaml: string) => tagText(parse(yaml) as TagSpec);

const AGG_CASES: Record<(typeof AGGS)[number], [string, string][]> = {
  count: [['{ agg: count }', '订单中所有行，行数'], ['{ agg: count, field: paid_at }', '订单中所有行，paid_at 不为空的行数']],
  count_distinct: [['{ agg: count_distinct, field: store_id }', '订单中所有行，store_id 的不同取值个数']],
  sum: [['{ agg: sum, field: amount }', '订单中所有行，amount 求和']],
  avg: [['{ agg: avg, field: amount }', '订单中所有行，amount 平均值']],
  min: [['{ agg: min, field: amount }', '订单中所有行，amount 最小值']],
  max: [['{ agg: max, field: paid_at }', '订单中所有行，paid_at 最大值']],
  ratio: [[
    '{ agg: ratio, numerator: { agg: sum, field: amount, filter: [{ field: status, op: eq, value: paid }] }, denominator: { agg: count_distinct, field: order_id } }',
    '订单中所有行，分子：status 等于 paid的行，amount 求和；分母：order_id 的不同取值个数',
  ], [
    '{ agg: ratio, numerator: { agg: count, filter: [{ field: status, op: in, value: [paid, shipped] }] }, denominator: { agg: count } }',
    '订单中所有行，分子：status 在 paid、shipped 中的行，行数；分母：行数',
  ]],
  latest: [['{ agg: latest, field: amount, by: paid_at }', '订单中所有行，按 paid_at 取最新一行的 amount']],
  earliest: [['{ agg: earliest, field: amount, by: paid_at }', '订单中所有行，按 paid_at 取最早一行的 amount']],
  days_since: [['{ agg: days_since, field: paid_at }', '订单中所有行，距 paid_at 最近一天的天数']],
};

const OP_CASES: Record<(typeof FILTER_OPS)[number], [string, string]> = {
  eq: ['{ field: status, op: eq, value: paid }', 'status 等于 paid'],
  ne: ['{ field: status, op: ne, value: cancelled }', 'status 不等于 cancelled'],
  in: ['{ field: status, op: in, value: [paid, shipped] }', 'status 在 paid、shipped 中'],
  not_in: ['{ field: status, op: not_in, value: [cancelled, refunded] }', 'status 不在 cancelled、refunded 中'],
  gt: ['{ field: amount, op: gt, value: 100 }', 'amount 大于 100'],
  gte: ['{ field: amount, op: gte, value: 100 }', 'amount 大于等于 100'],
  lt: ['{ field: amount, op: lt, value: 0.5 }', 'amount 小于 0.5'],
  lte: ['{ field: amount, op: lte, value: 100 }', 'amount 小于等于 100'],
  is_null: ['{ field: paid_at, op: is_null }', 'paid_at 为空'],
  not_null: ['{ field: paid_at, op: not_null }', 'paid_at 不为空'],
};

const CONDITION_CASES: Record<(typeof TAG_CONDITIONS)[number], [string, string]> = {
  gte: ['{ gte: 1000 }', '大于等于 1000'],
  gt: ['{ gt: 1000 }', '大于 1000'],
  lte: ['{ lte: 10 }', '小于等于 10'],
  lt: ['{ lt: 10 }', '小于 10'],
  eq: ['{ eq: 0 }', '等于 0'],
};

describe('指标口径文字', () => {
  it('每种度量各一条（含 ratio 的分子分母各带自己的过滤，latest / earliest 写出 by）', () => {
    expect(Object.keys(AGG_CASES).sort()).toEqual([...AGGS].sort());
    for (const [measure, text] of Object.values(AGG_CASES).flat()) expect(metric(`base: order\nmeasure: ${measure}\n`)).toBe(text);
  });

  it('每种过滤运算各一条：in / not_in 的值用「、」连接，is_null / not_null 不带值', () => {
    expect(Object.keys(OP_CASES).sort()).toEqual([...FILTER_OPS].sort());
    for (const [cond, text] of Object.values(OP_CASES)) {
      expect(metric(`base: order\nfilter: [${cond}]\nmeasure: { agg: count }\n`)).toBe(`订单中 ${text}的行，行数`);
    }
  });

  it('过滤与窗口一起：「订单中 status 等于 paid、paid_at 在最近 30 天内的行，amount 求和」；只有窗口时只写窗口', () => {
    expect(metric('base: order\nfilter: [{ field: status, op: eq, value: paid }]\nwindow: { field: paid_at, days: 30 }\nmeasure: { agg: sum, field: amount }\n'))
      .toBe('订单中 status 等于 paid、paid_at 在最近 30 天内的行，amount 求和');
    expect(metric('base: customer\nwindow: { field: created_at, days: 7 }\nmeasure: { agg: count }\n')).toBe('消费者中 created_at 在最近 7 天内的行，行数');
  });

  it('同一份定义两次结果相同，键顺序不同的 yaml 结果相同', () => {
    const a = 'base: order\nfilter: [{ field: status, op: in, value: [paid, shipped] }]\nwindow: { field: paid_at, days: 30 }\nmeasure: { agg: latest, field: amount, by: paid_at }\n';
    const b = 'measure: { by: paid_at, field: amount, agg: latest }\nwindow: { days: 30, field: paid_at }\nfilter: [{ value: [paid, shipped], op: in, field: status }]\nbase: order\n';
    expect(metric(a)).toBe(metric(a));
    expect(metric(b)).toBe(metric(a));
  });
});

describe('标签口径文字', () => {
  it('单指标写法：每种条件各一条，多个比较用「且」连接，missing 与 default', () => {
    expect(Object.keys(CONDITION_CASES).sort()).toEqual([...TAG_CONDITIONS].sort());
    for (const [when, text] of Object.values(CONDITION_CASES)) {
      expect(tag(`metric: revenue\nrules: [{ value: 是, when: ${when} }]\ndefault: 否\n`)).toBe(`按指标 revenue：${text} 时为 是；其余为 否`);
    }
    expect(tag('metric: revenue\nrules:\n  - { value: 高, when: { gte: 1000 } }\n  - { value: 中, when: { lt: 1000, gte: 100 } }\nmissing: { revenue: 0 }\ndefault: 低\n'))
      .toBe('按指标 revenue：大于等于 1000 时为 高；大于等于 100且小于 1000 时为 中；指标 revenue 为空时按 0 比较；其余为 低');
  });

  it('多指标写法：all 用「且」、any 用「或」连接，missing 按指标键排序，为 null 时不满足任何比较', () => {
    expect(tag([
      'rules:',
      '  - { value: 忠诚, when: { all: [{ metric: revenue, gte: 1000 }, { metric: orders, gte: 5 }] } }',
      '  - { value: 活跃, when: { any: [{ metric: orders, gt: 0 }, { metric: visits, gte: 3 }] } }',
      'missing: { visits: null, orders: 0 }',
      'default: 普通',
    ].join('\n'))).toBe('按指标 revenue、orders、visits：revenue 大于等于 1000 且 orders 大于等于 5 时为 忠诚；orders 大于 0 或 visits 大于等于 3 时为 活跃；'
      + '指标 orders 为空时按 0 比较；指标 visits 为空时不满足任何比较；其余为 普通');
  });

  it('键顺序不同的 yaml 结果相同', () => {
    const a = 'metric: revenue\nrules: [{ value: 高, when: { gte: 100, lt: 1000 } }]\nmissing: { revenue: 0 }\ndefault: 低\n';
    const b = 'default: 低\nmissing: { revenue: 0 }\nrules: [{ when: { lt: 1000, gte: 100 }, value: 高 }]\nmetric: revenue\n';
    expect(tag(a)).toBe(tag(a));
    expect(tag(b)).toBe(tag(a));
  });
});

describe('系统口径声明', () => {
  const spec = (yaml: string) => parse(yaml) as MetricSpec;
  const claimsOf = (yaml: string) => Object.fromEntries(metricClaims(spec(yaml)).map(c => [c.type, c.value]));
  const timeOf = (base: string, field?: string) =>
    claimsOf(`base: ${base}\n${field ? `window: { field: ${field}, days: 30 }\n` : ''}measure: { agg: count }\n`).time_meaning;
  const tagSpec = (yaml: string) => parse(yaml) as TagSpec;
  const tagClaim = (yaml: string, metrics: Record<string, string>) =>
    Object.fromEntries(tagClaims(tagSpec(yaml), new Map(Object.entries(metrics).map(([k, y]) => [k, spec(y)]))).map(c => [c.type, c.value]));

  it('五项按登记表顺序，每项都有值，派生声明不带 previous / needsReview', () => {
    const claims = metricClaims(spec('base: order\nmeasure: { agg: sum, field: amount }\n'));
    expect(claims.map(c => c.type)).toEqual(CLAIM_TYPE_ORDER);
    for (const c of claims) expect(Object.keys(c).sort()).toEqual(['type', 'value']);
    const tc = tagClaims(tagSpec('metric: revenue\nrules: [{ value: 是, when: { gte: 1 } }]\ndefault: 否\n'), new Map());
    expect(tc.map(c => c.type)).toEqual(CLAIM_TYPE_ORDER);
  });

  it('每种度量的单位：count / count_distinct → count，days_since → day，ratio → ratio，其余未知', () => {
    const expected: Record<(typeof AGGS)[number], string> = {
      count: 'count', count_distinct: 'count', sum: 'unknown', avg: 'unknown', min: 'unknown', max: 'unknown',
      ratio: 'ratio', latest: 'unknown', earliest: 'unknown', days_since: 'day',
    };
    expect(Object.keys(expected).sort()).toEqual([...AGGS].sort());
    for (const [agg, cases] of Object.entries(AGG_CASES)) {
      for (const [measure] of cases) expect(claimsOf(`base: order\nmeasure: ${measure}\n`).unit, measure).toBe(expected[agg as (typeof AGGS)[number]]);
    }
  });

  it('时间含义只来自 window.field 命中标准字段表', () => {
    expect(timeOf('order', 'created_at')).toBe('order_time');
    expect(timeOf('order', 'paid_at')).toBe('pay_time');
    expect(timeOf('event', 'occurred_at')).toBe('event_time');
    expect(timeOf('order', 'updated_at')).toBe('record_time');
    expect(timeOf('customer', 'updated_at')).toBe('record_time');
  });

  it('扩展字段、自定义实体（含其 updated_at）、表外的标准字段、没有 window 都是未知', () => {
    expect(timeOf('order', 'x_settle_at')).toBe('unknown');
    expect(timeOf('custom_store', 'updated_at')).toBe('unknown');
    expect(timeOf('custom_store', 'created_at')).toBe('unknown');
    expect(timeOf('coupon', 'issued_at')).toBe('unknown');
    expect(timeOf('order')).toBe('unknown');
  });

  it('币种、含税、扣退款永远未知：字段说明里写「元」也不算依据', () => {
    const c = claimsOf('base: order\ndescription: 订单金额（元，含税，已扣退款）\nwindow: { field: paid_at, days: 30 }\nmeasure: { agg: sum, field: amount }\n');
    expect(c).toEqual({ unit: 'unknown', currency: 'unknown', tax_included: 'unknown', refund_deducted: 'unknown', time_meaning: 'pay_time' });
  });

  it('时间字段表的每项都是标准实体的 timestamp 字段', () => {
    expect(Object.keys(TIME_FIELDS).length).toBeGreaterThan(0);
    for (const key of Object.keys(TIME_FIELDS)) {
      const [entity, field] = key.split('.');
      expect(CANONICAL_ENTITIES.find(e => e.name === entity)?.fields.find(f => f.name === field)?.type, key).toBe('timestamp');
    }
    for (const e of CANONICAL_ENTITIES) {
      if (e.fields.some(f => f.name === 'updated_at')) expect(timeOf(e.name, 'updated_at'), e.name).toBe('record_time');
    }
  });

  const PAID = 'base: order\nwindow: { field: paid_at, days: 30 }\nmeasure: { agg: sum, field: amount }\n';
  const CREATED = 'base: order\nwindow: { field: created_at, days: 30 }\nmeasure: { agg: count }\n';

  it('标签：单位不适用；单指标取被引用指标的时间含义，被引用指标不在本批时未知', () => {
    const single = 'metric: revenue\nrules: [{ value: 高, when: { gte: 1000 } }]\ndefault: 低\n';
    expect(tagClaim(single, { revenue: PAID })).toEqual({
      unit: 'not_applicable', currency: 'unknown', tax_included: 'unknown', refund_deducted: 'unknown', time_meaning: 'pay_time',
    });
    expect(tagClaim(single, {}).time_meaning).toBe('unknown');
  });

  it('标签：多指标全部在本批且一致时取该值，有一个缺失或不一致时未知', () => {
    const multi = 'rules:\n  - { value: 忠诚, when: { all: [{ metric: revenue, gte: 1000 }, { metric: orders, gte: 5 }] } }\ndefault: 普通\n';
    expect(tagClaim(multi, { revenue: PAID, orders: PAID }).time_meaning).toBe('pay_time');
    expect(tagClaim(multi, { revenue: PAID, orders: CREATED }).time_meaning).toBe('unknown');
    expect(tagClaim(multi, { revenue: PAID }).time_meaning).toBe('unknown');
    expect(tagClaim(multi, { revenue: 'base: order\nmeasure: { agg: count }\n', orders: 'base: order\nmeasure: { agg: count }\n' }).time_meaning).toBe('unknown');
  });
});

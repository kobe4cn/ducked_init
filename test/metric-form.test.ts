// test/metric-form.test.ts —— 指标表单 ↔ MetricSpec YAML 互转与四句摘要（纯函数，不碰库）：opsFor 按字段类型给出可用运算（boolean / string 受限，没有 OR / any）；
// count / sum / ratio / latest 的表单写成 YAML 过 checkMetric，读回与原表单相等（往返不丢信息，取值按字段类型转换）；
// consumer_via、device_attribution、路径（-> / consumer.）、维度的 as_of 与不认识的键标成只读并说明原因，raw 原样写回后仍过 checkMetric、与原定义深相等；
// summarize 四句（ratio + 过滤 + 窗口）与非 ratio 三句的全文；过滤句写「只算…的记录」，分子、分母的过滤各自写明范围
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { entityOf, type CustomEntityField, type EntityRelation } from '../app/lib/canonical-model';
import type { RegisteredEntity } from '../app/.server/custom-entities';
import { checkMetric, type DslContext } from '../app/.server/pipeline/dsl/metric-spec';
import { FILTER_OPS, FILTER_OP_TEXT } from '../app/lib/metric-vocab';
import { formToYaml, opsFor, summarize, yamlToForm, type FormField, type MetricForm } from '../app/lib/metric-form';

const field = (name: string, type: CustomEntityField['type'] = 'string'): CustomEntityField => ({ name, type, description: '', sensitive: false });
const rel = (from: string, to: string): EntityRelation => {
  const [fe, ff] = from.split('.'), [te, tf] = to.split('.');
  return { from: { entity: fe!, field: ff! }, ref: { entity: te!, field: tf! } };
};
const entity = (name: string, fields: CustomEntityField[], relations: EntityRelation[]): [string, RegisteredEntity] =>
  [name, { name, label: name, kind: 'dimension', fields, primaryKey: [fields[0]!.name], relations }];

// 订单明细两条引用（订单、到访）都能一跳连到消费者，要写 consumer_via；门店经订单的 store_id 关联
const ctx: DslContext = {
  published: new Map([
    entity('custom_store', [field('store_id'), field('name')], [rel('order.store_id', 'custom_store.store_id')]),
    entity('custom_visit', [field('visit_id'), field('customer_id')], [rel('custom_visit.customer_id', 'customer.customer_id')]),
    entity('custom_line', [field('line_id'), field('order_id'), field('visit_id'), field('qty', 'integer')],
      [rel('custom_line.order_id', 'order.order_id'), rel('custom_line.visit_id', 'custom_visit.visit_id')]),
  ]),
  plans: [],
  metrics: new Map(),
};

// 表单字段照 fieldsFor 的样子给（标准实体带上中文名，摘要用 label ?? name）
const ORDER: FormField[] = entityOf('order')!.fields
  .filter(f => !f.pii)
  .map(f => ({ name: f.name, type: f.type, label: f.label, ...(f.enum && { enum: f.enum }) }));
const LINE: FormField[] = [field('line_id'), field('order_id'), field('visit_id'), field('qty', 'integer')]
  .map(f => ({ name: f.name, type: f.type }));

const empty: Pick<MetricForm, 'filter' | 'dimensions' | 'readonly'> = { filter: [], dimensions: [], readonly: [] };

/** 表单 → YAML 过 checkMetric，再读回与原表单相等 */
function roundTrip(form: MetricForm, fields: FormField[]) {
  const yaml = formToYaml(form, fields);
  expect(checkMetric(yaml, ctx).ok, yaml).toBe(true);
  expect(yamlToForm(yaml, fields), yaml).toEqual(form);
}

describe('按字段类型给可用运算', () => {
  it('boolean 只有等于 / 不等于 / 判空，string 另有 in / not_in，都没有大小比较与 OR / any', () => {
    expect(opsFor('boolean').map(o => o.op)).toEqual(['eq', 'ne', 'is_null', 'not_null']);
    expect(opsFor('string').map(o => o.op)).toEqual(['eq', 'ne', 'in', 'not_in', 'is_null', 'not_null']);
  });

  it('整数、小数、时间与日期给全部运算，label 取词汇表的中文说明', () => {
    for (const type of ['integer', 'decimal', 'timestamp', 'date'] as const) {
      expect(opsFor(type).map(o => o.op)).toEqual([...FILTER_OPS]);
      expect(opsFor(type).map(o => o.label)).toEqual(FILTER_OPS.map(op => FILTER_OP_TEXT[op]));
    }
  });
});

describe('表单 ↔ YAML 往返', () => {
  it('count：不带 field、带一条 eq 过滤', () => {
    roundTrip({ base: 'order', agg: 'count', ...empty, filter: [{ field: 'status', op: 'eq', value: 'paid' }] }, ORDER);
  });

  it('sum：in / not_in 写列表、数字字段的取值写成数字，带窗口与一段维度路径', () => {
    roundTrip({
      base: 'order', agg: 'sum', field: 'amount', ...empty,
      filter: [{ field: 'status', op: 'in', value: ['paid', 'completed'] }, { field: 'amount', op: 'gt', value: '100' }],
      window: { field: 'created_at', days: 30 },
      dimensions: [{ name: 'channel', path: 'order.channel' }],
    }, ORDER);
    expect(formToYaml({ base: 'order', agg: 'sum', field: 'amount', ...empty }, ORDER)).toContain('field: amount');
  });

  it('ratio：只写 numerator / denominator，各自的 filter 叠加', () => {
    roundTrip({
      base: 'order', agg: 'ratio',
      numerator: { agg: 'count', filter: [{ field: 'status', op: 'eq', value: 'paid' }] },
      denominator: { agg: 'sum', field: 'amount', filter: [] },
      ...empty,
    }, ORDER);
  });

  it('latest：field + by；切换 agg 后不适用的键不写（latest 不带 by、sum 不带 by）', () => {
    roundTrip({ base: 'order', agg: 'latest', field: 'amount', by: 'created_at', ...empty }, ORDER);
    expect(formToYaml({ base: 'order', agg: 'sum', field: 'amount', by: 'created_at', ...empty }, ORDER)).not.toContain('by:');
  });
});

describe('表单表达不了的写法只读', () => {
  it('consumer_via、路径与维度的 as_of 标成只读并说明原因，raw 原样写回后仍过 checkMetric、与原定义深相等', () => {
    const yaml = `base: custom_line
consumer_via: order_id
measure: { agg: sum, field: qty }
filter:
  - { field: custom_line.order_id -> order.status, op: in, value: [paid, completed] }
window: { field: custom_line.order_id -> order.created_at, days: 365 }
dimensions:
  - name: store
    path: custom_line.order_id -> order.store_id -> custom_store.name
    as_of: current
`;
    const form = yamlToForm(yaml, LINE);
    expect(form.base).toBe('custom_line');
    expect(form.agg).toBe('sum');
    expect(form.field).toBe('qty');
    expect(form.filter).toEqual([]);
    expect(form.dimensions).toEqual([]);
    expect(form.window).toBeUndefined();
    expect(form.readonly.map(r => r.key)).toEqual(['consumer_via', 'filter.0', 'window', 'dimensions.0']);
    for (const r of form.readonly) expect(r.reason, r.key).toContain('请在 YAML 里修改');
    const out = formToYaml(form, LINE);
    expect(checkMetric(out, ctx).ok, out).toBe(true);
    expect(parse(out), out).toEqual(parse(yaml));
  });

  it('device_attribution、不认识的顶层键与度量的字段路径同样只读，写回不丢', () => {
    const yaml = `base: order
device_attribution: true
renamed: { a: 1 }
measure: { agg: count, field: order.store_id -> custom_store.name }
`;
    const form = yamlToForm(yaml, ORDER);
    expect(form.readonly.map(r => r.key)).toEqual(['device_attribution', 'renamed', 'measure.field']);
    for (const r of form.readonly) expect(r.reason, r.key).toContain('请在 YAML 里修改');
    expect(parse(formToYaml(form, ORDER))).toEqual(parse(yaml));
  });

  it('ratio 分子 filter 里的路径条目只读，写回时放回分子 filter 的原下标', () => {
    const yaml = `base: order
measure:
  agg: ratio
  numerator:
    agg: count
    filter:
      - { field: status, op: eq, value: paid }
      - { field: order.store_id -> custom_store.name, op: eq, value: milk }
  denominator: { agg: count }
`;
    const form = yamlToForm(yaml, ORDER);
    expect(form.readonly.map(r => r.key)).toEqual(['measure.numerator.filter.1']);
    const out = formToYaml(form, ORDER);
    expect(checkMetric(out, ctx).ok, out).toBe(true);
    expect(parse(out), out).toEqual(parse(yaml));
  });
});

describe('四句摘要', () => {
  it('ratio + 过滤 + 窗口给四句全文', () => {
    expect(summarize({
      base: 'order', agg: 'ratio', ...empty,
      numerator: { agg: 'count', filter: [{ field: 'status', op: 'eq', value: 'paid' }] },
      denominator: { agg: 'sum', field: 'amount', filter: [] },
      filter: [{ field: 'channel', op: 'not_null' }],
      window: { field: 'created_at', days: 30 },
    }, ORDER)).toEqual([
      '计算分子行数 ÷ 分母实付金额求和。',
      '只算 渠道 不为空 的记录；分子只算 订单状态 等于 paid 的记录。',
      '近 30 天，按下单时间。',
      '分母为 0 或为空时结果记为空。',
    ]);
  });

  it('非 ratio、无窗口时三句：聚合、过滤、不限时间', () => {
    expect(summarize({ base: 'order', agg: 'count', ...empty, filter: [{ field: 'status', op: 'eq', value: 'paid' }] }, ORDER))
      .toEqual(['计算行数。', '只算 订单状态 等于 paid 的记录。', '不限时间。']);
  });

  it('ratio 只有分母过滤时第二句只说分母的范围，不说成排除整个指标的记录', () => {
    expect(summarize({
      base: 'order', agg: 'ratio', ...empty,
      numerator: { agg: 'count', filter: [] },
      denominator: { agg: 'count', filter: [{ field: 'status', op: 'in', value: ['paid', 'completed'] }, { field: 'channel', op: 'not_null' }] },
    }, ORDER)[1]).toBe('分母只算 订单状态 在 paid、completed 中并且渠道 不为空 的记录。');
    expect(summarize({ base: 'order', agg: 'count', ...empty }, ORDER)[1]).toBe('不排除任何记录。');
  });
});

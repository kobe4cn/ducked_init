// test/metric-spec.test.ts —— 指标 DSL：YAML 校验与按行列报错（基础实体、字段、敏感字段、维度路径的关系 / 跳数 / 成环、维度个数、as_of），
// filter、measure、window 的字段写维度路径（ADR-0038）的校验、依赖与 JOIN 复用；基础实体经一跳引用关联消费者（consumer_via）的校验、依赖与编译；同样的定义编译出同样的 SQL，编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisteredEntity } from '../app/.server/custom-entities';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';
import { checkMetric, compileMetric, type DslContext, type MetricSpec } from '../app/.server/pipeline/dsl/metric-spec';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import type { CustomEntityField, EntityRelation } from '../app/lib/canonical-model';

const field = (name: string, type: CustomEntityField['type'] = 'string', sensitive = false): CustomEntityField => ({ name, type, description: '', sensitive });
const rel = (from: string, to: string): EntityRelation => {
  const [fe, ff] = from.split('.'), [te, tf] = to.split('.');
  return { from: { entity: fe!, field: ff! }, ref: { entity: te!, field: tf! } };
};
const entity = (name: string, fields: CustomEntityField[], relations: EntityRelation[] = []): [string, RegisteredEntity] =>
  [name, { name, label: name, kind: 'dimension', fields, primaryKey: [fields[0]!.name], relations }];

// 门店 → 区域 → 国家 → 大洲；门店有指向自己的上级门店；custom_visit 是带 customer_id 的事实实体，referrer_id 是另一个指向 customer 的引用；
// custom_line 没有 customer_id，order_id、visit_id 两条引用都能连到消费者（要写 consumer_via），store_id 指向的门店连不到
const published = new Map<string, RegisteredEntity>([
  entity('custom_store', [field('store_id'), field('region_id'), field('name'), field('parent_id'), field('area', 'decimal')],
    [rel('order.store_id', 'custom_store.store_id'), rel('custom_store.region_id', 'custom_region.region_id'), rel('custom_store.parent_id', 'custom_store.store_id')]),
  entity('custom_region', [field('region_id'), field('name'), field('manager_phone', 'string', true), field('country_id')],
    [rel('custom_region.country_id', 'custom_country.country_id')]),
  entity('custom_country', [field('country_id'), field('continent_id')], [rel('custom_country.continent_id', 'custom_continent.continent_id')]),
  entity('custom_continent', [field('continent_id'), field('name')]),
  entity('custom_visit', [field('visit_id'), field('customer_id'), field('visited_on', 'date'), field('minutes', 'integer'), field('referrer_id')],
    [rel('custom_visit.customer_id', 'customer.customer_id'), rel('custom_visit.referrer_id', 'customer.customer_id')]),
  // 会员档案：主键 customer_id 指向 customer，与 customer 一样只在同一数据源内唯一
  entity('custom_profile', [field('customer_id'), field('tier')],
    [rel('custom_profile.customer_id', 'customer.customer_id'), rel('order.customer_id', 'custom_profile.customer_id')]),
  entity('custom_line', [field('line_id'), field('order_id'), field('visit_id'), field('store_id'), field('qty', 'integer')],
    [rel('custom_line.order_id', 'order.order_id'), rel('custom_line.visit_id', 'custom_visit.visit_id'), rel('custom_line.store_id', 'custom_store.store_id')]),
]);
const plan = (entity: string, columns: { name: string; type: CustomEntityField['type']; sensitive?: true }[]) =>
  ({ entity, columns: columns.map(c => ({ ...c, expr: c.name })) }) as unknown as MergeMappingParam;
const ctx: DslContext = {
  published,
  plans: [plan('order', [{ name: 'x_vip_level', type: 'string' }, { name: 'x_buyer_phone', type: 'string', sensitive: true }])],
  metrics: new Map(),
};

const ok = (yaml: string): MetricSpec => {
  const r = checkMetric(yaml, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.spec;
};
const issues = (yaml: string) => {
  const r = checkMetric(yaml, ctx);
  if (r.ok) throw new Error('应当校验不通过');
  return r.issues;
};

const REGION = `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, completed] }
window: { field: created_at, days: 30 }
dimensions:
  - name: region
    path: order.store_id -> custom_store.region_id -> custom_region.name
`;

const RATIO = `base: order
measure:
  agg: ratio
  numerator:
    agg: count
    filter:
      - { field: status, op: eq, value: paid }
  denominator: { agg: count }
`;
// 近 365 天各品类消费金额：order_item 经 order_id 一跳关联消费者，状态与时间取自订单，品类取自商品
const ITEM_CATEGORY = `base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
window: { field: order_item.order_id -> order.created_at, days: 365 }
dimensions:
  - { name: category, path: order_item.product_id -> product.category }
`;
// 近 365 天奶粉消费金额：按品类过滤、没有维度，标签能引用
const MILK = `base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
  - { field: order_item.product_id -> product.category, op: eq, value: 奶粉 }
window: { field: order_item.order_id -> order.created_at, days: 365 }
`;
const LATEST = 'base: order\nmeasure: { agg: latest, field: amount, by: created_at }\n';
const DAYS_SINCE = 'base: order\nmeasure: { agg: days_since, field: created_at }\n';

describe('指标 DSL：校验', () => {
  it('合规的定义通过，注册表登记了 metric', () => {
    expect(ok(REGION)).toMatchObject({ base: 'order', measure: { agg: 'sum', field: 'amount' } });
    expect(DSL_KINDS.metric.check).toBe(checkMetric);
    expect(DSL_KINDS.metric.entities(ok(REGION), ctx)).toEqual(['custom_region', 'custom_store', 'order']);
  });

  it('可选的 description：写了带进定义，不写照常通过；不是字符串或超过 500 字被拒', () => {
    expect(ok(`description: 近 30 天各区域销售额\n${REGION}`).description).toBe('近 30 天各区域销售额');
    expect(ok(REGION).description).toBeUndefined();
    expect(issues(`description: [a]\n${REGION}`)).toEqual([{ line: 1, col: 14, path: 'description', message: '应为文本' }]);
    expect(issues(`description: ${'说'.repeat(501)}\n${REGION}`)).toEqual([expect.objectContaining({ path: 'description', message: '不能超过 500 字' })]);
  });

  it('基础实体可以是 customer、带指向 customer 的 customer_id 的自定义实体；x_ 字段只认已发布映射里的', () => {
    ok('base: customer\nmeasure: { agg: count }\n');
    ok('base: custom_visit\nmeasure: { agg: sum, field: minutes }\nwindow: { field: visited_on, days: 7 }\n');
    ok('base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: vip, path: order.x_vip_level }\n');
    expect(issues('base: order\nmeasure: { agg: count_distinct, field: x_draft_only }\n')[0]).toMatchObject({ line: 2, message: expect.stringMatching(/x_draft_only/) });
  });

  it.each([
    ['YAML 语法错', 'base: [order\n', 2, /YAML 语法错误/],
    ['缺 measure', 'base: order\n', 1, /缺少 measure/],
    ['基础实体没有引用 customer 的 customer_id', 'base: product\nmeasure: { agg: count }\n', 1, /customer_id/],
    ['未知实体', 'base: nothing\nmeasure: { agg: count }\n', 1, /没有实体 nothing/],
    ['未发布或未确认的自定义实体', 'base: custom_draft\nmeasure: { agg: count }\n', 1, /custom_draft.*发布/],
    ['未知字段', 'base: order\nmeasure: { agg: sum, field: nope }\n', 2, /没有字段 nope/],
    ['sum 用了文本字段', 'base: order\nmeasure: { agg: sum, field: channel }\n', 2, /整数或小数/],
    ['除 count 以外要写字段', 'base: order\nmeasure: { agg: max }\n', 2, /要写 field/],
    ['度量用了敏感字段', 'base: customer\nmeasure: { agg: count_distinct, field: phone }\n', 2, /敏感/],
    ['度量用了映射标成敏感的 x_ 字段', 'base: order\nmeasure: { agg: count_distinct, field: x_buyer_phone }\n', 2, /敏感/],
    ['过滤用了敏感字段', 'base: customer\nmeasure: { agg: count }\nfilter:\n  - { field: email, op: not_null }\n', 4, /敏感/],
    ['过滤的取值类型不对', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: amount, op: gt, value: abc }\n', 4, /数字/],
    ['过滤的取值不在标准枚举里', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: status, op: eq, value: lost }\n', 4, /status.*paid/],
    ['in 要给列表', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: status, op: in, value: paid }\n', 4, /列表/],
    ['窗口不是时间或日期字段', 'base: order\nmeasure: { agg: count }\nwindow: { field: amount, days: 30 }\n', 3, /时间或日期/],
    ['维度终点是敏感字段', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - name: r\n    path: order.store_id -> custom_store.region_id -> custom_region.manager_phone\n', 5, /敏感/],
    ['维度路径一跳不是指向主键的关系', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - name: r\n    path: order.channel -> custom_store.name\n', 5, /order\.channel.*custom_store/],
    ['维度路径第一段不是基础实体', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - name: r\n    path: custom_store.name\n', 5, /基础实体 order/],
    ['维度路径超过 3 跳', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - name: r\n    path: order.store_id -> custom_store.region_id -> custom_region.country_id -> custom_country.continent_id -> custom_continent.name\n', 5, /3 跳/],
    ['维度路径成环', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - name: r\n    path: order.store_id -> custom_store.parent_id -> custom_store.name\n', 5, /成环/],
    ['超过 3 个维度', `base: order\nmeasure: { agg: count }\ndimensions:\n${['a', 'b', 'c', 'd'].map(n => `  - { name: ${n}, path: order.channel }\n`).join('')}`, 4, /最多 3 个/],
    ['维度名重复', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: order.channel }\n  - { name: a, path: order.status }\n', 5, /重复/],
    ['as_of 不是 current', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: order.channel, as_of: "2024-01-01" }\n', 4, /暂不支持按时间点关联/],
    ['consumer 维度用了敏感字段', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: consumer.phone }\n', 4, /敏感字段 consumer\.phone/],
    ['consumer 维度没有这个字段', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: consumer.customer_id }\n', 4, /consumer 没有字段 customer_id/],
    ['consumer 维度写了多段', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: consumer.city -> custom_store.name }\n', 4, /只能写一段/],
    ['基础实体没有 customer_id 时不能按 consumer 做维度', 'base: custom_store\nmeasure: { agg: count }\ndimensions:\n  - { name: a, path: consumer.city }\n', 4, /custom_store 没有 customer_id，不能按 consumer 做维度/],
    ['sum 的字段路径终点是文本', 'base: order\nmeasure: { agg: sum, field: order.store_id -> custom_store.name }\n', 2, /sum 只能用整数或小数字段/],
    ['窗口的字段路径终点不是时间或日期', 'base: order\nmeasure: { agg: count }\nwindow: { field: order.store_id -> custom_store.area, days: 30 }\n', 3, /时间窗口要用时间或日期字段/],
    ['过滤的字段路径终点是敏感字段', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: order.store_id -> custom_store.region_id -> custom_region.manager_phone, op: not_null }\n', 4, /过滤不能用敏感字段 custom_region\.manager_phone/],
    ['过滤用了 consumer.<字段>', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: consumer.city, op: eq, value: 北京 }\n', 4, /consumer\.city 只能用作维度/],
    ['过滤的字段路径终点取值不在标准枚举里', 'base: order\nmeasure: { agg: count }\nfilter:\n  - { field: order.customer_id -> customer.gender, op: eq, value: x }\n', 4, /gender.*female/],
    ['字段路径只有一段但不是基础实体', 'base: order\nmeasure: { agg: count_distinct, field: custom_store.name }\n', 2, /路径要从基础实体 order 出发/],
    ['度量的字段路径不是指向主键的关系', 'base: order\nmeasure: { agg: count_distinct, field: order.channel -> custom_store.name }\n', 2, /order\.channel.*custom_store/],
  ])('%s', (_, yaml, line, message) => {
    const found = issues(yaml);
    expect(found.find(i => message.test(i.message)), JSON.stringify(found)).toMatchObject({ line });
  });

  it('ratio / latest / earliest / days_since 合规时通过；分子分母的过滤、by 计入依赖', () => {
    expect(ok(RATIO).measure).toMatchObject({ agg: 'ratio', numerator: { agg: 'count' }, denominator: { agg: 'count' } });
    ok('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: sum, field: amount }\n  denominator: { agg: count_distinct, field: order_id }\n');
    ok(LATEST);
    ok('base: order\nmeasure: { agg: earliest, field: amount, by: created_at }\n');
    ok(DAYS_SINCE);
    ok('base: custom_visit\nmeasure: { agg: days_since, field: visited_on }\n');
    expect(DSL_KINDS.metric.dependencies(ok('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: sum, field: amount, filter: [{ field: x_vip_level, op: eq, value: gold }] }\n  denominator: { agg: count_distinct, field: store_id, filter: [{ field: channel, op: not_null }] }\n')).fields)
      .toEqual(['amount', 'channel', 'store_id', 'x_vip_level'].map(field => ({ entity: 'order', field })));
    expect(DSL_KINDS.metric.dependencies(ok(LATEST)).fields).toEqual([{ entity: 'order', field: 'amount' }, { entity: 'order', field: 'created_at' }]);
    // 已发布版本的 YAML 不经 Schema 直接交给 dependencies：分子缺 filter、缺分母都不出错
    expect(DSL_KINDS.metric.dependencies({ base: 'order', measure: { agg: 'ratio', numerator: { agg: 'count' } } } as MetricSpec).fields).toEqual([]);
  });

  it('filter、measure、window 可写维度路径（一段的 <基础实体>.字段 等同裸字段）；依赖计入路径经过的实体与各段字段', () => {
    const yaml = 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: sum, field: order.store_id -> custom_store.area, filter: [{ field: order.customer_id -> customer.gender, op: eq, value: female }] }\n  denominator: { agg: count }\n'
      + 'filter:\n  - { field: order.store_id -> custom_store.region_id -> custom_region.name, op: eq, value: 华东 }\nwindow: { field: order.created_at, days: 30 }\n';
    ok(yaml);
    ok('base: order\nmeasure: { agg: latest, field: order.store_id -> custom_store.area, by: order.created_at }\n');
    ok('base: custom_visit\nmeasure: { agg: days_since, field: custom_visit.visited_on }\n');
    expect(DSL_KINDS.metric.dependencies(ok(yaml))).toMatchObject({
      entities: ['custom_region', 'custom_store', 'customer', 'order'],
      fields: [
        { entity: 'custom_region', field: 'name' },
        { entity: 'custom_store', field: 'area' },
        { entity: 'custom_store', field: 'region_id' },
        { entity: 'customer', field: 'gender' },
        { entity: 'order', field: 'created_at' },
        { entity: 'order', field: 'customer_id' },
        { entity: 'order', field: 'store_id' },
      ],
    });
    // 依赖只看结构：字段不是字符串时跳过，不出错
    expect(DSL_KINDS.metric.dependencies({ base: 'order', measure: { agg: 'sum', field: 3 }, filter: [{ field: null }] } as unknown as MetricSpec).fields).toEqual([]);
  });

  it.each([
    ['latest 配文本字段', 'base: order\nmeasure:\n  agg: latest\n  field: channel\n  by: created_at\n', 'measure.field', /latest 只能用整数或小数字段/],
    ['latest 的 by 不是时间或日期', 'base: order\nmeasure:\n  agg: latest\n  field: amount\n  by: amount\n', 'measure.by', /by 要用时间或日期字段/],
    ['latest 缺 by', 'base: order\nmeasure:\n  agg: latest\n  field: amount\n', 'measure', /缺少 by/],
    ['earliest 的 by 是敏感字段', 'base: order\nmeasure:\n  agg: earliest\n  field: amount\n  by: x_buyer_phone\n', 'measure.by', /敏感/],
    ['days_since 配非时间字段', 'base: order\nmeasure:\n  agg: days_since\n  field: amount\n', 'measure.field', /days_since 要用时间或日期字段/],
    ['days_since 缺 field', 'base: order\nmeasure:\n  agg: days_since\n', 'measure', /缺少 field/],
    ['ratio 的分子配 avg', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: avg, field: amount }\n  denominator: { agg: count }\n', 'measure.numerator.agg', /count、count_distinct、sum/],
    ['ratio 缺分母', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count }\n', 'measure', /缺少 denominator/],
    ['ratio 写了 field', 'base: order\nmeasure:\n  agg: ratio\n  field: amount\n  numerator: { agg: count }\n  denominator: { agg: count }\n', 'measure.field', /不能写 field/],
    ['sum 写了 by', 'base: order\nmeasure:\n  agg: sum\n  field: amount\n  by: created_at\n', 'measure.by', /不能写 by/],
    ['分母的 sum 用了文本字段', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count }\n  denominator: { agg: sum, field: channel }\n', 'measure.denominator.field', /sum 只能用整数或小数字段/],
    ['分母的 count_distinct 没写字段', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count }\n  denominator: { agg: count_distinct }\n', 'measure.denominator.agg', /要写 field/],
    ['分子的字段是敏感字段', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count_distinct, field: x_buyer_phone }\n  denominator: { agg: count }\n', 'measure.numerator.field', /敏感/],
    ['分子的过滤用了敏感字段', 'base: customer\nmeasure:\n  agg: ratio\n  numerator:\n    agg: count\n    filter:\n      - { field: email, op: not_null }\n  denominator: { agg: count }\n', 'measure.numerator.filter.0.field', /敏感/],
    ['分母的过滤取值不在标准枚举里', 'base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count }\n  denominator:\n    agg: count\n    filter:\n      - { field: status, op: eq, value: lost }\n', 'measure.denominator.filter.0.value', /status.*paid/],
    ['有多条可走的一跳却没写 consumer_via', 'base: custom_line\nmeasure: { agg: count }\n', 'consumer_via', /要写 consumer_via 选一条：order_id（→ order）、visit_id（→ custom_visit）/],
    ['基础实体自己能关联消费者却写了 consumer_via', 'base: order\nconsumer_via: store_id\nmeasure: { agg: count }\n', 'consumer_via', /order 自己就能关联消费者，不要写 consumer_via/],
    ['consumer_via 指向的实体连不到消费者', 'base: custom_line\nconsumer_via: store_id\nmeasure: { agg: count }\n', 'consumer_via', /custom_line\.store_id 不能关联到消费者/],
    ['consumer_via 指向的标准实体连不到消费者', 'base: order_item\nconsumer_via: product_id\nmeasure: { agg: count }\n', 'consumer_via', /order_item\.product_id 不能关联到消费者.*order_id（→ order）/],
  ])('%s', (_, yaml, path, message) => {
    const found = issues(yaml);
    expect(found.find(i => message.test(i.message)), JSON.stringify(found)).toMatchObject({ path });
  });

  it('基础实体经一跳引用关联消费者：唯一的一跳自动走，多条时按 consumer_via；consumer 维度放行；依赖计入那一跳到的实体与字段', () => {
    const items = ok(ITEM_CATEGORY);
    expect(items.consumer_via).toBeUndefined();
    ok(MILK);
    ok('base: custom_line\nconsumer_via: visit_id\nmeasure: { agg: sum, field: qty }\n');
    ok('base: order_item\nmeasure: { agg: count_distinct, field: order_id }\ndimensions:\n  - { name: city, path: consumer.city }\n');
    expect(DSL_KINDS.metric.dependencies(items)).toMatchObject({
      entities: ['order', 'order_item', 'product'],
      fields: [
        { entity: 'order', field: 'created_at' },
        { entity: 'order', field: 'customer_id' },
        { entity: 'order', field: 'status' },
        { entity: 'order_item', field: 'amount' },
        { entity: 'order_item', field: 'order_id' },
        { entity: 'order_item', field: 'product_id' },
        { entity: 'product', field: 'category' },
      ],
    });
    expect(DSL_KINDS.metric.entities(ok('base: order_item\nmeasure: { agg: sum, field: amount }\n'), ctx)).toEqual(['order', 'order_item']);
    // 关系登记在自定义实体上时，带上下文的 entities 找得到那一跳
    expect(DSL_KINDS.metric.entities(ok('base: custom_line\nconsumer_via: visit_id\nmeasure: { agg: count }\n'), ctx)).toEqual(['custom_line', 'custom_visit']);
  });

  it('多个问题一起报出，按位置排序', () => {
    const found = issues('base: order\nmeasure: { agg: sum, field: channel }\nwindow: { field: amount, days: 30 }\n');
    expect(found.map(i => i.line)).toEqual([2, 3]);
    expect(found[0]!.col).toBeGreaterThan(1);
  });

  it('device_attribution 只有 base 为 event 时能写', () => {
    expect(ok('base: event\nmeasure: { agg: count }\ndevice_attribution: false\n').device_attribution).toBe(false);
    expect(issues('base: order\nmeasure: { agg: count }\ndevice_attribution: true\n')).toEqual([
      expect.objectContaining({ line: 3, path: 'device_attribution', message: expect.stringMatching(/只有基础实体为 event/) }),
    ]);
    expect(issues('base: event\nmeasure: { agg: count }\ndevice_attribution: yes please\n')[0]).toMatchObject({ line: 3 });
  });
});

describe('指标 DSL：编译', () => {
  it('同样的定义编译出同样的 SQL，不依赖当前时间', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      const first = [REGION, RATIO, LATEST, DAYS_SINCE].map(y => compileMetric(ok(y), ctx, '2024-07-01'));
      vi.setSystemTime(new Date('2030-06-01T00:00:00Z'));
      expect([REGION, RATIO, LATEST, DAYS_SINCE].map(y => compileMetric(ok(y), ctx, '2024-07-01'))).toEqual(first);
      expect(first[3]).not.toMatch(/current_date|now\(\)/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('经 silver._identities 关联到 consumer_id，维度路径编译成链式 LEFT JOIN', () => {
    const sql = compileMetric(ok(REGION), ctx, '2024-07-01');
    expect(sql).toContain('silver._identities');
    expect(sql.match(/LEFT JOIN/g)).toHaveLength(2);
    expect(sql).toContain('未关联');
  });

  it('关联到 customer 或主键指向 customer 的实体时按数据源关联，其余实体不按；跳到 customer 时按引用列的数据源列（跨源引用，ADR-0030）', () => {
    const dim = (base: string, path: string) => compileMetric(ok(`base: ${base}\nmeasure: { agg: count }\ndimensions:\n  - { name: d, path: ${path} }\n`), ctx, '2024-07-01');
    expect(dim('order', 'order.customer_id -> custom_profile.tier')).toContain('d0_1._source = b._source');
    expect(dim('order', 'order.customer_id -> customer.city')).toContain('d0_1._source = b."_customer_source"');
    expect(dim('custom_visit', 'custom_visit.referrer_id -> customer.city')).toContain('d0_1._source = b."_referrer_id_source"');
    expect(dim('order', 'order.store_id -> custom_store.name')).not.toContain('d0_1._source');
  });

  it('按引用列的数据源列 _customer_source 关联 silver._identities，基础实体是 customer 时仍按 _source（跨源引用，ADR-0030）', () => {
    for (const extra of ['', 'device_attribution: false\n']) {
      const sql = compileMetric(ok(`base: event\nmeasure: { agg: count }\n${extra}`), ctx, '2024-07-01');
      expect(sql).toContain('i._source = b._customer_source AND i.customer_id = b.customer_id');
      expect(sql).not.toContain('i._source = b._source');
    }
    expect(compileMetric(ok('base: customer\nmeasure: { agg: count }\n'), ctx, '2024-07-01')).toContain('i._source = b._source AND i.customer_id = b.customer_id');
  });

  it('consumer 维度经 consumer_id 关联 silver._consumer，同一指标里只关联一次；依赖记作 customer 的字段', () => {
    const yaml = 'base: event\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: consumer.city }\n  - { name: g, path: consumer.gender }\n';
    const sql = compileMetric(ok(yaml), ctx, '2024-07-01');
    expect(sql.match(/silver\._consumer/g)).toHaveLength(1);
    expect(sql).toContain('LEFT JOIN silver._consumer cs ON cs.consumer_id = COALESCE(i.consumer_id, o.consumer_id)');
    expect(DSL_KINDS.metric.dependencies(ok(yaml))).toMatchObject({
      entities: ['customer', 'event'],
      fields: [{ entity: 'customer', field: 'city' }, { entity: 'customer', field: 'gender' }],
    });
  });

  it('event 指标缺省经 silver._device_owner 归属匿名事件；device_attribution: false 时与原来逐字节一致', () => {
    const sql = (extra = '') => compileMetric(ok(`base: event\nmeasure: { agg: count }\n${extra}`), ctx, '2024-07-01');
    expect(sql()).toContain('silver._device_owner');
    expect(sql('device_attribution: true\n')).toBe(sql());
    expect(sql('device_attribution: false\n')).toBe([
      'SELECT i.consumer_id, COUNT(*) AS value',
      'FROM silver."event" b',
      'INNER JOIN silver._identities i ON i._source = b._customer_source AND i.customer_id = b.customer_id',
      'GROUP BY ALL',
      'ORDER BY ALL',
    ].join('\n'));
    expect(compileMetric(ok('base: order\nmeasure: { agg: count }\n'), ctx, '2024-07-01')).not.toContain('_device_owner');
  });

  it('只写裸字段、带两个同前缀维度的定义与原来逐字节一致；一段的 <基础实体>.字段 编译成裸字段', () => {
    const yaml = (prefix: string) => `base: order\nmeasure: { agg: sum, field: ${prefix}amount }\nfilter:\n  - { field: ${prefix}status, op: in, value: [paid, completed] }\nwindow: { field: ${prefix}created_at, days: 30 }\n`
      + 'dimensions:\n  - { name: store, path: order.store_id -> custom_store.name }\n  - { name: region, path: order.store_id -> custom_store.region_id -> custom_region.name }\n';
    const sql = compileMetric(ok(yaml('')), ctx, '2024-07-01');
    expect(sql).toBe([
      'SELECT i.consumer_id, COALESCE(NULLIF(CAST(d0_1."name" AS VARCHAR), \'\'), \'未关联\') AS "store", COALESCE(NULLIF(CAST(d1_2."name" AS VARCHAR), \'\'), \'未关联\') AS "region", SUM(b."amount") AS value',
      'FROM silver."order" b',
      'INNER JOIN silver._identities i ON i._source = b._customer_source AND i.customer_id = b.customer_id',
      'LEFT JOIN silver."custom_store" d0_1 ON d0_1."store_id" = b."store_id"',
      'LEFT JOIN silver."custom_store" d1_1 ON d1_1."store_id" = b."store_id"',
      'LEFT JOIN silver."custom_region" d1_2 ON d1_2."region_id" = d1_1."region_id"',
      'WHERE b."status" IN (\'paid\', \'completed\')',
      '  AND (b."created_at" AT TIME ZONE \'UTC\')::DATE > DATE \'2024-07-01\' - 30',
      '  AND (b."created_at" AT TIME ZONE \'UTC\')::DATE <= DATE \'2024-07-01\'',
      'GROUP BY ALL',
      'ORDER BY ALL',
    ].join('\n'));
    expect(compileMetric(ok(yaml('order.')), ctx, '2024-07-01')).toBe(sql);
  });

  it('字段路径与维度前缀相同时复用维度的别名，字段路径之间也只连一次；其余段新开 p 别名、紧跟维度之后', () => {
    const sql = compileMetric(ok('base: order\nmeasure: { agg: count_distinct, field: order.store_id -> custom_store.region_id -> custom_region.country_id }\n'
      + 'filter:\n  - { field: order.store_id -> custom_store.region_id -> custom_region.name, op: eq, value: 华东 }\n'
      + 'dimensions:\n  - { name: store, path: order.store_id -> custom_store.name }\n'), ctx, '2024-07-01');
    expect(sql.match(/LEFT JOIN silver\."custom_store"/g)).toHaveLength(1);
    expect(sql.match(/LEFT JOIN silver\."custom_region"/g)).toHaveLength(1);
    expect(sql).toContain('LEFT JOIN silver."custom_store" d0_1 ON d0_1."store_id" = b."store_id"\nLEFT JOIN silver."custom_region" p0_2 ON p0_2."region_id" = d0_1."region_id"');
    expect(sql).toContain('COUNT(DISTINCT p0_2."country_id")');
    expect(sql).toContain('WHERE p0_2."name" = \'华东\'');
    // 跳到 customer 的字段路径照维度按引用列的数据源列关联
    expect(compileMetric(ok('base: order\nmeasure: { agg: count }\nfilter:\n  - { field: order.customer_id -> customer.gender, op: eq, value: female }\n'), ctx, '2024-07-01'))
      .toContain('LEFT JOIN silver."customer" p0_1 ON p0_1."customer_id" = b."customer_id" AND p0_1._source = b."_customer_source"');
  });

  it('经一跳时先 INNER JOIN 那一跳的实体 h、再按它关联 silver._identities；同一前缀的字段路径与维度共用 h，不经设备归属', () => {
    const sql = compileMetric(ok(ITEM_CATEGORY), ctx, '2024-07-01');
    expect(sql).toContain([
      'FROM silver."order_item" b',
      'INNER JOIN silver."order" h ON h."order_id" = b."order_id"',
      'INNER JOIN silver._identities i ON i._source = h._customer_source AND i.customer_id = h.customer_id',
      'LEFT JOIN silver."product" d0_1 ON d0_1."product_id" = b."product_id"',
      'WHERE h."status" IN (\'paid\', \'shipped\', \'completed\')',
    ].join('\n'));
    expect(sql.match(/silver\."order"/g)).toHaveLength(1);
    expect(sql).toContain('(h."created_at" AT TIME ZONE \'UTC\')::DATE > DATE \'2024-07-01\' - 365');
    expect(sql).not.toContain('_device_owner');
    const dim = compileMetric(ok('base: order_item\nmeasure: { agg: count }\ndimensions:\n  - { name: s, path: order_item.order_id -> order.store_id -> custom_store.name }\n  - { name: c, path: order_item.order_id -> order.channel }\n'), ctx, '2024-07-01');
    expect(dim.match(/silver\."order"/g)).toHaveLength(1);
    expect(dim).toContain('LEFT JOIN silver."custom_store" d0_2 ON d0_2."store_id" = h."store_id"');
    expect(dim).toContain('CAST(h."channel" AS VARCHAR)');
  });
});

describe('指标 DSL：编译出的 SQL 的结果', () => {
  let instance: DuckDBInstance;
  let con: DuckDBConnection;

  // 消费者 c1（两个源）、c2；o5 的门店不在门店表里、o6 没有门店、o7 的门店没有区域，都记为「未关联」；o8 打通不到消费者，不计入；
  // o9 在窗口外，o10 状态不计入。
  // 事件：设备 d1 先后被 c1、c2 登录，归 c2；d2 归 c1；d3 从未登录过；e6 的 customer_id 打通不到，不按设备 d2 归属
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    con = await instance.connect();
    await con.run(`SET TimeZone = 'UTC';
      CREATE SCHEMA silver;
      CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2');
      CREATE TABLE silver._consumer (consumer_id VARCHAR, city VARCHAR, city__source VARCHAR);
      INSERT INTO silver._consumer VALUES ('c1', '北京', 's2'), ('c2', NULL, NULL);
      CREATE TABLE silver.customer (customer_id VARCHAR, city VARCHAR, _source VARCHAR);
      INSERT INTO silver.customer VALUES ('1', '上海', 's1'), ('10', '北京', 's2'), ('2', NULL, 's1');
      CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, status VARCHAR, amount DECIMAL(18,2), created_at TIMESTAMPTZ, store_id VARCHAR, _source VARCHAR);
      INSERT INTO silver."order" VALUES
        ('o1', '1', 'paid', 100, '2024-06-30 10:00:00+00', 'st1', 's1'),
        ('o2', '10', 'completed', 50, '2024-06-20 10:00:00+00', 'st2', 's2'),
        ('o3', '1', 'paid', 30, '2024-06-02 00:00:00+00', 'st3', 's1'),
        ('o4', '2', 'paid', 70, '2024-07-01 23:00:00+00', 'st1', 's1'),
        ('o5', '2', 'paid', 5, '2024-06-15 10:00:00+00', 'gone', 's1'),
        ('o6', '2', 'paid', 6, '2024-06-15 10:00:00+00', NULL, 's1'),
        ('o7', '2', 'paid', 7, '2024-06-15 10:00:00+00', 'st4', 's1'),
        ('o8', 'x', 'paid', 999, '2024-06-15 10:00:00+00', 'st1', 's2'),
        ('o9', '1', 'paid', 1000, '2024-06-01 23:00:00+00', 'st1', 's1'),
        ('o10', '1', 'refunded', 2000, '2024-06-15 10:00:00+00', 'st1', 's1');
      CREATE TABLE silver.custom_store (store_id VARCHAR, region_id VARCHAR, name VARCHAR, parent_id VARCHAR);
      INSERT INTO silver.custom_store VALUES ('st1', 'r1', '一店', NULL), ('st2', 'r2', '二店', NULL), ('st3', 'r1', '三店', NULL), ('st4', NULL, '四店', NULL);
      CREATE TABLE silver.custom_region (region_id VARCHAR, name VARCHAR, manager_phone VARCHAR, country_id VARCHAR);
      INSERT INTO silver.custom_region VALUES ('r1', '华东', NULL, NULL), ('r2', '华北', NULL, NULL);
      CREATE TABLE silver._device_owner (device_id VARCHAR, consumer_id VARCHAR, login_at TIMESTAMPTZ);
      INSERT INTO silver._device_owner VALUES ('d1', 'c2', '2024-06-20 10:00:00+00'), ('d2', 'c1', '2024-06-10 10:00:00+00');
      CREATE TABLE silver.event (event_id VARCHAR, customer_id VARCHAR, device_id VARCHAR, event_type VARCHAR, occurred_at TIMESTAMPTZ, page VARCHAR, _source VARCHAR);
      INSERT INTO silver.event VALUES
        ('e1', '1', 'd1', 'login', '2024-06-10 10:00:00+00', NULL, 's1'),
        ('e2', NULL, 'd1', 'view', '2024-06-15 10:00:00+00', NULL, 's1'),
        ('e3', NULL, 'd1', 'view', '2024-06-21 10:00:00+00', NULL, 's1'),
        ('e4', '2', 'd1', 'login', '2024-06-20 10:00:00+00', NULL, 's1'),
        ('e5', NULL, 'd3', 'view', '2024-06-15 10:00:00+00', NULL, 's1'),
        ('e6', 'x', 'd2', 'view', '2024-06-15 10:00:00+00', NULL, 's2'),
        ('e7', NULL, 'd2', 'view', '2024-06-15 10:00:00+00', NULL, 's1');
      ALTER TABLE silver."order" ADD COLUMN _customer_source VARCHAR;
      UPDATE silver."order" SET _customer_source = _source;
      ALTER TABLE silver.event ADD COLUMN _customer_source VARCHAR;
      UPDATE silver.event SET _customer_source = _source;
      ALTER TABLE silver.custom_store ADD COLUMN area DECIMAL(18,2);
      UPDATE silver.custom_store SET area = CASE store_id WHEN 'st1' THEN 10.5 WHEN 'st2' THEN 20 WHEN 'st3' THEN 30 END;
      CREATE TABLE silver.product (product_id VARCHAR, category VARCHAR, _source VARCHAR);
      INSERT INTO silver.product VALUES ('p1', '奶粉', 's1'), ('p2', '纸尿裤', 's1');
      CREATE TABLE silver.order_item (order_item_id VARCHAR, order_id VARCHAR, product_id VARCHAR, amount DECIMAL(18,2), _source VARCHAR);
      INSERT INTO silver.order_item VALUES
        ('i1', 'o1', 'p1', 60, 's1'), ('i2', 'o1', 'p2', 40, 's1'), ('i3', 'o2', 'p1', 50, 's2'), ('i4', 'o4', 'p2', 70, 's1'),
        ('i5', 'o8', 'p1', 999, 's2'), ('i6', 'gone', 'p1', 500, 's1'), ('i7', 'o10', 'p1', 2000, 's1'), ('i8', 'o9', 'p1', 1000, 's1'),
        ('i9', 'o3', 'p9', 30, 's1');`);
  });

  afterAll(() => {
    con?.closeSync();
    instance?.closeSync();
  });

  const run = async (yaml: string, asOf = '2024-07-01') => (await con.runAndReadAll(compileMetric(ok(yaml), ctx, asOf))).getRowObjectsJson()
    .map(r => ({ ...r, value: r.value === null ? null : Number(r.value) }));

  it('按维度路径分组，关联不到或为空记为「未关联」不丢行；窗口取 (asOf - days, asOf]，打通不到的不计入', async () => {
    expect(await run(REGION)).toEqual([
      { consumer_id: 'c1', region: '华东', value: 130 },
      { consumer_id: 'c1', region: '华北', value: 50 },
      { consumer_id: 'c2', region: '华东', value: 70 },
      { consumer_id: 'c2', region: '未关联', value: 18 },
    ]);
  });

  it('没有维度时每个消费者一行；没有窗口时不加时间限制', async () => {
    expect(await run('base: order\nmeasure: { agg: count }\nfilter:\n  - { field: amount, op: gte, value: 30 }\n')).toEqual([
      { consumer_id: 'c1', value: 5 },
      { consumer_id: 'c2', value: 1 },
    ]);
  });

  it('ratio：分子分母各带过滤、与顶层过滤叠加，分母为 0 时取值为空；客单价 = sum / count', async () => {
    expect(await run(RATIO)).toEqual([{ consumer_id: 'c1', value: 0.6 }, { consumer_id: 'c2', value: 1 }]);
    expect(await run('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count }\n  denominator: { agg: count, filter: [{ field: status, op: eq, value: refunded }] }\n'))
      .toEqual([{ consumer_id: 'c1', value: 5 }, { consumer_id: 'c2', value: null }]);
    // 分子 sum 过滤后没有行记 0，不是空
    expect(await run('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: sum, field: amount, filter: [{ field: status, op: eq, value: refunded }] }\n  denominator: { agg: sum, field: amount }\n'))
      .toEqual([{ consumer_id: 'c1', value: 2000 / 3180 }, { consumer_id: 'c2', value: 0 }]);
    expect(await run('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: sum, field: amount }\n  denominator: { agg: count }\nfilter:\n  - { field: status, op: eq, value: paid }\nwindow: { field: created_at, days: 30 }\n'))
      .toEqual([{ consumer_id: 'c1', value: 65 }, { consumer_id: 'c2', value: 22 }]);
  });

  it('latest / earliest 按 by 取最新 / 最早一行的字段；days_since = asOf 减最近一天（UTC 日期）', async () => {
    expect(await run(LATEST)).toEqual([{ consumer_id: 'c1', value: 100 }, { consumer_id: 'c2', value: 70 }]);
    expect(await run('base: order\nmeasure: { agg: earliest, field: amount, by: created_at }\nfilter:\n  - { field: amount, op: gte, value: 30 }\n'))
      .toEqual([{ consumer_id: 'c1', value: 1000 }, { consumer_id: 'c2', value: 70 }]);
    expect(await run(DAYS_SINCE)).toEqual([{ consumer_id: 'c1', value: 1 }, { consumer_id: 'c2', value: 0 }]);
    expect(await run(DAYS_SINCE, '2024-07-11')).toEqual([{ consumer_id: 'c1', value: 11 }, { consumer_id: 'c2', value: 10 }]);
  });

  it('指向 customer 的一跳按数据源关联；基础实体是 customer 时按自身关联到 consumer_id', async () => {
    expect(await run('base: order\nmeasure: { agg: max, field: amount }\nfilter:\n  - { field: status, op: eq, value: paid }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n')).toEqual([
      { consumer_id: 'c1', city: '上海', value: 1000 },
      { consumer_id: 'c2', city: '未关联', value: 70 },
    ]);
    expect(await run('base: customer\nmeasure: { agg: count }\n')).toEqual([
      { consumer_id: 'c1', value: 2 },
      { consumer_id: 'c2', value: 1 },
    ]);
  });

  it('event 指标的匿名事件经设备归属计入设备主人（共享设备归最近一次登录者），从未登录过的设备与打通不到的 customer_id 不计入', async () => {
    expect(await run('base: event\nmeasure: { agg: count }\n')).toEqual([
      { consumer_id: 'c1', value: 2 },
      { consumer_id: 'c2', value: 3 },
    ]);
    expect(await run('base: event\nmeasure: { agg: count }\ndevice_attribution: false\n')).toEqual([
      { consumer_id: 'c1', value: 1 },
      { consumer_id: 'c2', value: 1 },
    ]);
  });

  it('consumer.city 维度一个人只有一个城市（不按源记录拆行），没有城市的记「未关联」；event 的匿名事件按设备主人取城市', async () => {
    expect(await run('base: order\nmeasure: { agg: max, field: amount }\nfilter:\n  - { field: status, op: eq, value: paid }\ndimensions:\n  - { name: city, path: consumer.city }\n')).toEqual([
      { consumer_id: 'c1', city: '北京', value: 1000 },
      { consumer_id: 'c2', city: '未关联', value: 70 },
    ]);
    expect(await run('base: event\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: consumer.city }\n')).toEqual([
      { consumer_id: 'c1', city: '北京', value: 2 },
      { consumer_id: 'c2', city: '未关联', value: 3 },
    ]);
  });

  it('维度路径 event.customer_id -> customer 这一跳，匿名事件仍记「未关联」', async () => {
    expect(await run('base: event\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: event.customer_id -> customer.city }\n')).toEqual([
      { consumer_id: 'c1', city: '上海', value: 1 },
      { consumer_id: 'c1', city: '未关联', value: 1 },
      { consumer_id: 'c2', city: '未关联', value: 3 },
    ]);
  });

  // 明细：i5 的订单 o8 打通不到消费者、i6 的订单不在订单表里，都不计入；i7 的订单已退款；i9 的商品不在商品表里，品类记「未关联」
  it('订单明细经订单关联消费者：各品类消费金额、奶粉消费金额与手写 SQL 一致，关联不到订单或消费者的明细不计入', async () => {
    const hand = async (select: string, where = 'TRUE') => (await con.runAndReadAll(`SELECT i.consumer_id, ${select} AS value
      FROM silver.order_item b JOIN silver."order" o ON o.order_id = b.order_id
      JOIN silver._identities i ON i._source = o._customer_source AND i.customer_id = o.customer_id
      LEFT JOIN silver.product p ON p.product_id = b.product_id
      WHERE o.status IN ('paid', 'shipped', 'completed') AND (o.created_at AT TIME ZONE 'UTC')::DATE > DATE '2024-07-01' - 365
        AND (o.created_at AT TIME ZONE 'UTC')::DATE <= DATE '2024-07-01' AND ${where}
      GROUP BY ALL ORDER BY ALL`)).getRowObjectsJson().map(r => ({ ...r, value: Number(r.value) }));

    expect(await run(ITEM_CATEGORY)).toEqual([
      { consumer_id: 'c1', category: '奶粉', value: 1110 },
      { consumer_id: 'c1', category: '未关联', value: 30 },
      { consumer_id: 'c1', category: '纸尿裤', value: 40 },
      { consumer_id: 'c2', category: '纸尿裤', value: 70 },
    ]);
    expect(await run(ITEM_CATEGORY)).toEqual(await hand("COALESCE(p.category, '未关联') AS category, SUM(b.amount)"));

    expect(await run(MILK)).toEqual([{ consumer_id: 'c1', value: 1110 }]);
    expect(await run(MILK)).toEqual(await hand('SUM(b.amount)', "p.category = '奶粉'"));
  });

  // 门店面积 st1 10.5、st2 20、st3 30、st4 为空；o5 的门店不在表里、o6 没有门店、o7 的门店没有区域
  it('filter 与 measure 写路径时取终点原值：关联不上为 NULL，eq / ne 不命中、is_null 命中、sum 跳过；结果与手写 SQL 一致', async () => {
    const hand = async (select: string, where = 'TRUE') => (await con.runAndReadAll(`SELECT i.consumer_id, ${select} AS value
      FROM silver."order" b JOIN silver._identities i ON i._source = b._customer_source AND i.customer_id = b.customer_id
      LEFT JOIN silver.custom_store s ON s.store_id = b.store_id LEFT JOIN silver.custom_region r ON r.region_id = s.region_id
      WHERE ${where} GROUP BY ALL ORDER BY ALL`)).getRowObjectsJson().map(r => ({ ...r, value: r.value === null ? null : Number(r.value) }));
    const region = (op: string, value = '') => `base: order\nmeasure: { agg: count }\nfilter:\n  - { field: order.store_id -> custom_store.region_id -> custom_region.name, op: ${op}${value && `, value: ${value}`} }\n`;

    expect(await run(region('eq', '华东'))).toEqual([{ consumer_id: 'c1', value: 4 }, { consumer_id: 'c2', value: 1 }]);
    expect(await run(region('eq', '华东'))).toEqual(await hand('COUNT(*)', "r.name = '华东'"));
    expect(await run(region('ne', '华东'))).toEqual([{ consumer_id: 'c1', value: 1 }]);
    expect(await run(region('is_null'))).toEqual([{ consumer_id: 'c2', value: 3 }]);
    expect(await run(region('is_null'))).toEqual(await hand('COUNT(*)', 'r.name IS NULL'));

    const area = 'base: order\nmeasure: { agg: sum, field: order.store_id -> custom_store.area }\n';
    expect(await run(area)).toEqual([{ consumer_id: 'c1', value: 81.5 }, { consumer_id: 'c2', value: 10.5 }]);
    expect(await run(area)).toEqual(await hand('SUM(s.area)'));
  });

  it('维度与字段路径共用前缀时结果不变；ratio 分子的过滤能引用路径', async () => {
    expect(await run('base: order\nmeasure: { agg: sum, field: order.store_id -> custom_store.area }\nfilter:\n  - { field: order.store_id -> custom_store.region_id -> custom_region.name, op: eq, value: 华东 }\n'
      + 'dimensions:\n  - { name: store, path: order.store_id -> custom_store.name }\n')).toEqual([
      { consumer_id: 'c1', store: '一店', value: 31.5 },
      { consumer_id: 'c1', store: '三店', value: 30 },
      { consumer_id: 'c2', store: '一店', value: 10.5 },
    ]);
    expect(await run('base: order\nmeasure:\n  agg: ratio\n  numerator: { agg: count, filter: [{ field: order.store_id -> custom_store.region_id -> custom_region.name, op: eq, value: 华东 }] }\n  denominator: { agg: count }\n'))
      .toEqual([{ consumer_id: 'c1', value: 0.8 }, { consumer_id: 'c2', value: 0.25 }]);
  });
});

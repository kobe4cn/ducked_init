// test/tag-spec.test.ts —— 标签 DSL：引用的指标要已发布、没有维度、取值为数字，rules 不能为空、when 要有条件、取值不能为空，多指标写法（all / any、missing）的问题按位置报，按行列报错；
// 编译出的 SQL 内联各指标、带上键、人群为全部统一消费者，在内存 DuckDB 里对手造的标准层得到已知答案；发布前的影响预览（impact.ts）按 consumer_id 对比两版结果只给计数（纯函数，不碰平台库与数据湖）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import { compileMetricDiff, compileTagDiff } from '../app/.server/pipeline/dsl/impact';
import { checkMetric, compileMetric, type DslContext } from '../app/.server/pipeline/dsl/metric-spec';
import { checkTag, compileTag, withMetric, type TagSpec } from '../app/.server/pipeline/dsl/tag-spec';

const base: DslContext = { published: new Map(), plans: [], metrics: new Map() };
const ctx: DslContext = {
  ...base,
  metrics: new Map([
    ['revenue', checkMetric('base: order\nmeasure: { agg: sum, field: amount }\n', base)],
    ['revenue_by_city', checkMetric('base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n', base)],
    ['last_order_at', checkMetric('base: order\nmeasure: { agg: max, field: created_at }\n', base)],
    ['top_amount', checkMetric('base: order\nmeasure: { agg: max, field: amount }\n', base)],
    ['orders', checkMetric('base: order\nmeasure: { agg: count }\n', base)],
    ['views', checkMetric('base: event\nmeasure: { agg: count }\nfilter:\n  - { field: event_type, op: eq, value: view }\ndevice_attribution: false\n', base)],
    // 近 365 天奶粉消费金额：订单明细经订单一跳关联消费者（ADR-0038）
    ['milk_365d', checkMetric(`base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
  - { field: order_item.product_id -> product.category, op: eq, value: 奶粉 }
window: { field: order_item.order_id -> order.created_at, days: 365 }
`, base)],
    ['stale', { ok: false, issues: [] }],
  ]),
};

const TIERS = `metric: revenue
rules:
  - value: high
    when: { gte: 1000 }
  - value: mid
    when: { gte: 100, lt: 1000 }
default: low
`;

// 浏览未购：近期浏览 ≥ 5 且没有订单
const BROWSE_NO_BUY = `rules:
  - value: 浏览未购
    when:
      all:
        - { metric: views, gte: 5 }
        - { metric: orders, eq: 0 }
default: 一般
`;

const ok = (yaml: string): TagSpec => {
  const r = checkTag(yaml, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.spec;
};
const issues = (yaml: string) => {
  const r = checkTag(yaml, ctx);
  if (r.ok) throw new Error('应当校验不通过');
  return r.issues;
};

describe('标签 DSL：校验', () => {
  it('合规的定义通过，注册表登记了 tag，用到的实体是引用指标的实体', () => {
    expect(ok(TIERS)).toMatchObject({ metric: 'revenue', default: 'low' });
    ok('metric: top_amount\nrules:\n  - { value: 1, when: { eq: 0 } }\ndefault: 0\n');
    expect(DSL_KINDS.tag.check).toBe(checkTag);
    expect(DSL_KINDS.tag.entities(ok(TIERS), ctx)).toEqual(['order']);
  });

  it('引用不存在或未发布、带维度、取值不是数字、已发布版本不再通过校验的指标被拒，报在 metric 上', () => {
    const at = (metric: string) => issues(TIERS.replace('metric: revenue', `metric: ${metric}`));
    expect(at('missing')).toEqual([{ line: 1, col: 9, path: 'metric', message: '没有已发布的指标 missing' }]);
    expect(at('revenue_by_city')).toEqual([expect.objectContaining({ path: 'metric', message: expect.stringMatching(/带维度/) })]);
    expect(at('last_order_at')).toEqual([expect.objectContaining({ path: 'metric', message: expect.stringMatching(/取值不是数字/) })]);
    expect(at('stale')).toEqual([expect.objectContaining({ path: 'metric', message: expect.stringMatching(/不再通过校验/) })]);
  });

  it('rules 为空、when 没有条件、取值为空被拒；缺项与不认识的条件报结构问题', () => {
    expect(issues('metric: revenue\nrules: []\ndefault: low\n')).toEqual([{ line: 2, col: 8, path: 'rules', message: '不能为空' }]);
    expect(issues('metric: revenue\nrules:\n  - { value: high, when: {} }\ndefault: low\n'))
      .toEqual([expect.objectContaining({ line: 3, path: 'rules.0.when', message: '不能为空' })]);
    expect(issues('metric: revenue\nrules:\n  - { value: "", when: { gte: 1 } }\n  - { value: "  ", when: { gte: 2 } }\ndefault: " "\n')).toEqual([
      expect.objectContaining({ line: 3, path: 'rules.0.value', message: '取值不能为空' }),
      expect.objectContaining({ line: 4, path: 'rules.1.value', message: '取值不能为空' }),
      expect.objectContaining({ line: 5, path: 'default', message: '取值不能为空' }),
    ]);
    expect(issues('metric: revenue\nrules:\n  - { value: high, when: { between: 1 } }\n').map(i => i.message))
      .toEqual(['缺少 default', '不认识的项 between']);
  });

  it('多指标写法：all / any 里引用多个指标通过，用到的实体是各指标实体的并集；依赖列出全部引用的指标', () => {
    const spec = ok(BROWSE_NO_BUY);
    expect(spec.metric).toBeUndefined();
    expect(DSL_KINDS.tag.entities(spec, ctx)).toEqual(['event', 'order']);
    expect(DSL_KINDS.tag.dependencies(spec).metrics).toEqual(['orders', 'views']);
    expect(DSL_KINDS.tag.dependencies(ok(TIERS)).metrics).toEqual(['revenue']);
    ok('rules:\n  - { value: a, when: { any: [{ metric: revenue, gte: 1000 }, { metric: views, gt: 10 }] } }\n  - { value: b, when: { all: [{ metric: revenue, gte: 1 }] } }\nmissing: { views: 0, revenue: null }\ndefault: c\n');
  });

  it('依赖对未经 Schema 的 YAML 容错：两种写法结构不全时只取能认出的指标键', () => {
    const deps = (v: unknown) => DSL_KINDS.tag.dependencies(v as TagSpec).metrics;
    expect(deps({})).toEqual([]);
    expect(deps({ rules: 'x' })).toEqual([]);
    expect(deps({ rules: [null, { when: null }, { when: { all: 'x', any: [null, { metric: 3 }, { metric: 'b' }] } }, { when: { all: [{ metric: 'a' }, { metric: 'b' }] } }] })).toEqual(['a', 'b']);
    expect(deps({ metric: 'revenue', rules: [{ when: { gte: 1 } }] })).toEqual(['revenue']);
  });

  it('多指标写法：引用的指标不能用、某项没有比较、all 与 any 同写、missing 写了没引用的指标被拒，按位置报', () => {
    expect(issues('rules:\n  - value: a\n    when:\n      all:\n        - { metric: views, gte: 5 }\n        - { metric: revenue_by_city, gte: 1 }\n        - { metric: orders }\ndefault: b\n')).toEqual([
      expect.objectContaining({ line: 6, path: 'rules.0.when.all.1.metric', message: expect.stringMatching(/带维度/) }),
      expect.objectContaining({ line: 7, path: 'rules.0.when.all.2', message: '至少写一个比较（gte、gt、lte、lt、eq）' }),
    ]);
    expect(issues('rules:\n  - { value: a, when: { all: [{ metric: views, gte: 5 }], any: [{ metric: missing, gte: 1 }] } }\nmissing: { orders: 0 }\ndefault: b\n')).toEqual([
      expect.objectContaining({ line: 2, path: 'rules.0.when', message: 'all 与 any 只能写一个' }),
      expect.objectContaining({ line: 2, path: 'rules.0.when.any.0.metric', message: '没有已发布的指标 missing' }),
      expect.objectContaining({ line: 3, path: 'missing.orders', message: '规则里没有引用指标 orders' }),
    ]);
    expect(issues(`${TIERS}missing: { views: 0 }\n`)).toEqual([expect.objectContaining({ path: 'missing.views', message: '规则里没有引用指标 views' })]);
  });

  it('两种写法不能混用：单指标写法的 when 不认 all，多指标写法的 when 不认比较、all 不能为空、missing 取值要是数字或空', () => {
    expect(issues('metric: revenue\nrules:\n  - { value: a, when: { all: [{ metric: views, gte: 5 }] } }\ndefault: b\n').map(i => i.message)).toEqual(['不认识的项 all']);
    expect(issues('rules:\n  - { value: a, when: { gte: 5 } }\ndefault: b\n').map(i => i.message)).toEqual(['不认识的项 gte']);
    expect(issues('rules:\n  - { value: a, when: { all: [] } }\ndefault: b\n')).toEqual([expect.objectContaining({ path: 'rules.0.when.all', message: '不能为空' })]);
    expect(issues('rules:\n  - { value: a, when: { all: [{ gte: 5 }] } }\ndefault: b\n').map(i => i.message)).toEqual(['缺少 metric']);
    expect(issues(`${BROWSE_NO_BUY}missing: { views: x }\n`)).toEqual([expect.objectContaining({ path: 'missing.views', message: expect.stringMatching(/^应为/) })]);
  });

  it('可选的 description：写了带进定义，不写照常通过；不是字符串或超过 500 字被拒', () => {
    expect(ok(`description: 按累计消费分层\n${TIERS}`).description).toBe('按累计消费分层');
    expect(ok(TIERS).description).toBeUndefined();
    expect(issues(`description: 3\n${TIERS}`)).toEqual([{ line: 1, col: 14, path: 'description', message: '应为文本' }]);
    expect(issues(`description: ${'说'.repeat(501)}\n${TIERS}`)).toEqual([expect.objectContaining({ path: 'description', message: '不能超过 500 字' })]);
    ok(`description: ${'说'.repeat(500)}\n${TIERS}`);
  });
});

describe('标签 DSL：编译', () => {
  it('同样的定义编译出同样的 SQL：内联引用指标的 SQL，键写成字面量，规则按顺序写成 CASE WHEN', () => {
    const sql = compileTag(ok(TIERS), ctx, '2024-07-01', 'value_tier');
    expect(compileTag(ok(TIERS), ctx, '2024-07-01', 'value_tier')).toBe(sql);
    expect(sql).toContain('silver._identities');
    expect(sql).toContain(`'value_tier' AS tag_key`);
    expect(sql.indexOf(`THEN 'high'`)).toBeLessThan(sql.indexOf(`THEN 'mid'`));
    expect(sql).toContain('COALESCE(m0.value, 0) >= 100 AND COALESCE(m0.value, 0) < 1000');
  });

  it('人群是全部统一消费者；不在结果里的按 missing 取值，没写的计数与求和记 0、其余不补（比较为假）', () => {
    const sql = compileTag(ok(`rules:\n  - value: x\n    when: { any: [{ metric: revenue, gte: 1 }, { metric: top_amount, gte: 1 }] }\ndefault: y\n`), ctx, '2024-07-01', 'k');
    expect(sql).toContain('SELECT DISTINCT consumer_id FROM silver._identities');
    expect(sql).toContain('(COALESCE(m0.value, 0) >= 1) OR (m1.value >= 1)');
    expect(compileTag(ok(`${TIERS}missing: { revenue: 500 }\n`), ctx, '2024-07-01', 'k')).toContain('COALESCE(m0.value, 500) >= 1000');
    expect(compileTag(ok(`${TIERS}missing: { revenue: null }\n`), ctx, '2024-07-01', 'k')).toContain('WHEN m0.value >= 1000');
  });
});

describe('标签 DSL：编译出的 SQL 的结果', () => {
  let instance: DuckDBInstance;
  let con: DuckDBConnection;

  // c1 有两个源的订单（100 + 900），c2 150，c3 20，c4 只有金额为空的订单（取值为空），c5 打通了但没有订单（不在指标结果里）；
  // 订单 x 打通不到消费者，不计入。浏览：c5 5 次（浏览未购），c2 5 次（下过单），c3 1 次浏览 1 次点击；c6 打通了但没有任何行为
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    con = await instance.connect();
    await con.run(`SET TimeZone = 'UTC';
      CREATE SCHEMA silver;
      CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3'), ('s1','4','c4'), ('s1','5','c5'), ('s1','6','c6');
      CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, amount DECIMAL(18,2), _source VARCHAR);
      INSERT INTO silver."order" VALUES
        ('o1', '1', 100, 's1'), ('o2', '10', 900, 's2'), ('o3', '2', 150, 's1'), ('o4', '3', 20, 's1'), ('o5', '4', NULL, 's1'), ('o6', 'x', 5000, 's2');
      ALTER TABLE silver."order" ADD COLUMN _customer_source VARCHAR;
      UPDATE silver."order" SET _customer_source = _source;
      ALTER TABLE silver."order" ADD COLUMN status VARCHAR;
      ALTER TABLE silver."order" ADD COLUMN created_at TIMESTAMPTZ;
      UPDATE silver."order" SET status = CASE order_id WHEN 'o4' THEN 'refunded' ELSE 'paid' END, created_at = '2024-06-01 10:00:00+00';
      CREATE TABLE silver.product (product_id VARCHAR, category VARCHAR, _source VARCHAR);
      INSERT INTO silver.product VALUES ('p1', '奶粉', 's1'), ('p2', '纸尿裤', 's1');
      CREATE TABLE silver.order_item (order_item_id VARCHAR, order_id VARCHAR, product_id VARCHAR, amount DECIMAL(18,2), _source VARCHAR);
      INSERT INTO silver.order_item VALUES ('i1', 'o1', 'p1', 80, 's1'), ('i2', 'o2', 'p1', 200, 's2'), ('i3', 'o3', 'p2', 150, 's1'), ('i4', 'o4', 'p1', 20, 's1'), ('i5', 'o6', 'p1', 5000, 's2');
      CREATE TABLE silver.event (event_id VARCHAR, customer_id VARCHAR, _customer_source VARCHAR, device_id VARCHAR, event_type VARCHAR, _source VARCHAR);
      INSERT INTO silver.event VALUES
        ('e1','5','s1',NULL,'view','s1'), ('e2','5','s1',NULL,'view','s1'), ('e3','5','s1',NULL,'view','s1'), ('e4','5','s1',NULL,'view','s1'), ('e5','5','s1',NULL,'view','s1'),
        ('e6','2','s1',NULL,'view','s1'), ('e7','2','s1',NULL,'view','s1'), ('e8','2','s1',NULL,'view','s1'), ('e9','2','s1',NULL,'view','s1'), ('e10','2','s1',NULL,'view','s1'),
        ('e11','3','s1',NULL,'view','s1'), ('e12','3','s1',NULL,'click','s1');`);
  });

  afterAll(() => {
    con?.closeSync();
    instance?.closeSync();
  });

  const run = async (yaml: string) => (await con.runAndReadAll(compileTag(ok(yaml), ctx, '2024-07-01', 'value_tier'))).getRowObjectsJson();

  it('多源订单合到同一消费者后取值；人群是全部统一消费者，没命中、指标值为空或不在指标结果里的取 default；每行带键', async () => {
    expect(await run(TIERS)).toEqual([
      { consumer_id: 'c1', tag_key: 'value_tier', tag_value: 'high' },
      { consumer_id: 'c2', tag_key: 'value_tier', tag_value: 'mid' },
      { consumer_id: 'c3', tag_key: 'value_tier', tag_value: 'low' },
      { consumer_id: 'c4', tag_key: 'value_tier', tag_value: 'low' },
      { consumer_id: 'c5', tag_key: 'value_tier', tag_value: 'low' },
      { consumer_id: 'c6', tag_key: 'value_tier', tag_value: 'low' },
    ]);
  });

  // 奶粉明细：c1 两个源的订单各一条，c2 只买纸尿裤，c3 的订单已退款，订单 o6 打通不到消费者
  it('奶粉人群：引用经订单明细算出的奶粉消费金额，买过奶粉的命中，只买别的品类、已退款与打通不到的不命中', async () => {
    const MILK_FANS = 'metric: milk_365d\nrules:\n  - value: 奶粉人群\n    when: { gt: 0 }\ndefault: 其他\n';
    expect(DSL_KINDS.tag.entities(ok(MILK_FANS), ctx)).toEqual(['order', 'order_item', 'product']);
    const milk = ctx.metrics.get('milk_365d')!;
    if (!milk.ok) throw new Error(JSON.stringify(milk.issues));
    expect((await con.runAndReadAll(compileMetric(milk.spec, ctx, '2024-07-01'))).getRowObjectsJson().map(r => ({ ...r, value: Number(r.value) })))
      .toEqual([{ consumer_id: 'c1', value: 280 }]);
    expect((await run(MILK_FANS)).map(r => [r.consumer_id, r.tag_value])).toEqual([
      ['c1', '奶粉人群'], ['c2', '其他'], ['c3', '其他'], ['c4', '其他'], ['c5', '其他'], ['c6', '其他'],
    ]);
  });

  it('多指标 all：从未下单但浏览过的消费者命中「浏览未购」，下过单的不命中；没有任何行为的统一消费者也有一行（取 default）', async () => {
    expect(await run(BROWSE_NO_BUY)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(c => ({ consumer_id: c, tag_key: 'value_tier', tag_value: c === 'c5' ? '浏览未购' : '一般' })));
  });

  it('多指标 any：任一满足即命中；missing 改写缺省——写 null 时不在结果里的人比较为假', async () => {
    const anyOf = 'rules:\n  - { value: 活跃, when: { any: [{ metric: views, gte: 5 }, { metric: revenue, gte: 1000 }] } }\ndefault: 沉默\n';
    expect((await run(anyOf)).map(r => r.tag_value)).toEqual(['活跃', '活跃', '沉默', '沉默', '活跃', '沉默']);
    const noOrders = 'rules:\n  - { value: 未下单, when: { all: [{ metric: orders, eq: 0 }] } }\ndefault: 下过单\n';
    expect((await run(noOrders)).map(r => r.tag_value)).toEqual(['下过单', '下过单', '下过单', '下过单', '未下单', '未下单']);
    expect((await run(`${noOrders}missing: { orders: null }\n`)).map(r => r.tag_value)).toEqual(['下过单', '下过单', '下过单', '下过单', '下过单', '下过单']);
    // 取最大金额（max）不补 0：没有订单的人比较为假
    expect((await run('metric: top_amount\nrules:\n  - { value: 小, when: { lt: 100 } }\ndefault: 其他\n')).map(r => r.tag_value))
      .toEqual(['其他', '其他', '小', '其他', '其他', '其他']);
  });

  it('按顺序取第一条命中的规则', async () => {
    const rows = await run('metric: revenue\nrules:\n  - { value: buyer, when: { gte: 100 } }\n  - { value: whale, when: { gte: 1000 } }\ndefault: 0\n');
    expect(rows.map(r => r.tag_value)).toEqual(['buyer', 'buyer', '0', '0', '0', '0']);
  });

  const values = (rows: string) => `SELECT * FROM (VALUES ${rows}) t(consumer_id, tag_key, tag_value)`;
  const diff = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();

  it('标签的影响：换了取值、新增、移出分开，按「原取值 → 新取值」分组计人数，取值没变的不出现；不出 consumer_id', async () => {
    const before = values(`('c1','k','a'), ('c2','k','a'), ('c3','k','a'), ('c4','k','b'), ('c5','k','b')`);
    const after = values(`('c1','k','a'), ('c2','k','b'), ('c3','k','b'), ('c4','k','a'), ('c6','k','a'), ('c7','k','a')`);
    const rows = await diff(compileTagDiff(before, after));
    expect(rows).toEqual([
      { before: null, after: 'a', consumers: 2 },
      { before: 'a', after: 'b', consumers: 2 },
      { before: 'b', after: null, consumers: 1 },
      { before: 'b', after: 'a', consumers: 1 },
    ]);
    expect(await diff(compileTagDiff(before, before))).toEqual([]);
  });

  it('草稿指标内联进标签：门槛不变时只有换了取值的消费者；指标加了过滤，结果里少了的消费者算移出', async () => {
    const draft = (yaml: string) => withMetric(ctx, 'revenue', checkMetric(yaml, base));
    const tag = (c: DslContext) => compileTag(ok(TIERS), c, '2024-07-01', 'value_tier');
    // c3 只有 20 元订单、c4 的订单金额为空，过滤后都不在指标结果里，仍按 0 取 default（人群是全部统一消费者）；c1、c2 的订单都大于 50，取值不变
    const filtered = draft('base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: amount, op: gt, value: 50 }\n');
    expect(await diff(compileTagDiff(tag(ctx), tag(filtered)))).toEqual([]);
    // 改成数订单笔数：c1 2 笔、其余 1 笔，都低于 100 → 都成 low
    const counted = draft('base: order\nmeasure: { agg: count }\n');
    expect(await diff(compileTagDiff(tag(ctx), tag(counted)))).toEqual([
      { before: 'high', after: 'low', consumers: 1 },
      { before: 'mid', after: 'low', consumers: 1 },
    ]);
  });

  it('指标的影响：每个消费者的全部行（含维度）按取值对比，给出取值变化、新增、移出的消费者数', async () => {
    const revenue = (yaml: string) => {
      const r = checkMetric(yaml, base);
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return compileMetric(r.spec, base, '2024-07-01');
    };
    const sum = revenue('base: order\nmeasure: { agg: sum, field: amount }\n');
    const filtered = revenue('base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: amount, op: gt, value: 50 }\n');
    const counted = revenue('base: order\nmeasure: { agg: count }\n');
    expect(await diff(compileMetricDiff(sum, filtered))).toEqual([{ changed: 0, added: 0, removed: 2 }]);
    expect(await diff(compileMetricDiff(filtered, sum))).toEqual([{ changed: 0, added: 2, removed: 0 }]);
    // c1 1000 → 2 笔，c2 150 → 1，c3 20 → 1；c4 空 → 1
    expect(await diff(compileMetricDiff(sum, counted))).toEqual([{ changed: 4, added: 0, removed: 0 }]);
    expect(await diff(compileMetricDiff(sum, sum))).toEqual([{ changed: 0, added: 0, removed: 0 }]);
    // 带维度时，消费者的任一行变了就算变：c1 的两笔订单在不同源，按源拆成两行
    const multi = (rows: string) => `SELECT * FROM (VALUES ${rows}) t(consumer_id, src, value)`;
    expect(await diff(compileMetricDiff(multi(`('c1','s1',100), ('c1','s2',900), ('c2','s1',150)`), multi(`('c1','s1',100), ('c1','s2',901), ('c2','s1',150)`))))
      .toEqual([{ changed: 1, added: 0, removed: 0 }]);
    // 只比较取值：维度改名不算变
    const renamed = `SELECT * FROM (VALUES ('c1','s1',100), ('c1','s2',900), ('c2','s1',150)) t(consumer_id, origin, value)`;
    expect(await diff(compileMetricDiff(multi(`('c1','s1',100), ('c1','s2',900), ('c2','s1',150)`), renamed))).toEqual([{ changed: 0, added: 0, removed: 0 }]);
  });
});

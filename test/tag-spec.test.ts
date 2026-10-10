// test/tag-spec.test.ts —— 标签 DSL：引用的指标要已发布、没有维度、取值为数字，rules 不能为空、when 要有条件、取值不能为空，按行列报错；
// 编译出的 SQL 内联指标、带上键，在内存 DuckDB 里对手造的标准层得到已知答案；发布前的影响预览（impact.ts）按 consumer_id 对比两版结果只给计数（纯函数，不碰平台库与数据湖）
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
});

describe('标签 DSL：编译', () => {
  it('同样的定义编译出同样的 SQL：内联引用指标的 SQL，键写成字面量，规则按顺序写成 CASE WHEN', () => {
    const sql = compileTag(ok(TIERS), ctx, '2024-07-01', 'value_tier');
    expect(compileTag(ok(TIERS), ctx, '2024-07-01', 'value_tier')).toBe(sql);
    expect(sql).toContain('silver._identities');
    expect(sql).toContain(`'value_tier' AS tag_key`);
    expect(sql.indexOf(`THEN 'high'`)).toBeLessThan(sql.indexOf(`THEN 'mid'`));
    expect(sql).toContain('m.value >= 100 AND m.value < 1000');
  });
});

describe('标签 DSL：编译出的 SQL 的结果', () => {
  let instance: DuckDBInstance;
  let con: DuckDBConnection;

  // c1 有两个源的订单（100 + 900），c2 150，c3 20，c4 只有金额为空的订单（取值为空），c5 打通了但没有订单（不在指标结果里）；
  // 订单 x 打通不到消费者，不计入
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    con = await instance.connect();
    await con.run(`SET TimeZone = 'UTC';
      CREATE SCHEMA silver;
      CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2'), ('s1','3','c3'), ('s1','4','c4'), ('s1','5','c5');
      CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, amount DECIMAL(18,2), _source VARCHAR);
      INSERT INTO silver."order" VALUES
        ('o1', '1', 100, 's1'), ('o2', '10', 900, 's2'), ('o3', '2', 150, 's1'), ('o4', '3', 20, 's1'), ('o5', '4', NULL, 's1'), ('o6', 'x', 5000, 's2');`);
  });

  afterAll(() => {
    con?.closeSync();
    instance?.closeSync();
  });

  const run = async (yaml: string) => (await con.runAndReadAll(compileTag(ok(yaml), ctx, '2024-07-01', 'value_tier'))).getRowObjectsJson();

  it('多源订单合到同一消费者后取值；覆盖指标结果里的每个消费者，没命中或指标值为空的取 default；每行带键', async () => {
    expect(await run(TIERS)).toEqual([
      { consumer_id: 'c1', tag_key: 'value_tier', tag_value: 'high' },
      { consumer_id: 'c2', tag_key: 'value_tier', tag_value: 'mid' },
      { consumer_id: 'c3', tag_key: 'value_tier', tag_value: 'low' },
      { consumer_id: 'c4', tag_key: 'value_tier', tag_value: 'low' },
    ]);
  });

  it('按顺序取第一条命中的规则', async () => {
    const rows = await run('metric: revenue\nrules:\n  - { value: buyer, when: { gte: 100 } }\n  - { value: whale, when: { gte: 1000 } }\ndefault: 0\n');
    expect(rows.map(r => r.tag_value)).toEqual(['buyer', 'buyer', '0', '0']);
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
    // c3 只有 20 元订单、c4 的订单金额为空，过滤后都不在指标结果里；c1、c2 的订单都大于 50，取值不变
    const filtered = draft('base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: amount, op: gt, value: 50 }\n');
    expect(await diff(compileTagDiff(tag(ctx), tag(filtered)))).toEqual([{ before: 'low', after: null, consumers: 2 }]);
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

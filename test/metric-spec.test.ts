// test/metric-spec.test.ts —— 指标 DSL：YAML 校验与按行列报错（基础实体、字段、敏感字段、维度路径的关系 / 跳数 / 成环、维度个数、as_of），
// 同样的定义编译出同样的 SQL，编译出的 SQL 在内存 DuckDB 里对手造的标准层得到已知答案（纯函数，不碰平台库与数据湖）
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

// 门店 → 区域 → 国家 → 大洲；门店有指向自己的上级门店；custom_visit 是带 customer_id 的事实实体
const published = new Map<string, RegisteredEntity>([
  entity('custom_store', [field('store_id'), field('region_id'), field('name'), field('parent_id')],
    [rel('order.store_id', 'custom_store.store_id'), rel('custom_store.region_id', 'custom_region.region_id'), rel('custom_store.parent_id', 'custom_store.store_id')]),
  entity('custom_region', [field('region_id'), field('name'), field('manager_phone', 'string', true), field('country_id')],
    [rel('custom_region.country_id', 'custom_country.country_id')]),
  entity('custom_country', [field('country_id'), field('continent_id')], [rel('custom_country.continent_id', 'custom_continent.continent_id')]),
  entity('custom_continent', [field('continent_id'), field('name')]),
  entity('custom_visit', [field('visit_id'), field('customer_id'), field('visited_on', 'date'), field('minutes', 'integer')],
    [rel('custom_visit.customer_id', 'customer.customer_id')]),
  // 会员档案：主键 customer_id 指向 customer，与 customer 一样只在同一数据源内唯一
  entity('custom_profile', [field('customer_id'), field('tier')],
    [rel('custom_profile.customer_id', 'customer.customer_id'), rel('order.customer_id', 'custom_profile.customer_id')]),
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

describe('指标 DSL：校验', () => {
  it('合规的定义通过，注册表登记了 metric', () => {
    expect(ok(REGION)).toMatchObject({ base: 'order', measure: { agg: 'sum', field: 'amount' } });
    expect(DSL_KINDS.metric.check).toBe(checkMetric);
    expect(DSL_KINDS.metric.entities(ok(REGION), ctx)).toEqual(['custom_region', 'custom_store', 'order']);
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
  ])('%s', (_, yaml, line, message) => {
    const found = issues(yaml);
    expect(found.find(i => message.test(i.message)), JSON.stringify(found)).toMatchObject({ line });
  });

  it('多个问题一起报出，按位置排序', () => {
    const found = issues('base: order\nmeasure: { agg: sum, field: channel }\nwindow: { field: amount, days: 30 }\n');
    expect(found.map(i => i.line)).toEqual([2, 3]);
    expect(found[0]!.col).toBeGreaterThan(1);
  });
});

describe('指标 DSL：编译', () => {
  it('同样的定义编译出同样的 SQL，不依赖当前时间', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      const first = compileMetric(ok(REGION), ctx, '2024-07-01');
      vi.setSystemTime(new Date('2030-06-01T00:00:00Z'));
      expect(compileMetric(ok(REGION), ctx, '2024-07-01')).toBe(first);
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

  it('关联到 customer 或主键指向 customer 的实体时按数据源关联，其余实体不按', () => {
    const dim = (path: string) => compileMetric(ok(`base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: d, path: ${path} }\n`), ctx, '2024-07-01');
    expect(dim('order.customer_id -> custom_profile.tier')).toContain('d0_1._source = b._source');
    expect(dim('order.customer_id -> customer.city')).toContain('d0_1._source = b._source');
    expect(dim('order.store_id -> custom_store.name')).not.toContain('d0_1._source');
  });
});

describe('指标 DSL：编译出的 SQL 的结果', () => {
  let instance: DuckDBInstance;
  let con: DuckDBConnection;

  // 消费者 c1（两个源）、c2；o5 的门店不在门店表里、o6 没有门店、o7 的门店没有区域，都记为「未关联」；o8 打通不到消费者，不计入；
  // o9 在窗口外，o10 状态不计入
  beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    con = await instance.connect();
    await con.run(`SET TimeZone = 'UTC';
      CREATE SCHEMA silver;
      CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      INSERT INTO silver._identities VALUES ('s1','1','c1'), ('s2','10','c1'), ('s1','2','c2');
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
      INSERT INTO silver.custom_region VALUES ('r1', '华东', NULL, NULL), ('r2', '华北', NULL, NULL);`);
  });

  afterAll(() => {
    con?.closeSync();
    instance?.closeSync();
  });

  const run = async (yaml: string, asOf = '2024-07-01') => (await con.runAndReadAll(compileMetric(ok(yaml), ctx, asOf))).getRowObjectsJson()
    .map(r => ({ ...r, value: Number(r.value) }));

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
});

// test/pipeline/dsl-definitions.test.ts —— 指标与标签定义的流水线接缝：成员新建定义（createDefinition）→ 再次保存改同一份草稿（saveDslDraft）→ getDefinition 读出各版本、
// 作者与最后保存的人，以及编译出的 SQL；键不合规或重复、YAML 校验不通过、没有起草权限时拒绝且不写入。
// 样本预览（previewDefinition）在只读挂载的数据湖上按今天运行编译出的 SQL，给出前 50 行与总行数，湖与任务队列不变。
// 双人发布（publishDefinition）以当天入队 gold.dsl，调度器成功后登记快照；丢弃草稿（discardDslDraft）回到已发布版本或删除定义
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { dslVersions, mappings, tasks } from '../../app/.server/db/schema';
import { createDefinition, discardDslDraft, DslError, getDefinition, previewDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { publishMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, relistSource, setSyncScope } from '../../app/.server/sources';
import { getTask } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish } from './fixtures';
import { CRM_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
const REVENUE_BY_CITY = `${REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`;

describe('指标定义', () => {
  it('新建后再次保存改的是同一份草稿，记下作者与最后保存的人；定义页给出编译出的 SQL', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com', 'data_engineer');

    expect(await createDefinition(analyst, 'metric', 'revenue_30d', REVENUE)).toEqual({ kind: 'metric', key: 'revenue_30d', version: 1 });
    expect(await saveDslDraft(engineer, 'metric', 'revenue_30d', REVENUE_BY_CITY)).toBe(1);

    const d = await getDefinition(analyst, 'metric', 'revenue_30d');
    expect(d).toMatchObject({
      kind: 'metric', key: 'revenue_30d', published: null,
      draft: { version: 1, yaml: REVENUE_BY_CITY, authors: ['analyst@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com' },
      compiled: { version: 1, issues: [] },
    });
    expect(d.versions).toHaveLength(1);
    expect(d.compiled.sql).toContain('silver._identities');
    expect(d.compiled.sql).toMatch(/LEFT JOIN silver\."customer"/);
    expect(d.compiled.sql).toContain('未关联');
  });

  it('键不合规或在租户内重复时拒绝；别的租户可以用同样的键', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await expect(createDefinition(analyst, 'metric', 'Revenue', REVENUE)).rejects.toThrow(/小写字母开头/);
    await expect(createDefinition(analyst, 'metric', '1st', REVENUE)).rejects.toBeInstanceOf(DslError);
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(createDefinition(analyst, 'metric', 'revenue', REVENUE)).rejects.toThrow(/已经有键为 revenue/);
    await expect(createDefinition(analyst, 'nope', 'revenue', REVENUE)).rejects.toMatchObject({ status: 404 });
    await expect(saveDslDraft(analyst, 'metric', 'missing', REVENUE)).rejects.toMatchObject({ status: 404 });

    const globex = await newTenant('globex');
    await createDefinition(await memberOf(globex, 'analyst@globex.com', 'analyst'), 'metric', 'revenue', REVENUE);
  });

  it('YAML 校验不通过时报出按行列的问题，不写入；未发布的自定义实体不能用', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const bad = createDefinition(analyst, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: channel }\n');
    await expect(bad).rejects.toMatchObject({ status: 400, issues: [{ line: 2, message: expect.stringMatching(/整数或小数/) }] });
    await expect(createDefinition(analyst, 'metric', 'stores', 'base: custom_store\nmeasure: { agg: count }\n'))
      .rejects.toMatchObject({ issues: [{ line: 1, message: expect.stringMatching(/custom_store.*发布/) }] });

    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(saveDslDraft(analyst, 'metric', 'revenue', 'base: order\n')).rejects.toMatchObject({ issues: [{ message: expect.stringMatching(/缺少 measure/) }] });
    expect((await getDefinition(analyst, 'metric', 'revenue')).draft).toMatchObject({ yaml: REVENUE });
    expect(await getDb().select().from(dslVersions)).toHaveLength(1);
  });

  it('没有起草权限的成员不能新建或保存，但可以查看', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(createDefinition(viewer, 'metric', 'revenue', REVENUE)).rejects.toMatchObject({ init: { status: 403 } });
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(saveDslDraft(viewer, 'metric', 'revenue', REVENUE_BY_CITY)).rejects.toMatchObject({ init: { status: 403 } });
    expect((await getDefinition(viewer, 'metric', 'revenue')).draft).toMatchObject({ yaml: REVENUE, authors: ['analyst@acme.com'] });
  });
});

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 在本租户数据湖里执行 SQL（查看快照） */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

const SNAPSHOT = `SELECT max(snapshot_id)::VARCHAR AS n FROM ducklake_snapshots('lake')`;

/**
 * 身份打通的三个源与两个订单映射已发布（crm.orders 里 A5 的下单人 99 打通不到消费者），CRM 源另加 60 笔 1 元订单（N01…N60，下单人 1）与门店表 stores；
 * 自定义实体 custom_store（store_id、name，关系 order.store_id → custom_store.store_id）登记发布并从 stores 合并；
 * CRM 订单映射重新发布，store_id 取订单号：A1、A2 与 N01…N60 能关联到门店，其余订单（含会员源的订单）关联不到
 */
async function ordersWithStores() {
  const people = await publishedIdentitySources({ orders: true });
  const { author, reviewer, sources: { crm } } = people;
  await grantOnSource(`
    INSERT INTO crm.orders SELECT 'N' || lpad(i::text, 2, '0'), 1, 'paid', 1, '2024-07-05 10:00', '2024-07-05 10:00', '2024-07-10' FROM generate_series(1, 60) i;
    CREATE TABLE crm.stores (store_id text PRIMARY KEY, name text, updated_at timestamp NOT NULL);
    INSERT INTO crm.stores VALUES ('A1', '一店', '2024-06-01'), ('A2', '二店', '2024-06-01');
    INSERT INTO crm.stores SELECT 'N' || lpad(i::text, 2, '0'), '店' || lpad(i::text, 2, '0'), '2024-06-01' FROM generate_series(1, 60) i;
    GRANT SELECT ON crm.stores TO ${READER.user};`);
  await relistSource(author, crm);
  await drain();
  await setSyncScope(author, crm, { add: ['stores'] });
  await drain();
  await confirmWatermark(author, crm, 'stores', 'updated_at');
  await syncSource(author, crm);
  await drain();
  const store = await createCustomEntity(author, {
    name: 'custom_store', label: '门店', kind: 'dimension', primaryKey: ['store_id'],
    fields: [{ name: 'store_id', type: 'string', description: '', sensitive: false }, { name: 'name', type: 'string', description: '', sensitive: false }],
    relations: [{ from: { entity: 'order', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }],
  });
  await publishCustomEntity(reviewer, store, 1);
  await publish(author, reviewer, crm, 'model: 1\nentity: custom_store\ntable: stores\nextensions:\n  store_id: { type: string, expr: store_id }\n  name: { type: string, expr: name }\ndedupe: { key: [store_id] }\n');
  const [orders] = await getDb().select({ id: mappings.id }).from(mappings).where(and(eq(mappings.sourceId, crm), eq(mappings.tableName, 'orders')));
  await publishMapping(reviewer, orders!.id, await saveDraft(author, orders!.id, `${CRM_ORDERS}  store_id: order_no\n`));
  await drain();
  return people;
}

const BY_STORE = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: store, path: order.store_id -> custom_store.name }\n';

describe('样本预览', () => {
  it('在只读挂载上按今天运行编译出的 SQL，给出前 50 行与总行数；关联不到门店的记「未关联」，打通不到消费者的订单不计入；湖与任务不变', async () => {
    const { acme } = await ordersWithStores();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    // 不计 1 元订单：每个消费者与门店一行，共 6 行
    await createDefinition(analyst, 'metric', 'big_orders', `${BY_STORE}filter:\n  - { field: amount, op: gt, value: 1 }\n`);
    await createDefinition(analyst, 'metric', 'by_store', BY_STORE);
    const [before] = await onLake<{ n: string }>(acme, SNAPSHOT);
    const queued = (await getDb().select().from(tasks)).length;

    const big = await previewDefinition(analyst, 'metric', 'big_orders');
    expect(big).toMatchObject({ version: 1, asOf: new Date().toISOString().slice(0, 10), columns: ['consumer_id', 'store', 'value'], total: 6 });
    expect(big.rows).toHaveLength(6);
    // consumer_id 是平台 ID（哈希），不是手机号或邮箱
    expect(big.rows.every(r => /^[0-9a-f]{64}$/.test(String(r.consumer_id)))).toBe(true);
    expect(big.rows.map(r => r.store).sort()).toEqual(['一店', '二店', '未关联', '未关联', '未关联', '未关联']);
    // 下单人 99 的 A5（50 元）不在结果里
    expect(big.rows.reduce((sum, r) => sum + Number(r.value), 0)).toBe(100 + 300 + 200 + 999 + 150 + 400 + 200 + 80 + 1000 + 500);

    // 60 个 1 元门店各一行，共 66 行，只给出前 50 行
    const all = await previewDefinition(analyst, 'metric', 'by_store');
    expect(all).toMatchObject({ total: 66 });
    expect(all.rows).toHaveLength(50);

    const [after] = await onLake<{ n: string }>(acme, SNAPSHOT);
    expect(after).toEqual(before);
    expect(await getDb().select().from(tasks)).toHaveLength(queued);
  });

  it('标准层还没有基础实体或身份打通结果时给出说明；没有的版本与其他租户的定义 404，查看者可以预览', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(previewDefinition(analyst, 'metric', 'revenue')).rejects.toThrow(/标准层还没有.*silver\.order/);
    await expect(previewDefinition(analyst, 'metric', 'revenue', 2)).rejects.toMatchObject({ status: 404 });
    const outsider = await memberOf(await newTenant('globex'), 'analyst@globex.com', 'analyst');
    await expect(previewDefinition(outsider, 'metric', 'revenue')).rejects.toMatchObject({ status: 404 });

    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(previewDefinition(viewer, 'metric', 'revenue')).rejects.toThrow(/标准层还没有/);
  });

  it('只发布了 customer 映射、还没有订单时说明缺 silver.order', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await expect(previewDefinition(analyst, 'metric', 'revenue')).rejects.toThrow(/标准层还没有.*silver\.order.*发布.*映射并合并/);
  });
});

// 不限时间窗口：覆盖夹具里 2024 年的订单
const ALL_REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';

describe('发布与丢弃', () => {
  it('最后保存草稿的人与分析师不能发布；另一位数据工程师发布后版本锁定，以当天入队 gold.dsl，成功后登记快照；再改是新一版草稿，再发布只新增快照', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(author, 'metric', 'revenue', ALL_REVENUE);

    const error = await publishDefinition(author, 'metric', 'revenue', 1).catch(e => e);
    expect(error).toBeInstanceOf(DslError);
    expect(error.message).toMatch(/最后改了这一版草稿/);
    await expect(publishDefinition(analyst, 'metric', 'revenue', 1)).rejects.toMatchObject({ init: { status: 403 } });

    const today = new Date().toISOString().slice(0, 10);
    const task = await publishDefinition(reviewer, 'metric', 'revenue', 1);
    expect(task).toMatchObject({
      kind: 'gold.dsl', status: 'queued',
      params: { kind: 'metric', key: 'revenue', definitionId: expect.any(String), definitionVersion: 1, asOf: today, entities: ['order'], sql: expect.stringContaining('silver._identities') },
    });
    expect(await getDefinition(analyst, 'metric', 'revenue')).toMatchObject({ draft: null, published: { version: 1, publishedByEmail: reviewer.email } });
    await expect(publishDefinition(author, 'metric', 'revenue', 1)).rejects.toThrow(/已锁定/);

    await drain();
    expect(await getTask(task.id)).toMatchObject({ status: 'succeeded' });
    const [first] = await listSnapshots(acme);
    const [{ n }] = await onLake<{ n: string }>(acme, `SELECT count(*)::VARCHAR AS n FROM gold."metric__${task.id}"`);
    expect(Number(n)).toBeGreaterThan(0);
    expect(first).toMatchObject({
      template: 'metric:revenue', taskId: task.id, table: `gold.metric__${task.id}`, definitionVersion: 1, rowCount: Number(n), incomplete: null,
      params: { kind: 'metric', key: 'revenue', asOf: today, definitionVersion: 1 },
    });
    expect(first!.expiresAt.getTime() - first!.createdAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);

    // 发布后再改是新的一版草稿，键不变，已发布的第 1 版不变
    expect(await saveDslDraft(analyst, 'metric', 'revenue', REVENUE_BY_CITY.replace(REVENUE, ALL_REVENUE))).toBe(2);
    expect(await getDefinition(analyst, 'metric', 'revenue')).toMatchObject({ key: 'revenue', draft: { version: 2 }, published: { version: 1 } });
    const second = await publishDefinition(author, 'metric', 'revenue', 2);
    await drain();
    expect(await getTask(second.id)).toMatchObject({ status: 'succeeded' });
    const snapshots = await listSnapshots(acme);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find(s => s.taskId === second.id)).toMatchObject({ template: 'metric:revenue', definitionVersion: 2 });
    expect(snapshots.find(s => s.taskId === task.id)).toEqual(first);
  });

  it('任务失败（标准层还没有订单）时不登记快照', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources();
    await createDefinition(author, 'metric', 'revenue', ALL_REVENUE);
    const task = await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await drain();
    expect(await getTask(task.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/silver\.order/) });
    expect(await listSnapshots(acme)).toEqual([]);
  });

  it('丢弃草稿：有已发布版本时回到它，从没发布过时删除整个定义', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    expect(await discardDslDraft(analyst, 'metric', 'revenue')).toEqual({ published: null });
    await expect(getDefinition(analyst, 'metric', 'revenue')).rejects.toMatchObject({ status: 404 });
    await expect(discardDslDraft(analyst, 'metric', 'revenue')).rejects.toMatchObject({ status: 404 });

    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await publishDefinition(engineer, 'metric', 'revenue', 1);
    await expect(discardDslDraft(analyst, 'metric', 'revenue')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/没有草稿/) });
    await saveDslDraft(analyst, 'metric', 'revenue', REVENUE_BY_CITY);
    expect(await discardDslDraft(engineer, 'metric', 'revenue')).toEqual({ published: 1 });
    expect(await getDefinition(analyst, 'metric', 'revenue')).toMatchObject({ draft: null, published: { version: 1, yaml: REVENUE } });
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(discardDslDraft(viewer, 'metric', 'revenue')).rejects.toMatchObject({ init: { status: 403 } });
  });
});

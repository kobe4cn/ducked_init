// 基于源视图的映射的流水线接缝：发布源视图 → createMapping（YAML 写 view:）对照视图的列 → dryRunMapping 转换视图的样本 →
// publishMapping 后 silver.merge 把视图的结果合并进标准层；视图引用的任一张表同步写入变更、或视图发布新版本后再合并（重建）
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, tasks } from '../../app/.server/db/schema';
import { createMapping, dryRunMapping, enqueueDueMerges, getMapping, mergeNow, publishMapping } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { revealPii } from '../../app/.server/pii';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, publishSourceView, saveSourceViewDraft } from '../../app/.server/source-views';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 两位数据工程师；登记电商库、选入全部表，确认 customers 与 orders 的水位线并同步一次 */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id };
}

/** 订单带上下单客户当前的城市与邮箱：customers 取每个客户的最新一版，平台列取自 orders */
const ORDER_CITIES = `WITH cur AS (
  SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY customer_id ORDER BY _batch DESC) AS rn FROM customers) WHERE rn = 1 AND _op <> 'delete'
)
SELECT o.order_id, o.customer_id, o.amount, o.status, o.created_at, c.city, c.email, o._op, o._batch, o._commit_ts
FROM orders o LEFT JOIN cur c ON c.customer_id = o.customer_id`;

const MAPPING = `model: 1
entity: order
view: order_cities
view_key: [order_id]
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
extensions:
  x_city: { type: string, expr: city }
  x_buyer_email: { type: string, expr: email, sensitive: true }
`;

/** 发布 order_cities 源视图（author 起草、reviewer 发布），返回视图 ID */
async function publishedView(author: Awaited<ReturnType<typeof syncedSource>>['author'], reviewer: typeof author, id: string) {
  const viewId = await createSourceView(author, id, { name: 'order_cities', sql: ORDER_CITIES });
  await publishSourceView(reviewer, id, viewId, 1);
  return viewId;
}

describe('基于源视图的映射', () => {
  it('YAML 用 view 引用已发布的源视图，空跑转换视图的样本，发布后视图的结果合并进标准层', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'order_cities', sql: ORDER_CITIES });
    // 源视图还没发布时不能引用
    await expect(createMapping(author, id, MAPPING)).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: 'view', message: '数据源中没有已发布的源视图 order_cities' })],
    });
    await publishSourceView(reviewer, id, viewId, 1);

    const mapping = await createMapping(author, id, MAPPING);
    expect(mapping).toMatchObject({ tableName: 'order_cities', sourceViewId: viewId });
    const dry = await dryRunMapping(author, mapping.id, 1);
    expect(dry.sampled).toBe(50);
    expect(dry.rows.every(r => ['北京', '上海', '广州', '深圳'].includes(String(r.x_city)))).toBe(true);
    expect(dry.columns.find(c => c.name === 'x_buyer_email')).toMatchObject({ sensitive: true });

    await publishMapping(reviewer, mapping.id, 1);
    await drain();
    const orders = await silver(acme, 'order', 'order_id::INT');
    expect(orders).toHaveLength(100);
    expect(orders[0]).toMatchObject({ order_id: '1', status: 'refunded', _mapping: mapping.id, _source: id });
    expect(orders.every(o => ['北京', '上海', '广州', '深圳'].includes(String(o.x_city)))).toBe(true);
    expect(JSON.stringify(orders)).not.toContain('@');
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', inserted: 100, rows: 100 });

    // 没有新批次时不重建
    await mergeNow(author);
    await drain();
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'incremental', inserted: 0, updated: 0, deleted: 0, rows: 100 });

    // 视图可能连接多张表，按源表主键找不回它的一行
    const admin = await memberOf(acme, 'admin@acme.com');
    await expect(revealPii(admin, { mappingId: mapping.id, key: '1', reason: '核对' })).rejects.toThrow(/源视图 order_cities/);
  });

  it('视图引用的任一张表同步写入变更后合并这个映射；没有变更的同步不合并；视图发布新版本后按新版本重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const viewId = await publishedView(author, reviewer, id);
    const mapping = await createMapping(author, id, MAPPING);
    await publishMapping(reviewer, mapping.id, 1);
    await drain();
    const merges = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge').length;
    expect(await merges()).toBe(1);

    // customers 不是视图的主表，平台列取自 orders：照样合并
    await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
    await syncSource(author, id);
    await drain();
    expect(await merges()).toBe(2);
    expect(await enqueueDueMerges()).toEqual([]);
    const cities = await silver(acme, 'order', 'order_id::INT');
    expect(cities.filter(o => o.customer_id === '5').map(o => o.x_city)).toEqual(expect.arrayContaining(['成都']));
    expect(cities.filter(o => o.customer_id === '5').every(o => o.x_city === '成都')).toBe(true);
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 100 });

    // 没有变更的同步不合并
    await syncSource(author, id);
    await drain();
    expect(await merges()).toBe(2);

    // 视图发布新版本：基于它的映射入队合并，按新版本重建
    await saveSourceViewDraft(author, id, viewId, ORDER_CITIES.replace('c.city,', "coalesce(c.city, '未知') AS city,").replace('WHERE rn = 1', "WHERE customer_id <> 5 AND rn = 1"));
    await publishSourceView(reviewer, id, viewId, 2);
    await drain();
    expect(await merges()).toBe(3);
    const unknown = await silver(acme, 'order', 'order_id::INT');
    expect(unknown.filter(o => o.customer_id === '5').every(o => o.x_city === '未知')).toBe(true);
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 100 });
    const [row] = await getDb().select().from(mappings).where(eq(mappings.id, mapping.id));
    expect(row.sourceViewId).toBe(viewId);
  });

  it('视图发布新版本时已有合并在运行：入队不了，定时检查发现合并带的视图版本旧了再补上', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const viewId = await publishedView(author, reviewer, id);
    const mapping = await createMapping(author, id, MAPPING);
    await publishMapping(reviewer, mapping.id, 1);
    await drain();
    expect(await enqueueDueMerges()).toEqual([]);

    // 模拟一个正在运行的合并：发布视图时入队不了
    const running = await mergeNow(author);
    await getDb().update(tasks).set({ status: 'running', startedAt: new Date() }).where(eq(tasks.id, running.id));
    await saveSourceViewDraft(author, id, viewId, ORDER_CITIES.replace('c.city,', "coalesce(c.city, '未知') AS city,"));
    await publishSourceView(reviewer, id, viewId, 2);
    expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge')).toHaveLength(2);
    expect(await enqueueDueMerges()).toEqual([]);

    // 运行中的合并带的是第 1 版视图：它结束后由定时检查补上
    await getDb().update(tasks).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(tasks.id, running.id));
    expect(await enqueueDueMerges()).toEqual([acme]);
    await drain();
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 100 });
    expect(await enqueueDueMerges()).toEqual([]);
  });
});

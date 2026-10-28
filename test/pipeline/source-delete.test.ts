// test/pipeline/source-delete.test.ts —— 删除数据源的接缝（ADR-0044）：deleteBlockers 列出全部拒绝原因（已发布没停用的映射、跨源引用方、排队或运行中的源任务与合并），
// deleteSource 满足条件时丢弃没发布过的映射与源视图、清空同步范围与凭据、打上删除标记、入队 source.drop 并记审计；已删除的数据源各处查不到，可以重新登记同名的；
// source.drop 删掉原始层的三个 schema 与文件，标准层不动；已删除的数据源不被定时同步与核对、工作台原始层视图、映射列表、跨源引用与恢复映射用到
import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, mappingVersions, sources, sourceTables, sourceViews, tasks } from '../../app/.server/db/schema';
import { confirmDisable, createMapping, listMappings, publishedPlans, publishMapping, requestDisable, restoreMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { requireSource, sourceIdByName } from '../../app/.server/source-config';
import { enqueueDueSyncs, syncSource } from '../../app/.server/source-sync';
import { enqueueDueVerifies } from '../../app/.server/source-verify';
import { createSourceView } from '../../app/.server/source-views';
import { confirmWatermark, deleteBlockers, deleteSource, listSources, registerSource } from '../../app/.server/sources';
import { listCatalog, runQuery } from '../../app/.server/workbench';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, onLake, publish, runTask, selectAllTables } from './fixtures';
import { CRM_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  updated_at: updated_at
`;

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
`;

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

const blockersOf = (tenantId: string, sourceId: string) => getDb().transaction(tx => deleteBlockers(tx, tenantId, sourceId));

describe('删除数据源', () => {
  it('有已发布没停用的映射、排队中的源任务或合并时拒绝并列出原因；分析师 403；停用并跑完任务后删除：丢弃没发布过的映射与源视图、清空同步范围与凭据，保留停用的映射', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const draftOnly = await createMapping(author, id, ORDERS);
    const viewId = await createSourceView(author, id, { name: 'paid_orders', sql: 'SELECT order_id, _op, _batch, _commit_ts FROM orders' });

    await syncSource(author, id);
    await requestDisable(author, customers);
    await confirmDisable(reviewer, customers);
    // 停用入队了一次撤下映射的合并，同步也在排队
    expect(await blockersOf(acme, id)).toEqual([
      '有排队中或运行中的任务：同步',
      '有排队中或运行中的合并任务',
    ]);
    await expect(deleteSource(author, id)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('有排队中或运行中的合并任务') });
    await expect(deleteSource(await memberOf(acme, 'an@acme.com', 'analyst'), id)).rejects.toMatchObject({ init: { status: 403 } });
    await drain();

    // 发布那份草稿：已发布没停用
    const orders = draftOnly.id;
    await publishMapping(reviewer, orders, 1);
    await drain();
    expect(await blockersOf(acme, id)).toEqual(['有已发布且没停用的映射：orders → order，先停用它们']);
    await expect(deleteSource(author, id)).rejects.toThrow('orders → order');
    await requestDisable(author, orders);
    await confirmDisable(reviewer, orders);
    await drain();
    // 停用的映射上留一份草稿：删除时丢弃草稿、保留已发布版本
    await saveDraft(author, customers, CUSTOMERS.replace('name: name', 'name: upper(name)'));

    expect(await blockersOf(acme, id)).toEqual([]);
    const [before] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(before.credentials).not.toBe('');
    await deleteSource(author, id);

    const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(row).toMatchObject({ credentials: '', deletedAt: expect.any(Date), deletedByEmail: 'de@acme.com' });
    expect(await getDb().select().from(sourceTables).where(eq(sourceTables.sourceId, id))).toEqual([]);
    expect(await getDb().select().from(sourceViews).where(eq(sourceViews.id, viewId))).toEqual([]);
    const kept = await getDb().select({ id: mappings.id, disabledAt: mappings.disabledAt }).from(mappings).where(eq(mappings.sourceId, id));
    expect(kept.map(m => m.id).sort()).toEqual([customers, orders].sort());
    expect(kept.every(m => m.disabledAt)).toBe(true);
    const versions = await getDb().select({ status: mappingVersions.status }).from(mappingVersions)
      .where(eq(mappingVersions.mappingId, customers));
    expect(versions.map(v => v.status)).toEqual(['published']);

    const audit = (await listAuditLogs(acme)).filter(l => l.action === '删除数据源').map(l => `${l.actor} ${l.summary}`);
    expect(audit).toEqual(['de@acme.com 「电商库」（PostgreSQL）']);
  });

  it('没发布过的映射草稿与源视图草稿一并丢弃', async () => {
    const { author, id } = await syncedSource();
    const draftOnly = await createMapping(author, id, CUSTOMERS);
    await createSourceView(author, id, { name: 'paid_orders', sql: 'SELECT order_id, _op, _batch, _commit_ts FROM orders' });
    await deleteSource(author, id);
    expect(await getDb().select().from(mappings).where(eq(mappings.id, draftOnly.id))).toEqual([]);
    expect(await getDb().select().from(sourceViews).where(eq(sourceViews.sourceId, id))).toEqual([]);
  });

  it('被别的数据源跨源引用时拒绝，列出引用方的数据源、映射与字段', async () => {
    const { acme, author, reviewer, sources: ids, orderMappings } = await publishedIdentitySources({ orders: true });
    const crmOrders = orderMappings!.crm;
    await publishMapping(reviewer, crmOrders, await saveDraft(author, crmOrders,
      CRM_ORDERS.replace('  customer_id: string(customer)\n', '  customer_id: { expr: string(customer), customer_source: 会员 }\n')));
    await drain();
    const reasons = await blockersOf(acme, ids.loyalty);
    expect(reasons).toContain('被别的数据源跨源引用：CRM 的 orders → order（customer_id），先改掉或停用它们');
    expect(reasons[0]).toMatch(/^有已发布且没停用的映射：/);
    expect((await publishedPlans(getDb(), acme)).some(p => p.sourceId === ids.loyalty)).toBe(true);
  });

  it('已删除的数据源：requireSource 404、sourceIdByName 为 null、listSources 里没有；可以重新登记同名的', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(author, await pgSourceInput(READER));
    await drain();
    await deleteSource(author, id);

    await expect(requireSource(acme, id)).rejects.toMatchObject({ status: 404 });
    expect(await sourceIdByName(acme, '电商库')).toBeNull();
    expect(await listSources(author)).toEqual([]);
    await expect(deleteSource(author, id)).rejects.toMatchObject({ status: 404 });

    const again = await registerSource(author, await pgSourceInput(READER));
    expect(again.id).not.toBe(id);
    expect(await sourceIdByName(acme, '电商库')).toBe(again.id);
    expect((await listSources(author)).map(s => s.id)).toEqual([again.id]);
  });

  it('删除入队 source.drop（参数是 schema）：跑完后三个 schema、其中的表与 parquet 文件都已删除，别的数据源的原始层与标准层的行不受影响；重复执行不报错', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const reviewer = await memberOf(acme, 'de2@acme.com');
    // 关掉内联，原始层写成 parquet 文件
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 0)`);
    const syncAll = async (name: string) => {
      const { id } = await registerSource(author, await pgSourceInput(READER, name));
      await selectAllTables(author, id);
      await drain();
      await confirmWatermark(author, id, 'customers', 'updated_at');
      await confirmWatermark(author, id, 'orders', 'order_id');
      await syncSource(author, id);
      await drain();
      return id;
    };
    const kept = await syncAll('电商库');
    const doomed = await syncAll('旧电商库');
    await publish(author, reviewer, kept, CUSTOMERS);
    const orders = await publish(author, reviewer, doomed, ORDERS);
    await drain();
    await requestDisable(author, orders);
    await confirmDisable(reviewer, orders);
    await drain();

    const schema = bronzeSchema(doomed);
    const schemas = [schema, `${schema}_keys`, `${schema}_mirror`];
    const lakeTables = (s: string[]) => onLake<{ name: string }>(acme, `
      SELECT table_schema || '.' || table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema IN (${s.map(x => `'${x}'`).join(', ')}) ORDER BY ALL`);
    const doomedTables = await lakeTables(schemas);
    expect(doomedTables.map(t => t.name)).toEqual(expect.arrayContaining([`${schema}.customers`, `${schema}_keys.customers`]));
    expect(doomedTables.some(t => t.name.startsWith(`${schema}_mirror.`))).toBe(true);
    const files = (await Promise.all(doomedTables.map(t => {
      const [s, name] = t.name.split('.');
      return onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', '${name}', schema => '${s}')`);
    }))).flat();
    expect(files.length).toBeGreaterThan(0);
    const keptTables = await lakeTables([bronzeSchema(kept)]);
    const silverCount = async () => (await onLake<{ n: string }>(acme, 'SELECT count(*) AS n FROM silver.customer'))[0].n;
    const customers = await silverCount();
    expect(Number(customers)).toBeGreaterThan(0);

    await deleteSource(author, doomed);
    const [drop] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'source.drop')));
    expect(drop).toMatchObject({ status: 'queued', params: { schema } });
    await drain();
    const [done] = await getDb().select().from(tasks).where(eq(tasks.id, drop.id));
    expect(done).toMatchObject({ status: 'succeeded' });

    expect(await lakeTables(schemas)).toEqual([]);
    const left = await onLake<{ name: string }>(acme, `SELECT schema_name AS name FROM information_schema.schemata WHERE catalog_name = 'lake'`);
    expect(left.map(s => s.name).filter(s => schemas.includes(s))).toEqual([]);
    expect(files.filter(f => existsSync(f.path))).toEqual([]);
    expect(await lakeTables([bronzeSchema(kept)])).toEqual(keptTables);
    expect(await silverCount()).toBe(customers);

    expect(await runTask(acme, 'source.drop', { schema })).toMatchObject({ status: 'succeeded' });
    expect(await runTask(acme, 'source.drop', { schema: 'silver' })).toMatchObject({ status: 'failed' });
  });

  it('已删除的数据源不再被调度与引用：定时同步与核对跳过它，工作台不挂它的原始层视图，映射列表没有它的映射，跨源引用指不到它，恢复它的映射时 400', async () => {
    const { acme, author, reviewer, sources: ids, mappings: customerMappings, orderMappings } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    const hasRaw = async (name: string) => (await listCatalog(analyst)).raw.some(s => s.name === name);
    expect(await hasRaw('会员')).toBe(true);
    for (const mapping of [orderMappings!.loyalty, customerMappings.loyalty]) {
      await requestDisable(author, mapping);
      await confirmDisable(reviewer, mapping);
      await drain();
    }
    const scope = await getDb().select().from(sourceTables).where(eq(sourceTables.sourceId, ids.loyalty));
    await deleteSource(author, ids.loyalty);
    await drain();
    // 删除清空了同步范围；插回去，确认跳过它靠的是删除标记
    await getDb().insert(sourceTables).values(scope);

    const later = new Date(Date.now() + 3 * 24 * 3_600_000);
    expect(await enqueueDueSyncs(later)).toEqual([ids.crm, ids.tracking].sort());
    await drain();
    expect(await enqueueDueVerifies(new Date(Date.now() + 30 * 24 * 3_600_000))).toEqual([ids.crm, ids.tracking].sort());

    expect(await hasRaw('会员')).toBe(false);
    expect((await runQuery(analyst, 'SHOW TABLES')).rows.some(r => r.includes('会员'))).toBe(false);
    expect((await listMappings(author)).mappings.some(m => m.sourceId === ids.loyalty)).toBe(false);

    const crmOrders = orderMappings!.crm;
    await expect(saveDraft(author, crmOrders, CRM_ORDERS.replace('  customer_id: string(customer)\n', '  customer_id: { expr: string(customer), customer_source: 会员 }\n')))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ message: expect.stringContaining('没有数据源 会员') })] });
    await expect(restoreMapping(author, customerMappings.loyalty)).rejects.toMatchObject({ status: 400, message: '数据源已删除' });
  });
});

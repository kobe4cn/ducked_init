// 结果快照登记的流水线接缝：打通后的消费者与订单 → runTask('gold.rfm') → 调度器在任务成功后登记快照 →
// listSnapshots / getSnapshot 读出的平台元数据，readRfmSnapshot 只读挂载数据湖读出的人群汇总与消费者明细；
// 登记时模板读到的实体有映射最近一次合并失败则在快照上记下「数据不完整」（incomplete）；
// 源端删掉映射引用的列 → 同步（没有行变化也合并）→ 只有引用它的映射合并失败，旧快照仍可读、新快照标「数据不完整」，能改映射的成员收到邮件；
// 源端改名 → 重新采集后平台起草修复草稿并发带链接的邮件，成员空跑、发布后合并恢复；
// 到期后 enqueueDueExpiries → 调度器派发 gold.expire → 湖里的表与文件、平台元数据里的 expiredAt
import { existsSync } from 'node:fs';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, mappingVersions, tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { setMailer, type Mail } from '../../app/.server/mailer';
import { dryRunMapping, publishMapping } from '../../app/.server/mappings';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import type { MergeRecord } from '../../app/.server/pipeline/merge-engine';
import { enqueueDueExpiries, getSnapshot, listSnapshots, readRfmSnapshot } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { resetDb } from '../http/harness';
import { memberOf, mergeUnchecked, newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const DAY = 24 * 60 * 60 * 1000;

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 在本租户数据湖里执行 SQL（查看表与文件） */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

describe('结果快照登记', () => {
  it('gold.rfm 成功后登记快照：模板、完整参数、表名、行数、创建后 90 天过期；只在本租户可见', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');

    // 映射合并后平台自动启用的模板快照来源是 publish，不算在内
    const list = (await listSnapshots(acme)).filter(s => s.trigger !== 'publish');
    expect(list).toHaveLength(1);
    const [snapshot] = list;
    expect(snapshot).toMatchObject({
      template: 'rfm', taskId: task!.id, table: `gold.rfm__${task!.id}`, rowCount: 5, definitionVersion: null, expiredAt: null,
      params: { asOf: '2024-07-01', lookbackDays: 365 },
    });
    expect(snapshot.expiresAt.getTime() - snapshot.createdAt.getTime()).toBe(90 * DAY);
    expect(await getSnapshot(acme, snapshot.id)).toMatchObject({ id: snapshot.id });

    const other = await newTenant('globex');
    expect(await listSnapshots(other)).toEqual([]);
    expect(await getSnapshot(other, snapshot.id)).toBeNull();
    expect(await getSnapshot(acme, 'not-a-uuid')).toBeNull();
  });

  it('失败的 gold.rfm 不登记快照', async () => {
    const acme = await newTenant('acme');
    expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'failed' });
    expect(await listSnapshots(acme)).toEqual([]);
  });

  it('读出 RFM 结果：按定义顺序的人群人数与金额，分页的消费者明细只带 consumer_id 与分值', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    const [snapshot] = await listSnapshots(acme);

    const first = await readRfmSnapshot(snapshot, { page: 1, pageSize: 2 });
    // 见 rfm.test.ts 的手算：重要价值 550；一般价值 500；一般挽留 300 + 80 + 1000
    expect(first.segments.filter(s => s.consumers > 0)).toEqual([
      { name: '重要价值', consumers: 1, monetary: '550.00' },
      { name: '一般价值', consumers: 1, monetary: '500.00' },
      { name: '一般挽留', consumers: 3, monetary: '1380.00' },
    ]);
    expect(first.segments.map(s => s.name)).toEqual((snapshot.params.segments as { name: string }[]).map(s => s.name));
    expect(first.consumers).toHaveLength(2);
    expect(Object.keys(first.consumers[0]).sort()).toEqual(['consumer_id', 'f', 'frequency', 'm', 'monetary', 'r', 'recency_days', 'segment']);

    const last = await readRfmSnapshot(snapshot, { page: 3, pageSize: 2 });
    expect(last.consumers).toHaveLength(1);
    const ids = [...first.consumers, ...(await readRfmSnapshot(snapshot, { page: 2, pageSize: 2 })).consumers, ...last.consumers].map(c => c.consumer_id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(5);
  });
});

/** 本租户某个实体的映射 ID：数据源 ID → 映射 ID */
async function mappingsOf(tenantId: string, entity: string) {
  const rows = await getDb().select({ id: mappings.id, sourceId: mappings.sourceId }).from(mappings)
    .where(and(eq(mappings.tenantId, tenantId), eq(mappings.entity, entity)));
  return Object.fromEntries(rows.map(r => [r.sourceId, r.id]));
}

/** 带这个映射的最近一次合并任务 */
async function lastMergeOf(tenantId: string, mappingId: string) {
  const [merge] = await getDb().select().from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'), sql`${tasks.result}->'mappings' @> ${JSON.stringify([{ mapping: mappingId }])}::jsonb`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return merge;
}

/** 把带这个映射的最近一次合并里它的记录改成失败（error）或跳过（skipped），返回那次合并任务 */
async function overrideMerge(tenantId: string, mappingId: string, outcome: { error: string } | { skipped: string }) {
  const merge = await lastMergeOf(tenantId, mappingId);
  const result = merge.result as { mappings: Record<string, unknown>[] };
  const records = result.mappings.map(r => {
    const { mapping, entity, table, version, startedAt, durationMs } = r;
    return mapping === mappingId ? { mapping, entity, table, version, startedAt, durationMs, ...outcome } : r;
  });
  await getDb().update(tasks).set({ result: { ...result, mappings: records } }).where(eq(tasks.id, merge.id));
  return merge;
}

const rfmSnapshotOf = async (tenantId: string) => {
  const task = await runTask(tenantId, 'gold.rfm', { asOf: '2024-07-01' });
  expect(task?.status).toBe('succeeded');
  return (await listSnapshots(tenantId)).find(s => s.taskId === task!.id)!;
};

describe('数据不完整', () => {
  it('order 与 customer 的映射最近一次合并失败：照常登记快照，记下失败的映射、源表、原因摘要（不带源端取值）与最近一次成功合并的时间', async () => {
    const { acme, sources, mappings: customers } = await publishedIdentitySources({ orders: true });
    const orders = await mappingsOf(acme, 'order');
    const [crmOrders, loyaltyOrders] = [orders[sources.crm], orders[sources.loyalty]];
    const succeeded = await lastMergeOf(acme, crmOrders);
    // CRM 订单再合并一次后失败：最近一次成功是更早的那次；会员订单唯一的一次合并就失败
    await mergeUnchecked(acme, [crmOrders]);
    await overrideMerge(acme, crmOrders, { error: "字段 status 有值字典里没有的取值：'13800138000'（1 行），请在值字典里补上，或用 otherwise 写兜底值，再重新发布" });
    await overrideMerge(acme, loyaltyOrders, { error: '主键 order_id 跨映射重复：A1001, 13800138000（映射 x、y），请在映射里用字段表达式对齐（如加前缀）或去掉一边的映射' });
    await overrideMerge(acme, customers.crm, { error: '源表读取失败' });

    const snapshot = await rfmSnapshotOf(acme);
    expect(snapshot.rowCount).toBe(5);
    const byMapping = (a: { mapping: string }, b: { mapping: string }) => a.mapping.localeCompare(b.mapping);
    expect([...snapshot.incomplete!].sort(byMapping)).toEqual([
      { mapping: crmOrders, entity: 'order', table: 'orders', error: '字段 status 有值字典里没有的取值', lastSuccessAt: succeeded.finishedAt!.toISOString() },
      { mapping: loyaltyOrders, entity: 'order', table: 'orders', error: '主键 order_id 跨映射重复', lastSuccessAt: null },
      { mapping: customers.crm, entity: 'customer', table: 'customers', error: '源表读取失败', lastSuccessAt: null },
    ].sort(byMapping));
    expect(JSON.stringify(snapshot.incomplete)).not.toMatch(/13800138000|A1001/);
    expect(await getSnapshot(acme, snapshot.id)).toMatchObject({ incomplete: snapshot.incomplete });
  });

  it('只看模板读到的实体与任务开始前结束的合并：event 映射失败、计算开始后才结束的失败都不标记；完整时 incomplete 为 null', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    expect((await rfmSnapshotOf(acme)).incomplete).toBeNull();

    const [event] = Object.values(await mappingsOf(acme, 'event'));
    await overrideMerge(acme, event, { error: '源表读取失败' });
    expect((await rfmSnapshotOf(acme)).incomplete).toBeNull();

    const orders = (await mappingsOf(acme, 'order'))[sources.crm];
    const merge = await overrideMerge(acme, orders, { error: '源表读取失败' });
    await getDb().update(tasks).set({ finishedAt: new Date(Date.now() + DAY) }).where(eq(tasks.id, merge.id));
    expect((await rfmSnapshotOf(acme)).incomplete).toBeNull();
  });

  it('跳过的合并不算失败也不盖掉之前的失败；失败的映射之后合并成功，再算的快照不再带标记', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    const orders = (await mappingsOf(acme, 'order'))[sources.crm];
    await overrideMerge(acme, orders, { error: '源表读取失败' });
    await mergeUnchecked(acme, [orders]);
    await overrideMerge(acme, orders, { skipped: '源表 orders 还没有同步进原始层，首次同步后再合并' });
    expect((await rfmSnapshotOf(acme)).incomplete).toMatchObject([{ mapping: orders, error: '源表读取失败', lastSuccessAt: null }]);

    expect(await mergeUnchecked(acme, [orders])).toMatchObject({ status: 'succeeded' });
    expect((await rfmSnapshotOf(acme)).incomplete).toBeNull();
  });
});

describe('源端结构变化', () => {
  const outbox: Mail[] = [];
  beforeEach(() => { outbox.length = 0; setMailer({ async send(m) { outbox.push(m); } }); });
  afterEach(() => { setMailer(undefined); });

  it('源端删掉订单表引用的列（没有行变化）：同步后只有这个映射合并失败，客户照常合并；旧快照仍可读，新快照标数据不完整；能改映射的成员收到邮件并记审计', async () => {
    const { acme, author, sources, mappings: customers, orderMappings } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const snapshot = await rfmSnapshotOf(acme);
    await grantOnSource(`ALTER TABLE crm.orders DROP COLUMN paid_at; UPDATE crm.customers SET name = '张三丰', updated_at = '2024-07-01' WHERE id = 1;`);
    await syncSource(author, sources.crm);
    await drain();

    const records = ((await lastMergeOf(acme, orderMappings!.crm)).result as { mappings: MergeRecord[] }).mappings;
    expect(records.find(r => r.mapping === orderMappings!.crm)).toMatchObject({ error: expect.stringMatching(/^映射引用的源列 paid_at 已被删除：/) });
    expect(records.find(r => r.mapping === customers.crm)).not.toHaveProperty('error');
    expect((await readRfmSnapshot(snapshot, { page: 1 })).consumers).toHaveLength(5);
    expect((await rfmSnapshotOf(acme)).incomplete).toMatchObject([{ mapping: orderMappings!.crm, error: '映射引用的源列 paid_at 已被删除' }]);

    const alerts = outbox.filter(m => m.subject.includes('源表结构变化影响映射'));
    expect(alerts.map(m => m.to).sort()).toEqual(['admin@acme.com', 'de2@acme.com', 'de@acme.com']);
    expect(alerts[0].text).toContain(`orders → 订单（映射 ${orderMappings!.crm}）：paid_at 已删除`);
    // 删掉的列没有改名的候选：平台不起草，另一封邮件说明
    expect(outbox.filter(m => m.subject.includes('映射修复草稿')).map(m => m.text))
      .toEqual(Array(3).fill(expect.stringContaining(`orders → 订单（映射 ${orderMappings!.crm}）：新增的列里没有类型相同、统计相近的候选，平台没有起草`)));
    const audits = (await listAuditLogs(acme)).filter(a => a.action === '源表结构变化影响映射');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: '平台', summary: expect.stringContaining('orders → 订单：paid_at 已删除') });

    // 结构没再变的同步不再通知；合并仍然失败，直到映射改版或源端恢复
    outbox.length = 0;
    await grantOnSource(`UPDATE crm.orders SET status = 'refunded', updated_at = '2024-07-01' WHERE order_no = 'A1';`);
    await syncSource(author, sources.crm);
    await drain();
    expect(outbox).toEqual([]);
    expect((await listAuditLogs(acme)).filter(a => a.action === '源表结构变化影响映射')).toHaveLength(1);
    expect(((await lastMergeOf(acme, orderMappings!.crm)).result as { mappings: MergeRecord[] }).mappings)
      .toContainEqual(expect.objectContaining({ mapping: orderMappings!.crm, error: expect.stringContaining('paid_at 已被删除') }));
  });

  it('源端把订单表引用的列改名：重新采集后平台起草修复草稿（换成新列名并注释依据）、发带链接的邮件；草稿不自动发布，合并照旧失败，另一位成员空跑并发布后合并恢复', async () => {
    const { acme, author, reviewer, sources, orderMappings } = await publishedIdentitySources({ orders: true });
    const mappingId = orderMappings!.crm;
    await grantOnSource(`ALTER TABLE crm.orders RENAME paid_at TO paid_time;`);
    await syncSource(author, sources.crm);
    await drain();

    const [draft] = await getDb().select().from(mappingVersions).where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.version, 2)));
    expect(draft).toMatchObject({ status: 'draft', lastEditor: 'platform', authors: [] });
    expect(draft.yaml).toContain(`paid_at: from_timezone(paid_time, 'UTC') # 平台猜测 paid_at 改名为 paid_time：类型相同（TIMESTAMP）、取值范围相同`);
    expect(((await lastMergeOf(acme, mappingId)).result as { mappings: MergeRecord[] }).mappings)
      .toContainEqual(expect.objectContaining({ mapping: mappingId, error: expect.stringContaining('paid_at 已被删除') }));

    const alerts = outbox.filter(m => m.subject.includes('源表结构变化影响映射'));
    expect(alerts[0].text).toContain('平台会按规则尝试起草修复草稿');
    const repairs = outbox.filter(m => m.subject.includes('映射修复草稿'));
    expect(repairs.map(m => m.to).sort()).toEqual(['admin@acme.com', 'de2@acme.com', 'de@acme.com']);
    expect(repairs[0].text).toContain(`/mappings/${mappingId}?version=2`);
    expect(repairs[0].text).toContain('paid_at → paid_time（类型相同（TIMESTAMP）、取值范围相同');
    expect((await listAuditLogs(acme)).filter(a => a.action === '平台起草修复草稿'))
      .toEqual([expect.objectContaining({ actor: '平台', summary: expect.stringContaining('第 2 版草稿：paid_at 改为 paid_time') })]);

    expect((await dryRunMapping(author, mappingId, 2)).rows).toHaveLength(6);
    await publishMapping(reviewer, mappingId, 2);
    await drain();
    expect(((await lastMergeOf(acme, mappingId)).result as { mappings: MergeRecord[] }).mappings.find(r => r.mapping === mappingId)).not.toHaveProperty('error');
  });
});

describe('快照过期', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('到期的快照删表、清掉湖里的数据（parquet 文件与内联在 catalog 的行）并标记 expiredAt；未到期的不受影响，重复执行不报错', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { acme } = await publishedIdentitySources({ orders: true });
    const m = `__ducklake_metadata_lake."${(await lakeRow(acme))!.catalogSchema}"`;
    const nameOf = (s: { table: string }) => s.table.slice('gold.'.length);
    // 第一张关掉内联、写成 parquet 文件；第二张只有 5 行，按默认内联在 catalog 里
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 0)`);
    const filedTask = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 10)`);
    await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    const [filed, inlined] = (await listSnapshots(acme)).sort((a, b) => Number(b.taskId === filedTask!.id) - Number(a.taskId === filedTask!.id));
    const files = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', '${nameOf(filed)}', schema => 'gold')`);
    expect(files.length).toBeGreaterThan(0);
    const inlinedData = () => onLake(acme, `
      SELECT i.table_name FROM ${m}.ducklake_inlined_data_tables i JOIN ${m}.ducklake_table t USING (table_id) WHERE t.table_name = '${nameOf(inlined)}'`);
    expect(await inlinedData()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 30 * DAY);
    await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    const [fresh] = await listSnapshots(acme);

    vi.setSystemTime(filed.expiresAt.getTime() + 60_000);
    expect(await enqueueDueExpiries()).toEqual([acme]);
    expect(await enqueueDueExpiries()).toEqual([]); // 已有过期任务在排队，不重复入队
    await drain();

    for (const s of [filed, inlined]) expect(await getSnapshot(acme, s.id)).toMatchObject({ expiredAt: expect.any(Date) });
    expect(await getSnapshot(acme, fresh.id)).toMatchObject({ expiredAt: null });
    const tables = await onLake<{ name: string }>(acme, `
      SELECT table_name AS name FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = 'gold'`);
    expect(tables.map(t => t.name)).toEqual([nameOf(fresh)]);
    expect(files.filter(f => existsSync(f.path))).toEqual([]);
    expect(await inlinedData()).toEqual([]);
    expect((await readRfmSnapshot(fresh, { page: 1 })).consumers).toHaveLength(5);
    await expect(readRfmSnapshot((await getSnapshot(acme, filed.id))!, { page: 1 })).rejects.toThrow('快照已过期');

    expect(await enqueueDueExpiries()).toEqual([]);
    expect(await runTask(acme, 'gold.expire', { tables: [filed.table] })).toMatchObject({ status: 'succeeded' });
  });
});

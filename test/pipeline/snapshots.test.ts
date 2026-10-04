// 结果快照登记的流水线接缝：打通后的消费者与订单 → runTask('gold.rfm') → 调度器在任务成功后登记快照 →
// listSnapshots / getSnapshot 读出的平台元数据，readRfmSnapshot 只读挂载数据湖读出的人群汇总与消费者明细；
// 到期后 enqueueDueExpiries → 调度器派发 gold.expire → 湖里的表与文件、平台元数据里的 expiredAt
import { existsSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { enqueueDueExpiries, getSnapshot, listSnapshots, readRfmSnapshot } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

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

    const list = await listSnapshots(acme);
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

// 结果快照登记的流水线接缝：打通后的消费者与订单 → runTask('gold.rfm') → 调度器在任务成功后登记快照 →
// listSnapshots / getSnapshot 读出的平台元数据，readRfmSnapshot 只读挂载数据湖读出的人群汇总与消费者明细
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { getSnapshot, listSnapshots, readRfmSnapshot } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const DAY = 24 * 60 * 60 * 1000;

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

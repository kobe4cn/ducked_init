// test/pipeline/inspect.test.ts —— 漂移检查的流水线接缝：已发布映射算出应有结构 → 入队 lake.inspect → 调度器派发、只读挂载数据湖 →
// 任务结果里的缺列、多列、类型不一致与孤表；同一租户同时只有一次检查在排队或运行
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { expectedTables, getInspectStatus, inspectLakeNow } from '../../app/.server/lake-inspect';
import type { InspectParams } from '../../app/.server/pipeline/inspect-engine';
import { publishedPlans } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { resetDb } from '../http/harness';
import { runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

async function inspect(tenantId: string, expected?: InspectParams['expected']) {
  const task = await runTask(tenantId, 'lake.inspect', { expected: expected ?? expectedTables(await publishedPlans(getDb(), tenantId)) });
  expect(task.error).toBeNull();
  expect(task.status).toBe('succeeded');
  return task.result!.drifts;
}

async function onLake(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    await session.con.run(sql);
  } finally {
    session.close();
  }
}

describe('漂移检查', () => {
  it('干净的种子数据没有漂移（含金额与时间列）；应有的表湖里还没有时不报', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    expect(await inspect(acme)).toEqual([]);
    const expected = expectedTables(await publishedPlans(getDb(), acme));
    expect(await inspect(acme, { ...expected, coupon: { coupon_id: 'VARCHAR' } })).toEqual([]);
  });

  it('报告缺列、多列、类型不一致（规范化后比较）与孤表；_ 开头的内部表不算', async () => {
    const { acme } = await publishedIdentitySources();
    await onLake(acme, `
      ALTER TABLE silver.customer ADD COLUMN x INTEGER;
      ALTER TABLE silver.customer DROP COLUMN city;
      ALTER TABLE silver.customer DROP COLUMN birthday;
      ALTER TABLE silver.customer ADD COLUMN birthday VARCHAR;
      CREATE TABLE silver.stray (id INTEGER);
      CREATE TABLE silver._scratch (id INTEGER);`);
    expect(await inspect(acme)).toEqual([
      { table: 'customer', kind: 'missing', column: 'city', expected: 'VARCHAR' },
      { table: 'customer', kind: 'extra', column: 'x', actual: 'INTEGER' },
      { table: 'customer', kind: 'type', column: 'birthday', expected: 'DATE', actual: 'VARCHAR' },
      { table: 'stray', kind: 'orphan' },
    ]);
  });

  it('成员触发后入队，已有一次在排队时不重复入队；最近一次结果给出检查时间与差异', async () => {
    const { acme, author } = await publishedIdentitySources();
    expect(await getInspectStatus(author)).toMatchObject({ status: 'none', inspectedAt: null, drifts: [] });

    await inspectLakeNow(author);
    await expect(inspectLakeNow(author)).rejects.toThrow('已有一次漂移检查在排队或运行中');
    expect(await getInspectStatus(author)).toMatchObject({ status: 'queued', inspectedAt: null });

    await onLake(acme, 'CREATE TABLE silver.stray (id INTEGER)');
    await drain();
    const status = await getInspectStatus(author);
    expect(status).toMatchObject({ status: 'succeeded', drifts: [{ table: 'stray', kind: 'orphan' }] });
    expect(status.inspectedAt).toBeInstanceOf(Date);
  });
});

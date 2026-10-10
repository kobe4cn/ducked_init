// test/pipeline/dsl-recompute.test.ts —— 指标与标签发布后的下游重算与手动回刷（ADR-0025）的流水线接缝：
// 发布指标新版本（publishDefinition）在同一事务里入队它自己与引用它的已发布标签（标签 SQL 内联新版本指标），发布标签只入队它自己；
// 回刷（backfillDefinition）按旧快照各自的 asOf 以生效版本入队，调度器跑完后出现新快照，旧快照不变，tag_key 不变
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks } from '../../app/.server/db/schema';
import { backfillDefinition, createDefinition, DslError, getDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listSnapshots } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 在本租户数据湖里执行 SQL（查看快照） */
async function onLake<T = Record<string, unknown>>(tenantId: string, query: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(query)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

const ALL_REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';
/** 第 2 版指标：过滤掉所有订单，按它算的标签没有消费者 */
const NO_REVENUE = `${ALL_REVENUE}filter:\n  - { field: amount, op: gt, value: 1000000000 }\n`;
const TIERS = (high = 'high') => `metric: revenue\nrules:\n  - { value: ${high}, when: { gte: 100 } }\ndefault: low\n`;
const EARLIER = '2024-07-15';
const today = () => new Date().toISOString().slice(0, 10);

/** 把这个定义已有的快照改成按更早的统计日算的（模拟以前算过的快照） */
const backdate = (tenantId: string, template: string) => getDb().update(snapshots)
  .set({ params: sql`jsonb_set(${snapshots.params}, '{asOf}', ${JSON.stringify(EARLIER)}::jsonb)` })
  .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.template, template)));

/**
 * 发布 revenue 第 1 版与引用它的标签 value_tier 第 1 版并跑完，两张快照的统计日改成 EARLIER；返回租户、两位成员与两张旧快照
 */
async function publishedMetricAndTag() {
  const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
  await createDefinition(author, 'metric', 'revenue', ALL_REVENUE);
  await publishDefinition(reviewer, 'metric', 'revenue', 1);
  await drain();
  await createDefinition(author, 'tag', 'value_tier', TIERS());
  await publishDefinition(reviewer, 'tag', 'value_tier', 1);
  await drain();
  await backdate(acme, 'metric:revenue');
  await backdate(acme, 'tag:value_tier');
  const old = await listSnapshots(acme);
  expect(old).toHaveLength(2);
  return { acme, author, reviewer, old };
}

const queuedDsl = (tenantId: string) => getDb().select().from(tasks)
  .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'gold.dsl'), inArray(tasks.status, ['queued', 'running'])));

describe('发布指标新版本后下游重算', () => {
  it('同一事务里入队指标与引用它的标签（标签内联第 2 版指标），跑完后下游标签有按第 2 版算的新快照，旧快照不变，tag_key 不变；回刷后旧统计日也有第 2 版快照', async () => {
    const { acme, author, reviewer, old } = await publishedMetricAndTag();
    expect(await getDefinition(author, 'metric', 'revenue')).toMatchObject({ backfill: { snapshots: 0, days: [] } });

    await saveDslDraft(author, 'metric', 'revenue', NO_REVENUE);
    const metricTask = await publishDefinition(reviewer, 'metric', 'revenue', 2);
    const queued = await queuedDsl(acme);
    expect(queued.map(t => [t.params.kind, t.params.key, t.params.definitionVersion, t.params.asOf]).sort()).toEqual([
      ['metric', 'revenue', 2, today()],
      ['tag', 'value_tier', 1, today()],
    ]);
    const tagTask = queued.find(t => t.params.kind === 'tag')!;
    expect(tagTask.params.sql).toContain('1000000000');
    expect(metricTask.params.sql).toContain('1000000000');

    await drain();
    const after = await listSnapshots(acme);
    expect(after).toHaveLength(4);
    for (const s of old) expect(after.find(a => a.id === s.id)).toEqual(s);
    expect(after.find(s => s.taskId === tagTask.id)).toMatchObject({ template: 'tag:value_tier', definitionVersion: 1, rowCount: 0, params: { asOf: today() } });
    const oldTag = old.find(s => s.template === 'tag:value_tier')!;
    expect(await onLake(acme, `SELECT DISTINCT tag_key FROM gold."tag__${oldTag.taskId}"`)).toEqual([{ tag_key: 'value_tier' }]);

    // 回刷：旧统计日的第 1 版指标快照可回刷；今天已有第 2 版的不算
    expect(await getDefinition(author, 'metric', 'revenue')).toMatchObject({ backfill: { snapshots: 1, days: [EARLIER] } });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await expect(backfillDefinition(analyst, 'metric', 'revenue')).rejects.toMatchObject({ init: { status: 403 } });
    // 下游标签已有任务在排队：同样拒绝
    const [blocking] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.dsl', params: { ...tagTask.params, asOf: today() } }).returning();
    await expect(backfillDefinition(reviewer, 'metric', 'revenue')).rejects.toThrow(/引用它的标签 value_tier已有计算在排队或运行中/);
    await getDb().delete(tasks).where(eq(tasks.id, blocking!.id));
    const result = await backfillDefinition(reviewer, 'metric', 'revenue');
    expect(result).toMatchObject({ version: 2, days: [EARLIER] });
    expect(result.tasks.map(t => [t.params.kind, t.params.key, t.params.definitionVersion, t.params.asOf]).sort()).toEqual([
      ['metric', 'revenue', 2, EARLIER],
      ['tag', 'value_tier', 1, EARLIER],
    ]);
    expect(result.tasks.find(t => t.params.kind === 'tag')!.params.sql).toContain('1000000000');
    // 本定义已有任务在排队：拒绝
    await expect(backfillDefinition(reviewer, 'metric', 'revenue')).rejects.toThrow(/排队或运行中/);

    await drain();
    const backfilled = await listSnapshots(acme);
    expect(backfilled).toHaveLength(6);
    for (const s of old) expect(backfilled.find(a => a.id === s.id)).toEqual(s);
    expect(backfilled.filter(s => s.params.asOf === EARLIER).map(s => [s.template, s.definitionVersion]).sort()).toEqual([
      ['metric:revenue', 1], ['metric:revenue', 2], ['tag:value_tier', 1], ['tag:value_tier', 1],
    ]);
    const newTag = backfilled.find(s => s.template === 'tag:value_tier' && s.params.asOf === EARLIER && s.id !== oldTag.id)!;
    expect(newTag.rowCount).toBe(0);
    expect(oldTag.rowCount).toBeGreaterThan(0);
    expect((await getDefinition(author, 'metric', 'revenue')).backfill).toEqual({ snapshots: 0, days: [] });
    await expect(backfillDefinition(reviewer, 'metric', 'revenue')).rejects.toThrow(/没有需要回刷的快照/);

    expect((await listAuditLogs(acme)).filter(l => l.action === '回刷指标或标签').map(l => [l.actor, l.summary]))
      .toEqual([[reviewer.email, `指标 revenue，按第 2 版回刷 ${EARLIER}，连同标签 value_tier`]]);
  });
});

describe('发布与回刷标签', () => {
  it('发布标签只入队它自己；回刷只回刷标签，已过期的快照不回刷', async () => {
    const { acme, author, reviewer } = await publishedMetricAndTag();
    await saveDslDraft(author, 'tag', 'value_tier', TIERS('vip'));
    await publishDefinition(reviewer, 'tag', 'value_tier', 2);
    expect((await queuedDsl(acme)).map(t => [t.params.kind, t.params.definitionVersion])).toEqual([['tag', 2]]);
    await drain();
    expect((await getDefinition(author, 'tag', 'value_tier')).backfill).toEqual({ snapshots: 1, days: [EARLIER] });
    expect((await getDefinition(author, 'metric', 'revenue')).backfill).toEqual({ snapshots: 0, days: [] });

    // 已过期的旧快照不回刷
    await getDb().update(snapshots).set({ expiredAt: new Date() })
      .where(and(eq(snapshots.tenantId, acme), like(snapshots.template, 'tag:%'), eq(snapshots.definitionVersion, 1)));
    expect((await getDefinition(author, 'tag', 'value_tier')).backfill).toEqual({ snapshots: 0, days: [] });
    const error = await backfillDefinition(reviewer, 'tag', 'value_tier').catch(e => e);
    expect(error).toBeInstanceOf(DslError);
    expect(error.message).toMatch(/没有需要回刷的快照/);

    await getDb().update(snapshots).set({ expiredAt: null }).where(eq(snapshots.tenantId, acme));
    const { tasks: enqueued } = await backfillDefinition(reviewer, 'tag', 'value_tier');
    expect(enqueued.map(t => [t.params.kind, t.params.definitionVersion, t.params.asOf])).toEqual([['tag', 2, EARLIER]]);
    await drain();
    const tag = (await listSnapshots(acme)).find(s => s.taskId === enqueued[0]!.id)!;
    expect(tag).toMatchObject({ template: 'tag:value_tier', definitionVersion: 2, params: { asOf: EARLIER } });
    expect(await onLake(acme, `SELECT DISTINCT tag_key FROM gold."tag__${tag.taskId}"`)).toEqual([{ tag_key: 'value_tier' }]);
  });
});

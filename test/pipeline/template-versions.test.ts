// test/pipeline/template-versions.test.ts —— 模板升级的流水线接缝：打开测试开关 TEMPLATE_TEST_VERSIONS=1 后 RFM 有了第 2 版（templates/test-versions.ts，分群带 v2: 前缀）→
// 锁定第 1 版的定义再起草发布、重新计算、定时刷新（saveDraft / publishTemplate / recomputeTemplate / enqueueDueRefreshes）→ 调度器派发 →
// 在版本行的 template_version、任务参数的 templateVersion 与数据湖快照表的 segment 上看结果；开关打开后才首次自动启用的租户锁定第 2 版（ADR-0021）
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, templateDefinitions, templateVersions } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { latestTemplate, templateAt } from '../../app/.server/pipeline/templates';
import { enqueueDueRefreshes } from '../../app/.server/refresh';
import { listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { publishTemplate, recomputeTemplate, saveDraft } from '../../app/.server/templates';
import { resetDb } from '../http/harness';
import { onLake } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.unstubAllEnvs(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

// 回看窗口放到最长，覆盖夹具里 2024 年的订单（发布时 asOf 取当天）
const PARAMS = {
  lookbackDays: 3650,
  statuses: ['completed', 'paid', 'shipped'],
  binning: { method: 'thresholds', recency: [30, 90, 180, 365], frequency: [2, 3, 5, 8], monetary: [100, 500, 1000, 5000] },
  segments: [{ name: '高价值', m: { min: 3 } }, { name: '其他' }],
};

const lockedVersions = async (tenantId: string) => (await getDb().select({ version: templateVersions.version, templateVersion: templateVersions.templateVersion })
  .from(templateVersions).innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
  .where(and(eq(templateDefinitions.tenantId, tenantId), eq(templateDefinitions.template, 'rfm')))
  .orderBy(templateVersions.version));

/** 本租户每张 RFM 快照里出现过的分群，按快照的任务 ID 索引 */
const segmentsByTask = async (tenantId: string) => {
  const rfm = (await listSnapshots(tenantId)).filter(s => s.template === 'rfm');
  return Object.fromEntries(await Promise.all(rfm.map(async s =>
    [s.taskId, (await onLake<{ segment: string }>(tenantId, `SELECT DISTINCT segment FROM gold."rfm__${s.taskId}" ORDER BY segment`)).map(r => r.segment)] as const)));
};

describe('模板升级', () => {
  it('不设开关时 RFM 的当前版本是第 1 版；打开开关后当前版本是测试用的第 2 版，第 1 版仍可按版本号取得', () => {
    expect(latestTemplate('rfm').version).toBe(1);
    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    expect(latestTemplate('rfm').version).toBe(2);
    const params = templateAt('rfm', 1).parse({ ...PARAMS, asOf: '2024-12-31' });
    expect(templateAt('rfm', 1).compile(params, () => true)).not.toContain('v2:');
    expect(templateAt('rfm', 2).compile(params, () => true)).toContain(`SELECT * REPLACE ('v2:' || segment AS segment) FROM (${templateAt('rfm', 1).compile(params, () => true)})`);
    expect(latestTemplate('user360').version).toBe(1);
  });

  it('模板新版本发布后，锁定第 1 版的定义起草发布、重新计算、定时刷新的结果都不变；开关打开后才自动启用 RFM 的租户锁定第 2 版，分群带 v2:', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    await drain();
    // 开关关闭时平台已自动启用 RFM，锁定第 1 版；之后模板升到第 2 版
    expect(await lockedVersions(acme)).toEqual([{ version: 1, templateVersion: 1 }]);
    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');

    await saveDraft(author, 'rfm', PARAMS);
    const published = await publishTemplate(reviewer, 'rfm', 2);
    expect(published.params).toMatchObject({ definitionVersion: 2, templateVersion: 1 });
    await drain();
    const { task: recomputed } = await recomputeTemplate(reviewer, 'rfm', '2024-12-31');
    expect(recomputed.params).toMatchObject({ templateVersion: 1 });
    await drain();

    // 定时刷新：新订单合并后、把已有快照改成更早的统计日，入队当天的 gold.rfm
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', 50, '2024-07-01 10:00', '2024-07-01 10:00', '2024-07-01 07:00')`);
    await syncSource(author, sources.crm);
    await drain();
    await getDb().update(snapshots).set({ params: sql`jsonb_set(${snapshots.params}, '{asOf}', '"2024-07-15"'::jsonb)` }).where(eq(snapshots.tenantId, acme));
    const scheduled = (await enqueueDueRefreshes()).filter(t => t.kind === 'gold.rfm');
    expect(scheduled.map(t => [t.params.trigger, t.params.templateVersion])).toEqual([['scheduled', 1]]);
    await drain();

    expect(await lockedVersions(acme)).toEqual([{ version: 1, templateVersion: 1 }, { version: 2, templateVersion: 1 }]);
    const acmeSegments = await segmentsByTask(acme);
    for (const id of [published.id, recomputed.id, scheduled[0]!.id]) expect(acmeSegments[id]).toEqual(['其他', '高价值']);
    expect(Object.values(acmeSegments).flat().filter(s => s.startsWith('v2:'))).toEqual([]);

    // 开关打开后才发布映射的租户：自动启用的 RFM 锁定第 2 版，分群带 v2:
    const { acme: globex, reviewer: globexReviewer } = await publishedIdentitySources({ orders: true, slug: 'globex' });
    await drain();
    expect(await lockedVersions(globex)).toEqual([{ version: 1, templateVersion: 2 }]);
    // 默认回看 365 天，参考日期放到 2024 年底才算得到夹具里的订单
    const { task: globexTask } = await recomputeTemplate(globexReviewer, 'rfm', '2024-12-31');
    expect(globexTask.params).toMatchObject({ templateVersion: 2 });
    await drain();
    const globexSegments = await segmentsByTask(globex);
    expect(globexSegments[globexTask.id]!.length).toBeGreaterThan(0);
    expect(Object.values(globexSegments).flat().every(s => s.startsWith('v2:'))).toBe(true);
    // 第一个租户的结果仍是第 1 版的
    expect(Object.values(await segmentsByTask(acme)).flat().filter(s => s.startsWith('v2:'))).toEqual([]);
  });
});

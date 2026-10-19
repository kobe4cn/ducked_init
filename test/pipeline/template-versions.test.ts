// test/pipeline/template-versions.test.ts —— 模板升级的流水线接缝：打开测试开关 TEMPLATE_TEST_VERSIONS=1 后 RFM 有了第 2 版（templates/test-versions.ts，分群带 v2: 前缀）→
// 锁定第 1 版的定义再起草发布、重新计算、定时刷新（saveDraft / publishTemplate / recomputeTemplate / enqueueDueRefreshes）→ 调度器派发 →
// 在版本行的 template_version、任务参数的 templateVersion 与数据湖快照表的 segment 上看结果；开关打开后才首次自动启用的租户锁定第 2 版（ADR-0021）。
// 升级预览与确认：previewTemplateUpgrade 在只读挂载的湖上只出分群迁移计数，upgradeTemplateDraft 起草锁定新版本的草稿，双人发布后才按新版本计算
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, snapshots, tasks, templateDefinitions, templateVersions } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { latestTemplate, templateAt } from '../../app/.server/pipeline/templates';
import { enqueueDueRefreshes } from '../../app/.server/refresh';
import { listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { discardDraft, getTemplate, previewTemplateUpgrade, publishTemplate, recomputeTemplate, saveDraft, upgradeTemplateDraft } from '../../app/.server/templates';
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

const LAKE_SNAPSHOT = `SELECT max(snapshot_id)::VARCHAR AS n FROM ducklake_snapshots('lake')`;

describe('升级预览与确认', () => {
  it('预览只出分群迁移人数、湖与任务不变；确认后起草锁定第 2 版的草稿，发布前仍按第 1 版计算，另一位成员发布后按第 2 版；丢弃草稿回到第 1 版', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await drain();
    await saveDraft(author, 'rfm', PARAMS);
    await publishTemplate(reviewer, 'rfm', 2);
    await drain();

    // 开关关闭：没有新版本
    expect(await getTemplate(author, 'rfm')).toMatchObject({ latestTemplateVersion: 1, upgradeAvailable: false });
    await expect(previewTemplateUpgrade(author, 'rfm')).rejects.toThrow('已是最新模板版本');
    await expect(upgradeTemplateDraft(author, 'rfm')).rejects.toThrow('已是最新模板版本');

    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    expect(await getTemplate(author, 'rfm')).toMatchObject({ latestTemplateVersion: 2, upgradeAvailable: true, published: { version: 2, templateVersion: 1 } });
    const { task: baseline } = await recomputeTemplate(reviewer, 'rfm', '2024-12-31');
    await drain();
    const [{ n: total }] = await onLake<{ n: string }>(acme, `SELECT count(*)::VARCHAR AS n FROM gold."rfm__${baseline.id}"`);

    const [lakeBefore] = await onLake<{ n: string }>(acme, LAKE_SNAPSHOT);
    const queued = (await getDb().select().from(tasks)).length;
    const preview = await previewTemplateUpgrade(author, 'rfm', '2024-12-31');
    expect(preview).toMatchObject({ from: 1, to: 2, asOf: '2024-12-31', metric: null });
    expect(preview.segments!.length).toBeGreaterThan(0);
    for (const t of preview.segments!) expect(t.after).toBe(`v2:${t.before}`);
    expect(preview.segments!.reduce((n, t) => n + t.consumers, 0)).toBe(Number(total));
    expect(JSON.stringify(preview)).not.toMatch(/[0-9a-f]{64}/);
    await expect(previewTemplateUpgrade(author, 'rfm', '2999-01-01')).rejects.toThrow(/晚于今天/);
    expect(await onLake<{ n: string }>(acme, LAKE_SNAPSHOT)).toEqual([lakeBefore]);
    expect(await getDb().select().from(tasks)).toHaveLength(queued);

    // 已有草稿：改成锁定第 2 版，作者照常记下；丢弃后回到第 1 版
    await saveDraft(author, 'rfm', { ...PARAMS, lookbackDays: 3000 });
    expect(await upgradeTemplateDraft(reviewer, 'rfm')).toEqual({ version: 3, from: 1, to: 2 });
    expect((await getTemplate(author, 'rfm')).draft).toMatchObject({ version: 3, templateVersion: 2, authors: [author.email, reviewer.email], lastEditor: reviewer.email });
    await discardDraft(author, 'rfm');
    expect(await lockedVersions(acme)).toEqual([{ version: 1, templateVersion: 1 }, { version: 2, templateVersion: 1 }]);

    // 没有草稿：以生效参数新建锁定第 2 版的草稿
    expect(await upgradeTemplateDraft(author, 'rfm')).toEqual({ version: 3, from: 1, to: 2 });
    expect(await lockedVersions(acme)).toEqual([{ version: 1, templateVersion: 1 }, { version: 2, templateVersion: 1 }, { version: 3, templateVersion: 2 }]);
    expect((await getTemplate(author, 'rfm')).draft).toMatchObject({ params: PARAMS, lastEditor: author.email });
    await expect(upgradeTemplateDraft(reviewer, 'rfm')).rejects.toThrow('第 3 版草稿已锁定模板第 2 版');
    const audits = await getDb().select({ actorEmail: auditLogs.actorEmail, detail: auditLogs.detail }).from(auditLogs)
      .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'template.upgrade_drafted'))).orderBy(auditLogs.createdAt);
    expect(audits).toEqual([
      { actorEmail: reviewer.email, detail: { template: 'rfm', version: 3, from: 1, to: 2 } },
      { actorEmail: author.email, detail: { template: 'rfm', version: 3, from: 1, to: 2 } },
    ]);

    // 发布之前，重新计算仍按第 1 版
    const { task: before } = await recomputeTemplate(reviewer, 'rfm', '2024-12-31');
    expect(before.params).toMatchObject({ definitionVersion: 2, templateVersion: 1 });
    await drain();
    // 另一位成员发布后按第 2 版计算，分群带 v2:
    const upgraded = await publishTemplate(reviewer, 'rfm', 3);
    expect(upgraded.params).toMatchObject({ definitionVersion: 3, templateVersion: 2 });
    await drain();
    const { task: after } = await recomputeTemplate(reviewer, 'rfm', '2024-12-31');
    expect(after.params).toMatchObject({ definitionVersion: 3, templateVersion: 2 });
    await drain();
    const segments = await segmentsByTask(acme);
    expect(segments[before.id]!.every(s => !s.startsWith('v2:'))).toBe(true);
    expect(segments[after.id]!.length).toBeGreaterThan(0);
    expect(segments[after.id]!.every(s => s.startsWith('v2:'))).toBe(true);

    expect(await getTemplate(author, 'rfm')).toMatchObject({ latestTemplateVersion: 2, upgradeAvailable: false });
    await expect(previewTemplateUpgrade(author, 'rfm')).rejects.toThrow('已是最新模板版本');
  });

  it('其他模板给出变化、新增、移出人数；新版本拒绝生效的参数时预览与升级都说明原因；没有测试版本的模板已是最新', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await drain();
    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    // 流失预警第 2 版把 at_risk 取反：每个人都换了取值
    const { task } = await recomputeTemplate(reviewer, 'churn', '2024-10-15');
    await drain();
    const [{ n }] = await onLake<{ n: string }>(acme, `SELECT count(*)::VARCHAR AS n FROM gold."churn__${task.id}"`);
    expect(Number(n)).toBeGreaterThan(0);
    expect(await previewTemplateUpgrade(author, 'churn', '2024-10-15'))
      .toEqual({ template: 'churn', from: 1, to: 2, asOf: '2024-10-15', segments: null, metric: { changed: Number(n), added: 0, removed: 0 } });

    // 第 2 版的 minOrders 不超过 10
    await saveDraft(author, 'churn', { minOrders: 20 });
    await publishTemplate(reviewer, 'churn', 2);
    await expect(previewTemplateUpgrade(author, 'churn')).rejects.toThrow(/第 2 版不接受生效的参数：.*minOrders/);
    await expect(upgradeTemplateDraft(author, 'churn')).rejects.toThrow(/第 2 版不接受生效的参数：.*minOrders/);

    await expect(previewTemplateUpgrade(author, 'cohort')).rejects.toThrow('已是最新模板版本');
    await expect(upgradeTemplateDraft(author, 'cohort')).rejects.toThrow('已是最新模板版本');
  });
});

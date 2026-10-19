// 分析模板定义的流水线接缝：成员保存模板参数草稿（saveDraft）→ 另一位有发布权限的成员发布（publishTemplate）→ 以新参数入队 gold.rfm →
// 调度器派发并在成功后登记快照 → listSnapshots 读出的定义版本与参数；getTemplate 读出各版本与当前生效的参数；
// 按当前生效的版本重新计算（recomputeTemplate），可指定参考日期；定时刷新（enqueueDueRefreshes，ADR-0028）在依赖的实体有新合并后
// 以当天为 asOf 入队 gold.rfm；快照记来源（发布 publish、重新计算 manual、定时刷新 scheduled）
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks } from '../../app/.server/db/schema';
import { RFM_DEFAULTS } from '../../app/.server/pipeline/templates/rfm';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { enqueueDueRefreshes } from '../../app/.server/refresh';
import { listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { getTask } from '../../app/.server/tasks';
import { discardDraft, getTemplate, publishTemplate, recomputeTemplate, saveDraft, TemplateError } from '../../app/.server/templates';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();
const today = () => new Date().toISOString().slice(0, 10);

// 回看窗口放到最长，覆盖夹具里 2024 年的订单（发布时 asOf 取当天）
const PARAMS = {
  lookbackDays: 3650,
  statuses: ['completed', 'paid', 'shipped'],
  binning: { method: 'thresholds', recency: [30, 90, 180, 365], frequency: [2, 3, 5, 8], monetary: [100, 500, 1000, 5000] },
  segments: [{ name: '高价值', m: { min: 3 } }, { name: '其他' }],
};

describe('分析模板定义', () => {
  it('没有已发布版本时模板用注册表里的默认参数；保存草稿后生效的仍是默认参数', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    expect(await getTemplate(analyst, 'rfm')).toMatchObject({ published: null, draft: null, params: RFM_DEFAULTS, versions: [] });

    expect(await saveDraft(analyst, 'rfm', PARAMS)).toBe(1);
    const t = await getTemplate(analyst, 'rfm');
    expect(t).toMatchObject({ published: null, params: RFM_DEFAULTS, draft: { version: 1, params: PARAMS, authors: ['analyst@acme.com'], lastEditor: 'analyst@acme.com' } });
  });

  it('参数不合法时保存草稿报错说明原因，不写入草稿；没有起草权限的成员不能保存', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await expect(saveDraft(analyst, 'rfm', { ...PARAMS, lookbackDays: 0 })).rejects.toThrow(/lookbackDays/);
    await expect(saveDraft(analyst, 'rfm', { ...PARAMS, segments: [{ name: '高价值', m: { min: 3 } }] })).rejects.toThrow(/最后一条/);
    await expect(saveDraft(analyst, 'rfm', { ...PARAMS, asOf: '2024-07-01' })).rejects.toBeInstanceOf(TemplateError);
    await expect(saveDraft(analyst, 'nope', PARAMS)).rejects.toMatchObject({ status: 404 });
    expect((await getTemplate(analyst, 'rfm')).draft).toBeNull();

    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(saveDraft(viewer, 'rfm', PARAMS)).rejects.toMatchObject({ init: { status: 403 } });
  });

  it('再次保存改的是同一份草稿，记下又一位作者与最后保存的人', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    await saveDraft(analyst, 'rfm', PARAMS);
    expect(await saveDraft(engineer, 'rfm', { ...PARAMS, lookbackDays: 400 })).toBe(1);
    expect((await getTemplate(analyst, 'rfm')).draft).toMatchObject({
      version: 1, params: { lookbackDays: 400 }, authors: ['analyst@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com',
    });
  });

  it('最后保存草稿的人不能发布，分析师没有发布权限；另一位数据工程师发布后以新参数入队 gold.rfm，快照记下定义版本', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await saveDraft(author, 'rfm', PARAMS);

    const error = await publishTemplate(author, 'rfm', 1).catch(e => e);
    expect(error).toBeInstanceOf(TemplateError);
    expect(error.message).toMatch(/最后改了这一版草稿/);
    await expect(publishTemplate(analyst, 'rfm', 1)).rejects.toMatchObject({ init: { status: 403 } });

    const task = await publishTemplate(reviewer, 'rfm', 1);
    expect(task).toMatchObject({ kind: 'gold.rfm', status: 'queued', params: { ...PARAMS, definitionVersion: 1, asOf: new Date().toISOString().slice(0, 10) } });
    const t = await getTemplate(analyst, 'rfm');
    expect(t).toMatchObject({ draft: null, params: PARAMS, published: { version: 1, publishedByEmail: reviewer.email } });
    await expect(publishTemplate(reviewer, 'rfm', 1)).rejects.toThrow(/已锁定/);

    await drain();
    expect(await getTask(task.id)).toMatchObject({ status: 'succeeded' });
    const [snapshot] = await listSnapshots(acme);
    expect(snapshot).toMatchObject({ template: 'rfm', taskId: task.id, definitionVersion: 1, trigger: 'publish', params: { lookbackDays: 3650, segments: PARAMS.segments } });

    // 发布后再改是新的一版草稿，已发布的第 1 版不变
    expect(await saveDraft(analyst, 'rfm', { ...PARAMS, lookbackDays: 400 })).toBe(2);
    expect(await getTemplate(analyst, 'rfm')).toMatchObject({ params: PARAMS, draft: { version: 2 }, published: { version: 1 } });
  });

  it('通用表单的五个模板（user360、cohort、repurchase、clv、churn）都能起草、由另一位数据工程师发布，并各产出一张快照', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const drafts = {
      user360: { lookbackDays: 3650 },
      cohort: { granularity: 'week', periods: 60 },
      repurchase: { lookbackDays: 3650, windowDays: 60 },
      clv: { lookbackDays: 3650, decay: 3 },
      churn: { lookbackDays: 3650, minOrders: 2 },
    } as const;
    for (const [id, params] of Object.entries(drafts) as [keyof typeof drafts, Record<string, unknown>][]) {
      expect(await saveDraft(author, id, params)).toBe(1);
      expect(await publishTemplate(reviewer, id, 1)).toMatchObject({ kind: `gold.${id}`, status: 'queued', params: { ...params, definitionVersion: 1 } });
    }
    await drain();
    const snapshots = await listSnapshots(acme);
    for (const [id, params] of Object.entries(drafts)) {
      expect(snapshots.filter(s => s.template === id)).toEqual([expect.objectContaining({ definitionVersion: 1, trigger: 'publish', params: expect.objectContaining(params) })]);
    }
  });

  it('重新计算：以当前生效版本的参数入队 gold.rfm，不产生新版本；可指定参考日期，不能晚于今天；同模板已有任务在排队或运行时拒绝', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await expect(recomputeTemplate(reviewer, 'rfm')).rejects.toThrow(/还没有发布/);
    await saveDraft(author, 'rfm', PARAMS);
    await publishTemplate(reviewer, 'rfm', 1);
    // 发布入队的任务还在排队
    await expect(recomputeTemplate(reviewer, 'rfm')).rejects.toThrow(/已在排队或运行中/);
    await drain();

    await expect(recomputeTemplate(analyst, 'rfm')).rejects.toMatchObject({ init: { status: 403 } });
    await expect(recomputeTemplate(reviewer, 'rfm', '2999-01-01')).rejects.toThrow(/晚于今天/);
    await expect(recomputeTemplate(reviewer, 'rfm', '2026-02-30')).rejects.toBeInstanceOf(TemplateError);

    const current = await recomputeTemplate(author, 'rfm');
    expect(current.version).toBe(1);
    expect(current.task).toMatchObject({ kind: 'gold.rfm', status: 'queued', params: { ...PARAMS, asOf: today(), definitionVersion: 1, trigger: 'manual' } });
    await drain();
    const { task } = await recomputeTemplate(reviewer, 'rfm', '2026-09-30');
    expect(task.params).toEqual({ ...PARAMS, asOf: '2026-09-30', definitionVersion: 1, trigger: 'manual' });
    await drain();
    expect(await getTask(task.id)).toMatchObject({ status: 'succeeded' });
    expect((await listSnapshots(acme)).find(s => s.taskId === task.id)).toMatchObject({ definitionVersion: 1, trigger: 'manual', params: { asOf: '2026-09-30', lookbackDays: 3650 } });
    expect((await getTemplate(analyst, 'rfm')).versions).toHaveLength(1);
  });

  it('丢弃草稿：有已发布版本时回到它，从没发布过时回到默认参数', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    await saveDraft(analyst, 'rfm', PARAMS);
    expect(await discardDraft(analyst, 'rfm')).toEqual({ published: null });
    expect(await getTemplate(analyst, 'rfm')).toMatchObject({ draft: null, published: null, versions: [], params: RFM_DEFAULTS });
    await expect(discardDraft(analyst, 'rfm')).rejects.toThrow(/没有草稿/);

    await saveDraft(analyst, 'rfm', PARAMS);
    await publishTemplate(engineer, 'rfm', 1);
    await saveDraft(analyst, 'rfm', { ...PARAMS, lookbackDays: 400 });
    expect(await discardDraft(engineer, 'rfm')).toEqual({ published: 1 });
    expect(await getTemplate(analyst, 'rfm')).toMatchObject({ draft: null, published: { version: 1 }, params: PARAMS });
  });

  describe('定时刷新', () => {
    afterEach(() => { vi.useRealTimers(); });

    const syncAndMerge = async (author: Awaited<ReturnType<typeof publishedIdentitySources>>['author'], sourceId: string, insert: string) => {
      await grantOnSource(insert);
      await syncSource(author, sourceId);
      await drain();
    };
    const newOrder = (no: string) => `INSERT INTO crm.orders VALUES ('${no}', 1, 'paid', 50, '2024-07-01 10:00', '2024-07-01 10:00', '2024-07-01 ${no.slice(1).padStart(2, '0')}:00')`;
    const refreshed = async () => (await enqueueDueRefreshes()).map(t => [t.kind, t.params.definitionVersion, t.params.asOf, t.params.trigger, t.params.lookbackDays]);

    it('依赖的实体有新合并后以生效版本的参数入队当天的 gold.rfm（来源 scheduled）；依赖没变、已在排队或运行、当天已有当前版本的快照时不入队', async () => {
      const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
      await saveDraft(author, 'rfm', PARAMS);
      await publishTemplate(reviewer, 'rfm', 1);
      await drain();
      // 发布之后没有新合并
      expect(await enqueueDueRefreshes()).toEqual([]);
      // 只合并了 event：RFM 依赖 order 与 customer，不入队
      await syncAndMerge(author, sources.tracking,
        `INSERT INTO tracking.events VALUES ('e10', 'u1', 'd1', 'view', '2024-07-01 10:00', '2024-07-01')`);
      expect(await enqueueDueRefreshes()).toEqual([]);

      await syncAndMerge(author, sources.crm, newOrder('A7'));
      // 发布那张快照就是当天当前版本的：不入队；把它改成更早的统计日后入队
      expect(await enqueueDueRefreshes()).toEqual([]);
      await getDb().update(snapshots).set({ params: sql`jsonb_set(${snapshots.params}, '{asOf}', '"2024-07-15"'::jsonb)` }).where(eq(snapshots.tenantId, acme));
      expect(await refreshed()).toEqual([['gold.rfm', 1, today(), 'scheduled', 3650]]);
      // 已在排队：不重复入队
      expect(await enqueueDueRefreshes()).toEqual([]);
      await drain();
      expect((await listSnapshots(acme)).filter(s => s.trigger === 'scheduled').map(s => [s.template, s.definitionVersion, s.params.asOf]))
        .toEqual([['rfm', 1, today()]]);

      // 又一笔订单：当天已有当前版本的快照，不再算
      await syncAndMerge(author, sources.crm, newOrder('A8'));
      expect(await enqueueDueRefreshes()).toEqual([]);

      // 第二天：模板已有任务在排队时不入队，没有时按新的一天入队
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
      const [manual] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.rfm', params: {} }).returning();
      expect(await enqueueDueRefreshes()).toEqual([]);
      await getDb().delete(tasks).where(eq(tasks.id, manual!.id));
      expect(await refreshed()).toEqual([['gold.rfm', 1, today(), 'scheduled', 3650]]);
      expect((await listAuditLogs(acme)).filter(l => l.action === '定时刷新模板').map(l => [l.actor, l.summary])).toEqual([
        ['平台', `RFM 分层，按第 1 版参数刷新 ${today()}`],
        ['平台', `RFM 分层，按第 1 版参数刷新 ${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`],
      ]);
    });
  });
});

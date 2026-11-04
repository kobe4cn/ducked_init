// test/pipeline/catalog-projection.test.ts —— 目录检索投影（ADR-0047）的接缝：refreshProjection / rebuildProjection → catalog_projection。
// 一串目录变化后逐版增量刷新与从零重建得到的投影完全相同；两类投影的条目集合与 catalogFor 一致、restricted 不带数据源、源表与映射血缘的文字；
// catalog_search 先在请求里把投影刷到最新目录版本，在投影上排序并带命中理由；差异超过阈值时只入队一个 catalog.projection，任务成功后重建；投影不可用时回退到实时目录搜索
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogFor, runTool } from '../../app/.server/assistant/tools';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { projectionVersion, rankedSearch, rebuildProjection, refreshFrom, refreshProjection } from '../../app/.server/catalog/projection';
import * as rankModule from '../../app/.server/catalog/rank';
import { currentCatalogVersion } from '../../app/.server/catalog/versions';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogProjection, tasks } from '../../app/.server/db/schema';
import { createDefinition, deleteDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { addMembership, createSubject } from '../../app/.server/knowledge/subjects';
import { confirmDisable, requestDisable } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { drain, memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.restoreAllMocks(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const REFUND = 'base: order\nmeasure: { agg: count }\ndescription: 退货笔数统计\n';

/** 身份打通数据源与订单映射，加一位分析师、一位查看者 */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  const viewer = await memberOf(s.acme, 'view@acme.com', 'viewer');
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst, viewer };
}

/** 该租户的全部投影行，按类别与 entryId 排序 */
const rows = (tenantId: string) => getDb().select().from(catalogProjection)
  .where(eq(catalogProjection.tenantId, tenantId))
  .orderBy(asc(catalogProjection.visibilityClass), asc(catalogProjection.entryId));

describe('检索投影', () => {
  it('加别名、加主题归属、发布与删除定义、停用映射、改业务说明：每步之后逐版增量刷新与从零重建得到的投影完全相同', async () => {
    const { acme, author, reviewer, analyst, orderMappings } = await setup();
    expect(await refreshProjection(acme)).toBe('refreshed');
    expect(await refreshProjection(acme)).toBe('fresh');

    const steps: [string, () => Promise<unknown>][] = [
      ['别名', () => addAlias(analyst, { targetId: 'field:order.status', alias: '单据状态' })],
      ['主题归属', async () => addMembership(analyst, await createSubject(analyst, '交易分析'), 'entity:order')],
      ['发布指标', async () => {
        await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
        await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
        await createDefinition(analyst, 'metric', 'refund_count', REFUND);
        await publishDefinition(reviewer, 'metric', 'refund_count', 1);
      }],
      ['删除定义', () => deleteDefinition(author, 'metric', 'refund_count')],
      ['停用映射', async () => {
        await requestDisable(author, orderMappings!.loyalty);
        await confirmDisable(reviewer, orderMappings!.loyalty);
      }],
      ['业务说明', () => saveBusinessNote(analyst, { entity: 'order', field: 'status', note: '只算已支付' })],
    ];
    for (const [label, act] of steps) {
      const before = await projectionVersion(getDb(), acme);
      await act();
      expect(await refreshProjection(acme), label).toBe('refreshed');
      const v = await currentCatalogVersion(getDb(), acme);
      expect(v, label).toBeGreaterThan(before!);
      const incremental = await rows(acme);
      expect(new Set(incremental.map(r => r.catalogVersion)), label).toEqual(new Set([v]));
      await rebuildProjection(acme);
      expect(await rows(acme), label).toEqual(incremental);
    }
    const all = await rows(acme);
    expect(all.find(r => r.visibilityClass === 'restricted' && r.entryId === 'field:order.status')).toMatchObject({ aliases: ['单据状态'] });
    expect(all.find(r => r.visibilityClass === 'full' && r.entryId === 'entity:order')).toMatchObject({ subjects: ['交易分析'] });
    expect(all.find(r => r.entryId === 'metric:paid_revenue')?.spaceId).toBe(analyst.space.id);
    expect(all.some(r => r.entryId === 'metric:refund_count')).toBe(false);
  });

  it('锁外读到旧版本、锁里投影已被并发刷新推进：按锁里的版本算净差异，之后删掉的条目不会留在投影里', async () => {
    const { acme, analyst, reviewer, author } = await setup();
    await refreshProjection(acme);
    const a = (await projectionVersion(getDb(), acme))!;
    await createDefinition(analyst, 'metric', 'refund_count', REFUND);
    await publishDefinition(reviewer, 'metric', 'refund_count', 1);
    await refreshProjection(acme);
    const b = (await projectionVersion(getDb(), acme))!;
    expect((await rows(acme)).some(r => r.entryId === 'metric:refund_count')).toBe(true);

    // 模拟锁外读到的是 A：把投影行的版本号改回 A；然后删掉 X，在锁里按 B 刷新
    await getDb().update(catalogProjection).set({ catalogVersion: a }).where(eq(catalogProjection.tenantId, acme));
    await deleteDefinition(author, 'metric', 'refund_count');
    const c = await tenantCatalog(acme);
    await getDb().transaction(tx => refreshFrom(tx, acme, b, c));
    const incremental = await rows(acme);
    expect(incremental.some(r => r.entryId === 'metric:refund_count')).toBe(false);
    await rebuildProjection(acme);
    expect(await rows(acme)).toEqual(incremental);
  });

  it('两类投影的条目集合与 catalogFor 一致；restricted 的文字不带源表、数据源与源表条目、映射说明与映射别名', async () => {
    const { acme, author, analyst, viewer, orderMappings } = await setup();
    await saveBusinessNote(author, { entity: 'order', field: 'status', mappingId: orderMappings!.crm, note: '源端状态码说明' });
    await addAlias(author, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, alias: '源端单据态' });
    await refreshProjection(acme);
    const all = await rows(acme);
    const ids = (cls: string) => all.filter(r => r.visibilityClass === cls).map(r => r.entryId).sort();
    const live = async (m: typeof viewer) => (await catalogFor(m)).entries.map(e => e.id).sort();
    expect(ids('restricted')).toEqual(await live(viewer));
    expect(ids('full')).toEqual(await live(analyst));

    // 字段的检索文字只从映射血缘取映射说明与映射知识；数据源名、源表只经 source: / table: 条目与「源/表」形式出现
    const tableIds = (await catalogFor(analyst)).entries.filter(e => e.kind === 'table').map(e => e.id.slice('table:'.length).toLowerCase());
    expect(tableIds).toEqual(expect.arrayContaining(['crm/orders', '会员/orders']));
    const fullStatus = all.find(r => r.visibilityClass === 'full' && r.entryId === 'field:order.status')!.text;
    expect(fullStatus).toContain('源端状态码说明');
    expect(fullStatus).toContain('源端单据态');
    for (const r of all.filter(r => r.visibilityClass === 'restricted')) {
      for (const t of tableIds) expect(r.text, r.entryId).not.toContain(t);
      expect(r.text, r.entryId).not.toContain('源端状态码说明');
      expect(r.text, r.entryId).not.toContain('源端单据态');
      expect(r.text, r.entryId).not.toMatch(/(source|table):/);
    }
  });

  it('投影落后时 catalog_search 先把投影刷到最新目录版本；删除的定义搜不到', async () => {
    const { acme, author, reviewer, analyst, viewer } = await setup();
    await createDefinition(analyst, 'metric', 'refund_count', REFUND);
    await publishDefinition(reviewer, 'metric', 'refund_count', 1);
    await refreshProjection(acme);
    expect(await runTool(viewer, 'catalog_search', { query: '退货笔数' })).toContain('metric:refund_count');

    await deleteDefinition(author, 'metric', 'refund_count');
    expect(await projectionVersion(getDb(), acme)).toBeLessThan((await currentCatalogVersion(getDb(), acme))!);
    expect(await runTool(viewer, 'catalog_search', { query: '退货笔数' })).not.toContain('metric:refund_count');
    expect(await projectionVersion(getDb(), acme)).toBe(await currentCatalogVersion(getDb(), acme));
    expect((await rows(acme)).some(r => r.entryId === 'metric:refund_count')).toBe(false);
  });

  it('净差异超过阈值：只入队一个 catalog.projection、不改投影，排队期间检索走实时目录、搜不到投影里还在的已删指标，任务成功后投影与从零重建相同', async () => {
    const { acme, author, reviewer, analyst, viewer } = await setup();
    await createDefinition(analyst, 'metric', 'refund_count', REFUND);
    await publishDefinition(reviewer, 'metric', 'refund_count', 1);
    await rebuildProjection(acme);
    const before = await projectionVersion(getDb(), acme);
    const beforeRows = await rows(acme);
    expect(beforeRows.some(r => r.entryId === 'metric:refund_count')).toBe(true);
    await deleteDefinition(author, 'metric', 'refund_count');

    expect(await refreshProjection(acme, { syncLimit: 0 })).toBe('queued');
    expect(await refreshProjection(acme, { syncLimit: 0 })).toBe('queued');
    const queued = () => getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'catalog.projection')));
    expect(await queued()).toHaveLength(1);
    expect(await projectionVersion(getDb(), acme)).toBe(before);
    expect(await rows(acme)).toEqual(beforeRows);

    const during = await runTool(viewer, 'catalog_search', { query: '退货笔数' });
    expect(during).not.toContain('metric:refund_count');
    expect(during).not.toContain('命中：');

    await drain();
    expect((await queued()).map(t => t.status)).toEqual(['succeeded']);
    expect(await projectionVersion(getDb(), acme)).toBe(await currentCatalogVersion(getDb(), acme));
    const rebuilt = await rows(acme);
    expect(rebuilt.some(r => r.entryId === 'metric:refund_count')).toBe(false);
    await rebuildProjection(acme);
    expect(await rows(acme)).toEqual(rebuilt);
  });

  it('catalog_search 按投影排序：别名命中的指标排在前面，条目下带「命中：」理由', async () => {
    const { acme, reviewer, analyst, viewer } = await setup();
    await createDefinition(analyst, 'metric', 'refund_count', REFUND);
    await publishDefinition(reviewer, 'metric', 'refund_count', 1);
    await addAlias(analyst, { targetId: 'metric:refund_count', alias: '退单量' });
    const out = await runTool(viewer, 'catalog_search', { query: '退单量' });
    // 第一个候选是别名命中的指标，它的条目后面接着命中理由
    const first = out.slice(0, out.indexOf('命中：'));
    expect(first).toContain('metric:refund_count');
    expect(out).toContain('命中：别名「退单量」');
    expect(await projectionVersion(getDb(), acme)).toBe(await currentCatalogVersion(getDb(), acme));
    // ASCII 别名：小写查询也命中，理由里显示别名原文
    await addAlias(analyst, { targetId: 'metric:refund_count', alias: 'RefundCnt' });
    const ascii = await runTool(viewer, 'catalog_search', { query: 'refundcnt' });
    expect(ascii).toContain('命中：别名「RefundCnt」');
  });

  it('投影不可用时回退到实时目录搜索、不带理由：刷新抛错、投影版本不等于目录版本、排序抛错', async () => {
    const { acme, reviewer, analyst, viewer } = await setup();
    await createDefinition(analyst, 'metric', 'refund_count', REFUND);
    await publishDefinition(reviewer, 'metric', 'refund_count', 1);
    const c = await catalogFor(viewer);
    const found = (r: Awaited<ReturnType<typeof rankedSearch>>) => r.ranked.map(x => x.entry.id);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await rankedSearch(acme, 'restricted', c, '退货笔数', {});
    expect(ok.fallback).toBe(false);
    expect(found(ok)).toContain('metric:refund_count');
    expect(ok.ranked.find(x => x.entry.id === 'metric:refund_count')!.reasons.length).toBeGreaterThan(0);

    // 刷新抛错：租户 id 不是 uuid
    const thrown = await rankedSearch('not-a-uuid', 'restricted', c, '退货笔数', {});
    expect(thrown).toMatchObject({ fallback: true });
    expect(found(thrown)).toContain('metric:refund_count');
    expect(thrown.ranked.every(x => x.reasons.length === 0)).toBe(true);

    // 投影版本不等于调用方目录的版本（投影已是最新、不会入队）
    const stale = await rankedSearch(acme, 'restricted', { ...c, version: (c.version ?? 0) + 1 }, '退货笔数', {});
    expect(stale.fallback).toBe(true);
    expect(found(stale)).toContain('metric:refund_count');
    expect(await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'catalog.projection')))).toHaveLength(0);

    // 排序抛错：catalog_search 的输出仍有实时目录里的条目、没有「命中：」
    vi.spyOn(rankModule, 'rank').mockImplementation(() => { throw new Error('boom'); });
    expect(await rankedSearch(acme, 'restricted', c, '退货笔数', {})).toMatchObject({ fallback: true });
    const out = await runTool(viewer, 'catalog_search', { query: '退货笔数' });
    expect(out).toContain('metric:refund_count');
    expect(out).not.toContain('命中：');
  });
});

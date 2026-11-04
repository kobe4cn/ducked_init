// test/pipeline/catalog-projection.test.ts —— 目录检索投影（ADR-0047）的接缝：refreshProjection / rebuildProjection → catalog_projection。
// 一串目录变化后逐版增量刷新与从零重建得到的投影完全相同；两类投影的条目集合与 catalogFor 一致、restricted 不带数据源、源表与映射血缘的文字；
// catalog_search 先在请求里把投影刷到最新目录版本，结果来自实时目录
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { catalogFor, runTool } from '../../app/.server/assistant/tools';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { projectionVersion, rebuildProjection, refreshProjection } from '../../app/.server/catalog/projection';
import { currentCatalogVersion } from '../../app/.server/catalog/versions';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogProjection } from '../../app/.server/db/schema';
import { createDefinition, deleteDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { addMembership, createSubject } from '../../app/.server/knowledge/subjects';
import { confirmDisable, requestDisable } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

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
});

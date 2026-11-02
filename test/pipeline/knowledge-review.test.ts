// test/pipeline/knowledge-review.test.ts —— 需复核（ADR-0046）：指标发布新版本、映射发布改了计划的新版本后，挂在上面的别名、口径声明、业务说明
// 在目录里带需复核标记（同一次发布的那一版目录里），口径声明按「未知」输出、能搜到「待复核」；重新保存 / 停用后重新加同名别名后标记消失
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown, type CatalogEntry } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogVersions } from '../../app/.server/db/schema';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { addAlias, retireAlias } from '../../app/.server/knowledge/aliases';
import { saveClaim } from '../../app/.server/knowledge/claims';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { CRM_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { republish } from './identity-helpers';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const REVENUE_V2 = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 新口径\n';
const CRM_ORDERS_V2 = CRM_ORDERS.replace(`paid_at: from_timezone(paid_at, 'UTC')`, `paid_at: from_timezone(paid_at, 'Asia/Shanghai')`);

/** 某个原因最新的一版目录 */
const versionOf = async (tenantId: string, reason: string) => (await getDb().select().from(catalogVersions)
  .where(and(eq(catalogVersions.tenantId, tenantId), eq(catalogVersions.reason, reason))).orderBy(desc(catalogVersions.version)).limit(1))[0];
const changedKeys = (v: Awaited<ReturnType<typeof versionOf>>, id: string) =>
  (v?.diff as { changed: { id: string; keys: string[] }[] }).changed.find(x => x.id === id)?.keys ?? [];
const crmLineage = (e: CatalogEntry | null) => (e?.kind === 'field' ? e.lineage.find(l => l.source === 'CRM') : undefined);

/** 身份打通数据源与订单映射，加一位分析师，发布指标 paid_revenue（作者与发布者是两个人） */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst };
}

describe('需复核', () => {
  it('指标发布改了 yaml 的新版本后，别名、口径声明、业务说明带需复核，记进那一版目录；内容不变的重新发布不触发；重新保存后标记消失', async () => {
    const { acme, reviewer, analyst } = await setup();
    const target = 'metric:paid_revenue';
    const aliasId = await addAlias(analyst, { targetId: target, alias: '营收' });
    await saveClaim(analyst, { targetId: target, type: 'currency', value: 'CNY' });
    await saveBusinessNote(analyst, { targetId: target, note: '只算已支付' });

    // 内容不变的重新发布：不需复核
    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    const same = expand(await tenantCatalog(acme), target)!;
    expect(JSON.stringify(same)).not.toContain('needsReview');
    expect(same).toMatchObject({ knowledge: { claims: [{ type: 'currency', value: 'CNY' }] } });

    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_V2);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 3);
    expect(changedKeys(await versionOf(acme, 'definition.published'), target)).toContain('knowledge');
    const c = await tenantCatalog(acme);
    const e = expand(c, target)!;
    expect(e).toMatchObject({
      knowledge: {
        aliases: ['营收'], aliasesNeedReview: ['营收'], noteNeedsReview: true, note: '只算已支付',
        claims: [{ type: 'currency', value: 'unknown', previous: 'CNY', needsReview: true }],
      },
    });
    const md = toMarkdown(e);
    expect(md).toContain('币种：未知（待复核，原为 人民币）');
    expect(md).toContain('别名：营收（待复核）');
    expect(md).toContain('业务说明（待复核）：只算已支付');
    expect(search(c, '待复核').map(x => x.id)).toContain(target);

    await saveClaim(analyst, { targetId: target, type: 'currency', value: 'CNY' });
    await saveBusinessNote(analyst, { targetId: target, note: '只算已支付' });
    await retireAlias(analyst, aliasId);
    await addAlias(analyst, { targetId: target, alias: '营收' });
    const after = expand(await tenantCatalog(acme), target)!;
    expect(JSON.stringify(after)).not.toContain('needsReview');
    expect(JSON.stringify(after)).not.toContain('previous');
    expect(after).toMatchObject({ knowledge: { aliases: ['营收'], note: '只算已支付', claims: [{ type: 'currency', value: 'CNY' }] } });
  });

  it('映射发布改了计划的新版本后，映射字段上的别名、口径声明、映射说明带需复核，说明的标记在血缘项上；内容不变的重新发布不触发', async () => {
    const { acme, author, reviewer, orderMappings } = await setup();
    const crm = orderMappings!.crm;
    const target = 'field:order.status';
    await addAlias(author, { targetId: target, mappingId: crm, alias: '单据状态' });
    await saveClaim(author, { targetId: target, mappingId: crm, type: 'time_meaning', value: 'pay_time' });
    await saveBusinessNote(author, { entity: 'order', field: 'status', mappingId: crm, note: 'CRM 手工改状态' });

    await republish(author, reviewer, crm, CRM_ORDERS);
    expect(JSON.stringify(crmLineage(expand(await tenantCatalog(acme), target)))).not.toContain('needsReview');

    await republish(author, reviewer, crm, CRM_ORDERS_V2);
    expect(changedKeys(await versionOf(acme, 'mapping.published'), target)).toContain('lineage');
    const c = await tenantCatalog(acme);
    const e = expand(c, target);
    expect(crmLineage(e)).toMatchObject({
      note: 'CRM 手工改状态', noteNeedsReview: true,
      knowledge: { aliasesNeedReview: ['单据状态'], claims: [{ type: 'time_meaning', value: 'unknown', previous: 'pay_time', needsReview: true }] },
    });
    expect(JSON.stringify(e?.kind === 'field' && e.lineage.find(l => l.source === '会员'))).not.toContain('needsReview');
    const md = toMarkdown(e!);
    expect(md).toContain('映射说明（待复核）：CRM 手工改状态');
    expect(md).toContain('时间含义：未知（待复核，原为 支付时间）');
    expect(search(c, '待复核').map(x => x.id)).toContain(target);

    await saveBusinessNote(author, { entity: 'order', field: 'status', mappingId: crm, note: 'CRM 手工改状态' });
    expect(crmLineage(expand(await tenantCatalog(acme), target))).not.toHaveProperty('noteNeedsReview');
  });
});

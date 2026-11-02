// test/pipeline/knowledge-claims.test.ts —— 口径声明（ADR-0046）的接缝：saveClaim → semantic_claims 与审计、目录版本 →
// tenantCatalog 的条目（映射字段在血缘项下）、search 与 Markdown；claimHistory 列出每一版
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, catalogVersions, semanticClaims } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { claimHistory, saveClaim, saveClaimTx } from '../../app/.server/knowledge/claims';
import { definitionHash, planHash } from '../../app/.server/knowledge/basis';
import { listAuditLogs } from '../../app/.server/audit';
import { publishedPlans } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';

const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];
const claimRows = (tenantId: string) => getDb().select().from(semanticClaims).where(eq(semanticClaims.tenantId, tenantId));
const audits = (tenantId: string) => getDb().select().from(auditLogs)
  .where(eq(auditLogs.tenantId, tenantId)).then(rows => rows.filter(r => r.action === 'semantic_claim.saved'));

/** 做一件事，断言目录版本 +1、原因是 reason */
async function expectBump<T>(tenantId: string, reason: string, act: () => Promise<T>): Promise<T> {
  const before = (await latestVersion(tenantId))?.version ?? 0;
  const out = await act();
  expect(await latestVersion(tenantId), reason).toMatchObject({ version: before + 1, reason });
  return out;
}

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue（作者与发布者是两个人） */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  const viewer = await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst, viewer };
}

describe('口径声明', () => {
  it('分析师给指标与字段、数据工程师给映射字段保存口径声明：目录带 knowledge.claims（每种取最新、按登记顺序），能搜到、Markdown 列出；历史列出每一版', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const loyalty = orderMappings!.loyalty;
    const save = (actor: typeof analyst, input: Parameters<typeof saveClaim>[1]) => expectBump(acme, 'semantic_claim.saved', () => saveClaim(actor, input));
    await save(analyst, { targetId: 'metric:paid_revenue', type: 'tax_included', value: 'unknown' });
    await save(analyst, { targetId: 'metric:paid_revenue', type: 'currency', value: 'USD' });
    await save(analyst, { targetId: 'metric:paid_revenue', type: 'currency', value: 'CNY' });
    await save(analyst, { targetId: 'field:order.status', type: 'unit', value: 'not_applicable' });
    await save(author, { targetId: 'field:order.status', mappingId: loyalty, type: 'time_meaning', value: 'pay_time' });

    const c = await tenantCatalog(acme);
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({
      knowledge: { claims: [{ type: 'currency', value: 'CNY' }, { type: 'tax_included', value: 'unknown' }] },
    });
    const status = expand(c, 'field:order.status')!;
    expect(status).toMatchObject({ knowledge: { claims: [{ type: 'unit', value: 'not_applicable' }] } });
    expect(status).not.toHaveProperty('knowledge.aliases');
    const lineage = status.kind === 'field' ? status.lineage : [];
    expect(lineage.find(l => l.source === '会员')).toMatchObject({ knowledge: { claims: [{ type: 'time_meaning', value: 'pay_time' }] } });
    expect(lineage.find(l => l.source === 'CRM')).not.toHaveProperty('knowledge');
    // 没有声明的类型不输出，没有声明的条目不带 knowledge
    expect(expand(c, 'entity:order')).not.toHaveProperty('knowledge');

    const md = toMarkdown(expand(c, 'metric:paid_revenue')!);
    expect(md).toContain('- 口径：\n  - 币种：人民币\n  - 是否含税：未知');
    expect(md).not.toContain('美元');
    expect(toMarkdown(status)).toContain('时间含义：支付时间');
    expect(search(c, '是否含税').map(e => e.id)).toContain('metric:paid_revenue');

    const history = await claimHistory(getDb(), acme, 'metric:paid_revenue');
    expect(history.map(h => [h.type, h.value, h.createdByEmail])).toEqual([
      ['currency', 'CNY', 'an@acme.com'], ['currency', 'USD', 'an@acme.com'], ['tax_included', 'unknown', 'an@acme.com'],
    ]);
    expect(history.every(h => h.createdAt instanceof Date)).toBe(true);
    expect((await claimHistory(getDb(), acme, 'field:order.status', loyalty)).map(h => [h.type, h.value, h.createdByEmail]))
      .toEqual([['time_meaning', 'pay_time', author.email]]);
    expect(await claimHistory(getDb(), acme, 'field:order.status')).toHaveLength(1);

    // 同一事务里同一类型存两次（接受知识提案时可能发生）：后存的生效
    await getDb().transaction(async tx => {
      await saveClaimTx(tx, analyst, { targetId: 'entity:order', type: 'time_meaning', value: 'ship_time' });
      await saveClaimTx(tx, analyst, { targetId: 'entity:order', type: 'time_meaning', value: 'order_time' });
    });
    expect(expand(await tenantCatalog(acme), 'entity:order')).toMatchObject({ knowledge: { claims: [{ type: 'time_meaning', value: 'order_time' }] } });
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('保存记审计 semantic_claim.saved，detail 为 {targetId, mappingId, type}；based_on 是依据摘要', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const loyalty = orderMappings!.loyalty;
    const a = await saveClaim(analyst, { targetId: 'metric:paid_revenue', type: 'refund_deducted', value: 'yes' });
    const b = await saveClaim(author, { targetId: 'field:order.status', mappingId: loyalty, type: 'time_meaning', value: 'record_time' });
    const c = await saveClaim(analyst, { targetId: 'entity:order', type: 'currency', value: 'HKD' });
    const logs = await audits(acme);
    expect(logs.map(l => [l.targetType, l.targetId, l.detail])).toEqual(expect.arrayContaining([
      ['knowledge', a, { targetId: 'metric:paid_revenue', mappingId: null, type: 'refund_deducted' }],
      ['knowledge', b, { targetId: 'field:order.status', mappingId: loyalty, type: 'time_meaning' }],
      ['knowledge', c, { targetId: 'entity:order', mappingId: null, type: 'currency' }],
    ]));
    expect(logs).toHaveLength(3);
    expect((await listAuditLogs(acme)).find(l => l.action === '保存口径声明' && l.summary.includes('metric:paid_revenue'))?.summary)
      .toBe('metric:paid_revenue：是否扣除退款');

    const [plan] = await publishedPlans(getDb(), acme, [loyalty]);
    const basedOn = Object.fromEntries((await claimRows(acme)).map(r => [r.id, r.basedOn]));
    expect(basedOn).toEqual({
      [a]: [{ id: 'metric:paid_revenue', hash: definitionHash(REVENUE) }],
      [b]: [{ id: `mapping:${loyalty}`, hash: planHash(plan) }],
      [c]: [],
    });
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('类型或取值不在登记表里、目标不合法（含敏感字段）时 400 且不留记录；查看者 403，分析师给映射字段保存 403', async () => {
    const { acme, author, analyst, viewer, mappings, orderMappings } = await setup();
    const before = (await latestVersion(acme))!.version;
    const bad = [
      { targetId: 'metric:paid_revenue', type: 'color', value: 'unknown' },
      { targetId: 'metric:paid_revenue', type: 'currency', value: 'GBP' },
      { targetId: 'metric:paid_revenue', type: 'currency', value: 'cny' },
      { targetId: 'metric:paid_revenue', type: 'time_meaning', value: '下单后 24 小时' },
      { targetId: 'metric:paid_revenue', type: 'unit', value: null },
      { targetId: 'metric:paid_revenue', type: 'toString', value: 'unknown' },
      { targetId: 'metric:nope', type: 'currency', value: 'CNY' },
      { targetId: 'field:order.nope', type: 'currency', value: 'CNY' },
      { targetId: 'source:CRM', type: 'currency', value: 'CNY' },
      { targetId: 'field:customer.phone', type: 'unit', value: 'unknown' },
      { targetId: '', type: 'unit', value: 'unknown' },
    ];
    for (const input of bad) await expect(saveClaim(analyst, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400 });
    const badMapped = [
      { targetId: 'field:order.status', mappingId: mappings.tracking, type: 'unit', value: 'unknown' },
      { targetId: 'field:customer.name', mappingId: mappings.crm, type: 'unit', value: 'unknown' },
      { targetId: 'field:order.status', mappingId: 'not-a-uuid', type: 'unit', value: 'unknown' },
      { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, type: 'unit', value: 'yen' },
    ];
    for (const input of badMapped) await expect(saveClaim(author, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400 });

    await expect(saveClaim(viewer, { targetId: 'metric:paid_revenue', type: 'currency', value: 'CNY' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(saveClaim(analyst, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, type: 'unit', value: 'count' }))
      .rejects.toMatchObject({ init: { status: 403 } });

    expect(await claimRows(acme)).toEqual([]);
    expect(await audits(acme)).toEqual([]);
    expect((await latestVersion(acme))!.version).toBe(before);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s
});

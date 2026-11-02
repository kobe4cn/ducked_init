// test/pipeline/knowledge-derive.test.ts —— 系统事实（ADR-0046 入口①）进目录：已发布的指标与标签条目带 system.text（DSL 确定性生成的口径文字），
// search 能用口径里的词搜到，Markdown 有「- 口径（系统生成）：…」；指标改 yaml 发布新版本后文字随之更新，记进 definition.published 那一版目录的 diff。
// 派生的口径声明（system.claims）同样进检索与 Markdown、随发布更新，和成员写的口径声明（knowledge.claims）分开
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogVersions } from '../../app/.server/db/schema';
import { saveClaim } from '../../app/.server/knowledge/claims';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nfilter: [{ field: status, op: eq, value: paid }]\nwindow: { field: paid_at, days: 30 }\nmeasure: { agg: sum, field: amount }\n';
const REVENUE_V2 = 'base: order\nfilter: [{ field: status, op: in, value: [paid, shipped] }]\nwindow: { field: paid_at, days: 90 }\nmeasure: { agg: sum, field: amount }\n';
const REVENUE_CREATED = 'base: order\nwindow: { field: created_at, days: 90 }\nmeasure: { agg: sum, field: amount }\n';
const HIGH_VALUE = 'metric: paid_revenue\nrules: [{ value: 高, when: { gte: 1000 } }]\nmissing: { paid_revenue: 0 }\ndefault: 低\n';

/** 某个原因最新的一版目录 */
const versionOf = async (tenantId: string, reason: string) => (await getDb().select().from(catalogVersions)
  .where(and(eq(catalogVersions.tenantId, tenantId), eq(catalogVersions.reason, reason))).orderBy(desc(catalogVersions.version)).limit(1))[0];
const changedKeys = (v: Awaited<ReturnType<typeof versionOf>>, id: string) =>
  (v?.diff as { changed: { id: string; keys: string[] }[] }).changed.find(x => x.id === id)?.keys ?? [];

describe('系统口径进目录', () => {
  it('指标与标签条目带 system.text 与 system.claims，能搜到、Markdown 有口径行；指标发布新版本后文字更新，那一版 diff 的 changed 键含 system', async () => {
    const { acme, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
    await createDefinition(analyst, 'tag', 'high_value', HIGH_VALUE);
    await publishDefinition(reviewer, 'tag', 'high_value', 1);

    const c = await tenantCatalog(acme);
    const metric = expand(c, 'metric:paid_revenue')!;
    const text = '订单中 status 等于 paid、paid_at 在最近 30 天内的行，amount 求和';
    expect(metric).toMatchObject({ system: { text } });
    expect(toMarkdown(metric)).toContain(`- 口径（系统生成）：${text}`);
    const tag = expand(c, 'tag:high_value')!;
    const tagLine = '按指标 paid_revenue：大于等于 1000 时为 高；指标 paid_revenue 为空时按 0 比较；其余为 低';
    expect(tag).toMatchObject({ system: { text: tagLine } });
    expect(toMarkdown(tag)).toContain(`- 口径（系统生成）：${tagLine}`);
    expect(search(c, '最近 30 天内').map(x => x.id)).toContain('metric:paid_revenue');
    expect(search(c, '大于等于 1000').map(x => x.id)).toContain('tag:high_value');

    const claims = (unit: string, time: string) => [
      { type: 'unit', value: unit }, { type: 'currency', value: 'unknown' }, { type: 'tax_included', value: 'unknown' },
      { type: 'refund_deducted', value: 'unknown' }, { type: 'time_meaning', value: time },
    ];
    expect(metric.kind === 'metric' && metric.system.claims).toEqual(claims('unknown', 'pay_time'));
    expect(tag.kind === 'tag' && tag.system.claims).toEqual(claims('not_applicable', 'pay_time'));
    expect(toMarkdown(metric)).toContain('- 口径声明（系统生成）：单位：未知、币种：未知、是否含税：未知、是否扣除退款：未知、时间含义：支付时间');
    expect(toMarkdown(tag)).toContain('- 口径声明（系统生成）：单位：不适用、');
    expect(search(c, '支付时间').map(x => x.id)).toEqual(expect.arrayContaining(['metric:paid_revenue', 'tag:high_value']));

    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_V2);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    expect(changedKeys(await versionOf(acme, 'definition.published'), 'metric:paid_revenue')).toContain('system');
    expect(expand(await tenantCatalog(acme), 'metric:paid_revenue')).toMatchObject({
      system: { text: '订单中 status 在 paid、shipped 中、paid_at 在最近 90 天内的行，amount 求和' },
    });

    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_CREATED);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 3);
    const c3 = await tenantCatalog(acme);
    expect(expand(c3, 'metric:paid_revenue')).toMatchObject({ system: { claims: claims('unknown', 'order_time') } });
    expect(expand(c3, 'tag:high_value')).toMatchObject({ system: { claims: claims('not_applicable', 'order_time') } });
  });

  it('成员写的口径声明在 knowledge.claims，派生声明在 system.claims，两边分开不合并', async () => {
    const { acme, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
    await saveClaim(analyst, { targetId: 'metric:paid_revenue', type: 'currency', value: 'CNY' });

    const metric = expand(await tenantCatalog(acme), 'metric:paid_revenue')!;
    expect(metric).toMatchObject({ knowledge: { claims: [{ type: 'currency', value: 'CNY' }] } });
    expect(metric.kind === 'metric' && metric.system.claims.find(x => x.type === 'currency')).toEqual({ type: 'currency', value: 'unknown' });
  });
});

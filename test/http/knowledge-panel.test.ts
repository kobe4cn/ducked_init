// test/http/knowledge-panel.test.ts —— 业务知识面板（ADR-0046）的 HTTP 接缝：指标 / 标签详情页（analytics.definitions.$kind.$key）的面板显示系统事实与成员写的知识，
// 分析师、数据工程师、管理员提交 alias.* / claim.* / note.* / subject.* 后面板与目录（expand 的 knowledge）立即反映；查看者看得到、没有编辑入口、提交 403；
// 依据变了的知识显示「待复核」；从未发布过的定义只提示发布后才能添加
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expand } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { analysisSubjects, knowledgeAliases } from '../../app/.server/db/schema';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { saveClaim } from '../../app/.server/knowledge/claims';
import { createSubject } from '../../app/.server/knowledge/subjects';
import { memberOf } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const REVENUE_V2 = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 新口径\n';
const SPENDER = 'metric: paid_revenue\nrules:\n  - { value: high, when: { gte: 1000 } }\ndefault: low\n';
const METRIC = '/analytics/definitions/metric/paid_revenue';
const TAG = '/analytics/definitions/tag/spender';
const TARGET = 'metric:paid_revenue';

const decode = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
/** 页面里的业务知识面板（data-knowledge-panel 的 section） */
const panelOf = async (browser: Awaited<ReturnType<typeof loginAs>>, path: string) => {
  const html = decode(await (await browser.get(path)).text());
  return html.match(/<section[^>]*data-knowledge-panel[\s\S]*?<\/section>/)?.[0] ?? '';
};
const knowledgeOf = async (tenantId: string, id = TARGET) => {
  const e = expand(await tenantCatalog(tenantId), id);
  return e && 'knowledge' in e ? e.knowledge : undefined;
};

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue 与标签 spender（作者与发布者是两个人） */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  await createDefinition(analyst, 'tag', 'spender', SPENDER);
  await publishDefinition(s.reviewer, 'tag', 'spender', 1);
  return { ...s, analyst };
}

describe('业务知识面板', () => {
  it('分析师在指标详情页加 / 停用别名、存 / 清空业务说明、设置口径声明、新建主题并加入 / 移出，面板与目录立即反映；数据工程师与管理员同样能改，标签页也有面板', async () => {
    const { acme, analyst } = await setup();
    const an = await loginAs(app, 'an@acme.com');
    const post = (form: Record<string, string>, path = METRIC) => an.post(path, { targetId: TARGET, ...form });

    let panel = await panelOf(an, METRIC);
    expect(panel).toContain('系统事实');
    expect(panel).toContain('sum(amount)');
    expect(panel).toContain('系统扫描尚未生成');
    expect(panel).toContain('还没有别名');
    for (const intent of ['alias.add', 'claim.save', 'note.save', 'subject.create']) expect(panel).toContain(`name="intent" value="${intent}"`);

    expect((await post({ intent: 'alias.add', alias: ' 近一年营收 ' })).status).toBe(302);
    expect((await post({ intent: 'claim.save', type: 'currency', value: 'CNY' })).status).toBe(302);
    expect((await post({ intent: 'note.save', note: '只算已支付' })).status).toBe(302);
    expect((await post({ intent: 'subject.create', name: '营收' })).status).toBe(302);
    const [subject] = await getDb().select().from(analysisSubjects).where(eq(analysisSubjects.tenantId, acme));

    panel = await panelOf(an, METRIC);
    expect(panel).toContain('data-alias="近一年营收"');
    expect(panel).toContain('data-claim="currency"');
    expect(panel).toContain('币种：人民币');
    expect(panel).toContain('data-note="只算已支付"');
    expect(panel).toContain(`data-member-of="${subject!.id}"`);
    expect(await knowledgeOf(acme)).toEqual({
      aliases: ['近一年营收'], claims: [{ type: 'currency', value: 'CNY' }], subjects: ['营收'], note: '只算已支付',
    });

    // 输入不合法：400，页面显示中文消息
    const bad = await post({ intent: 'alias.add', alias: '近一年营收' });
    expect(bad.status).toBe(400);
    expect(decode(await bad.text())).toContain('已有别名「近一年营收」');

    const [alias] = await getDb().select().from(knowledgeAliases).where(eq(knowledgeAliases.tenantId, acme));
    expect((await post({ intent: 'alias.retire', aliasId: alias!.id })).status).toBe(302);
    expect((await post({ intent: 'note.save', note: '' })).status).toBe(302);
    expect((await post({ intent: 'subject.remove', subjectId: subject!.id })).status).toBe(302);
    expect((await post({ intent: 'claim.save', type: 'currency', value: 'not_applicable' })).status).toBe(302);
    panel = await panelOf(an, METRIC);
    expect(panel).not.toContain('data-alias=');
    expect(panel).not.toContain('data-note=');
    expect(panel).not.toContain('data-member-of=');
    expect(panel).toContain('币种：不适用');
    expect(await knowledgeOf(acme)).toEqual({ claims: [{ type: 'currency', value: 'not_applicable' }] });

    // 已有的主题直接加入；数据工程师、管理员同样能改
    const other = await createSubject(analyst, '复购');
    const de = await loginAs(app, 'de@acme.com');
    expect((await de.post(METRIC, { targetId: TARGET, intent: 'subject.add', subjectId: other })).status).toBe(302);
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post(METRIC, { targetId: TARGET, intent: 'alias.add', alias: '年营收' })).status).toBe(302);
    expect(await knowledgeOf(acme)).toMatchObject({ aliases: ['年营收'], subjects: ['复购'] });

    // 标签页：系统事实是取值，表单同样在
    panel = await panelOf(an, TAG);
    expect(panel).toContain('high');
    expect(panel).toContain('name="intent" value="alias.add"');
    expect((await post({ intent: 'alias.add', alias: '高消费', targetId: 'tag:spender' }, TAG)).status).toBe(302);
    expect(await knowledgeOf(acme, 'tag:spender')).toEqual({ aliases: ['高消费'] });
  });

  it('查看者看得到同样的知识，没有编辑入口，提交 403', async () => {
    const { acme, analyst } = await setup();
    await addAlias(analyst, { targetId: TARGET, alias: '营收' });
    await saveBusinessNote(analyst, { targetId: TARGET, note: '只算已支付' });
    const viewer = await loginAs(app, 'view@acme.com');

    const panel = await panelOf(viewer, METRIC);
    expect(panel).toContain('data-alias="营收"');
    expect(panel).toContain('data-note="只算已支付"');
    expect(panel).not.toContain('name="intent"');
    expect(panel).not.toContain('<button');
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'alias.add', alias: '年营收' })).status).toBe(403);
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'note.save', note: '改掉' })).status).toBe(403);
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'claim.save', type: 'currency', value: 'CNY' })).status).toBe(403);
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'subject.create', name: '营收' })).status).toBe(403);
    expect(await knowledgeOf(acme)).toEqual({ aliases: ['营收'], note: '只算已支付' });
  });

  it('依据变了的别名、业务说明、口径声明显示「待复核」，口径声明显示原值；从未发布过的定义只提示发布后才能添加', async () => {
    const { reviewer, analyst } = await setup();
    await addAlias(analyst, { targetId: TARGET, alias: '营收' });
    await saveClaim(analyst, { targetId: TARGET, type: 'currency', value: 'CNY' });
    await saveBusinessNote(analyst, { targetId: TARGET, note: '只算已支付' });
    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_V2);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    await createDefinition(analyst, 'metric', 'draft_only', REVENUE);
    const an = await loginAs(app, 'an@acme.com');

    const panel = await panelOf(an, METRIC);
    expect(panel).toMatch(/data-alias="营收"[^>]*data-needs-review/);
    expect(panel).toContain('币种：未知（待复核，原为 人民币）');
    expect(panel).toMatch(/data-note="只算已支付"[^>]*data-needs-review/);
    expect(panel.match(/待复核/g)!.length).toBeGreaterThanOrEqual(3);

    const draft = await panelOf(an, '/analytics/definitions/metric/draft_only');
    expect(draft).toContain('发布后才能添加业务知识');
    expect(draft).not.toContain('name="intent"');
  });
});

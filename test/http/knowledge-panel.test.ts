// test/http/knowledge-panel.test.ts —— 业务知识面板（ADR-0046）的 HTTP 接缝：指标 / 标签详情页（analytics.definitions.$kind.$key）的面板显示系统事实与成员写的知识，
// 分析师、数据工程师、管理员提交 alias.* / claim.* / note.* / subject.* 后面板与目录（expand 的 knowledge）立即反映；查看者看得到、没有编辑入口、提交 403；
// 依据变了的知识显示「待复核」；从未发布过的定义只提示发布后才能添加；待确认的知识提案可以接受、修改后接受、拒绝（理由必填），已处理或依据已变化时 409、显示错误
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
import { proposeKnowledge, type ProposalInput } from '../../app/.server/knowledge/proposals';
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

const propose = (tenantId: string, input: Pick<ProposalInput, 'kind' | 'content'>) => getDb().transaction(tx => proposeKnowledge(tx, tenantId, {
  targetId: TARGET, evidence: [{ ref: 'metric:paid_revenue', version: 1 }], generatorVersion: 'test-gen-1', ...input,
})).then(p => p!);

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

  it('待确认的提案显示种类、内容、证据，接受前不进知识区与目录；直接接受别名、改值后接受口径声明与业务说明，提案消失、知识区与目录是改后的值', async () => {
    const { acme } = await setup();
    const alias = await propose(acme, { kind: 'alias', content: { alias: '流水' } });
    const claim = await propose(acme, { kind: 'claim', content: { type: 'currency', value: 'USD' } });
    const note = await propose(acme, { kind: 'note', content: { note: '含退款' } });
    const an = await loginAs(app, 'an@acme.com');
    const post = (form: Record<string, string>) => an.post(METRIC, { targetId: TARGET, ...form });

    let panel = await panelOf(an, METRIC);
    expect(panel).toContain('待确认的知识提案');
    expect(panel).toContain('待确认');
    for (const p of [alias, claim, note]) expect(panel).toContain(`data-proposal="${p.id}"`);
    expect(panel).toContain('别名：流水');
    expect(panel).toContain('口径声明：币种：美元');
    expect(panel).toContain('业务说明：含退款');
    expect(panel).toContain('metric:paid_revenue v1');
    for (const intent of ['proposal.accept', 'proposal.acceptEdited', 'proposal.reject']) expect(panel).toContain(`name="intent" value="${intent}"`);
    expect(panel).not.toContain('data-alias=');
    expect(panel).not.toContain('data-note=');
    expect(await knowledgeOf(acme)).toBeUndefined();

    expect((await post({ intent: 'proposal.accept', proposalId: alias.id })).status).toBe(302);
    panel = await panelOf(an, METRIC);
    expect(panel).not.toContain(`data-proposal="${alias.id}"`);
    expect(panel).toContain('data-alias="流水"');
    expect(await knowledgeOf(acme)).toEqual({ aliases: ['流水'] });

    expect((await post({ intent: 'proposal.acceptEdited', proposalId: claim.id, kind: 'claim', type: 'currency', value: 'CNY' })).status).toBe(302);
    expect((await post({ intent: 'proposal.acceptEdited', proposalId: note.id, kind: 'note', note: '不含退款' })).status).toBe(302);
    panel = await panelOf(an, METRIC);
    expect(panel).not.toContain('data-proposal=');
    expect(panel).not.toContain('待确认的知识提案');
    expect(panel).toContain('币种：人民币');
    expect(panel).toContain('data-note="不含退款"');
    expect(await knowledgeOf(acme)).toEqual({ aliases: ['流水'], claims: [{ type: 'currency', value: 'CNY' }], note: '不含退款' });

    // 别名也能改词后接受
    const other = await propose(acme, { kind: 'alias', content: { alias: '营业额' } });
    expect((await post({ intent: 'proposal.acceptEdited', proposalId: other.id, kind: 'alias', alias: '年营业额' })).status).toBe(302);
    expect((await knowledgeOf(acme))?.aliases).toEqual(expect.arrayContaining(['年营业额', '流水']));
  });

  it('拒绝要填理由，拒绝后提案消失、目录不变；已处理或依据已变化时接受 409 并显示错误；查看者没有处理入口，提交 403', async () => {
    const { acme, reviewer, analyst } = await setup();
    const alias = await propose(acme, { kind: 'alias', content: { alias: '流水' } });
    const an = await loginAs(app, 'an@acme.com');
    const post = (form: Record<string, string>) => an.post(METRIC, { targetId: TARGET, ...form });

    const empty = await post({ intent: 'proposal.reject', proposalId: alias.id, reason: '  ' });
    expect(empty.status).toBe(400);
    expect(decode(await empty.text())).toContain('请填写拒绝理由');
    expect(await panelOf(an, METRIC)).toContain(`data-proposal="${alias.id}"`);

    expect((await post({ intent: 'proposal.reject', proposalId: alias.id, reason: '不是这个意思' })).status).toBe(302);
    expect(await panelOf(an, METRIC)).not.toContain(`data-proposal="${alias.id}"`);
    expect(await knowledgeOf(acme)).toBeUndefined();

    const handled = await post({ intent: 'proposal.accept', proposalId: alias.id });
    expect(handled.status).toBe(409);
    expect(decode(await handled.text())).toMatch(/role="alert"[^>]*>[^<]+</);

    const stale = await propose(acme, { kind: 'note', content: { note: '含退款' } });
    await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_V2);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    const changed = await post({ intent: 'proposal.accept', proposalId: stale.id });
    expect(changed.status).toBe(409);
    expect(decode(await changed.text())).toContain('依据已变化');
    expect(await knowledgeOf(acme)).toBeUndefined();

    const viewer = await loginAs(app, 'view@acme.com');
    const panel = await panelOf(viewer, METRIC);
    expect(panel).toContain(`data-proposal="${stale.id}"`);
    expect(panel).not.toContain('name="intent"');
    expect(panel).not.toContain('<button');
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'proposal.accept', proposalId: stale.id })).status).toBe(403);
    expect((await viewer.post(METRIC, { targetId: TARGET, intent: 'proposal.reject', proposalId: stale.id, reason: 'x' })).status).toBe(403);
  });
});

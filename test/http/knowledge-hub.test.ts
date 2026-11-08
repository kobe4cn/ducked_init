// test/http/knowledge-hub.test.ts —— 业务知识集中页 /knowledge（ADR-0046）的 HTTP 接缝：按分析主题分组列出待确认提案数与缺失项（金额字段的单位与币种、指标的单位），
// 「未声明」与「未知」分开写，没有主题的条目进「未归入主题」组；?item= 在本页展开同一个业务知识面板，处理后 302 回原 URL、列表随之更新；查看者只读、提交 403；
// 主题组的「生成建议」按钮按主题同步生成提案（#513），302 回集中页带计数，未配置模型服务 409
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { saveClaim } from '../../app/.server/knowledge/claims';
import { proposeKnowledge, type ProposalInput } from '../../app/.server/knowledge/proposals';
import { addMembership, createSubject } from '../../app/.server/knowledge/subjects';
import { memberOf } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeLlm, json, platformDefault } from '../pipeline/llm-fixtures';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const TARGET = 'metric:paid_revenue';
const AMOUNT = 'field:order.amount';
const ITEM = `/knowledge?item=${encodeURIComponent(TARGET)}`;

const decode = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const pageOf = async (browser: Awaited<ReturnType<typeof loginAs>>, path = '/knowledge') => decode(await (await browser.get(path)).text());
/** 页面里的一组（data-hub-group 的 section） */
const groupOf = (html: string, subject: string) =>
  html.match(new RegExp(`<section[^>]*data-hub-group="${subject}"[\\s\\S]*?</section>`))?.[0] ?? '';
/** 组里的一个条目（data-hub-item 的 li） */
const itemOf = (group: string, targetId: string) =>
  group.match(new RegExp(`<li[^>]*data-hub-item="${targetId}"[\\s\\S]*?</li>`))?.[0] ?? '';
/** 页顶统计卡（StatTile）里 label 后面的数值 */
const statOf = (html: string, label: string) => html.match(new RegExp(`>${label}</div><div[^>]*>(\\d+)</div>`))?.[1];
const panelOf = (html: string, targetId: string) =>
  html.match(new RegExp(`<section[^>]*data-knowledge-panel="${targetId}"[\\s\\S]*?</section>`))?.[0] ?? '';

const propose = (tenantId: string, input: Pick<ProposalInput, 'kind' | 'content'>) => getDb().transaction(tx => proposeKnowledge(tx, tenantId, {
  targetId: TARGET, evidence: [{ ref: TARGET, version: 1 }], generatorVersion: 'test-gen-1', ...input,
})).then(p => p!);

/** 模型替身返回的一批提案：给主题条目 metric:paid_revenue 提别名 / 口径 / 说明，把邻接条目 entity:order 归入主题（照 pipeline/knowledge-suggest-run 的写法） */
const modelOutput = () => ({ proposals: [
  { kind: 'alias', targetId: TARGET, alias: '流水暗号', evidence: [{ ref: 'entity:order' }], reason: '常用叫法' },
  { kind: 'claim', targetId: TARGET, claim: { type: 'currency', value: 'CNY' }, evidence: [], reason: '币种' },
  { kind: 'note', targetId: TARGET, note: '只算实付金额', evidence: [{ ref: 'entity:order' }], reason: '口径说明' },
  { kind: 'subject', targetId: 'entity:order', evidence: [{ ref: TARGET }], reason: '订单在主题里' },
] });

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue（sum(amount)，系统单位未知） */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  return { ...s, analyst };
}

describe('业务知识集中页', () => {
  it('按主题分组列出待确认提案数与缺失项，没有主题的进「未归入主题」；未声明与未知分开写，不适用与具体值不算缺失', async () => {
    const { acme, analyst } = await setup();
    const subject = await createSubject(analyst, '营收');
    await addMembership(analyst, subject, TARGET);
    await addMembership(analyst, await createSubject(analyst, '订单'), TARGET);
    await propose(acme, { kind: 'alias', content: { alias: '流水' } });
    const an = await loginAs(app, 'an@acme.com');

    let html = await pageOf(an);
    expect(html).toContain('业务知识');
    // 指标同属「订单」「营收」两组（1 条提案、单位 1 个缺失，按条目只算一次）；未归入主题：order.amount 的单位、币种 2 个缺失
    expect(statOf(html, '待确认提案')).toBe('1');
    expect(statOf(html, '缺失项')).toBe('3');
    expect(statOf(html, '有条目的主题')).toBe('2');
    expect(itemOf(groupOf(html, '订单'), TARGET)).toContain('1 条待确认');
    expect(html.indexOf('data-hub-group="订单"')).toBeLessThan(html.indexOf('data-hub-group="营收"'));
    const revenue = groupOf(html, '营收');
    expect(revenue).toContain('1 条待确认提案');
    expect(revenue).toContain('1 个缺失项');
    let item = itemOf(revenue, TARGET);
    expect(item).toContain(`href="${ITEM}"`);
    expect(item).toContain('1 条待确认');
    expect(item).toMatch(/data-missing="unit"[^>]*>[\s\S]*?单位：未知/);
    expect(itemOf(groupOf(html, 'none'), TARGET)).toBe('');
    expect(html.indexOf('data-hub-group="营收"')).toBeLessThan(html.indexOf('data-hub-group="none"'));

    const none = groupOf(html, 'none');
    expect(none).toContain('未归入主题');
    item = itemOf(none, AMOUNT);
    expect(item).toMatch(/data-missing="unit"[^>]*>[\s\S]*?单位：未声明/);
    expect(item).toMatch(/data-missing="currency"[^>]*>[\s\S]*?币种：未声明/);
    expect(item).not.toContain('待确认');

    await saveClaim(analyst, { targetId: AMOUNT, type: 'currency', value: 'unknown' });
    await saveClaim(analyst, { targetId: AMOUNT, type: 'unit', value: 'not_applicable' });
    html = await pageOf(an);
    item = itemOf(groupOf(html, 'none'), AMOUNT);
    expect(item).toMatch(/data-missing="currency"[^>]*>[\s\S]*?币种：未知/);
    expect(statOf(html, '缺失项')).toBe('2');
    expect(item).not.toContain('data-missing="unit"');

    await saveClaim(analyst, { targetId: AMOUNT, type: 'currency', value: 'CNY' });
    html = await pageOf(an);
    expect(html).not.toContain(`data-hub-item="${AMOUNT}"`);
    expect(html).toContain(`data-hub-item="${TARGET}"`);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('点开条目在本页展开同一个面板；接受提案、声明单位后 302 回原 URL，列表随之更新；重复别名 400 错误在面板里；查看者只读、提交 403', async () => {
    const { acme, analyst } = await setup();
    await addAlias(analyst, { targetId: TARGET, alias: '营收' });
    const alias = await propose(acme, { kind: 'alias', content: { alias: '流水' } });
    const an = await loginAs(app, 'an@acme.com');

    let html = await pageOf(an, ITEM);
    let panel = panelOf(html, TARGET);
    expect(panel).toContain(`data-proposal="${alias.id}"`);
    expect(panel).toContain('name="intent" value="claim.save"');
    expect(panelOf(await pageOf(an), TARGET)).toBe('');
    expect(panelOf(await pageOf(an, '/knowledge?item=metric%3Anope'), 'metric:nope')).toBe('');

    // 查看者
    const viewer = await loginAs(app, 'view@acme.com');
    html = await pageOf(viewer, ITEM);
    expect(html).toContain(`data-hub-item="${TARGET}"`);
    panel = panelOf(html, TARGET);
    expect(panel).toContain(`data-proposal="${alias.id}"`);
    expect(panel).not.toContain('name="intent"');
    expect(panel).not.toContain('<button');
    expect((await viewer.post(ITEM, { targetId: TARGET, intent: 'proposal.accept', proposalId: alias.id })).status).toBe(403);
    expect((await viewer.post(ITEM, { targetId: TARGET, intent: 'claim.save', type: 'unit', value: 'currency_major' })).status).toBe(403);

    const dup = await an.post(ITEM, { targetId: TARGET, intent: 'alias.add', alias: '营收' });
    expect(dup.status).toBe(400);
    expect(panelOf(decode(await dup.text()), TARGET)).toMatch(/role="alert"[^>]*>[^<]*已有别名「营收」/);
    expect((await an.post(ITEM, { intent: 'nope' })).status).toBe(400);

    let res = await an.post(ITEM, { targetId: TARGET, intent: 'proposal.accept', proposalId: alias.id });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ITEM);
    html = await pageOf(an, ITEM);
    const item = itemOf(groupOf(html, 'none'), TARGET);
    expect(item).toContain('data-missing="unit"');
    expect(item).not.toContain('待确认');

    res = await an.post(ITEM, { targetId: TARGET, intent: 'claim.save', type: 'unit', value: 'currency_major' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ITEM);
    html = await pageOf(an, ITEM);
    expect(html).not.toContain(`data-hub-item="${TARGET}"`);
    expect(panelOf(html, TARGET)).toContain('data-claim="unit"');
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），还有 2 次登录与约 14 次请求，4 个 worker 并行时超过默认的 90 s

  it('主题组有「生成建议」按钮（「未归入主题」组没有）：提交 302 回集中页带计数，组里待确认数增加、页顶提示新建与跳过；再点提示已生成过；未配置模型服务 409、没有这个主题 400；查看者没有按钮、提交 403', async () => {
    const { analyst } = await setup();
    const subjectId = await createSubject(analyst, '营收');
    await addMembership(analyst, subjectId, TARGET);
    const an = await loginAs(app, 'an@acme.com');

    let html = await pageOf(an);
    expect(groupOf(html, '营收')).toContain('name="intent" value="suggest"');
    expect(groupOf(html, 'none')).not.toContain('<form');

    platformDefault();
    fakeLlm(f => app.setLlmFetch(f), () => json(modelOutput()));
    let res = await an.post('/knowledge', { intent: 'suggest', subjectId });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(decodeURIComponent(location)).toBe('/knowledge?suggested=营收&created=4&skipped=0');
    html = await pageOf(an, location);
    expect(html).toContain('主题「营收」新建 4 条提案，跳过 0 条');
    // 模型给了 metric:paid_revenue 三条（别名 / 口径 / 说明），归入主题的那条目标是 entity:order、不在「营收」组
    expect(statOf(html, '待确认提案')).toBe('4');
    expect(groupOf(html, '营收')).toContain('3 条待确认提案');
    expect(itemOf(groupOf(html, '营收'), TARGET)).toContain('3 条待确认');
    expect(itemOf(groupOf(html, 'none'), 'entity:order')).toContain('1 条待确认');
    expect(groupOf(html, '营收')).toContain('name="intent" value="suggest"');

    // 同样的输入与生成器版本已经生成过：不调模型，提示没有新提案
    res = await an.post('/knowledge', { intent: 'suggest', subjectId });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toBe('/knowledge?suggested=营收&fresh=0');
    html = await pageOf(an, res.headers.get('location')!);
    expect(html).toContain('主题「营收」已按当前内容生成过，没有新提案');

    // 未配置模型服务：409 的中文错误显示在页顶
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');
    const unconfigured = await an.post('/knowledge', { intent: 'suggest', subjectId });
    expect(unconfigured.status).toBe(409);
    expect(decode(await unconfigured.text())).toMatch(/role="alert"[^>]*>[\s\S]*?未配置模型服务/);
    const missing = await an.post('/knowledge', { intent: 'suggest', subjectId: 'nope' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('没有这个主题');

    // 查看者看不到按钮，直接提交 403
    const viewer = await loginAs(app, 'view@acme.com');
    html = await pageOf(viewer);
    expect(html).not.toContain('name="intent" value="suggest"');
    expect(html).not.toContain('生成建议');
    expect((await viewer.post('/knowledge', { intent: 'suggest', subjectId })).status).toBe(403);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），还有 2 次登录、1 次模型替身与约 10 次请求，4 个 worker 并行时超过默认的 90 s
});

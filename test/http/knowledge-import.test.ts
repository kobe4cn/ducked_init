// test/http/knowledge-import.test.ts —— 知识粘贴导入页 /knowledge/import 与来源原文页 /knowledge/sources/:id（ADR-0046 入口③，#527）的 HTTP 接缝：
// 分析师粘贴标题、种类与正文提交后保存来源并调模型解析，302 回集中页带计数（跳过 = 已有 + 拒绝过 + 不合法 + 依据已变）、页顶提示《标题》与新提案；
// 查看者打不开导入页（GET / POST 都 403）、集中页没有入口；未配置模型服务 409 时页面原地显示错误、带回已填的值与来源页链接；
// 来源页按段渲染（段落带 p<段号> 锚点、段前显示段号），有 definitions:read 就能看，非 UUID / 不存在 400，?v= 与当前版本不同时提示段号可能对不上；
// 知识面板里 source:<id>#p<段号> 证据渲染成指向来源页对应段落的链接（?v=<证据版本>#p<段号>），非 source 证据仍是纯文本
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { knowledgeSources } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { saveKnowledgeSource } from '../../app/.server/knowledge/sources';
import { proposeKnowledge } from '../../app/.server/knowledge/proposals';
import { memberOf } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeLlm, json, platformDefault } from '../pipeline/llm-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const TARGET = 'metric:paid_revenue';
const TITLE = '指标口径文档';
/** 三段的指标说明：段号 1–3，模型输出的证据都指这三段 */
const BODY = '订单实付金额的口径说明。\n\n金额字段 amount 存的是人民币（元）。\n\n销售管实付金额叫「成交额」。';

const decode = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const pageOf = async (browser: Awaited<ReturnType<typeof loginAs>>, path = '/knowledge') => decode(await (await browser.get(path)).text());
const statOf = (html: string, label: string) => html.match(new RegExp(`>${label}</div><div[^>]*>(\\d+)</div>`))?.[1];
const panelOf = (html: string, targetId: string) =>
  html.match(new RegExp(`<section[^>]*data-knowledge-panel="${targetId}"[\\s\\S]*?</section>`))?.[0] ?? '';
/** 本租户当前唯一的知识来源（粘贴导入只建一条时用） */
const theSource = async (tenantId: string) =>
  (await getDb().select().from(knowledgeSources).where(eq(knowledgeSources.tenantId, tenantId)))[0]!;

/** 模型替身返回的一批提案（照 pipeline/knowledge-import.test.ts）：给 metric:paid_revenue 提口径与别名、给 entity:order 提说明，证据指三段 */
const modelOutput = () => ({ proposals: [
  { kind: 'claim', targetId: TARGET, claim: { type: 'currency', value: 'CNY' }, evidence: [{ paragraph: 2 }], reason: '文档说金额是人民币' },
  { kind: 'alias', targetId: TARGET, alias: '成交额', evidence: [{ paragraph: 3 }], reason: '销售常用叫法' },
  { kind: 'note', targetId: 'entity:order', note: '订单表存下单与支付信息', evidence: [{ paragraph: 1 }], reason: '文档第一段' },
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

describe('知识粘贴导入页与来源原文页', () => {
  it('分析师在新页粘贴并提交：302 回集中页带计数，页顶提示与新提案都在；重复提交计入跳过；字数计数与「只粘贴元数据说明」的提示在页', async () => {
    const { acme, analyst } = await setup();
    const an = await loginAs(app, 'an@acme.com');

    let html = await pageOf(an, '/knowledge/import');
    expect(html).toContain('粘贴导入');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="kind"');
    expect(html).toContain('name="body"');
    expect(html).toContain('已输入 0 / 20000 字');
    expect(html).toContain('只粘贴元数据说明');

    platformDefault();
    fakeLlm(f => app.setLlmFetch(f), () => json(modelOutput()));
    const res = await an.post('/knowledge/import', { title: TITLE, kind: 'metric', body: BODY });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get('location')!)).toBe(`/knowledge?imported=${TITLE}&created=3&skipped=0`);

    html = await pageOf(an, res.headers.get('location')!);
    expect(html).toContain(`已从《${TITLE}》新建 3 条提案，跳过 0 条`);
    expect(statOf(html, '待确认提案')).toBe('3');
    expect(html).toContain('href="/knowledge/import"');

    // 同样内容再提交：模型再调一次，重复提案按指纹计跳过
    const again = await an.post('/knowledge/import', { title: TITLE, kind: 'metric', body: BODY });
    expect(again.status).toBe(302);
    expect(decodeURIComponent(again.headers.get('location')!)).toBe(`/knowledge?imported=${TITLE}&created=0&skipped=3`);

    // 校验失败的提交（空正文）原地 400 带回已填的值
    const bad = await an.post('/knowledge/import', { title: TITLE, kind: 'metric', body: '' });
    expect(bad.status).toBe(400);
    const badHtml = decode(await bad.text());
    expect(badHtml).toMatch(/role="alert"[^>]*>[\s\S]*?请先粘贴来源原文/);
    expect(badHtml).toContain(`value="${TITLE}"`);

    const source = await theSource(acme);
    expect(source.title).toBe(TITLE);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('查看者打不开导入页：GET 与 POST 都 403，集中页没有「粘贴导入」入口', async () => {
    await setup();
    const viewer = await loginAs(app, 'view@acme.com');
    expect((await viewer.get('/knowledge/import')).status).toBe(403);
    expect((await viewer.post('/knowledge/import', { title: TITLE, kind: 'metric', body: BODY })).status).toBe(403);
    const html = await pageOf(viewer);
    expect(html).not.toContain('href="/knowledge/import"');
    expect(html).not.toContain('粘贴导入');
  }, 180_000); // 每个用例都跑 publishedIdentitySources，4 个 worker 并行时超过默认的 90 s

  it('未配置模型服务 409：页面原地显示错误、带回已填的值与种类，来源已保存、给出来源页链接', async () => {
    const { acme } = await setup();
    const an = await loginAs(app, 'an@acme.com');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');

    const res = await an.post('/knowledge/import', { title: TITLE, kind: 'metric', body: BODY });
    expect(res.status).toBe(409);
    const html = decode(await res.text());
    expect(html).toMatch(/role="alert"[^>]*>[\s\S]*?未配置模型服务/);
    expect(html).toContain(`value="${TITLE}"`);
    expect(html).toContain('订单实付金额的口径说明。');
    expect(html).toMatch(/<option[^>]*value="metric"[^>]*selected/);

    // 来源已保存（保存不调模型），给出来源页链接，成员可以直接去看原文再重试
    const source = await theSource(acme);
    expect(source.title).toBe(TITLE);
    expect(html).toContain(`href="/knowledge/sources/${source.id}"`);
  }, 180_000); // 每个用例都跑 publishedIdentitySources，4 个 worker 并行时超过默认的 90 s

  it('来源页按段显示、段落有锚点与段号：有 definitions:read 就能看（查看者可以），非 UUID 与不存在的来源 400', async () => {
    const { analyst } = await setup();
    const saved = await saveKnowledgeSource(analyst, { title: TITLE, kind: 'metric', body: BODY });
    const viewer = await loginAs(app, 'view@acme.com');

    const res = await viewer.get(`/knowledge/sources/${saved.id}`);
    expect(res.status).toBe(200);
    const html = decode(await res.text());
    expect(html).toContain(TITLE);
    expect(html).toContain('指标说明'); // 种类中文名
    expect(html).toContain('第 1 版');
    expect(html).toContain('id="p1"');
    expect(html).toContain('id="p2"');
    expect(html).toContain('id="p3"');
    expect(html).toContain('¶1');
    expect(html).toContain('¶2');
    expect(html).toContain('金额字段 amount 存的是人民币（元）。');
    expect(html).not.toContain('段号可能对不上'); // 没带 ?v= 时不提示

    expect((await viewer.get('/knowledge/sources/not-a-uuid')).status).toBe(400);
    expect((await viewer.get('/knowledge/sources/00000000-0000-0000-0000-000000000000')).status).toBe(400);
  }, 180_000); // 每个用例都跑 publishedIdentitySources，4 个 worker 并行时超过默认的 90 s

  it('知识面板里的 source: 证据渲染成指向来源页对应段落的链接（带证据版本），非 source 证据仍是纯文本', async () => {
    const { acme, analyst } = await setup();
    // 一条非 source 证据的提案（知识面板既有样子，不能被改掉）
    await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: TARGET, evidence: [{ ref: TARGET, version: 1 }], generatorVersion: 'test-gen-1',
      kind: 'alias', content: { alias: '流水' },
    }));
    const an = await loginAs(app, 'an@acme.com');

    platformDefault();
    fakeLlm(f => app.setLlmFetch(f), () => json(modelOutput()));
    const res = await an.post('/knowledge/import', { title: TITLE, kind: 'metric', body: BODY });
    expect(res.status).toBe(302);
    const source = await theSource(acme);

    const html = await pageOf(an, `/knowledge?item=${encodeURIComponent(TARGET)}`);
    const panel = panelOf(html, TARGET);
    expect(panel).toContain(`href="/knowledge/sources/${source.id}?v=1#p2"`);
    expect(panel).toContain(`href="/knowledge/sources/${source.id}?v=1#p3"`);
    expect(panel).toContain(`source:${source.id}#p2 v1`);
    // 非 source 证据仍是纯文本：显示文字但不包在链接里
    expect(panel).toContain('metric:paid_revenue v1');
    expect(panel).not.toMatch(new RegExp(`<a[^>]*>[^<]*metric:paid_revenue v1[\\s\\S]*?</a>`));

    // 来源页链接打得开且落得到对应段落
    expect((await an.get(`/knowledge/sources/${source.id}?v=1`)).status).toBe(200);
  }, 180_000); // 每个用例都跑 publishedIdentitySources，4 个 worker 并行时超过默认的 90 s

  it('来源页 ?v= 与当前版本不同时提示「证据来自旧版，段号可能对不上」，相同时不提示', async () => {
    const { analyst } = await setup();
    const v1 = await saveKnowledgeSource(analyst, { title: TITLE, kind: 'metric', body: BODY });
    const v2 = await saveKnowledgeSource(analyst, { title: TITLE, kind: 'metric', body: `${BODY}\n\n补充：退货不算流水。` });
    expect(v2.version).toBe(2);
    const an = await loginAs(app, 'an@acme.com');

    const stale = decode(await (await an.get(`/knowledge/sources/${v1.id}?v=1`)).text());
    expect(stale).toContain('证据来自 v1，原文已更新到 v2，段号可能对不上');
    const fresh = decode(await (await an.get(`/knowledge/sources/${v1.id}?v=2`)).text());
    expect(fresh).toContain('补充：退货不算流水。');
    expect(fresh).not.toContain('段号可能对不上');
  }, 180_000); // 每个用例都跑 publishedIdentitySources，4 个 worker 并行时超过默认的 90 s
});

// test/http/i18n-knowledge-pages.test.ts —— 知识库三个页面接入双语后的整页断言（#1048，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下 /knowledge、/knowledge/import 与 /knowledge/sources/:id
// 写死的文字没有汉字：口径类型与状态（Unit: Not declared、Currency: Not declared）、知识源种类（Metric notes）与
// 更新时间的英文格式；中文界面下三页的原中文（单位：未声明、指标说明、更新于 …）都还在（验收标准 2）。
// 指标描述、来源标题与正文等数据值不翻，夹具全 ASCII；标准模型的字段名「实付金额」是数据，断言前换成 ASCII；只 GET 页面不写库，夹具共用一次 setup
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { saveKnowledgeSource } from '../../app/.server/knowledge/sources';
import { memberOf } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
afterEach(() => { vi.unstubAllEnvs(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: paid amount\n';
const TARGET = 'metric:paid_revenue';
const AMOUNT = 'field:order.amount';
const TITLE = 'revenue metric notes';
const BODY = 'amount is in CNY (yuan).\n\nsales calls it gross revenue.';

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换表单的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 再把作为数据传入的目录条目名替换成 ASCII：order.amount 的中文名「实付金额」是标准模型的字段名（租户可见的展示名，不经本页翻译） */
const strip = (html: string) => stripScripts(html).replaceAll('实付金额', 'amount paid');

/** 页顶统计卡（StatTile）里 label 后面的数值 */
const statOf = (html: string, label: string) => html.match(new RegExp(`>${label}</div><div[^>]*>(\\d+)</div>`))?.[1];

let an: Awaited<ReturnType<typeof loginAs>>;
let sourceId: string;
// 共用一次 setup（publishedIdentitySources 很慢）：发布指标 paid_revenue（系统单位未知）、order.amount 带两条未声明的缺失口径，另存一份英文种类的知识来源
beforeAll(async () => {
  await resetDb();
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  sourceId = (await saveKnowledgeSource(analyst, { title: TITLE, kind: 'metric', body: BODY })).id;
  an = await loginAs(app, 'an@acme.com');
}, 180_000);

describe('英文界面：知识库三个页面', () => {
  it('/knowledge 写死的文字没有汉字：缺失口径的类型与状态、统计卡与「未归入主题」组都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    an.store('crm_locale=en; Path=/');
    const html = strip(await (await an.get('/knowledge')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Business Knowledge');
    expect(html).toContain('Not in a subject');
    // 口径类型与状态显示英文：字段的单位、币种未声明，指标的系统单位未知
    expect(html).toMatch(new RegExp(`data-missing="unit"[^>]*>[\\s\\S]*?Unit: Not declared`));
    expect(html).toMatch(new RegExp(`data-missing="currency"[^>]*>[\\s\\S]*?Currency: Not declared`));
    expect(html).toMatch(new RegExp(`data-hub-item="${AMOUNT}"[\\s\\S]*?Field[\\s\\S]*?${AMOUNT}`));
    expect(html).toMatch(new RegExp(`data-hub-item="${TARGET}"[\\s\\S]*?Metrics`));
    expect(html).toContain('>Proposals to confirm</div>');
    expect(html).toContain('>Missing claims</div>');
    expect(html).toContain('>Subjects with entries</div>');
  });

  it('/knowledge/import 写死的文字没有汉字：表单、种类选项（英文）与字数提示都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    an.store('crm_locale=en; Path=/');
    const html = strip(await (await an.get('/knowledge/import')).text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Paste import · Business Knowledge · CRM Data Analytics Platform');
    expect(html).toContain('Data dictionary</option>');
    expect(html).toContain('Metric notes</option>');
    expect(html).toContain('SQL</option>');
    expect(html).toContain('Save and parse');
    expect(html).toContain('0 / 20000 characters');
  });

  it('/knowledge/sources/:id 写死的文字没有汉字：种类、版本与更新时间（英文格式）都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    an.store('crm_locale=en; Path=/');
    const html = strip(await (await an.get(`/knowledge/sources/${sourceId}`)).text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain(`${TITLE} · Source text · CRM Data Analytics Platform`);
    // 知识源种类经 builtinName、更新时间按英文格式（zh-CN 是 2026/11/22 14:30:00 的 24 小时制）
    expect(html).toContain('Metric notes · Version 1 · Updated ');
    expect(html).toMatch(/Updated \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/);
  });
});

describe('中文界面：三页输出与改造前一致', () => {
  it('/knowledge 的口径类型、状态与统计卡仍是中文', async () => {
    const html = strip(await (await an.get('/knowledge')).text());
    expect(html).toMatch(new RegExp(`data-missing="unit"[^>]*>[\\s\\S]*?单位：未声明`));
    expect(html).toMatch(new RegExp(`data-missing="currency"[^>]*>[\\s\\S]*?币种：未声明`));
    expect(statOf(html, '待确认提案')).toBe('0');
    expect(statOf(html, '缺失项')).toBe('3');
    expect(html).toContain('未归入主题');
    expect(html).toContain('业务知识');
  });

  it('/knowledge/import 的表单与种类选项仍是中文', async () => {
    const html = strip(await (await an.get('/knowledge/import')).text());
    expect(html).toContain('粘贴导入 · 业务知识 · CRM 数据分析平台');
    expect(html).toContain('value="metric">指标说明</option>');
    expect(html).toContain('保存并解析');
    expect(html).toContain('已输入 0 / 20000 字');
  });

  it('/knowledge/sources/:id 的种类与更新时间仍是中文（zh-CN 格式）', async () => {
    const html = strip(await (await an.get(`/knowledge/sources/${sourceId}`)).text());
    expect(html).toContain(`${TITLE} · 来源原文 · CRM 数据分析平台`);
    expect(html).toMatch(/指标说明 · 第 1 版 · 更新于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
  });
});

// test/http/i18n-misc-pages.test.ts —— 模型调用页、敏感字段查看与登录验证页接入双语后的整页断言（#1047，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下三个页面写死的文字没有汉字——模型调用页（页头、统计卡、两张表、
// 分页、来源列；#1254 加「超时」表头与 ?tab=turns 的轮次表：视图 / 时间窗两组 tab、表头、发起人与分页都是英文，种入带 turn_id 的行才看得到表；
// 金额列来自服务端 formatCost，#1126 不在本票，夹具给用到的模型配好单价，金额列只剩数字）、
// 敏感字段查看页（表单、下拉选项与明文面板——标准实体名与字段名经 builtinName 显示英文）、未登录的登录验证页
// （无 token 与 POST 无效 token 的英文报错）；两份词典的英文值里没有 standard layer（统一 Silver layer）；
// 中文界面输出与改造前一致（抽查各页一句中文与 auth.verify 的中文报错）。源名、表名、明文与错误文字全 ASCII（数据值不翻）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { llmCalls, modelPrices } from '../../app/.server/db/schema';
import enClient from '../../app/i18n/en.client.json';
import enServer from '../../app/i18n/en.server.json';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

const ago = (days: number) => new Date(Date.now() - days * 86400_000);
/** 造一条调用记录（默认 connectivity，近 1 天） */
const call = (tenantId: string, over: Partial<typeof llmCalls.$inferInsert> = {}) =>
  getDb().insert(llmCalls).values({ tenantId, purpose: 'connectivity', model: 'm-fast', durationMs: 100, createdAt: ago(1), ...over });
/** 直接给模型配单价（numeric 列传字符串，照 test/http/llm-usage.test.ts 的 price()），不经过运营后台 */
const price = (model: string, inputPerMTok: string, outputPerMTok: string, currency: 'CNY' | 'USD') =>
  getDb().insert(modelPrices).values({ model, inputPerMTok, outputPerMTok, currency });

/** ASCII 的线索表：消费者实体 + 三个标准敏感字段（姓名、手机号、邮箱）+ 敏感扩展字段 x_wechat（明文是数据值，不翻） */
const LEADS = `
  CREATE TABLE shop.leads (id int PRIMARY KEY, full_name text, mobile text, mail text, wechat text, channel text);
  INSERT INTO shop.leads VALUES
    (1, 'Lead One', '+86 138-0000-0001', 'User1@Example.COM', 'wxid_lead1', 'store'),
    (2, 'Lead Two', '0086 13800000002', NULL, NULL, 'mall');
  GRANT SELECT ON shop.leads TO ${READER.user};`;

const LEADS_MAPPING = `model: 1
entity: customer
table: leads
fields:
  customer_id: concat('L', string(id))
  name: full_name
  phone: mobile
  email: mail
extensions:
  x_wechat: { type: string, expr: wechat, sensitive: true }
`;

/** 开通租户 acme，登记 ASCII 名字的电商库（加线索表）、同步进原始层，发布线索表的映射（敏感字段在标准层只有哈希） */
async function revealableLead() {
  const tenantId = await newTenant('acme');
  const author = await memberOf(tenantId, 'de@acme.com');
  const reviewer = await memberOf(tenantId, 'de2@acme.com');
  const input = await pgSourceInput(READER, 'shop-db');
  await grantOnSource(LEADS);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await syncSource(author, id);
  await drain();
  const mappingId = await publish(author, reviewer, id, LEADS_MAPPING);
  return { mappingId };
}

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

describe('英文界面：模型调用页', () => {
  it('写死的文字没有汉字：页头、统计卡（含来源卡）、两张表、分页与来源列；金额列配了单价只剩数字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const acme = await newTenant('acme');
    await price('m-fast', '2', '6', 'CNY');
    await price('m-reason', '1', '3', 'CNY');
    await call(acme, { promptTokens: 10, completionTokens: 5, durationMs: 100, schemaValid: true, source: 'tenant' });
    await call(acme, { purpose: 'mapping_draft', model: 'm-reason', promptTokens: 100, completionTokens: 50, durationMs: 400, schemaValid: false, error: 'HTTP 500 upstream broke', source: 'platform', turnId: crypto.randomUUID(), actorEmail: 'de@acme.com', cachedTokens: 3 });

    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await admin.get('/llm-usage?days=7')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    // 页头与时间窗标签
    expect(html).toContain('<title>Model Calls · CRM Data Analytics Platform</title>');
    expect(html).toContain('Last 7 days');
    // 统计卡：来源卡按租户 / 平台端点分开计数，错误卡的失败次数是 ICU 复数
    expect(html).toContain('Tenant 1 / Platform 1');
    expect(html).toContain('1 failure');
    // 两张表的表头（「超时」列 #1254）
    for (const head of ['Purpose</th>', 'Calls</th>', 'Avg latency</th>', 'P95 latency</th>', 'Schema pass rate</th>', 'Validation pass rate</th>', 'Errors</th>', 'Timeouts</th>', 'Amount</th>', 'Time</th>', 'Model</th>', 'Source</th>', 'Input tokens</th>', 'Output tokens</th>', 'Duration</th>', 'Schema</th>']) {
      expect(html).toContain(head);
    }
    // 明细里的 Schema 校验结果与分页
    expect(html).toContain('Passed');
    expect(html).toContain('Failed');
    expect(html).toContain('Page 1 of 1, 50 rows per page');
    // 金额列只剩数字（部分模型未配单价时 formatCost 会下发中文，归 #1126）
    expect(html).toContain('CNY');

    // 「按轮次」视图（#1254）：整页同样没有汉字（种入一条带 turn_id 的行，否则只看到空状态），
    // 视图与时间窗两组 tab、轮次表头、发起人与分页都是英文
    const turns = stripScripts(await (await admin.get('/llm-usage?days=7&tab=turns')).text());
    expect(turns).not.toMatch(/[一-鿿]/);
    expect(turns).toContain('By purpose');
    expect(turns).toContain('By turn');
    expect(turns).toContain('Last 30 days');
    for (const head of ['Started at</th>', 'Initiator</th>', 'Purpose</th>', 'Requests</th>', 'Tokens (input / output)</th>', 'Cached tokens</th>']) {
      expect(turns).toContain(head);
    }
    expect(turns).toContain('de@acme.com');
    expect(turns).toContain('Page 1 of 1, 50 rows per page');
  });
});

describe('英文界面：敏感字段查看页', () => {
  it('写死的文字没有汉字：表单、下拉选项（标准实体名与字段名显示英文）、明文面板', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { mappingId } = await revealableLead();
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');

    const page = stripScripts(await (await admin.get('/pii/reveal')).text());
    expect(page).not.toMatch(/[一-鿿]/);
    expect(page).toContain('<title>PII Reveal · CRM Data Analytics Platform</title>');
    // 下拉选项：源名、表名是数据；实体与字段是标准名，经 builtinName 显示英文（x_wechat 是扩展字段名，原样透传；
    // 文本里的双引号被 React 转义成 &quot;）
    expect(page).toContain('&quot;shop-db&quot; leads → Customer (Name, Phone, Email, x_wechat)');

    const res = await admin.post('/pii/reveal', { mappingId, key: '1', reason: 'complaint callback, verify contact' });
    expect(res.status).toBe(200);
    const html = stripScripts(await res.text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('&quot;shop-db&quot; leads → Customer, primary key id = 1.');
    expect(html).toContain('Lead One');
    for (const label of ['Name</td>', 'Phone</td>', 'Email</td>', 'x_wechat</td>']) expect(html).toContain(label);
  });
});

describe('英文界面：登录验证页（未登录）', () => {
  it('无 token 的页面与 POST 无效 token 的回显都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const client = app.client();
    client.store('crm_locale=en; Path=/');

    const html = stripScripts(await (await client.get('/auth/verify')).text());
    expect(html).toContain('lang="en"');
    expect(html).toContain('<title>Confirm Sign-in · CRM Data Analytics Platform</title>');
    expect(html).toContain('The Magic Link is invalid; request a new one.');
    expect(html).not.toMatch(/[一-鿿]/);

    const posted = stripScripts(await (await client.post('/auth/verify?token=bogus')).text());
    expect(posted).toContain('The Magic Link is invalid, expired, or already used; request a new one.');
    expect(posted).not.toMatch(/[一-鿿]/);
  });
});

describe('词典与中文界面', () => {
  it('两份词典的英文值里没有 standard layer（统一 Silver layer）', () => {
    for (const [file, dict] of [['en.client.json', enClient], ['en.server.json', enServer]] as const) {
      for (const [key, value] of Object.entries(dict)) expect(value, `${file} 的「${key}」`).not.toMatch(/standard.layer/i);
    }
  });

  it('中文界面：模型调用页抽查（页头说明、分页句、来源卡）与改造前一致', async () => {
    const acme = await newTenant('acme');
    await call(acme, { source: 'tenant' });
    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();
    expect(html).toContain('近 7 天本租户的模型调用：次数、token、耗时与质量（Schema 通过率、错误率）。「校验通过率」只统计映射草稿：通过 / 做了映射校验的生成，部分采用另计。');
    expect(html).toContain('租户 1 / 平台 0');
    expect(html).toContain('第 1 / 1 页，每页 50 条');
  });

  it('中文界面：敏感字段查看页抽查（页头说明、明文面板的一句与标准字段名）与改造前一致', async () => {
    const { mappingId } = await revealableLead();
    const admin = await loginAs(app, 'admin@acme.com');
    const page = await (await admin.get('/pii/reveal')).text();
    expect(page).toContain('标准层里的敏感字段只有哈希。确有需要时按源表主键从原始层读出一条记录的明文，每次解密都记入审计日志。');
    expect(page).toContain('「shop-db」leads → 消费者（姓名、手机号、邮箱、x_wechat）');
    const html = await (await admin.post('/pii/reveal', { mappingId, key: '1', reason: '客户投诉回访，需核对联系方式' })).text();
    expect(html).toContain('「shop-db」leads → 消费者，主键 id = 1。');
    expect(html).toContain('只在本页显示一次，离开或刷新后不再保留。');
  });

  it('中文界面：登录验证页的两种报错与改造前一致', async () => {
    const client = app.client();
    const html = await (await client.get('/auth/verify')).text();
    expect(html).toContain('登录链接无效，请重新申请。');
    const posted = await (await client.post('/auth/verify?token=bogus')).text();
    expect(posted).toContain('登录链接无效、已过期或已被使用，请重新申请。');
  });
});

// test/http/i18n-api-keys-model-provider.test.ts —— API Key 页与模型服务页接入双语后的整页断言（#1046，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下 Key 列表与模型服务页整页没有汉字，「接口说明」标签页只断言外壳
// （鉴权、参数表头与参数位置、必填 / 可选、错误表头——登记内容 api-docs.ts 留给 #1125，不做整页断言）；
// 两页 action 的未知操作 400 与模型服务页非法档位 400 走 formatServer 回显英文；中文界面下关键文字与时间格式（24 小时制）与改造前一致。
// Key 名与模型配置全 ASCII（数据不翻，整页断言不剔数据值）；pgvector 连通用 setPgvectorConnect 替身，不连真实地址
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setPgvectorConnect(undefined); vi.unstubAllEnvs(); });

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 开通租户 acme 并以管理员登录、切到英文界面 */
async function enAdmin() {
  const tenantId = await newTenant('acme');
  await memberOf(tenantId, 'admin@acme.com', 'admin');
  const admin = await loginAs(app, 'admin@acme.com');
  admin.store('crm_locale=en; Path=/');
  return admin;
}

/** 外部 pgvector 建连替身（不连真实地址）：全部成功，让保存写入 checked_at、页面显示「上次检查 …，连接正常」 */
const pgvectorOk = () => {
  app.setPgvectorConnect(() => ({ query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) }));
};

describe('英文界面：API Key 页', () => {
  it('Key 列表写死的文字没有汉字：创建表单、表头、数据范围与英文格式的创建时间（24 小时制）、从未使用', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const admin = await enAdmin();
    const created = await admin.post('/api-keys', { intent: 'create', name: 'marketing', scope: ['catalog', 'consumers', 'exports'], dataScope: 'all' });
    expect(created.status).toBe(200);
    const html = stripScripts(await (await admin.get('/api-keys')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    // 创建表单与列表
    expect(html).toContain('Create an API Key');
    expect(html).toContain('e.g. Marketing automation');
    for (const head of ['Name</th>', 'Prefix</th>', 'APIs</th>', 'Data</th>', 'Created by</th>', 'Created</th>', 'Last used</th>', 'Actions</th>']) {
      expect(html).toContain(head);
    }
    expect(html).toContain('Everything');
    expect(html).toContain('Never used');
    // 创建时间是英文格式（zh-CN 是 2026/11/22 10:30:00 这样的 24 小时制）
    expect(html).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
  });

  it('「接口说明」标签页的外壳是英文：鉴权、参数表头与参数位置、必填 / 可选、错误表头（登记内容是 #1125，不做整页断言）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const admin = await enAdmin();
    const html = stripScripts(await (await admin.get('/api-keys?tab=docs')).text());
    expect(html).toContain('API reference');
    expect(html).toContain('Authentication: ');
    // 参数表：标题、表头与位置取值（位置值是代码名 path / query / body 的页面文案）
    expect(html).toContain('>Parameters<');
    for (const head of ['Parameters</th>', 'Location</th>', 'Required</th>', 'Description</th>']) expect(html).toContain(head);
    for (const cell of ['>Path</td>', '>Query</td>', '>Request body</td>', '>Required</td>', '>Optional</td>']) expect(html).toContain(cell);
    // 成功响应与错误表的外壳
    expect(html).toContain('Success response example');
    expect(html).toContain('>Errors<');
    for (const head of ['Status code</th>', 'Response text (error field)</th>', 'When it occurs</th>']) expect(html).toContain(head);
    // 开头说明里的占位符（React 把文本里的 < > 转义成 &lt; &gt;）
    expect(html).toContain('&lt;platform URL&gt;');
  });

  it('action 的未知操作 400 回显英文，整页没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const admin = await enAdmin();
    const bad = await admin.request('/api-keys', { method: 'POST', body: new URLSearchParams({ intent: 'bogus' }) });
    expect(bad.status).toBe(400);
    const html = stripScripts(await bad.text());
    expect(html).toContain('Unknown operation');
    expect(html).not.toMatch(/[一-鿿]/);
  });
});

describe('英文界面：模型服务页', () => {
  it('整页没有汉字：页头、当前配置、向量检索与向量存储（英文格式的上次检查时间）、档位卡与脱敏样本开关', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const admin = await enAdmin();
    // 保存本租户的模型服务与一个档位（只填模型名，端点沿用），再保存外部 pgvector（替身连通，写入 checked_at）
    expect((await admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1/', model: 'deepseek-chat', apiKey: 'sk-tenant-secret-1234' })).status).toBe(302);
    expect((await admin.post('/model-provider', { intent: 'tier_save', tier: 'fast', model: 'qwen-fast', baseUrl: '', apiKey: '' })).status).toBe(302);
    pgvectorOk();
    expect((await admin.post('/model-provider', { intent: 'vector_store_save', vectorStore: 'pgvector', vectorStoreUrl: 'postgres://vector:sec%40ret@pg.example.com:5432/vectors' })).status).toBe(200);
    const html = stripScripts(await (await admin.get('/model-provider')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    // 当前配置与档位卡：租户配置、绑定的档位（端点沿用）
    // React 把文本里的 ' 转义成 &#x27;（下同）
    expect(html).toContain('Currently using this tenant&#x27;s configuration');
    expect(html).toContain('Model qwen-fast, endpoint inherits this tenant&#x27;s default');
    expect(html).toContain('Fast tier (fast)');
    // 向量存储：选型、状态行的英文格式时间（zh-CN 是 2026/11/22 10:30:00 这样的 24 小时制）
    expect(html).toContain('>External pgvector</span>');
    expect(html).toMatch(/Last checked \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
  });

  it('action 的两条报错是英文：未知操作 400、非法档位 400，整页回显都没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const admin = await enAdmin();
    const bad = await admin.request('/model-provider', { method: 'POST', body: new URLSearchParams({ intent: 'bogus' }) });
    expect(bad.status).toBe(400);
    const badHtml = stripScripts(await bad.text());
    expect(badHtml).toContain('Unknown operation');
    expect(badHtml).not.toMatch(/[一-鿿]/);
    const badTier = await admin.post('/model-provider', { intent: 'tier_save', tier: 'bogus', model: 'qwen-fast' });
    expect(badTier.status).toBe(400);
    const tierHtml = stripScripts(await badTier.text());
    expect(tierHtml).toContain('Tier must be fast or reasoning');
    expect(tierHtml).not.toMatch(/[一-鿿]/);
  });
});

describe('中文界面输出与改造前一致', () => {
  it('API Key 页：创建提示、表头、从未使用与 24 小时制的创建时间', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const admin = await loginAs(app, 'admin@acme.com');
    const created = await admin.post('/api-keys', { intent: 'create', name: '营销自动化', scope: ['catalog', 'consumers', 'exports'], dataScope: 'all' });
    const createdHtml = await created.text();
    expect(createdHtml).toContain('已创建「营销自动化」');
    expect(createdHtml).toContain('请现在复制并妥善保存。这把 Key 只展示这一次，平台不保存明文，之后无法再查看。');
    const list = await (await admin.get('/api-keys')).text();
    expect(list).toContain('创建 API Key');
    expect(list).toContain('每个外部系统各用一把，便于单独吊销。');
    expect(list).toContain('从未使用');
    expect(list).toMatch(/20\d{2}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
    expect(list).toContain('外部系统用 Authorization: Bearer &lt;Key&gt; 调用 /api/v1/ 下的接口。');
    const docs = await (await admin.get('/api-keys?tab=docs')).text();
    expect(docs).toContain('（&lt;平台地址&gt;、&lt;你的 API Key&gt;）');
  });

  it('模型服务页：当前配置、档位卡与上次检查的 24 小时制时间、非法档位报错仍是中文', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1/', model: 'deepseek-chat', apiKey: 'sk-tenant-secret-1234' })).status).toBe(302);
    expect((await admin.post('/model-provider', { intent: 'tier_save', tier: 'fast', model: 'qwen-fast', baseUrl: '', apiKey: '' })).status).toBe(302);
    pgvectorOk();
    expect((await admin.post('/model-provider', { intent: 'vector_store_save', vectorStore: 'pgvector', vectorStoreUrl: 'postgres://vector:sec%40ret@pg.example.com:5432/vectors' })).status).toBe(200);
    const html = await (await admin.get('/model-provider')).text();
    expect(html).toContain('当前使用本租户的配置');
    expect(html).toContain('快速档（fast）');
    expect(html).toContain('模型 qwen-fast，端点沿用本租户默认');
    expect(html).toMatch(/上次检查 20\d{2}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}，连接正常/);
    const badTier = await admin.post('/model-provider', { intent: 'tier_save', tier: 'bogus', model: 'qwen-fast' });
    expect(badTier.status).toBe(400);
    expect(await badTier.text()).toContain('档位须是 fast 或 reasoning');
  });
});

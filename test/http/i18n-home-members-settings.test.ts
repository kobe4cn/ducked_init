// test/http/i18n-home-members-settings.test.ts —— 首页、成员页与个人设置页接入双语后的整页断言（#1045，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下三页写死的文字没有汉字：角色名经 builtinName、能力名经对照表显示英文，
// 待发布行的类型名是英文单数、不可用原因是整句英文；成员页 / 设置页 intent=bogus 的 400 报错走 formatServer 也是英文；
// 中文界面下成员加入日期、令牌时间仍是 zh-CN 格式。
// 默认空间名「默认空间」是数据值（租户起的名不翻），断言前替换掉；其余数据（租户名、邮箱、定义 key、令牌名）都用 ASCII。
// confirm() 里的文字只存在于水合 script 里（SSR 不渲染事件处理器），整页断言看不到，由浏览器验收检查。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDefinition } from '../../app/.server/dsl-definitions';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换表单的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 再把作为数据传入的默认空间名替换成 ASCII（不翻的是租户起的名，不是页面上写死的文字） */
const stripData = (html: string) => stripScripts(html).replaceAll('默认空间', 'space');

describe('英文界面：首页、成员页与个人设置页', () => {
  it('管理员首页写死的文字没有汉字：页头角色名、待发布行的类型名（英文单数）与最后保存人、能力名都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const tenantId = await newTenant('acme');
    await createDefinition(await memberOf(tenantId, 'de@acme.com'), 'metric', 'order_count', 'base: order\nmeasure: { agg: count }\n');
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const html = stripData(await (await admin.get('/')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Current tenant · space · admin@acme.com (Admin)');
    expect(html).toContain('Awaiting your publish');
    expect(html).toContain('Metric · v1 · Last saved by de@acme.com');
    // 能力名（对照表）与区块说明
    expect(html).toContain('Invite members, change roles, and remove members');
    expect(html).toContain('View the Gold layer');
    expect(html).toContain('Your role is Admin.');
  });

  it('查看者首页写死的文字没有汉字：不可用原因是整句英文（角色名英文），没有「待你发布」区块', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'vi@acme.com', 'viewer');
    const viewer = await loginAs(app, 'vi@acme.com');
    viewer.store('crm_locale=en; Path=/');
    const html = stripData(await (await viewer.get('/')).text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Current tenant · space · vi@acme.com (Viewer)');
    expect(html).toContain('Only Admin can invite members, change roles, and remove members');
    expect(html).not.toContain('Awaiting your publish');
  });

  it('成员页写死的文字没有汉字：角色下拉显示英文、option value 不变，表头、邀请表单与日期都是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const html = stripData(await (await admin.get('/members')).text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Members · CRM Data Analytics Platform');
    for (const role of ['admin', 'data_engineer', 'analyst', 'viewer']) expect(html).toContain(`value="${role}"`);
    expect(html).toContain('Admin</option>');
    expect(html).toContain('Viewer</option>');
    for (const head of ['Email</th>', 'Role</th>', 'Joined</th>', 'Actions</th>']) expect(html).toContain(head);
    expect(html).toContain('Invite members');
    expect(html).toMatch(/>\d{1,2}\/\d{1,2}\/\d{4}</); // 加入日期是英文格式（zh-CN 是 2026/11/22）
  });

  it('个人设置页写死的文字没有汉字：签发提示、令牌表（表头、徽标、英文格式的时间）与吊销按钮', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const issued = await admin.post('/settings', { intent: 'create', name: 'my agent', days: '30', allowQuery: 'on' });
    expect(issued.status).toBe(200);
    expect(stripData(await issued.text())).toContain('Issued “my agent”');
    const html = stripData(await (await admin.get('/settings')).text());
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('My settings · CRM Data Analytics Platform');
    for (const head of ['Name</th>', 'Prefix</th>', 'Valid until</th>', 'Created</th>', 'Last used</th>', 'Actions</th>']) expect(html).toContain(head);
    expect(html).toContain('Can run queries');
    expect(html).toContain('Never used');
    expect(html).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/); // hour12:false 的英文时间（zh-CN 是 2026/11/22 14:30:00）
    expect(html).toContain('Revoke</button>');
  });

  it('成员页与设置页 intent=bogus 的 400 报错是英文，整页回显没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    for (const path of ['/members', '/settings']) {
      const bad = await admin.request(path, { method: 'POST', body: new URLSearchParams({ intent: 'bogus' }) });
      expect(bad.status).toBe(400);
      const badHtml = stripData(await bad.text());
      expect(badHtml).toContain('Unknown operation');
      expect(badHtml).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('中文界面输出与改造前一致', () => {
  it('成员加入日期与令牌时间仍是 zh-CN 格式（2026/11/22、2026/11/22 14:30:00 的 24 小时制）', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'de@acme.com', 'data_engineer');
    const admin = await loginAs(app, 'admin@acme.com');
    const members = await (await admin.get('/members')).text();
    expect(members).toMatch(/>\d{4}\/\d{1,2}\/\d{1,2}</);
    await admin.post('/settings', { intent: 'create', name: '我的 Claude Code', days: '30', allowQuery: 'on' });
    const settings = await (await admin.get('/settings')).text();
    expect(settings).toMatch(/\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
    expect(settings).toContain('可执行查询');
    expect(settings).toContain('从未使用');
  });
});

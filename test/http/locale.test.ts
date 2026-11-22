// test/http/locale.test.ts —— 界面语言的判断与切换（#945，ADR-0060）：账号 > cookie > 浏览器语言 > 中文
// 开关 CRM_ENABLE_EN_LOCALE 关闭时整站中文、切换接口 404；打开时按优先级判断，POST /locale 写 cookie 并同步到账号；
// 顶栏与导航整块翻译（#1012）：英文界面顶栏全英文、中文界面输出不变、子路由 404 时根 ErrorBoundary 英文
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { members } from '../../app/.server/db/schema';
import { Client, createOperator, createTenant, extractLink, loginAs, loginAsOperator, resetDb, startApp, type Mail, type TestApp } from './harness';

let app: TestApp;
const OPS_EMAIL = 'ops@platform.com';
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 申请 Magic Link 并等后台签发与发信完成 */
async function requestLink(browser: Client, email: string) {
  const res = await browser.post('/login', { email });
  await app.drain();
  return res;
}

/** 申请 Magic Link → 从邮件里挑指定租户那一行 → 打开链接 → 确认登录 */
async function loginToTenant(browser: Client, email: string, tenantName: string) {
  await requestLink(browser, email);
  const mail = app.outbox.at(-1)!;
  const line = mail.text.split('\n').find(l => l.startsWith(tenantName));
  const link = extractLink(line ? ({ ...mail, text: line } as Mail) : mail);
  expect((await browser.get(link)).status).toBe(200);
  return browser.post(link, {});
}

/** 某邮箱所有成员记录的 locale */
async function memberLocales(email: string) {
  const rows = await getDb().select({ locale: members.locale }).from(members).where(eq(members.email, email));
  return rows.map(r => r.locale);
}

/** 页面 HTML 里提交语言切换的那个表单（不含其他 action="/locale" 的表单干扰时唯一对应一个选项） */
const localeForm = (html: string, locale: string) => {
  const form = [...html.matchAll(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g)]
    .map(m => m[0])
    .find(f => f.includes(`name="locale" value="${locale}"`));
  expect(form, `切换到 ${locale} 的表单`).toBeDefined();
  return form!;
};

describe('界面语言：开关关闭时整站中文', () => {
  it('无论 cookie、Accept-Language 还是账号语言如何，页面都是中文，POST /locale 返回 404', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const anon = await app.client().get('/login', { Cookie: 'crm_locale=en', 'Accept-Language': 'en-US,en;q=0.9' });
    expect(await anon.text()).toContain('lang="zh-CN"');

    const browser = app.client();
    expect((await loginToTenant(browser, 'admin@acme.com', '示例商贸')).status).toBe(302);
    await getDb().update(members).set({ locale: 'en' }).where(eq(members.email, 'admin@acme.com'));
    const home = await browser.get('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('lang="zh-CN"');

    expect((await browser.post('/locale', { locale: 'en', redirectTo: '/' })).status).toBe(404);
  });
});

describe('界面语言：开关打开时按账号 > cookie > 浏览器语言 > 中文判断', () => {
  beforeEach(() => { vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1'); });

  it('未登录时按浏览器语言：Accept-Language 是英文则英文，都不认识、q=0 或没有头则中文', async () => {
    const en = await app.client().get('/login', { 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' });
    expect(await en.text()).toContain('lang="en"');
    const zh = await app.client().get('/login', { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
    expect(await zh.text()).toContain('lang="zh-CN"');

    const none = await app.client().get('/login');
    expect(await none.text()).toContain('lang="zh-CN"');
    // 只认识 en / zh：法语跳过；en 的 q=0 是明确拒绝，也跳过
    const fr = await app.client().get('/login', { 'Accept-Language': 'fr-FR,fr;q=0.9' });
    expect(await fr.text()).toContain('lang="zh-CN"');
    const rejected = await app.client().get('/login', { 'Accept-Language': 'fr;q=0.9,en;q=0' });
    expect(await rejected.text()).toContain('lang="zh-CN"');
  });

  it('cookie 胜过浏览器语言：crm_locale=zh-CN 时即便 Accept-Language 是英文也仍是中文', async () => {
    const res = await app.client().get('/login', { Cookie: 'crm_locale=zh-CN', 'Accept-Language': 'en-US,en;q=0.9' });
    expect(await res.text()).toContain('lang="zh-CN"');
  });

  it('账号胜过 cookie：成员 locale=en、cookie 是 zh-CN 时页面是英文', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = app.client();
    expect((await loginToTenant(browser, 'admin@acme.com', '示例商贸')).status).toBe(302);
    await getDb().update(members).set({ locale: 'en' }).where(eq(members.email, 'admin@acme.com'));
    browser.store('crm_locale=zh-CN; Path=/');
    const home = await browser.get('/');
    expect(await home.text()).toContain('lang="en"');
  });
});

describe('界面语言：POST /locale 切换', () => {
  it('写 crm_locale cookie 后跳回 redirectTo，当前页生效', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const browser = app.client();
    const res = await browser.post('/locale', { locale: 'en', redirectTo: '/login' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.headers.getSetCookie()).toContain('crm_locale=en; Path=/; Max-Age=31536000; SameSite=Lax');
    expect(browser.cookie('crm_locale')).toBe('en');
    expect(await (await browser.get('/login')).text()).toContain('lang="en"');
  });

  it('redirectTo 不是站内路径时回退到 /，locale 不是 en/zh-CN 时 400', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const browser = app.client();
    const evil = await browser.post('/locale', { locale: 'en', redirectTo: '//evil.com' });
    expect(evil.headers.get('Location')).toBe('/');
    const backslash = await browser.post('/locale', { locale: 'en', redirectTo: '/\\evil.com' });
    expect(backslash.headers.get('Location')).toBe('/');
    const bad = await browser.post('/locale', { locale: 'fr', redirectTo: '/' });
    expect(bad.status).toBe(400);
  });
});

describe('界面语言：切换入口（顶栏与登录页，#946）', () => {
  it('开关关闭时，登录后的首页和登录页都没有切换入口', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    expect(await (await browser.get('/')).text()).not.toContain('action="/locale"');
    expect(await (await app.client().get('/login')).text()).not.toContain('action="/locale"');
  });

  it('开关打开时，登录页右上角与顶栏（头像旁）都有入口，redirectTo 带查询参数、当前语言有标记；/ops 不显示', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    // 未登录：登录页右上角，中文为当前语言
    const loginHtml = await (await app.client().get('/login')).text();
    expect(loginHtml).toContain('action="/locale"');
    expect(localeForm(loginHtml, 'zh-CN')).toContain('aria-current="true"');
    expect(localeForm(loginHtml, 'zh-CN')).toContain('name="redirectTo" value="/login"');
    expect(localeForm(loginHtml, 'en')).not.toContain('aria-current="true"');

    // 登录后的顶栏：停留页带查询参数时 redirectTo 原样带上
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    const tasksHtml = await (await browser.get('/tasks?x=1&y=2')).text();
    expect(tasksHtml).toContain('action="/locale"');
    expect(localeForm(tasksHtml, 'zh-CN')).toContain('aria-current="true"');
    // HTML 里 & 转义成 &amp;
    expect(localeForm(tasksHtml, 'zh-CN')).toContain('name="redirectTo" value="/tasks?x=1&amp;y=2"');

    // 运营后台的外壳不显示切换入口
    await createOperator(OPS_EMAIL);
    const ops = await loginAsOperator(app, OPS_EMAIL);
    expect(await (await ops.browser.get('/ops')).text()).not.toContain('action="/locale"');
  });

  it('从入口提交后 302 跳回停留页（含查询参数），整页换成所选语言', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    const html = await (await browser.get('/tasks?x=1&y=2')).text();
    // 用表单里实际渲染的字段提交，而不是手写一份
    const redirectTo = localeForm(html, 'en').match(/name="redirectTo" value="([^"]*)"/)![1].replace('&amp;', '&');
    expect(redirectTo).toBe('/tasks?x=1&y=2');

    const res = await browser.post('/locale', { locale: 'en', redirectTo });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/tasks?x=1&y=2');

    const after = await (await browser.get('/tasks?x=1&y=2')).text();
    expect(after).toContain('lang="en"');
    expect(localeForm(after, 'en')).toContain('aria-current="true"');
    expect(localeForm(after, 'zh-CN')).not.toContain('aria-current="true"');
  });
});

describe('界面语言：顶栏与导航整块翻译（#1012）', () => {
  beforeEach(() => { vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1'); });

  /** 去掉 <script>（loader 数据与水合脚本里的导航仍是中文）后的顶栏这一块 */
  const headerOf = (html: string) => {
    const header = html.replace(/<script[\s\S]*?<\/script>/g, '').match(/<header[\s\S]*?<\/header>/)?.[0];
    expect(header, '顶栏 <header>').toBeDefined();
    return header!;
  };

  it('英文界面下顶栏与导航整块英文，中文 label 不出现', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    browser.store('crm_locale=en; Path=/');
    const header = headerOf(await (await browser.get('/')).text());
    // 品牌名、全部分组与链接、我的设置提示、退出登录（「API Key」本就是英文；& 在 HTML 里转义成 &amp;）
    for (const en of ['CRM Data Analytics Platform', 'Overview', 'Data Ingestion', 'Sources', 'Mappings', 'Custom Entities', 'Data Quality', 'Data Model', 'Canonical Model', 'Lineage', 'Business Knowledge', 'Analytics', 'Metrics &amp; Tags', 'Query', 'Tasks', 'Admin', 'Members', 'API Key', 'Model Providers', 'Model Calls', 'Audit Log', 'PII Reveal', 'Sign out', 'title="My settings (admin@acme.com)"']) {
      expect(header).toContain(en);
    }
    // 导航定义（app/.server/nav.ts）保持中文，只在渲染时翻译：顶栏里中文 label 一个都不出现
    for (const zh of ['概览', '数据接入', '数据源', '映射', '自定义实体', '数据质量', '数据模型', '标准模型', '数据地图', '业务知识', '分析', '指标与标签', '查询', '任务', '管理', '成员', '模型服务', '模型调用', '审计日志', '解密', '退出登录', '我的设置']) {
      expect(header).not.toContain(zh);
    }
  });

  it('中文界面下顶栏与导航仍是中文（不下发词典、按原文回退，输出与改造前一致）', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    browser.store('crm_locale=zh-CN; Path=/');
    const header = headerOf(await (await browser.get('/')).text());
    for (const zh of ['CRM 数据分析平台', '概览', '数据接入', '数据源', '映射', '自定义实体', '数据质量', '数据模型', '标准模型', '数据地图', '业务知识', '分析', '指标与标签', '查询', '任务', '管理', '成员', 'API Key', '模型服务', '模型调用', '审计日志', '解密', '退出登录', '我的设置（admin@acme.com）']) {
      expect(header).toContain(zh);
    }
  });

  it('英文界面下根路由 ErrorBoundary 的出错页（404）是英文', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = await loginAs(app, 'admin@acme.com');
    browser.store('crm_locale=en; Path=/');
    // 子路由 loader 抛 404（数据源不存在）：root loader 正常跑完、词典已下发，错误页整块英文
    const res = await browser.get('/sources/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    const strip = (await res.text()).replace(/<script[\s\S]*?<\/script>/g, '');
    expect(strip).toContain('lang="en"');
    expect(strip).toContain('Page not found.');
    for (const zh of ['出错了', '页面不存在', '发生了意外错误', '无权访问', '返回首页']) {
      expect(strip).not.toContain(zh);
    }
  });
});

describe('界面语言：同一邮箱隶属多个租户时语言跟随账号', () => {
  it('在 A 租户切换语言后，所有成员记录同步更新，换租户登录仍是同一语言', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await createTenant('acme', '示例商贸', 'ops@shared.com');
    await createTenant('globex', '环球零售', 'ops@shared.com');
    expect(await memberLocales('ops@shared.com')).toEqual([null, null]);

    const browser = app.client();
    expect((await loginToTenant(browser, 'ops@shared.com', '示例商贸')).status).toBe(302);
    const res = await browser.post('/locale', { locale: 'en', redirectTo: '/' });
    expect(res.status).toBe(302);
    expect(await memberLocales('ops@shared.com')).toEqual(['en', 'en']);
    expect(await (await browser.get('/')).text()).toContain('lang="en"');

    // 换一台没有 cookie 的浏览器登录另一个租户：语言仍是账号上的英文
    const fresh = app.client();
    expect((await loginToTenant(fresh, 'ops@shared.com', '环球零售')).status).toBe(302);
    const home = await fresh.get('/');
    const html = await home.text();
    expect(html).toContain('lang="en"');
    expect(html).toContain('环球零售');
  });
});

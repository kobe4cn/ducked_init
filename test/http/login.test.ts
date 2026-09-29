import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, extractLink, resetDb, runCli, startApp, type Mail, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const createTenant = (slug: string, name: string, adminEmail: string) =>
  runCli('scripts/create-tenant.ts', ['--slug', slug, '--name', name, '--admin-email', adminEmail]);

/** 申请 Magic Link 并等待后台签发与发信完成 */
async function requestLink(browser: Client, email: string) {
  const res = await browser.post('/login', { email });
  await app.drain();
  return res;
}

/** 申请 Magic Link → 打开链接 → 确认登录 */
async function login(email: string) {
  const browser = app.client();
  await requestLink(browser, email);
  const link = extractLink(app.outbox.at(-1)!);
  expect((await browser.get(link)).status).toBe(200);
  const res = await browser.post(link, {});
  return { browser, res };
}

describe('租户与 Magic Link 登录', () => {
  it('运营命令创建租户与首个管理员，管理员通过 Magic Link 登录后看到租户与角色', async () => {
    const cli = await createTenant('acme', '示例商贸', 'Admin@Acme.com');
    expect(cli.code).toBe(0);

    const { browser, res } = await login('admin@acme.com');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/');

    const home = await browser.get('/');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('示例商贸');
    expect(html).toContain('管理员');
    expect(html).toContain('admin@acme.com');
    expect(html).toContain('默认空间');
  });

  it('运营命令拒绝重复的租户标识', async () => {
    expect((await createTenant('acme', '示例商贸', 'admin@acme.com')).code).toBe(0);
    const dup = await createTenant('acme', '另一家', 'boss@other.com');
    expect(dup.code).not.toBe(0);
    expect(dup.stderr).toContain('租户标识已存在');
  });

  it('未登录访问首页跳转到登录页', async () => {
    const res = await app.client().get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');
  });

  it('Magic Link 只能使用一次', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { res } = await login('admin@acme.com');
    expect(res.status).toBe(302);

    const link = extractLink(app.outbox.at(-1)!);
    const other = app.client();
    const again = await other.post(link, {});
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('登录链接无效、已过期或已被使用');
    expect((await other.get('/')).status).toBe(302);
  });

  it('Magic Link 超过 15 分钟失效', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    vi.useFakeTimers({ toFake: ['Date'] });
    const browser = app.client();
    await requestLink(browser, 'admin@acme.com');
    const link = extractLink(app.outbox.at(-1)!);

    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1000);
    const res = await browser.post(link, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('登录链接无效、已过期或已被使用');
    expect((await browser.get('/')).status).toBe(302);
  });

  it('伪造的令牌无法登录', async () => {
    const browser = app.client();
    const res = await browser.post('/auth/verify?token=not-a-real-token', {});
    expect(await res.text()).toContain('登录链接无效、已过期或已被使用');
    expect((await browser.get('/')).status).toBe(302);
  });

  it('未登记的邮箱收不到链接，且答复与已登记邮箱相同', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const known = await (await requestLink(app.client(), 'admin@acme.com')).text();
    app.outbox.length = 0;

    const res = await requestLink(app.client(), 'stranger@evil.com');
    expect(res.status).toBe(200);
    expect(app.outbox).toHaveLength(0);
    const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(strip(await res.text())).toBe(strip(known));
  });

  it('没有自助注册入口，申请登录也不会创建成员', async () => {
    expect((await app.client().get('/signup')).status).toBe(404);
    expect((await app.client().get('/register')).status).toBe(404);

    await requestLink(app.client(), 'stranger@evil.com');
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    await requestLink(app.client(), 'stranger@evil.com');
    expect(app.outbox).toHaveLength(0);
  });

  it('开发环境下邮件内容输出到控制台', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    app.setMailer(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await requestLink(app.client(), 'admin@acme.com');
    } finally {
      app.useTestMailer();
    }
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('admin@acme.com');
    expect(printed).toMatch(/\/auth\/verify\?token=[\w-]+/);
  });

  it('同一邮箱隶属多个租户时，按所选链接进入对应租户', async () => {
    await createTenant('acme', '示例商贸', 'ops@shared.com');
    await createTenant('globex', '环球零售', 'ops@shared.com');
    const browser = app.client();
    await requestLink(browser, 'ops@shared.com');
    const mail = app.outbox.at(-1)!;
    const globexLine = mail.text.split('\n').find(l => l.startsWith('环球零售'))!;
    const link = extractLink({ ...mail, text: globexLine });

    await browser.post(link, {});
    const html = await (await browser.get('/')).text();
    expect(html).toContain('环球零售');
    expect(html).not.toContain('示例商贸');
  });

  it('退出登录后会话失效', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await login('admin@acme.com');
    const res = await browser.post('/logout');
    expect(res.headers.get('Location')).toBe('/login');
    expect((await browser.get('/')).status).toBe(302);
  });

  it('重新申请后，之前未使用的链接作废', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const browser = app.client();
    await requestLink(browser, 'admin@acme.com');
    const first = extractLink(app.outbox.at(-1)!);
    await requestLink(browser, 'admin@acme.com');
    const second = extractLink(app.outbox.at(-1)!);

    expect(await (await browser.post(first, {})).text()).toContain('登录链接无效、已过期或已被使用');
    expect((await browser.post(second, {})).status).toBe(302);
  });

  it('同一邮箱申请过于频繁时被限流，已登记与未登记邮箱表现一致', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    for (const email of ['admin@acme.com', 'stranger@evil.com']) {
      for (let i = 0; i < 5; i++) expect((await requestLink(app.client(), email)).status).toBe(200);
      const limited = await requestLink(app.client(), email);
      expect(limited.status).toBe(429);
      expect(await limited.text()).toContain('申请过于频繁');
    }
    expect(app.outbox).toHaveLength(5);

    // 时间窗口过去后恢复
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1000);
    expect((await requestLink(app.client(), 'admin@acme.com')).status).toBe(200);
    expect(app.outbox).toHaveLength(6);
  });

  it('申请登录的响应不等待签发与发信，已登记邮箱无法通过响应时间被探测', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const sent: Mail[] = [];
    app.setMailer({ async send(m) { await gate; sent.push(m); } });
    try {
      const res = await Promise.race([
        app.client().post('/login', { email: 'admin@acme.com' }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('响应在等待发信')), 3000)),
      ]);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0);
      release();
      await app.drain();
      expect(sent).toHaveLength(1);
    } finally {
      release();
      app.useTestMailer();
    }
  });
});

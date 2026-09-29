import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { totpCode } from '../../app/.server/totp';
import {
  createOperator, createTenant, extractOpsLink, loginAs, loginAsOperator, opsMagicLogin, resetDb, scanTotpQrOn, startApp, totpSecretOn,
  type Client, type TestApp,
} from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const OPS = 'ops@platform.com';

/** 创建运营者并完成首次登录 */
async function operator(email = OPS) {
  expect((await createOperator(email)).code).toBe(0);
  return loginAsOperator(app, email);
}

/** 从运营后台租户列表里取出某个租户的 ID */
async function tenantIdOf(ops: Client, slug: string) {
  const html = await (await ops.get('/ops')).text();
  const m = html.match(new RegExp(`data-tenant-slug="${slug}" data-tenant-id="([\\w-]+)"`));
  if (!m) throw new Error(`运营后台没有租户 ${slug}`);
  return m[1];
}

const auditActions = (html: string) => [...html.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1]);

describe('运营者身份：只能由运营命令创建', () => {
  it('运营命令创建运营者，重复邮箱被拒绝；新增运营者作为平台事件记录', async () => {
    const cli = await createOperator('Ops@Platform.com');
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain(OPS);
    const dup = await createOperator(OPS);
    expect(dup.code).not.toBe(0);
    expect(dup.stderr).toContain('运营者已存在');

    const { browser } = await loginAsOperator(app, OPS);
    const events = await (await browser.get('/ops/audit')).text();
    expect(auditActions(events)).toEqual(expect.arrayContaining(['新增运营者', '绑定 TOTP', '运营者登录']));
  });

  it('后台没有新增或停用运营者的入口', async () => {
    const { browser } = await operator();
    for (const path of ['/ops/operators', '/ops/operators/new']) expect((await browser.get(path)).status).toBe(404);
    for (const intent of ['create-operator', 'disable-operator']) {
      expect((await browser.post('/ops?index', { intent, email: 'evil@platform.com' })).status).toBe(400);
    }
    // 没有创建出新的运营者：该邮箱申请登录收不到邮件
    app.outbox.length = 0;
    await app.client().post('/ops/login', { email: 'evil@platform.com' });
    await app.drain();
    expect(app.outbox).toHaveLength(0);
  });
});

describe('运营后台登录：Magic Link + 强制 TOTP', () => {
  it('首次登录展示密钥并确认一次验证码后进入运营后台', async () => {
    await createOperator(OPS);
    const browser = await opsMagicLogin(app, OPS);
    // 只通过 Magic Link 还不能进入运营后台
    for (const path of ['/ops', '/ops/audit']) {
      const res = await browser.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/ops/totp');
    }

    const secret = await totpSecretOn(browser);
    // 页面上的二维码可被认证器扫描，编码的是含同一密钥的 otpauth 绑定链接
    const uri = new URL((await scanTotpQrOn(browser))!);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(decodeURIComponent(uri.pathname)).toContain(OPS);

    const wrong = await browser.post('/ops/totp', { code: '000000' === totpCode(secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('验证码不正确');
    expect((await browser.get('/ops')).status).toBe(302);

    const ok = await browser.post('/ops/totp', { code: totpCode(secret) });
    expect(ok.headers.get('Location')).toBe('/ops');
    const home = await browser.get('/ops');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain(OPS);
  });

  it('绑定后再次登录不再展示密钥，仍须输入验证码；同一个验证码不能重复使用', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { secret } = await operator();
    const code = totpCode(secret);

    const again = await opsMagicLogin(app, OPS);
    const page = await (await again.get('/ops/totp')).text();
    expect(page).not.toContain('data-totp-secret');
    expect(page).not.toContain(secret);
    expect(await scanTotpQrOn(again)).toBeNull();
    expect((await again.get('/ops')).status).toBe(302);

    // 同一时间步内重放刚才用过的验证码
    expect((await again.post('/ops/totp', { code })).status).toBe(400);

    vi.setSystemTime(Date.now() + 30_000);
    expect((await again.post('/ops/totp', { code: totpCode(secret) })).headers.get('Location')).toBe('/ops');
    expect((await again.get('/ops')).status).toBe(200);
  });

  it('连续输错验证码 5 次后会话作废，需要重新申请登录链接', async () => {
    await createOperator(OPS);
    const browser = await opsMagicLogin(app, OPS);
    const secret = await totpSecretOn(browser);
    const bad = totpCode(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await browser.post('/ops/totp', { code: bad })).status).toBe(400);
    const locked = await browser.post('/ops/totp', { code: bad });
    expect(locked.status).toBe(302);
    expect(locked.headers.get('Location')).toBe('/ops/login?reason=totp_locked');
    expect(await (await browser.get('/ops/login?reason=totp_locked')).text()).toContain('验证码错误次数过多');

    const res = await browser.post('/ops/totp', { code: totpCode(secret) });
    expect(res.headers.get('Location')).toBe('/ops/login');
    expect((await browser.get('/ops')).headers.get('Location')).toBe('/ops/login');
  });

  it('未登录访问运营后台跳转到运营者登录页', async () => {
    for (const path of ['/ops', '/ops/audit', '/ops/totp']) {
      const res = await app.client().get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/ops/login');
    }
  });

  it('非运营者邮箱（包括租户管理员）收不到运营后台登录链接，答复与运营者相同', async () => {
    await createOperator(OPS);
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');
    const known = strip(await (await app.client().post('/ops/login', { email: OPS })).text());
    await app.drain();
    app.outbox.length = 0;

    for (const email of ['admin@acme.com', 'stranger@evil.com']) {
      const res = await app.client().post('/ops/login', { email });
      expect(res.status).toBe(200);
      expect(strip(await res.text())).toBe(known);
    }
    await app.drain();
    expect(app.outbox).toHaveLength(0);
  });

  it('运营后台的登录链接只能使用一次，且不能用于成员登录', async () => {
    await createOperator(OPS);
    await app.client().post('/ops/login', { email: OPS });
    await app.drain();
    const link = extractOpsLink(app.outbox.at(-1)!);
    const token = new URL(link, 'http://x').searchParams.get('token')!;

    const member = app.client();
    expect(await (await member.post(`/auth/verify?token=${token}`, {})).text()).toContain('登录链接无效');
    expect((await app.client().post(link, {})).headers.get('Location')).toBe('/ops/totp');
    const reused = await app.client().post(link, {});
    expect(reused.status).toBe(200);
    expect(await reused.text()).toContain('登录链接无效、已过期或已被使用');
  });

  it('运营者会话 8 小时后失效', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { browser } = await operator();
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 - 60_000);
    expect((await browser.get('/ops')).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await browser.get('/ops')).headers.get('Location')).toBe('/ops/login');
  });

  it('退出登录后运营者会话失效', async () => {
    const { browser } = await operator();
    const res = await browser.post('/ops/logout');
    expect(res.headers.get('Location')).toBe('/ops/login');
    expect((await browser.get('/ops')).headers.get('Location')).toBe('/ops/login');
  });
});

describe('成员会话与运营者会话互不通用', () => {
  it('成员会话（包括管理员）访问运营后台一律被拒绝', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    for (const path of ['/ops', '/ops/audit', '/ops/totp']) {
      const res = await admin.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/ops/login');
    }
    const create = await admin.post('/ops?index', { intent: 'create-tenant', slug: 'evil', name: '恶意', adminEmail: 'x@evil.com' });
    expect(create.status).toBe(302);
    expect(create.headers.get('Location')).toBe('/ops/login');

    // 把成员会话令牌放进运营者 cookie 同样无效
    const forged = app.client();
    const res = await forged.get('/ops', { Cookie: `crm_ops_session=${admin.cookie('crm_session')}` });
    expect(res.headers.get('Location')).toBe('/ops/login');
  });

  it('运营者会话访问成员页面同样被拒绝', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await operator();
    for (const path of ['/', '/members', '/audit']) {
      const res = await browser.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login');
    }
    expect((await browser.post('/members', { intent: 'invite', email: 'x@acme.com', role: 'admin' })).headers.get('Location')).toBe('/login');

    const forged = await app.client().get('/', { Cookie: `crm_session=${browser.cookie('crm_ops_session')}` });
    expect(forged.headers.get('Location')).toBe('/login');
  });
});

describe('租户管理', () => {
  it('列出租户：名称、标识、开通时间、成员数与管理员邮箱，看不到其他成员', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    await admin.post('/members', { intent: 'invite', email: 'ana@acme.com', role: 'analyst' });
    await admin.post('/members', { intent: 'invite', email: 'boss@acme.com', role: 'admin' });
    await createTenant('globex', '环球零售', 'admin@globex.com');

    const { browser } = await operator();
    const html = await (await browser.get('/ops')).text();
    expect(html).toContain('示例商贸');
    expect(html).toContain('环球零售');
    expect(html).toMatch(/data-tenant-slug="acme"[^>]*data-member-count="3"/);
    expect(html).toMatch(/data-tenant-slug="globex"[^>]*data-member-count="1"/);
    expect(html).toContain('admin@acme.com');
    expect(html).toContain('boss@acme.com');
    expect(html).not.toContain('ana@acme.com');

    const detail = await (await browser.get(`/ops/tenants/${await tenantIdOf(browser, 'acme')}`)).text();
    expect(detail).toContain('boss@acme.com');
    expect(detail).not.toContain('ana@acme.com');
    // 没有进入租户的入口
    expect(detail).not.toMatch(/href="\/(members|audit)?"/);
  });

  it('开通租户：首个管理员随即可以登录；租户审计日志显示运营者', async () => {
    const { browser } = await operator();
    const res = await browser.post('/ops?index', { intent: 'create-tenant', slug: 'acme', name: '示例商贸', adminEmail: 'Admin@Acme.com' });
    expect(res.status).toBe(302);
    expect(await (await browser.get('/ops')).text()).toContain('示例商贸');

    const admin = await loginAs(app, 'admin@acme.com');
    const home = await (await admin.get('/')).text();
    expect(home).toContain('示例商贸');
    expect(home).toContain('默认空间');
    const audit = await (await admin.get('/audit')).text();
    expect(auditActions(audit)).toEqual(['开通租户']);
    expect(audit).toContain(`运营者 ${OPS}`);
  });

  it('开通租户时拒绝重复标识与不合法的输入', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await operator();
    const cases: [Record<string, string>, string][] = [
      [{ slug: 'acme', name: '另一家', adminEmail: 'x@other.com' }, '租户标识已存在'],
      [{ slug: 'Bad Slug', name: '另一家', adminEmail: 'x@other.com' }, '租户标识不合法'],
      [{ slug: 'other', name: ' ', adminEmail: 'x@other.com' }, '租户名称不能为空'],
      [{ slug: 'other', name: '另一家', adminEmail: 'nope' }, '管理员邮箱不合法'],
    ];
    for (const [form, error] of cases) {
      const res = await browser.post('/ops?index', { intent: 'create-tenant', ...form });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(error);
    }
  });

  it('租户改名：成员看到新名称，租户审计日志记录运营者操作', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await operator();
    const id = await tenantIdOf(browser, 'acme');
    expect((await browser.post(`/ops/tenants/${id}`, { intent: 'rename', name: '示例集团' })).status).toBe(302);
    const blank = await browser.post(`/ops/tenants/${id}`, { intent: 'rename', name: '  ' });
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain('租户名称不能为空');

    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/')).text()).toContain('示例集团');
    const audit = await (await admin.get('/audit')).text();
    expect(auditActions(audit)).toEqual(['租户改名', '开通租户']);
    expect(audit).toContain('示例商贸 → 示例集团');
    expect(audit).toContain(`运营者 ${OPS}`);
  });

  it('为租户指定管理员：可提升已有成员，也可新增管理员邮箱', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    await admin.post('/members', { intent: 'invite', email: 'ana@acme.com', role: 'analyst' });
    const { browser } = await operator();
    const id = await tenantIdOf(browser, 'acme');

    expect((await browser.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'Ana@Acme.com' })).status).toBe(302);
    expect((await browser.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'new-admin@acme.com' })).status).toBe(302);
    await app.drain();
    expect(app.outbox.some(m => m.to === 'new-admin@acme.com' && m.text.includes('示例商贸'))).toBe(true);

    for (const email of ['ana@acme.com', 'new-admin@acme.com']) {
      const b = await loginAs(app, email);
      expect(await (await b.get('/')).text()).toContain('管理员');
      expect((await b.get('/members')).status).toBe(200);
    }
    const html = await (await browser.get('/ops')).text();
    expect(html).toMatch(/data-tenant-slug="acme"[^>]*data-member-count="3"/);

    const audit = await (await admin.get('/audit')).text();
    expect(auditActions(audit)).toEqual(['指定管理员', '指定管理员', '邀请成员', '开通租户']);
    expect(audit).toContain('ana@acme.com（原角色：分析师）');
    expect(audit).toContain('new-admin@acme.com（新增）');

    const dup = await browser.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'admin@acme.com' });
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain('已是管理员');
    const bad = await browser.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('不存在的租户返回 404', async () => {
    const { browser } = await operator();
    for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      expect((await browser.get(`/ops/tenants/${id}`)).status).toBe(404);
      expect((await browser.post(`/ops/tenants/${id}`, { intent: 'rename', name: 'x' })).status).toBe(404);
    }
  });
});

describe('审计', () => {
  it('平台级事件不会出现在任何租户的审计日志中，只在运营后台可见', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await operator();
    const id = await tenantIdOf(browser, 'acme');
    await browser.post(`/ops/tenants/${id}`, { intent: 'rename', name: '示例集团' });

    const admin = await loginAs(app, 'admin@acme.com');
    const audit = await (await admin.get('/audit')).text();
    expect(auditActions(audit)).toEqual(['租户改名', '开通租户']);
    for (const text of ['新增运营者', '运营者登录', '绑定 TOTP']) expect(audit).not.toContain(text);

    const events = await (await browser.get('/ops/audit')).text();
    expect(auditActions(events)).toEqual(expect.arrayContaining(['新增运营者', '绑定 TOTP', '运营者登录', '租户改名']));
    // 运营后台看不到成员自己的操作
    await admin.post('/members', { intent: 'invite', email: 'ana@acme.com', role: 'analyst' });
    const after = await (await browser.get('/ops/audit')).text();
    expect(after).not.toContain('ana@acme.com');
    expect(auditActions(after)).not.toContain('邀请成员');
  });
});

describe('IP 白名单（可选）', () => {
  it('配置 OPS_ALLOWED_CIDRS 后只允许白名单 IP 访问运营后台，成员页面不受影响', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const { browser } = await operator();
    vi.stubEnv('OPS_ALLOWED_CIDRS', '10.0.0.0/8, 2001:db8::/32');

    expect((await browser.get('/ops', { 'X-Forwarded-For': '10.1.2.3' })).status).toBe(200);
    expect((await browser.get('/ops', { 'X-Forwarded-For': '203.0.113.9, 10.1.2.3' })).status).toBe(200);
    expect((await browser.get('/ops', { 'X-Forwarded-For': '2001:db8::1' })).status).toBe(200);
    for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'X-Forwarded-For': '10.1.2.3, 203.0.113.9' }, {}] as Record<string, string>[]) {
      expect((await browser.get('/ops', headers)).status).toBe(403);
      expect((await app.client().get('/ops/login', headers)).status).toBe(403);
      expect((await app.client().post('/ops/login', { email: OPS }, headers)).status).toBe(403);
    }

    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.get('/', { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(200);
  });
});

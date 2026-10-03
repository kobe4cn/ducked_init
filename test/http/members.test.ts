import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTenant, extractLink, loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 从成员页取出某个邮箱对应的成员 ID */
async function memberIdOf(admin: Client, email: string) {
  const html = await (await admin.get('/members')).text();
  const m = html.match(new RegExp(`data-email="${email.replace(/[.]/g, '\\.')}" data-member-id="([\\w-]+)"`));
  if (!m) throw new Error(`成员页没有 ${email}`);
  return m[1];
}

/** 开通租户并由管理员邀请一名指定角色的成员，返回双方已登录的浏览器 */
async function tenantWith(role: string, slug = 'acme', name = '示例商贸') {
  await createTenant(slug, name, `admin@${slug}.com`);
  const admin = await loginAs(app, `admin@${slug}.com`);
  const email = `${role}@${slug}.com`;
  expect((await admin.post('/members', { intent: 'invite', email, role })).status).toBe(302);
  const member = await loginAs(app, email);
  return { admin, member, email, memberId: await memberIdOf(admin, email) };
}

describe('成员邀请与角色', () => {
  it('管理员邀请成员并指定角色，被邀请者登录后看到自己的角色', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');

    const res = await admin.post('/members', { intent: 'invite', email: 'Ana@Acme.com', role: 'analyst' });
    expect(res.status).toBe(302);
    await app.drain();
    expect(app.outbox.some(m => m.to === 'ana@acme.com' && m.text.includes('示例商贸'))).toBe(true);

    const ana = await loginAs(app, 'ana@acme.com');
    const html = await (await ana.get('/')).text();
    expect(html).toContain('示例商贸');
    expect(html).toContain('分析师');
  });

  it('修改角色后，成员已登录的会话立即按新角色生效', async () => {
    const { admin, member, memberId } = await tenantWith('viewer');
    expect(await (await member.get('/')).text()).toContain('查看者');

    expect((await admin.post('/members', { intent: 'change-role', memberId, role: 'data_engineer' })).status).toBe(302);
    const html = await (await member.get('/')).text();
    expect(html).toContain('数据工程师');
    expect(html).not.toContain('查看者');
  });

  it('被移除成员的会话立即失效，也无法再申请登录', async () => {
    const { admin, member, email, memberId } = await tenantWith('analyst');
    expect((await member.get('/')).status).toBe(200);

    expect((await admin.post('/members', { intent: 'remove', memberId })).status).toBe(302);
    const res = await member.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/login');

    app.outbox.length = 0;
    await app.client().post('/login', { email });
    await app.drain();
    expect(app.outbox).toHaveLength(0);
  });
});

// spec 的权限矩阵（角色 × 操作），作为独立的期望来源
const MATRIX: Record<string, Record<string, boolean>> = {
  //                  数据源/映射 读、写        指标/标签定义 读、草稿、写                      发布           沙箱          结果层               成员 / API Key / 模型服务 / 审计 / 解密敏感信息
  admin:         { 'sources:read': true,  'sources:write': true,  'definitions:read': true,  'definitions:draft': true,  'definitions:write': true,  publish: true,  sandbox: true,  'results:read': true, 'members:manage': true,  'api_keys:manage': true,  'model_provider:manage': true,  'audit:read': true,  'pii:reveal': true },
  data_engineer: { 'sources:read': true,  'sources:write': true,  'definitions:read': true,  'definitions:draft': true,  'definitions:write': true,  publish: true,  sandbox: true,  'results:read': true, 'members:manage': false, 'api_keys:manage': false, 'model_provider:manage': false, 'audit:read': false, 'pii:reveal': false },
  analyst:       { 'sources:read': true,  'sources:write': false, 'definitions:read': true,  'definitions:draft': true,  'definitions:write': false, publish: false, sandbox: true,  'results:read': true, 'members:manage': false, 'api_keys:manage': false, 'model_provider:manage': false, 'audit:read': false, 'pii:reveal': false },
  viewer:        { 'sources:read': false, 'sources:write': false, 'definitions:read': true,  'definitions:draft': false, 'definitions:write': false, publish: false, sandbox: false, 'results:read': true, 'members:manage': false, 'api_keys:manage': false, 'model_provider:manage': false, 'audit:read': false, 'pii:reveal': false },
};

/** 以指定角色登录（管理员直接用开通时的首个管理员） */
async function loginWithRole(role: string) {
  if (role === 'admin') {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    return loginAs(app, 'admin@acme.com');
  }
  return (await tenantWith(role)).member;
}

describe('权限矩阵', () => {
  for (const role of Object.keys(MATRIX)) {
    it(`${role}：首页列出的可用操作与 spec 一致，不可用的操作带说明`, async () => {
      const browser = await loginWithRole(role);
      const html = await (await browser.get('/')).text();
      const shown = Object.fromEntries(
        [...html.matchAll(/data-permission="([\w:]+)" data-allowed="(true|false)"/g)].map(m => [m[1], m[2] === 'true']),
      );
      expect(shown).toEqual(MATRIX[role]);
      if (role !== 'admin') expect(html).toContain('仅管理员可以邀请成员、修改角色与移除成员');
    });

    const allowed = MATRIX[role]['members:manage'];
    it(`${role}：${allowed ? '可以' : '不能'}管理成员与查看审计日志`, async () => {
      const browser = await loginWithRole(role);
      const pages = [await browser.get('/members'), await browser.get('/audit')];
      const invite = await browser.post('/members', { intent: 'invite', email: 'new@acme.com', role: 'admin' });
      if (allowed) {
        expect(pages.map(p => p.status)).toEqual([200, 200]);
        expect(invite.status).toBe(302);
        return;
      }
      expect(pages.map(p => p.status)).toEqual([403, 403]);
      expect(await pages[0].text()).toContain('仅管理员可以邀请成员、修改角色与移除成员');
      expect(invite.status).toBe(403);
      app.outbox.length = 0;
      await app.client().post('/login', { email: 'new@acme.com' });
      await app.drain();
      expect(app.outbox).toHaveLength(0);
    });
  }
});

describe('审计日志', () => {
  it('记录开通租户、邀请、修改角色与移除成员，管理员按时间倒序查看', async () => {
    const { admin, memberId } = await tenantWith('viewer');
    await admin.post('/members', { intent: 'change-role', memberId, role: 'analyst' });
    await admin.post('/members', { intent: 'remove', memberId });

    const html = await (await admin.get('/audit')).text();
    const actions = [...html.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1]);
    expect(actions).toEqual(['移除成员', '修改角色', '邀请成员', '开通租户']);
    expect(html).toContain('viewer@acme.com：查看者 → 分析师');
    expect(html).toContain('viewer@acme.com（原角色：分析师）');
    expect(html).toContain('运营者');
    expect(html).toContain('admin@acme.com');
  });
});

describe('跨租户访问一律拒绝', () => {
  it('A 租户管理员不能修改或移除 B 租户的成员，也看不到 B 的成员与审计记录', async () => {
    const b = await tenantWith('analyst', 'globex', '环球零售');
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const adminA = await loginAs(app, 'admin@acme.com');

    const bAdminId = await memberIdOf(b.admin, 'admin@globex.com');
    for (const [intent, memberId] of [['change-role', b.memberId], ['remove', b.memberId], ['remove', bAdminId]]) {
      const res = await adminA.post('/members', { intent, memberId, role: 'viewer' });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('成员不存在');
    }

    // B 的成员与会话不受影响
    const html = await (await b.member.get('/')).text();
    expect(html).toContain('环球零售');
    expect(html).toContain('分析师');
    expect((await b.admin.get('/members')).status).toBe(200);

    const membersA = await (await adminA.get('/members')).text();
    expect(membersA).not.toContain('globex.com');
    const auditA = await (await adminA.get('/audit')).text();
    expect(auditA).not.toContain('globex');
    expect(auditA).not.toContain('环球零售');
  });

  it('同一邮箱在 A 租户是管理员、在 B 租户是查看者时，B 租户会话不具备管理员权限', async () => {
    await createTenant('acme', '示例商贸', 'ops@shared.com');
    await createTenant('globex', '环球零售', 'admin@globex.com');
    const adminB = await loginAs(app, 'admin@globex.com');
    await adminB.post('/members', { intent: 'invite', email: 'ops@shared.com', role: 'viewer' });

    const browser = app.client();
    await browser.post('/login', { email: 'ops@shared.com' });
    await app.drain();
    const mail = app.outbox.filter(m => m.to === 'ops@shared.com' && m.text.includes('/auth/verify')).at(-1)!;
    const globexLine = mail.text.split('\n').find(l => l.startsWith('环球零售'))!;
    await browser.post(extractLink({ ...mail, text: globexLine }), {});

    expect(await (await browser.get('/')).text()).toContain('环球零售');
    expect((await browser.get('/members')).status).toBe(403);
    expect((await browser.post('/members', { intent: 'invite', email: 'x@globex.com', role: 'admin' })).status).toBe(403);
  });
});

describe('成员管理的边界', () => {
  it('租户至少保留一名管理员：唯一的管理员不能被降级或移除', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    const selfId = await memberIdOf(admin, 'admin@acme.com');

    for (const form of [{ intent: 'change-role', role: 'viewer' }, { intent: 'remove' }] as Record<string, string>[]) {
      const res = await admin.post('/members', { ...form, memberId: selfId });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('租户至少需要保留一名管理员');
    }
    expect(await (await admin.get('/')).text()).toContain('管理员');
  });

  it('有其他管理员时可以移除自己，移除后会话失效', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    await admin.post('/members', { intent: 'invite', email: 'boss@acme.com', role: 'admin' });
    const res = await admin.post('/members', { intent: 'remove', memberId: await memberIdOf(admin, 'admin@acme.com') });
    expect(res.headers.get('Location')).toBe('/login');
    expect((await admin.get('/')).status).toBe(302);

    const boss = await loginAs(app, 'boss@acme.com');
    const audit = await (await boss.get('/audit')).text();
    expect(audit).toContain('admin@acme.com（原角色：管理员）');
  });

  it('有其他管理员时可以把自己降级，随后回到首页并失去管理权限', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    await admin.post('/members', { intent: 'invite', email: 'boss@acme.com', role: 'admin' });
    const res = await admin.post('/members', { intent: 'change-role', memberId: await memberIdOf(admin, 'admin@acme.com'), role: 'analyst' });
    expect(res.headers.get('Location')).toBe('/');
    expect(await (await admin.get('/')).text()).toContain('分析师');
    expect((await admin.get('/members')).status).toBe(403);
  });

  it('拒绝重复邀请、非法邮箱与未知角色', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    const cases: [Record<string, string>, string][] = [
      [{ email: 'ADMIN@acme.com', role: 'viewer' }, 'admin@acme.com 已是本租户成员'],
      [{ email: 'not-an-email', role: 'viewer' }, '邮箱格式不正确'],
      [{ email: 'x@acme.com', role: 'owner' }, '请选择有效的角色'],
    ];
    for (const [form, error] of cases) {
      const res = await admin.post('/members', { intent: 'invite', ...form });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(error);
    }
    const audit = await (await admin.get('/audit')).text();
    expect([...audit.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1])).toEqual(['开通租户']);
  });
});

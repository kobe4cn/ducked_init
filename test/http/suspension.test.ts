import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOperator, createTenant, extractLink, loginAs, loginAsOperator, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const OPS = 'ops@platform.com';

async function operator() {
  expect((await createOperator(OPS)).code).toBe(0);
  return (await loginAsOperator(app, OPS)).browser;
}

/** 运营后台租户列表中某个租户所在的行 */
async function tenantRow(ops: Client, slug: string) {
  const html = await (await ops.get('/ops')).text();
  const m = html.match(new RegExp(`<tr[^>]*data-tenant-slug="${slug}"[\\s\\S]*?</tr>`));
  if (!m) throw new Error(`运营后台没有租户 ${slug}`);
  return { html: m[0], id: m[0].match(/data-tenant-id="([\w-]+)"/)![1], status: m[0].match(/data-tenant-status="(\w+)"/)![1] };
}

const suspend = (ops: Client, id: string, reason: string) => ops.post(`/ops/tenants/${id}`, { intent: 'suspend', reason });
const resume = (ops: Client, id: string) => ops.post(`/ops/tenants/${id}`, { intent: 'resume' });

/** 申请登录链接，返回页面答复（去掉脚本）与这次发出的邮件 */
async function requestLogin(email: string) {
  app.outbox.length = 0;
  const res = await app.client().post('/login', { email });
  await app.drain();
  return { status: res.status, html: (await res.text()).replace(/<script[\s\S]*?<\/script>/g, ''), mails: [...app.outbox] };
}

const auditActions = (html: string) => [...html.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1]);

describe('停用租户', () => {
  it('必须填写原因；租户列表显示状态、原因与停用时间', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const ops = await operator();
    const { id, status } = await tenantRow(ops, 'acme');
    expect(status).toBe('active');

    const blank = await suspend(ops, id, '   ');
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain('请填写停用原因');
    expect((await tenantRow(ops, 'acme')).status).toBe('active');

    expect((await suspend(ops, id, '欠费未续约')).status).toBe(302);
    const row = await tenantRow(ops, 'acme');
    expect(row.status).toBe('suspended');
    expect(row.html).toContain('已停用');
    expect(row.html).toContain('欠费未续约');
    expect(row.html).toMatch(/data-suspended-at="[^"]+"/);

    const again = await suspend(ops, id, '重复停用');
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('已停用');
  });

  it('停用后成员会话立即失效，未使用的登录链接作废，也无法再申请到链接；页面答复与正常时一致', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    const normal = await requestLogin('admin@acme.com');
    expect(normal.mails).toHaveLength(1);
    const pendingLink = extractLink(normal.mails[0]);

    const ops = await operator();
    await suspend(ops, (await tenantRow(ops, 'acme')).id, '欠费未续约');

    for (const path of ['/', '/members', '/audit']) {
      const res = await admin.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/login');
    }
    expect(await (await app.client().post(pendingLink, {})).text()).toContain('登录链接无效');

    const blocked = await requestLogin('admin@acme.com');
    expect(blocked.status).toBe(normal.status);
    expect(blocked.html).toBe(normal.html);
    expect(blocked.mails).toHaveLength(0);
  });

  it('同一邮箱属于多个租户时，只有被停用的租户无法进入', async () => {
    await createTenant('acme', '示例商贸', 'both@example.com');
    await createTenant('globex', '环球零售', 'both@example.com');
    const inAcme = await loginAs(app, 'both@example.com');
    expect(await (await inAcme.get('/')).text()).toContain('示例商贸');

    const ops = await operator();
    await suspend(ops, (await tenantRow(ops, 'acme')).id, '合同到期');
    expect((await inAcme.get('/')).headers.get('Location')).toBe('/login');

    const { mails } = await requestLogin('both@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('环球零售');
    expect(mails[0].text).not.toContain('示例商贸');
    const browser = app.client();
    expect((await browser.post(extractLink(mails[0]), {})).status).toBe(302);
    expect(await (await browser.get('/')).text()).toContain('环球零售');
  });
});

describe('停用期间不能指定管理员', () => {
  it('指定管理员被拒绝，不发通知也不写审计；恢复后可以指定', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const ops = await operator();
    const { id } = await tenantRow(ops, 'acme');
    await suspend(ops, id, '欠费未续约');
    expect(await (await ops.get(`/ops/tenants/${id}`)).text()).not.toContain('name="intent" value="assign-admin"');

    app.outbox.length = 0;
    const res = await ops.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'new-admin@acme.com' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('租户已停用');
    await app.drain();
    expect(app.outbox).toHaveLength(0);
    expect((await tenantRow(ops, 'acme')).html).not.toContain('new-admin@acme.com');

    await resume(ops, id);
    expect((await ops.post(`/ops/tenants/${id}`, { intent: 'assign-admin', email: 'new-admin@acme.com' })).status).toBe(302);
    const admin = await loginAs(app, 'new-admin@acme.com');
    expect(auditActions(await (await admin.get('/audit')).text())).toEqual(['指定管理员', '恢复租户', '停用租户', '开通租户']);
  });
});

describe('恢复租户', () => {
  it('恢复后成员需要重新登录；停用与恢复都写入该租户的审计日志', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const before = await loginAs(app, 'admin@acme.com');
    const ops = await operator();
    const { id } = await tenantRow(ops, 'acme');

    const notSuspended = await resume(ops, id);
    expect(notSuspended.status).toBe(400);
    expect(await notSuspended.text()).toContain('未停用');

    await suspend(ops, id, '欠费未续约');
    expect((await resume(ops, id)).status).toBe(302);
    const row = await tenantRow(ops, 'acme');
    expect(row.status).toBe('active');
    expect(row.html).not.toContain('欠费未续约');

    expect((await before.get('/')).headers.get('Location')).toBe('/login');
    const admin = await loginAs(app, 'admin@acme.com');
    const audit = await (await admin.get('/audit')).text();
    expect(auditActions(audit)).toEqual(['恢复租户', '停用租户', '开通租户']);
    expect(audit).toContain('欠费未续约');
    expect(audit).toContain(`运营者 ${OPS}`);

    const events = await (await ops.get('/ops/audit')).text();
    expect(auditActions(events)).toEqual(expect.arrayContaining(['停用租户', '恢复租户']));
  });

  it('与停用并发写入的会话在恢复后同样作废', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const ops = await operator();
    const { id } = await tenantRow(ops, 'acme');
    await suspend(ops, id, '欠费未续约');

    // 模拟消费登录链接与停用并发：会话在停用之后才写入
    const token = 'raced-session-token';
    const db = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await db.connect();
    await db.query(
      `INSERT INTO platform.sessions (member_id, token_hash, expires_at)
       SELECT id, $1, now() + interval '1 day' FROM platform.members WHERE email = 'admin@acme.com'`,
      [createHash('sha256').update(token).digest('hex')],
    );
    await db.end();
    const raced = app.client();
    const cookie = { Cookie: `crm_session=${encodeURIComponent(btoa(JSON.stringify(token)))}` };
    expect((await raced.get('/', cookie)).headers.get('Location')).toBe('/login');

    await resume(ops, id);
    expect((await raced.get('/', cookie)).headers.get('Location')).toBe('/login');
  });
});

// test/http/workbench.test.ts —— 数据查询工作台的 HTTP 接缝：分析师、数据工程师在 /workbench 提交 SQL，看到结果表格或拒绝原因；
// 客户端中止请求即取消查询，同租户已有查询在运行时再提交返回 429。查看者看不到导航、打开与提交都 403。
// 填上表名点「保存」把 SELECT 的结果存为沙箱表，「我的沙箱表」列出自己的表；别人的沙箱读不到。
// 表的主人分享给本租户有沙箱权限的成员后，被分享人在「分享给我的」里看到、能读不能写，撤销后又读不到
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, members, sandboxTables } from '../../app/.server/db/schema';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
let acme: string;
beforeAll(async () => {
  app = await startApp();
  await resetDb();
  ({ acme } = await publishedIdentitySources());
  await memberOf(acme, 'an@acme.com', 'analyst');
  await memberOf(acme, 'vi@acme.com', 'viewer');
});
afterAll(async () => { await app?.close(); await closeDb(); });

const SLOW = `SELECT count(*) FROM ${Array.from({ length: 12 }, (_, i) => `silver.customer c${i}`).join(', ')}`;
const lastAudit = async () => (await getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'workbench.query')))).at(-1);

describe('数据查询工作台', () => {
  it('分析师与数据工程师执行 SELECT 看到结果，写入被拒并说明原因；查看者没有导航、403', async () => {
    const analyst = await loginAs(app, 'an@acme.com');
    const page = await analyst.get('/workbench');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/workbench"');
    expect(html).toContain('name="sql"');

    const res = await analyst.post('/workbench', { sql: "SELECT 'hello' || '-workbench' AS greeting FROM silver.customer LIMIT 1" });
    expect(res.status).toBe(200);
    const result = await res.text();
    expect(result).toContain('greeting');
    expect(result).toContain('hello-workbench');
    expect(await lastAudit()).toMatchObject({ actorEmail: 'an@acme.com', detail: { rows: 1, truncated: false } });

    const denied = await analyst.post('/workbench', { sql: 'DROP TABLE silver.customer' });
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain('只能执行一条 SELECT');

    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.post('/workbench', { sql: 'SELECT count(*) AS n FROM silver.customer' })).text()).toContain('1 行');

    const viewer = await loginAs(app, 'vi@acme.com');
    expect((await viewer.get('/workbench')).status).toBe(403);
    expect((await viewer.post('/workbench', { sql: 'SELECT 1' })).status).toBe(403);
    expect(await (await viewer.get('/')).text()).not.toContain('href="/workbench"');
  });

  it('客户端中止请求即取消查询；运行中再提交返回 429', async () => {
    const analyst = await loginAs(app, 'an@acme.com');
    const controller = new AbortController();
    const pending = analyst.request('/workbench', { method: 'POST', body: new URLSearchParams({ sql: SLOW }), signal: controller.signal })
      .then(r => r.status, () => 'aborted');
    await new Promise(r => setTimeout(r, 1000));
    const busy = await analyst.post('/workbench', { sql: 'SELECT 1' });
    expect(busy.status).toBe(429);
    expect(await busy.text()).toContain('本租户已有查询在运行');

    controller.abort();
    await pending;
    // 查询中断、审计写完后锁才释放
    await expect.poll(async () => (await lastAudit())?.detail, { timeout: 20_000 }).toMatchObject({ sql: SLOW, error: '查询已取消' });
    expect((await analyst.post('/workbench', { sql: 'SELECT 1 AS one' })).status).toBe(200);
  }, 60_000);
});

describe('沙箱表', () => {
  it('保存 SELECT 结果后列在「我的沙箱表」里并能查询；表名不合规、写语句被拒；别的成员看不到也读不到；查看者 403', async () => {
    const analyst = await loginAs(app, 'an@acme.com');
    expect(await (await analyst.get('/workbench')).text()).toContain('还没有沙箱表');

    const saved = await analyst.post('/workbench', { intent: 'save', name: 'my_customers', sql: 'SELECT customer_id FROM silver.customer LIMIT 3' });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('已保存沙箱表 my_customers');
    const page = await (await analyst.get('/workbench')).text();
    const schema = /(sandbox_[0-9a-f]{32})\.my_customers/.exec(page)?.[1];
    expect(schema).toBeDefined();
    expect(page).toMatch(/my_customers<\/td><td[^>]*>3<\/td>/);

    const read = await analyst.post('/workbench', { sql: `SELECT count(*) AS n FROM ${schema}.my_customers` });
    expect(await read.text()).toContain('1 行');

    const badName = await analyst.post('/workbench', { intent: 'save', name: 'gold.x', sql: 'SELECT 1' });
    expect(badName.status).toBe(400);
    expect(await badName.text()).toContain('表名只能用');
    const write = await analyst.post('/workbench', { intent: 'save', name: 'x', sql: 'CREATE TABLE gold.x AS SELECT 1' });
    expect(write.status).toBe(400);
    expect(await write.text()).toContain('只能执行一条 SELECT');

    const engineer = await loginAs(app, 'de@acme.com');
    const theirs = await (await engineer.get('/workbench')).text();
    expect(theirs).not.toContain('my_customers');
    const denied = await engineer.post('/workbench', { sql: `SELECT * FROM ${schema}.my_customers` });
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain(`表 ${schema}.my_customers 不存在或没有权限`);

    const viewer = await loginAs(app, 'vi@acme.com');
    expect((await viewer.post('/workbench', { intent: 'save', name: 'v', sql: 'SELECT 1' })).status).toBe(403);
  });
});

/** 页面上我的沙箱 schema（先保存一张表才会出现在列表里） */
const sandboxOfPage = (html: string, table: string) => new RegExp(`(sandbox_[0-9a-f]{32})\\.${table}`).exec(html)?.[1];
const shareAudits = async (action: 'sandbox.share' | 'sandbox.unshare') => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, action)));
/** 页面「分享给我的」面板的 HTML */
const sharedPanel = (html: string) => html.split('data-shared-with-me')[1]?.split('</table>')[0] ?? '';

describe('分享', () => {
  it('主人分享后被分享人在「分享给我的」里看到并能读，写不了也覆盖不了；撤销后又读不到；分享与撤销记审计', async () => {
    const owner = await loginAs(app, 'an@acme.com');
    await owner.post('/workbench', { intent: 'save', name: 'shared_top', sql: 'SELECT customer_id FROM silver.customer ORDER BY 1 LIMIT 2' });
    const schema = sandboxOfPage(await (await owner.get('/workbench')).text(), 'shared_top')!;
    const engineer = await loginAs(app, 'de@acme.com');

    // 没分享：表在与不在报同样的话
    for (const table of ['shared_top', 'no_such_table']) {
      const denied = await engineer.post('/workbench', { sql: `SELECT count(*) AS n FROM ${schema}.${table}` });
      expect(denied.status).toBe(400);
      expect(await denied.text()).toContain(`表 ${schema}.${table} 不存在或没有权限`);
    }
    expect(sharedPanel(await (await engineer.get('/workbench')).text())).not.toContain('shared_top');

    const shared = await owner.post('/workbench', { intent: 'share', name: 'shared_top', email: 'DE@acme.com ' });
    expect(shared.status).toBe(200);
    expect(await shared.text()).toContain('已把 shared_top 分享给 de@acme.com');
    expect(await (await owner.get('/workbench')).text()).toMatch(/shared_top<\/td>(?:(?!<\/tr>).)*de@acme\.com/s);
    expect((await shareAudits('sandbox.share')).at(-1)).toMatchObject({ actorEmail: 'an@acme.com', detail: { name: 'shared_top', member: 'de@acme.com' } });

    const panel = sharedPanel(await (await engineer.get('/workbench')).text());
    expect(panel).toContain('an@acme.com');
    expect(panel).toContain(`${schema}.shared_top`);
    const read = await engineer.post('/workbench', { sql: `SELECT count(*) AS n FROM ${schema}.shared_top` });
    expect(read.status).toBe(200);
    expect(await read.text()).toMatch(/<td[^>]*>2<\/td>/);
    expect(await (await engineer.post('/workbench', { sql: 'SHOW TABLES' })).text()).toContain('shared_top');

    // 写入、建表被拒；同名另存只存进自己的沙箱，主人的表不变
    for (const sql of [`INSERT INTO ${schema}.shared_top SELECT 'x'`, `CREATE OR REPLACE TABLE ${schema}.shared_top AS SELECT 1 AS x`]) {
      expect((await engineer.post('/workbench', { sql })).status).toBe(400);
      expect((await engineer.post('/workbench', { intent: 'save', name: 'shared_top', sql })).status).toBe(400);
    }
    expect((await engineer.post('/workbench', { intent: 'save', name: 'shared_top', sql: 'SELECT 42 AS answer' })).status).toBe(200);
    const mine = await owner.post('/workbench', { sql: `SELECT * FROM ${schema}.shared_top` });
    expect(await mine.text()).toContain('customer_id');

    const unshared = await owner.post('/workbench', { intent: 'unshare', name: 'shared_top', email: 'de@acme.com' });
    expect(unshared.status).toBe(200);
    expect((await shareAudits('sandbox.unshare')).at(-1)).toMatchObject({ actorEmail: 'an@acme.com', detail: { name: 'shared_top', member: 'de@acme.com' } });
    const again = await engineer.post('/workbench', { sql: `SELECT count(*) AS n FROM ${schema}.shared_top` });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('不存在或没有权限');
    expect(sharedPanel(await (await engineer.get('/workbench')).text())).not.toContain('an@acme.com');
  });

  it('只能分享给本租户有沙箱权限的成员；别人的表、过期的表分享不了；表过期或被分享人降为查看者后分享失效', async () => {
    const owner = await loginAs(app, 'an@acme.com');
    await owner.post('/workbench', { intent: 'save', name: 'rules_top', sql: 'SELECT 1 AS x' });
    const schema = sandboxOfPage(await (await owner.get('/workbench')).text(), 'rules_top')!;
    const globex = await newTenant('globex');
    await memberOf(globex, 'an@globex.com', 'analyst');
    await memberOf(acme, 'de2@acme.com', 'data_engineer');

    const refused: [Record<string, string>, string][] = [
      [{ name: 'rules_top', email: 'vi@acme.com' }, '没有沙箱权限'],
      [{ name: 'rules_top', email: 'an@globex.com' }, '本租户没有成员 an@globex.com'],
      [{ name: 'rules_top', email: 'nobody@acme.com' }, '本租户没有成员 nobody@acme.com'],
      [{ name: 'rules_top', email: 'an@acme.com' }, '不用分享给自己'],
      [{ name: 'no_such_table', email: 'de@acme.com' }, '没有沙箱表 no_such_table'],
    ];
    for (const [form, message] of refused) {
      const res = await owner.post('/workbench', { intent: 'share', ...form });
      expect(res.status, form.email).toBe(400);
      expect(await res.text(), form.email).toContain(message);
    }
    // 别人的表：数据工程师有同名表也只能分享自己的
    const engineer = await loginAs(app, 'de@acme.com');
    expect((await engineer.post('/workbench', { intent: 'share', name: 'rules_top', email: 'an@acme.com' })).status).toBe(400);
    expect(await shareAudits('sandbox.share')).not.toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ name: 'rules_top' }) }));

    // 被分享人降为查看者后读不到（之后恢复角色照常）；表过期后读不到，也不能再分享
    expect((await owner.post('/workbench', { intent: 'share', name: 'rules_top', email: 'de2@acme.com' })).status).toBe(200);
    const other = await loginAs(app, 'de2@acme.com');
    expect((await other.post('/workbench', { sql: `SELECT * FROM ${schema}.rules_top` })).status).toBe(200);
    await getDb().update(members).set({ role: 'viewer' }).where(and(eq(members.tenantId, acme), eq(members.email, 'de2@acme.com')));
    expect((await other.post('/workbench', { sql: `SELECT * FROM ${schema}.rules_top` })).status).toBe(403);
    await getDb().update(members).set({ role: 'data_engineer' }).where(and(eq(members.tenantId, acme), eq(members.email, 'de2@acme.com')));
    expect((await other.post('/workbench', { sql: `SELECT * FROM ${schema}.rules_top` })).status).toBe(200);

    await getDb().update(sandboxTables).set({ expiredAt: new Date() }).where(and(eq(sandboxTables.tenantId, acme), eq(sandboxTables.name, 'rules_top')));
    const expired = await other.post('/workbench', { sql: `SELECT * FROM ${schema}.rules_top` });
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain('不存在或没有权限');
    expect(sharedPanel(await (await other.get('/workbench')).text())).not.toContain('rules_top');
    expect((await owner.post('/workbench', { intent: 'share', name: 'rules_top', email: 'de@acme.com' })).status).toBe(400);
  });
});

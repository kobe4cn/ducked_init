// test/http/workbench.test.ts —— 数据查询工作台的 HTTP 接缝：分析师、数据工程师在 /workbench 提交 SQL，看到结果表格或拒绝原因；
// 客户端中止请求即取消查询，同租户已有查询在运行时再提交返回 429。查看者看不到导航、打开与提交都 403。
// 填上表名点「保存」把 SELECT 的结果存为沙箱表，「我的沙箱表」列出自己的表；别人的沙箱读不到。
// 表的主人分享给本租户有沙箱权限的成员后，被分享人在「分享给我的」里看到、能读不能写，撤销后又读不到。
// 写下需求点「AI 起草」，起草的 SQL 填进编辑框、不执行（ADR-0043）；结果上方「请 AI 解读」先显示确认框，确认后显示解读。
// 左侧目录树只列能读的表（字段类型、行数、湖中位置、带引号的引用）；原始层按数据源名列出视图，数据源改名后别名随之变化
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, members, sandboxTables, sources } from '../../app/.server/db/schema';
import { memberOf, newTenant, onLake } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeLlm, json, platformDefault } from '../pipeline/llm-fixtures';
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

afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

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

  it('没有 JS 时 SQL 框照样能提交，提交后 SQL 留在框里', async () => {
    // 用数据工程师登录：同一邮箱的登录申请有次数限制，其他用例已经用满了分析师的次数
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get('/workbench')).text();
    expect(html).toMatch(/<textarea[^>]*name="sql"[^>]*required/);
    expect(html).toContain('data-sql-editor');
    expect(html).not.toContain('cm-editor');

    const res = await engineer.post('/workbench', { sql: 'SELECT 42 AS answer' });
    expect(res.status).toBe(200);
    const after = await res.text();
    expect(after).toMatch(/<textarea[^>]*name="sql"[^>]*>SELECT 42 AS answer<\/textarea>/);
    expect(after).toContain('answer');
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

describe('AI 起草', () => {
  it('分析师点「AI 起草」后编辑框里是草稿，没有结果表格、不记查询；草稿没过校验时编辑框保留原来的 SQL', async () => {
    await memberOf(acme, 'an-ai@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an-ai@acme.com');
    const draft = 'SELECT city, count(*) AS n FROM silver.customer GROUP BY city';
    let reply = draft;
    platformDefault();
    fakeLlm(f => app.setLlmFetch(f), () => json({ sql: reply }));
    const before = await lastAudit();

    const res = await analyst.post('/workbench', { intent: 'draft', request: '每个城市的客户数', sql: 'SELECT 1' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<textarea[^>]*name="sql"[^>]*>SELECT city, count\(\*\) AS n FROM silver.customer GROUP BY city<\/textarea>/);
    expect(html).toContain('data-drafted');
    expect(html).not.toContain('data-workbench-result');
    expect(await lastAudit()).toEqual(before);

    reply = 'DELETE FROM silver.customer';
    const rejected = await analyst.post('/workbench', { intent: 'draft', request: '清空客户', sql: 'SELECT 1' });
    expect(rejected.status).toBe(422);
    const page = await rejected.text();
    expect(page).toContain('AI 起草的 SQL 没有通过校验');
    expect(page).toMatch(/<textarea[^>]*name="sql"[^>]*>SELECT 1<\/textarea>/);
  });
});

describe('AI 解读', () => {
  it('结果上方有「请 AI 解读」；预览显示确认框（发送 city、剔除哈希列 p），不请求模型；确认后显示解读；两步都保留结果表格', async () => {
    await memberOf(acme, 'an-int@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an-int@acme.com');
    const sql = 'SELECT phone AS p, city FROM silver.customer LIMIT 100';
    platformDefault();
    const { received } = fakeLlm(f => app.setLlmFetch(f), () => json({ interpretation: '客户集中在少数几个城市' }));

    expect(await (await analyst.post('/workbench', { sql })).text()).toContain('value="interpret_preview"');

    const preview = await analyst.post('/workbench', { intent: 'interpret_preview', sql });
    expect(preview.status).toBe(200);
    const confirm = await preview.text();
    expect(confirm).toContain('data-interpret="confirm"');
    expect(confirm).toContain('data-workbench-result');
    expect(confirm).toMatch(/data-interpret-sent="?[^>]*>city</);
    expect(confirm).toMatch(/data-interpret-dropped="?[^>]*>p</);
    expect(received).toEqual([]);

    expect((await analyst.post('/workbench', { intent: 'interpret', sql })).status).toBe(400);
    expect(received).toEqual([]);

    const done = await analyst.post('/workbench', { intent: 'interpret', sql, confirmed: '1' });
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain('data-interpret="result"');
    expect(html).toContain('客户集中在少数几个城市');
    expect(html).toContain('data-workbench-result');
    expect(received).toHaveLength(1);
  });
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

/** 页面目录树的 HTML，以及其中一节（silver、gold、mine、shared） */
const catalogOf = (html: string) => html.split('data-catalog-tree')[1]?.split('data-catalog-end')[0] ?? '';
const catalogSection = (html: string, section: string) => catalogOf(html).split(`data-section="${section}"`)[1]?.split('data-section=')[0] ?? '';
const unescape = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('目录树', () => {
  it('列出 silver、gold、我的沙箱与分享给我的表及字段类型、行数、湖中位置与带引号的引用；他人没分享的沙箱、原始层、stage 与元数据表不出现', async () => {
    await onLake(acme, `CREATE TABLE gold."rfm__catalog-test" AS SELECT range AS n FROM range(3)`);
    // 登录有每邮箱的频率限制，用这里新加的成员
    await memberOf(acme, 'an3@acme.com', 'analyst');
    await memberOf(acme, 'de3@acme.com', 'data_engineer');
    const owner = await loginAs(app, 'an3@acme.com');
    await owner.post('/workbench', { intent: 'save', name: 'catalog_mine', sql: 'SELECT customer_id FROM silver.customer ORDER BY 1 LIMIT 4' });
    const ownerSchema = sandboxOfPage(await (await owner.get('/workbench')).text(), 'catalog_mine')!;
    const engineer = await loginAs(app, 'de3@acme.com');
    await engineer.post('/workbench', { intent: 'save', name: 'catalog_theirs', sql: 'SELECT 1 AS x' });

    const html = unescape(await (await owner.get('/workbench')).text());
    const silver = catalogSection(html, 'silver');
    expect(silver).toContain('data-ref="lake.silver."customer""');
    expect(silver).toMatch(/customer_id<\/span>\s*<span[^>]*>VARCHAR/);
    const gold = catalogSection(html, 'gold');
    expect(gold).toContain('data-ref="lake.gold."rfm__catalog-test""');
    expect(gold).toMatch(/data-rows="3"/);
    const mine = catalogSection(html, 'mine');
    expect(mine).toContain(`data-ref="lake.${ownerSchema}."catalog_mine""`);
    expect(mine).toMatch(/data-rows="4"/);
    expect(mine).toContain(`${ownerSchema}/catalog_mine/`);
    const catalog = catalogOf(html);
    expect(catalog).not.toContain('catalog_theirs');
    // 湖里确有原始层表，下面的断言才有意义
    expect(await onLake(acme, `SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND schema_name LIKE 'bronze_%'`)).not.toHaveLength(0);
    expect(catalog).not.toMatch(/bronze_|stage\.|ducklake_/);
    expect(catalogSection(html, 'shared')).not.toContain('catalog_');

    // 分享后出现在对方的「分享给我的」里
    expect(catalogOf(unescape(await (await engineer.get('/workbench')).text()))).not.toContain('catalog_mine');
    await owner.post('/workbench', { intent: 'share', name: 'catalog_mine', email: 'de3@acme.com' });
    const shared = catalogSection(unescape(await (await engineer.get('/workbench')).text()), 'shared');
    expect(shared).toContain(`data-ref="lake.${ownerSchema}."catalog_mine""`);
    expect(shared).toContain('customer_id');
  });
});

describe('原始层视图', () => {
  it('按数据源名查原始层：改名后新名字可查、旧名字不行，目录随之变化；与保留名冲突时目录里给出原因', async () => {
    await memberOf(acme, 'an4@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an4@acme.com');
    const raw = async () => catalogSection(unescape(await (await analyst.get('/workbench')).text()), 'raw');
    expect(await raw()).toContain('data-ref=""CRM"."customers""');
    const ok = await analyst.post('/workbench', { sql: 'SELECT id, email FROM crm.customers ORDER BY id' });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toMatch(/[0-9a-f]{64}/);
    expect(html).not.toContain('zhang@crm.test');

    const [crm] = await getDb().select().from(sources).where(and(eq(sources.tenantId, acme), eq(sources.name, 'CRM')));
    const rename = (name: string) => getDb().update(sources).set({ name }).where(eq(sources.id, crm.id));
    try {
      await rename('客户库');
      expect((await analyst.post('/workbench', { sql: 'SELECT count(*) AS n FROM 客户库.customers' })).status).toBe(200);
      const old = await analyst.post('/workbench', { sql: 'SELECT * FROM crm.customers' });
      expect(old.status).toBe(400);
      expect(await old.text()).toContain('不能读 crm.customers');
      const renamed = await raw();
      expect(renamed).toContain('data-ref=""客户库"."customers""');
      expect(renamed).not.toContain('"CRM"');

      await rename('gold');
      expect(await raw()).toMatch(/data-raw-source="gold"[\s\S]*与保留名 gold 冲突，原始层视图没有挂载/);
    } finally {
      await rename('CRM');
    }
  });
});

// test/http/workbench.test.ts —— 数据查询工作台的 HTTP 接缝：分析师、数据工程师在 /workbench 提交 SQL，看到结果表格或拒绝原因；
// 客户端中止请求即取消查询，同租户已有查询在运行时再提交返回 429。查看者看不到导航、打开与提交都 403
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs } from '../../app/.server/db/schema';
import { memberOf } from '../pipeline/fixtures';
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

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { enqueueTask } from '../../app/.server/tasks';
import { newTenant, runTask } from '../pipeline/fixtures';
import { createOperator, loginAs, loginAsOperator, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 任务页上的任务：[类型, 状态] */
const taskRows = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-task-kind="([^"]+)"[^>]*data-task-status="(\w+)"[\s\S]*?<\/tr>/g)].map(m => ({ kind: m[1], status: m[2], html: m[0] }));

describe('成员查看本租户的任务', () => {
  it('任何角色都能看到本租户的任务列表与状态，看不到其他租户的任务', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'lake.inventory');
    await runTask(acme, 'demo.seed', { customers: 0 });
    await runTask(globex, 'lake.inventory');
    // 最后入队、不再派发：保持排队中
    await enqueueTask(acme, 'demo.seed', { customers: 10 });
    await enqueueTask(globex, 'lake.inventory');

    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post('/members', { intent: 'invite', email: 'viewer@acme.com', role: 'viewer' })).status).toBe(302);
    const viewer = await loginAs(app, 'viewer@acme.com');
    const home = await (await viewer.get('/')).text();
    expect(home).toContain('href="/tasks"');

    const html = await (await viewer.get('/tasks')).text();
    const rows = taskRows(html);
    expect(rows.map(r => [r.kind, r.status])).toEqual([
      ['demo.seed', 'queued'],
      ['demo.seed', 'failed'],
      ['lake.inventory', 'succeeded'],
    ]);
    expect(rows[0].html).toContain('排队中');
    expect(rows[0].html).toContain('生成演示数据');
    expect(rows[1].html).toContain('失败');
    expect(rows[1].html).toContain('参数 customers');
    expect(rows[2].html).toContain('成功');
  });

  it('成功的任务可以查看结果：各表的行数与运行时的配额', async () => {
    const acme = await newTenant('acme');
    await runTask(acme, 'lake.inventory');
    await runTask(acme, 'demo.seed', { customers: 10 });

    const admin = await loginAs(app, 'admin@acme.com');
    const [seed, inventory] = taskRows(await (await admin.get('/tasks')).text());
    expect(seed.html).toContain('查看结果');
    expect(seed.html).toMatch(/data-result-table="customers"[\s\S]*?>10 行</);
    expect(seed.html).toContain('data-result-table="orders"');
    expect(seed.html).toMatch(/内存 \d+(\.\d+)? ?\w+ · 2 线程/);
    expect(inventory.html).toContain('数据湖里还没有表');
  });
});

describe('运营者设置租户配额', () => {
  it('租户页展示数据湖与配额；修改配额写入该租户的审计日志，不合法的值被拒绝', async () => {
    const acme = await newTenant('acme');
    expect((await createOperator('ops@platform.com')).code).toBe(0);
    const { browser: ops } = await loginAsOperator(app, 'ops@platform.com');

    const page = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(page).toContain(`/tenants/${acme}/`);
    expect(page).toContain(`lake_${acme.replace(/-/g, '')}`);
    expect(page).toContain('data-lake-status="ready"');
    expect(page).toMatch(/name="memoryLimitMb"[^>]*value="2048"|value="2048"[^>]*name="memoryLimitMb"/);

    const bad = await ops.post(`/ops/tenants/${acme}`, { intent: 'set-quota', memoryLimitMb: '64', threads: '2', maxConcurrentTasks: '1' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('单任务内存上限必须是 128 到');

    const ok = await ops.post(`/ops/tenants/${acme}`, { intent: 'set-quota', memoryLimitMb: '4096', threads: '4', maxConcurrentTasks: '3' });
    expect(ok.status).toBe(302);
    const after = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(after).toMatch(/value="4096"/);

    const admin = await loginAs(app, 'admin@acme.com');
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('调整配额');
    expect(audit).toContain('内存 2048 MiB → 4096 MiB，线程 2 → 4，并发任务 1 → 3');
  });
});

describe('本功能上线前开通的租户', () => {
  it('租户页提示还没有数据湖，运营者初始化后即可运行任务，并记入审计日志', async () => {
    const acme = await newTenant('acme');
    // 模拟上线前开通的租户：没有数据湖
    const db = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await db.connect();
    const { rows: [lake] } = await db.query('DELETE FROM platform.tenant_lakes WHERE tenant_id = $1 RETURNING catalog_schema, db_role', [acme]);
    await db.query(`DROP SCHEMA "${lake.catalog_schema}" CASCADE; DROP ROLE "${lake.db_role}"`);
    await db.end();

    expect((await createOperator('ops@platform.com')).code).toBe(0);
    const { browser: ops } = await loginAsOperator(app, 'ops@platform.com');
    const page = await ops.get(`/ops/tenants/${acme}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-lake-status="missing"');
    expect(html).toContain('name="intent" value="init-lake"');
    expect((await runTask(acme, 'lake.inventory')).status).toBe('queued');

    expect((await ops.post(`/ops/tenants/${acme}`, { intent: 'init-lake' })).status).toBe(302);
    expect(await (await ops.get(`/ops/tenants/${acme}`)).text()).toContain('data-lake-status="ready"');
    expect((await runTask(acme, 'lake.inventory')).status).toBe('succeeded');

    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/audit')).text()).toContain('初始化数据湖');
  });
});

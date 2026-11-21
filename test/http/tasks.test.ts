import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { getTenantLake, tenantDataPath } from '../../app/.server/lake';
import { requestLakeMigration } from '../../app/.server/lake-migration';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { enqueueTask, type TaskKind } from '../../app/.server/tasks';
import { drain, newTenant, runTask } from '../pipeline/fixtures';
import { WORKER_SUFFIX } from '../setup-env';
import { createOperator, loginAs, loginAsOperator, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 任务页上的任务：[类型, 状态] */
const taskRows = (html: string) =>
  [...html.matchAll(/<tr[^>]*data-task-kind="([^"]+)"[^>]*data-task-status="(\w+)"[\s\S]*?<\/tr>/g)].map(m => ({ kind: m[1], status: m[2], html: m[0] }));

describe('成员查看本租户的任务', () => {
  it('任何角色都能看到本租户的任务列表与状态，看不到其他租户的任务', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'lake.inventory');
    // 参数不合法：入队校验上线前的任务直接插进队列（裸插），工作进程一侧照样校验并记为失败
    await getDb().insert(tasks).values({ tenantId: acme, kind: 'demo.seed', params: { customers: 0 } });
    await drain();
    await runTask(globex, 'lake.inventory');
    // 最后入队、不再派发：保持排队中
    await enqueueTask(acme, 'demo.seed', { customers: 10 });
    await enqueueTask(globex, 'lake.inventory');

    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post('/members', { intent: 'invite', email: 'viewer@acme.com', role: 'viewer' })).status).toBe(302);
    const viewer = await loginAs(app, 'viewer@acme.com');
    const home = await (await viewer.get('/')).text();
    expect(home).toContain('href="/tasks"');
    // 首页指标卡：只数本租户的任务
    const tile = (label: string) => home.match(new RegExp(`>${label}</div><div[^>]*>(\\d+)<`))?.[1];
    expect([tile('进行中'), tile('失败'), tile('成功')]).toEqual(['1', '1', '1']);
    expect(home).not.toContain('数据源数');
    expect(await (await admin.get('/')).text()).toMatch(/>数据源数<\/div><div[^>]*>0</);

    const html = await (await viewer.get('/tasks')).text();
    const rows = taskRows(html);
    expect(rows.map(r => [r.kind, r.status])).toEqual([
      ['demo.seed', 'queued'],
      ['demo.seed', 'failed'],
      ['lake.inventory', 'succeeded'],
    ]);
    expect(rows.map(r => r.html.match(/>(排队中|运行中|成功|失败)</)?.[1])).toEqual(['排队中', '失败', '成功']);
    expect(rows[0].html).toContain('生成演示数据');
    expect(rows[1].html).toContain('参数 customers');
  });

  it('失败原因按界面语言显示（ADR-0060）：带句式的失败任务出读者的语言，旧任务（无句式）仍是原中文', async () => {
    const acme = await newTenant('acme');
    // 裸插两条失败任务：一条带句式（调度器写入的失联失败同款），一条是只有中文 error 的旧数据（不回填）
    await getDb().insert(tasks).values({ tenantId: acme, kind: 'demo.seed', params: {}, status: 'failed', error: '调度器失联，任务中断', errorMsg: { key: '调度器失联，任务中断' } });
    await getDb().insert(tasks).values({ tenantId: acme, kind: 'lake.inventory', params: {}, status: 'failed', error: '调度器失联，任务中断' });

    const admin = await loginAs(app, 'admin@acme.com');
    // crm_locale 写进 cookie jar：显式传 Cookie 头时 Client 不带 jar，会丢登录会话
    admin.store('crm_locale=en; Path=/');
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    // 英文界面：带句式的那条出英文，旧任务仍显示原中文
    const en = taskRows(await (await admin.get('/tasks')).text());
    const errOf = (rows: ReturnType<typeof taskRows>, kind: string) =>
      rows.find(r => r.kind === kind)!.html.match(/text-red-600">([^<]*)</)![1];
    expect(errOf(en, 'demo.seed')).toBe('Dispatcher lost; task interrupted');
    expect(errOf(en, 'lake.inventory')).toBe('调度器失联，任务中断');

    // 中文界面：两条都是原中文
    admin.store('crm_locale=zh-CN; Path=/');
    const zh = taskRows(await (await admin.get('/tasks')).text());
    expect(errOf(zh, 'demo.seed')).toBe('调度器失联，任务中断');
    expect(errOf(zh, 'lake.inventory')).toBe('调度器失联，任务中断');
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
    expect(inventory.html).toMatch(/data-result-table="silver\._merges"[\s\S]*?>0 行</);
  });

  it('同步与核对任务的结果按表展示，读不到行数的表不报错', async () => {
    const acme = await newTenant('acme');
    // 参数只够领取（sourceId）、不够入队校验：裸插再直接改状态
    const finish = async (kind: TaskKind, params: Record<string, unknown>, result: Record<string, unknown>) => {
      const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind, params }).returning();
      await getDb().update(tasks).set({ status: 'succeeded', result, finishedAt: new Date() }).where(eq(tasks.id, task.id));
    };
    await finish('source.sync', { sourceId: 'x' }, { tables: [{ table: 'orders', rows: 3 }, { table: 'gone_table', error: '源端已没有这张表', gone: true }] });
    await finish('source.verify', { sourceId: 'x' }, { tables: [{ table: 'customers', sourceRows: 12, ok: true }, { table: 'secret', sourceRows: null, ok: null }], differences: 0 });

    const admin = await loginAs(app, 'admin@acme.com');
    const res = await admin.get('/tasks');
    expect(res.status).toBe(200);
    const [verify, sync] = taskRows(await res.text());
    expect(verify.html).toMatch(/data-result-table="customers"[\s\S]*?>12 行</);
    expect(verify.html).toMatch(/data-result-table="secret"[\s\S]*?>—</);
    expect(sync.html).toMatch(/data-result-table="orders"[\s\S]*?>3 行</);
    expect(sync.html).toMatch(/data-result-table="gone_table"[\s\S]*?>—</);
  });

  it('结果形状相近的不同 kind 任务各自按 kind 显示结果，不再按结果形状猜', async () => {
    const acme = await newTenant('acme');
    // 参数过不了入队校验：裸插再直接改状态（任务页只读结果，不读参数）
    const finish = async (kind: TaskKind, params: Record<string, unknown>, result: Record<string, unknown>) => {
      const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind, params }).returning();
      await getDb().update(tasks).set({ status: 'succeeded', result, finishedAt: new Date() }).where(eq(tasks.id, task.id));
    };
    const engine = { memoryLimit: '2 GiB', threads: 2 };
    const keyCheckShape = { tableName: 'shop.customers', keyColumns: ['customer_id'], ok: true, nullRows: 0, duplicates: [] };
    // lake.inspect 的结果顶层带 table / rows，形状像快照表结果，任务页只显示运行配额，不提示数据湖里还没有表
    await finish('lake.inspect', {}, { table: 'gold.metric__791a674d-0000-4000-8000-000000000000', rows: 5, engine });
    // silver.keycheck 的结果带 tableName / ok 等，形状像业务主键检查，任务页不渲染检查结果
    await finish('silver.keycheck', {}, { ...keyCheckShape, engine });
    // source.keycheck 的结果同形，这个 kind 显示主键检查结果
    await finish('source.keycheck', { sourceId: 'x', tableName: 'shop.customers', keyColumns: ['customer_id'], sensitive: false }, { ...keyCheckShape, engine });

    const admin = await loginAs(app, 'admin@acme.com');
    const res = await admin.get('/tasks');
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(taskRows(await res.text()).map(r => [r.kind, r]));
    expect(byKind['lake.inspect'].html).toContain('运行配额');
    expect(byKind['lake.inspect'].html).not.toContain('data-result-table');
    expect(byKind['lake.inspect'].html).not.toContain('数据湖里还没有表');
    expect(byKind['silver.keycheck'].html).toContain('运行配额');
    expect(byKind['silver.keycheck'].html).not.toContain('data-keycheck-result');
    expect(byKind['source.keycheck'].html).toMatch(/data-keycheck-result="shop\.customers"/);
    expect(byKind['source.keycheck'].html).toContain('通过');
  });

  it('生成服务库的任务结果显示服务库版本与各部分行数，空表提示只在盘点数据湖时出现', async () => {
    const acme = await newTenant('acme');
    // 参数过不了入队校验：裸插再直接改状态（不触发服务库激活钩子，不用造服务库文件）
    const finish = async (kind: TaskKind, params: Record<string, unknown>, result: Record<string, unknown>) => {
      const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind, params }).returning();
      await getDb().update(tasks).set({ status: 'succeeded', result, finishedAt: new Date() }).where(eq(tasks.id, task.id));
    };
    const engine = { memoryLimit: '2 GiB', threads: 2 };
    await finish('serving.build', {}, {
      version: 57,
      path: 'x/_serving/v57.duckdb',
      rows: { rfm: 42965, tags: 416010, metrics: 621216, consumer_aliases: 7528, consumer_sources: 92080 },
      engine,
    });
    await finish('lake.inventory', {}, { tables: [], engine });

    const admin = await loginAs(app, 'admin@acme.com');
    const res = await admin.get('/tasks');
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(taskRows(await res.text()).map(r => [r.kind, r]));
    const serving = byKind['serving.build'].html;
    expect(serving).toContain('服务库第 57 版');
    expect(serving).toContain('RFM：');
    expect(serving).toContain('42,965');
    expect(serving).toContain('标签：');
    expect(serving).toContain('416,010');
    expect(serving).toContain('指标：');
    expect(serving).toContain('621,216');
    expect(serving).toContain('退役 ID 对照：');
    expect(serving).toContain('7,528');
    expect(serving).toContain('源端 ID 对照：');
    expect(serving).toContain('92,080');
    expect(serving).not.toContain('数据湖里还没有表');
    expect(byKind['lake.inventory'].html).toContain('数据湖里还没有表');
  });

  it('RFM 分层任务展示快照表与打通不到消费者的订单，快照过期任务列出删除的表', async () => {
    const acme = await newTenant('acme');
    // gold.expire 的 {} 过不了入队校验：裸插再直接改状态
    const finish = async (kind: TaskKind, result: Record<string, unknown>) => {
      const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind, params: {} }).returning();
      await getDb().update(tasks).set({ status: 'succeeded', result, finishedAt: new Date() }).where(eq(tasks.id, task.id));
    };
    const rfmTable = 'gold.rfm__791a674d-0000-4000-8000-000000000000';
    const oldTable = 'gold.rfm__11111111-0000-4000-8000-000000000000';
    await finish('gold.rfm', { table: rfmTable, rows: 147393, unlinkedOrders: 42, params: { asOf: '2026-10-01' }, engine: { memoryLimit: '2 GiB', threads: 2 } });
    await finish('gold.expire', { tables: [oldTable], engine: { memoryLimit: '2 GiB', threads: 2 } });

    const admin = await loginAs(app, 'admin@acme.com');
    const [expire, rfm] = taskRows(await (await admin.get('/tasks')).text());
    expect(rfm.html).toMatch(new RegExp(`data-result-table="${rfmTable}"[\\s\\S]*?>147,393 行<`));
    expect(rfm.html).toMatch(/打通不到消费者的订单：<span[^>]*>42</);
    expect(rfm.html).not.toContain('数据湖里还没有表');
    expect(rfm.html).not.toContain('asOf');
    expect(rfm.html).toContain('运行配额');
    expect(expire.html).toMatch(new RegExp(`data-result-table="${oldTable}"[\\s\\S]*?>已删除<`));
    expect(expire.html).not.toContain('：—');
    expect(expire.html).not.toContain('数据湖里还没有表');
  });
});

describe('运营者设置租户配额', () => {
  it('租户页展示数据湖与配额；修改配额写入该租户的审计日志，不合法的值被拒绝', async () => {
    const acme = await newTenant('acme');
    await createOperator('ops@platform.com');
    const { browser: ops } = await loginAsOperator(app, 'ops@platform.com');

    const page = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(page).toContain(`/tenants/${acme}/`);
    expect(page).toContain(`lake_${acme.replace(/-/g, '')}`);
    expect(page).toContain('data-lake-status="ready"');
    expect(page).toMatch(/name="memoryLimitMb"[^>]*value="2048"|value="2048"[^>]*name="memoryLimitMb"/);
    expect(page).toContain('单个上传文件上限');
    expect(page).toMatch(/name="maxUploadMb"[^>]*value="100"|value="100"[^>]*name="maxUploadMb"/);
    expect(page).toContain('租户存储配额');
    expect(page).toMatch(/name="storageQuotaMb"[^>]*value="10240"|value="10240"[^>]*name="storageQuotaMb"/);

    const bad = await ops.post(`/ops/tenants/${acme}`, { intent: 'set-quota', memoryLimitMb: '64', threads: '2', maxConcurrentTasks: '1', maxUploadMb: '100', storageQuotaMb: '10240' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('单任务内存上限必须是 128 到');

    const badStorage = await ops.post(`/ops/tenants/${acme}`, { intent: 'set-quota', memoryLimitMb: '2048', threads: '2', maxConcurrentTasks: '1', maxUploadMb: '100', storageQuotaMb: '0' });
    expect(badStorage.status).toBe(400);
    expect(await badStorage.text()).toContain('租户存储配额必须是 1 到');

    const ok = await ops.post(`/ops/tenants/${acme}`, { intent: 'set-quota', memoryLimitMb: '4096', threads: '4', maxConcurrentTasks: '3', maxUploadMb: '50', storageQuotaMb: '20480' });
    expect(ok.status).toBe(302);
    const after = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(after).toMatch(/value="4096"/);
    expect(after).toMatch(/name="maxUploadMb"[^>]*value="50"|value="50"[^>]*name="maxUploadMb"/);
    expect(after).toMatch(/name="storageQuotaMb"[^>]*value="20480"|value="20480"[^>]*name="storageQuotaMb"/);

    const admin = await loginAs(app, 'admin@acme.com');
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('调整配额');
    expect(audit).toContain('内存 2048 MiB → 4096 MiB，线程 2 → 4，并发任务 1 → 3，上传 100 MiB → 50 MiB，存储 10240 MiB → 20480 MiB');
  });

  it('配额区块显示桶用量与统计时间；未统计时显示「尚未统计」', async () => {
    const acme = await newTenant('acme');
    await createOperator('ops@platform.com');
    const { browser: ops } = await loginAsOperator(app, 'ops@platform.com');

    const before = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(before).toContain('尚未统计');

    // 模拟调度器统计完一轮写回
    await getDb().execute(sql`UPDATE platform.tenant_lakes SET storage_used_bytes = 5 * 1024 * 1024, storage_measured_at = now() WHERE tenant_id = ${acme}`);
    const after = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(after).toContain('已用 5 MiB / 配额 10240 MiB');
    expect(after).toContain('统计于');
    expect(after).not.toContain('尚未统计');
  });
});

describe('本功能上线前开通的租户', () => {
  it('租户页提示还没有数据湖，运营者初始化后即可运行任务，并记入审计日志', async () => {
    const acme = await newTenant('acme');
    // 模拟上线前开通的租户：没有数据湖
    const db = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await db.connect();
    const { rows: [lake] } = await db.query('DELETE FROM platform.tenant_lakes WHERE tenant_id = $1 RETURNING catalog_schema, db_role, ro_db_role', [acme]);
    await db.query(`DROP SCHEMA "${lake.catalog_schema}" CASCADE; DROP ROLE "${lake.ro_db_role}"; DROP ROLE "${lake.db_role}"`);
    await db.end();

    await createOperator('ops@platform.com');
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

describe('运营后台查看数据湖迁移', () => {
  it('租户页展示当前存储位置与「迁移中」，完成后给出旧位置', async () => {
    const acme = await newTenant('acme');
    const oldPath = (await getTenantLake(acme))!.dataPath;
    const target = join(tmpdir(), `crm_platform_test_lake_moved${WORKER_SUFFIX}`);
    await rm(target, { recursive: true, force: true });
    await createOperator('ops@platform.com');
    const { browser: ops } = await loginAsOperator(app, 'ops@platform.com');

    await requestLakeMigration(null, acme, target);
    const migrating = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(migrating).toContain('data-lake-migration="pending"');
    expect(migrating).toContain(oldPath);
    expect(migrating).toContain(tenantDataPath(target, acme));

    await createDispatcher({ maxWorkers: 1 }).runUntilIdle();
    const done = await (await ops.get(`/ops/tenants/${acme}`)).text();
    expect(done).toContain('data-lake-migration="succeeded"');
    expect(done).toContain(`旧位置 <span class="font-mono">${oldPath}</span>`);
  });
});

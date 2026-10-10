// 数据源的 HTTP 接缝：数据工程师在界面上登记、修改与轮换凭据、测试连接、选定同步范围、查看列统计并确认水位线；凭据在任何页面与接口里都不回显
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER, WRITER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 开通租户并以数据工程师身份登录 */
async function engineerOf(slug: string) {
  const tenantId = await newTenant(slug);
  await memberOf(tenantId, `de@${slug}.com`, 'data_engineer');
  return { tenantId, browser: await loginAs(app, `de@${slug}.com`) };
}

/** 页面 HTML 与 loader 数据（单次请求的 .data 接口）拼在一起：两处都不能出现凭据 */
async function pageAndData(browser: Client, path: string) {
  const html = await (await browser.get(path)).text();
  const data = await (await browser.get(`${path}.data`)).text();
  return html + data;
}

async function register(browser: Client, form: Record<string, string>) {
  return browser.post('/sources', { intent: 'register', ...form });
}

const sourceIdOf = (res: Response) => res.headers.get('Location')!.match(/^\/sources\/([0-9a-f-]{36})$/)![1];

const PG_TABLES = ['customers', 'events', 'orders', 'regions'];

/** 在数据源页保存同步范围：页面列出 listed 这些表，勾选其中的 tables */
const saveScope = (browser: Client, id: string, tables: string[], listed = PG_TABLES) =>
  browser.post(`/sources/${id}`, { intent: 'scope', listed, table: tables });

/** 登记电商库并把可读的表全部选入同步范围，让调度器跑完采集 */
async function registerAndSelect(browser: Client, input: Record<string, string>, tables = PG_TABLES) {
  const id = sourceIdOf(await register(browser, input));
  expect((await saveScope(browser, id, tables)).status).toBe(302);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  return id;
}

describe('登记数据源', () => {
  it('数据工程师登记后跳到数据源页；页面与接口都不回显密码', async () => {
    const { browser } = await engineerOf('acme');
    const res = await register(browser, await pgSourceInput(READER));
    expect(res.status).toBe(302);
    const id = sourceIdOf(res);

    const list = await pageAndData(browser, '/sources');
    expect(list).toContain('电商库');
    expect(list).toContain(`href="/sources/${id}"`);
    expect(list).toMatch(/数据源数[\s\S]*?核对一致[\s\S]*?需要处理/);
    expect(list).toContain('登记新的数据源');
    const detail = await pageAndData(browser, `/sources/${id}`);
    expect(detail).toContain(READER.user);
    expect(detail).toContain('crm_source_test');
    expect(detail).not.toContain(READER.password);
    expect(detail).not.toContain(READER.password.replace(/'/g, '&#x27;'));
    // 登记后只列出表，所有表都不在同步范围内，不采集
    expect(detail).toContain('data-profile-status="none"');
    expect(detail).toContain('有 4 张新表未选');
  });

  it('可写账号被拒绝登记，页面说明哪些对象可写，表单里也不回显密码', async () => {
    const { browser } = await engineerOf('acme');
    const res = await register(browser, await pgSourceInput(WRITER));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('对数据源可写');
    expect(html).toContain('shop.orders（INSERT、UPDATE）');
    expect(html).not.toContain(WRITER.password);
    expect(await (await browser.get('/sources')).text()).not.toContain('电商库');
  });

  it('分析师可以查看数据源但不能登记与修改；查看者看不到数据源', async () => {
    const { tenantId, browser } = await engineerOf('acme');
    const id = sourceIdOf(await register(browser, await pgSourceInput(READER)));
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');

    const analyst = await loginAs(app, 'an@acme.com');
    const list = await (await analyst.get('/sources')).text();
    expect(list).toContain('电商库');
    expect(list).not.toContain('name="intent" value="register"');
    expect(list).not.toContain('登记新的数据源');
    expect(await (await analyst.get(`/sources/${id}`)).text()).not.toContain('name="intent" value="update"');
    expect((await register(analyst, await pgSourceInput(READER, '另一个'))).status).toBe(403);
    expect((await analyst.post(`/sources/${id}`, { intent: 'test' })).status).toBe(403);

    const viewer = await loginAs(app, 'viewer@acme.com');
    expect((await viewer.get('/sources')).status).toBe(403);
    expect(await (await viewer.get('/')).text()).not.toContain('href="/sources"');
  });

  it('看不到其他租户的数据源', async () => {
    const { browser } = await engineerOf('acme');
    const id = sourceIdOf(await register(browser, await pgSourceInput(READER)));
    const { browser: other } = await engineerOf('globex');
    expect((await other.get(`/sources/${id}`)).status).toBe(404);
    expect((await other.post(`/sources/${id}`, { intent: 'test' })).status).toBe(404);
  });
});

describe('测试连接与轮换凭据', () => {
  it('测试连接列出表数；源端改密码后测试失败，填入新密码保存即恢复，审计记下轮换', async () => {
    const { tenantId, browser } = await engineerOf('acme');
    const input = await pgSourceInput(READER);
    const id = sourceIdOf(await register(browser, input));

    const ok = await browser.post(`/sources/${id}`, { intent: 'test' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('连接正常：4 张表，账号只读');

    await grantOnSource(`ALTER ROLE ${READER.user} PASSWORD 'rotated-pass'`);
    const broken = await browser.post(`/sources/${id}`, { intent: 'test' });
    expect(broken.status).toBe(400);
    expect(await broken.text()).toContain('无法连接数据源');

    // 凭据留空表示沿用：原密码已失效，保存被拒绝
    const { password: _, ...withoutPassword } = input;
    expect((await browser.post(`/sources/${id}`, { intent: 'update', ...withoutPassword })).status).toBe(400);
    const saved = await browser.post(`/sources/${id}`, { intent: 'update', ...withoutPassword, password: 'rotated-pass' });
    expect(saved.status).toBe(302);
    expect(await (await browser.post(`/sources/${id}`, { intent: 'test' })).text()).toContain('连接正常');
    expect(await pageAndData(browser, `/sources/${id}`)).not.toContain('rotated-pass');

    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const audit = await (await (await loginAs(app, 'admin@acme.com')).get('/audit')).text();
    expect(audit).toContain('登记数据源');
    expect(audit).toContain('「电商库」（PostgreSQL），4 张表');
    expect(audit).toContain('「电商库」，轮换凭据');
  });

  it('修改后的账号可写时拒绝保存，原有配置不变', async () => {
    const { browser } = await engineerOf('acme');
    const input = await pgSourceInput(READER);
    const id = sourceIdOf(await register(browser, input));
    const res = await browser.post(`/sources/${id}`, { intent: 'update', ...input, ...WRITER });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('对数据源可写');
    const detail = await (await browser.get(`/sources/${id}`)).text();
    expect(detail).toContain(READER.user);
    expect(detail).not.toContain(WRITER.user);
  });
});

describe('列统计与水位线', () => {
  it('采集完成后展示每张表的列统计、同步方式与频率：没有水位线的表全量比对，大表每天一次；确认水位线后按增量同步', async () => {
    const { browser } = await engineerOf('acme');
    const id = await registerAndSelect(browser, await pgSourceInput(READER));

    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toContain('data-profile-status="succeeded"');
    expect(html).toMatch(/data-table="events"[^>]*data-sync-mode="full_compare"/);
    expect(html).not.toContain('未上线');
    expect(html).toMatch(/data-table="events"[\s\S]*?全量比对[\s\S]*?行数达到 1,000（大表）：每天全量比对一次/);
    expect(html).toMatch(/data-table="regions"[^>]*data-sync-mode="full_compare"[\s\S]*?每小时全量比对一次/);
    expect(html).toMatch(/data-table="customers"[^>]*data-sync-mode="needs_confirmation"/);
    expect(html).toMatch(/data-column="email"[\s\S]*?25(\.0)?%[\s\S]*?邮箱 100%/);
    expect(html).toMatch(/data-column="status"[\s\S]*?data-top[^>]*>paid（50），refunded（50）/);

    const res = await browser.post(`/sources/${id}`, { intent: 'confirm-watermark', table: 'customers', column: 'updated_at' });
    expect(res.status).toBe(302);
    const after = await (await browser.get(`/sources/${id}`)).text();
    expect(after).toMatch(/data-table="customers"[^>]*data-sync-mode="watermark"/);
    expect(after).toContain('按 updated_at 每小时增量同步');
  });

  it('展示各表的主键；没有主键的表说明按整行比对，成员可以声明多列业务主键（标出样本中唯一的列），全表检查不唯一时声明不生效', async () => {
    const { browser } = await engineerOf('acme');
    const id = await registerAndSelect(browser, await pgSourceInput(READER));

    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toMatch(/data-table="customers"[\s\S]*?主键：customer_id/);
    expect(html).toMatch(/data-table="regions"[\s\S]*?data-no-key[^>]*>没有主键：按整行比对[\s\S]*?data-key-column="code"[\s\S]*?data-key-candidate="code"[\s\S]*?data-key-column="name"/);
    expect(html).toMatch(/data-table="events"[\s\S]*?data-no-key/);

    const res = await browser.post(`/sources/${id}`, { intent: 'confirm-key', table: 'regions', column: ['code', 'name'] });
    expect(res.status).toBe(302);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect(await (await browser.get(`/sources/${id}`)).text()).toMatch(/data-declared-key="code,name"[\s\S]*?已确认（de@acme.com）/);
    const duplicated = await browser.post(`/sources/${id}`, { intent: 'confirm-key', table: 'events', column: ['event_type'] });
    expect(duplicated.status).toBe(302);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect((await (await browser.get(`/sources/${id}`)).text()).match(/data-declared-key="[^"]*"/g)).toEqual(['data-declared-key="code,name"']);
    const rejected = await browser.post(`/sources/${id}`, { intent: 'confirm-key', table: 'customers', column: 'email' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('已有主键 customer_id');
  });

  it('账号读不了某些表时：测试连接与数据源页都列出这些表，采集跳过它们；一张都读不了时拒绝登记并给出授权语句', async () => {
    const { browser } = await engineerOf('acme');
    const input = await pgSourceInput(READER);
    await grantOnSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);
    const id = sourceIdOf(await register(browser, input));

    const tested = await (await browser.post(`/sources/${id}`, { intent: 'test' })).text();
    expect(tested).toContain('连接正常：3 张表，账号只读；1 张表没有读权限，不能选入同步范围：events');
    const refused = await saveScope(browser, id, PG_TABLES);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('账号没有表 events 的读权限');
    expect((await saveScope(browser, id, ['customers', 'orders', 'regions'])).status).toBe(302);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toContain('data-profile-status="succeeded"');
    expect(html).toContain('不能选入同步范围：events');
    expect(html).not.toContain('data-table="events"');
    expect(html).toMatch(/data-lake-coverage[^>]*>[\s\S]*?已进湖 0 张，未进湖 3 张[\s\S]*?账号没有读权限 1 张/);

    await grantOnSource(`REVOKE USAGE ON SCHEMA shop FROM ${READER.user}`);
    const rejected = await register(browser, { ...input, name: '电商库 2' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(`GRANT USAGE ON SCHEMA shop TO ${READER.user}`);
  });
});

describe('同步', () => {
  it('数据工程师手动触发同步；数据源页显示每张表的同步历史（批次、行数、耗时、水位线）；分析师只能查看', async () => {
    const { tenantId, browser } = await engineerOf('acme');
    const id = await registerAndSelect(browser, await pgSourceInput(READER));

    const before = await (await browser.get(`/sources/${id}`)).text();
    expect(before).toMatch(/data-lake-coverage[^>]*>[\s\S]*?已进湖 0 张，未进湖 4 张/);
    expect(before).toMatch(/data-table="customers"[\s\S]*?data-in-lake="false"[^>]*>未进湖：待确认水位线/);
    expect(before).toMatch(/data-table="events"[\s\S]*?data-in-lake="false"[^>]*>未进湖：等待首次同步/);

    await browser.post(`/sources/${id}`, { intent: 'confirm-watermark', table: 'customers', column: 'updated_at' });
    expect((await browser.post(`/sources/${id}`, { intent: 'sync' })).status).toBe(302);
    expect(await (await browser.get(`/sources/${id}`)).text()).toContain('data-sync-status="queued"');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toContain('data-sync-status="succeeded"');
    expect(html).toMatch(/data-sync-table="customers"[\s\S]*?data-batch="1"[\s\S]*?全表读取[\s\S]*?40[\s\S]*?ms[\s\S]*?2024-06-02 16:00:00/);
    // 没有水位线的表同一次同步里全量比对
    expect(html).toMatch(/data-sync-table="events"[\s\S]*?data-batch-mode="compare"[\s\S]*?全量比对[\s\S]*?1,500（新增 1,500[\s\S]*?没有水位线/);
    // 进湖情况：只有同步成功过的表算进湖，其余的说明原因
    expect(html).toMatch(/data-lake-coverage[^>]*>[\s\S]*?已进湖 3 张，未进湖 1 张：orders（待确认水位线）/);
    expect(html).toMatch(/data-table="customers"[\s\S]*?data-in-lake="true"[^>]*>已进湖/);
    expect(html).toMatch(/data-table="events"[\s\S]*?data-in-lake="true"[^>]*>已进湖/);

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const seen = await (await analyst.get(`/sources/${id}`)).text();
    expect(seen).toContain('data-batch="1"');
    expect(seen).not.toContain('name="intent" value="sync"');
    expect((await analyst.post(`/sources/${id}`, { intent: 'sync' })).status).toBe(403);
  });
});

describe('同步范围', () => {
  it('登记后列出表与估算行数、都不在范围内；按表勾选保存后只采集选中的表，取消勾选即移出；分析师只能查看；修改记入审计', async () => {
    const { tenantId, browser } = await engineerOf('acme');
    const id = sourceIdOf(await register(browser, await pgSourceInput(READER)));
    const listed = await (await browser.get(`/sources/${id}`)).text();
    for (const name of PG_TABLES) expect(listed).toMatch(new RegExp(`data-listed="${name}"[^>]*data-in-scope="false"[\\s\\S]*?data-new`));
    expect(listed).toContain('保存同步范围');
    expect(listed).toMatch(/data-lake-coverage[^>]*>[\s\S]*?已进湖 0 张，未进湖 0 张；不在同步范围 4 张/);

    expect((await saveScope(browser, id, ['customers', 'regions'])).status).toBe(302);
    const selected = await (await browser.get(`/sources/${id}`)).text();
    expect(selected).toContain('data-profile-status="queued"');
    expect(selected).toMatch(/data-listed="customers"[^>]*data-in-scope="true"[\s\S]*?已选入（de@acme.com/);
    expect(selected).toMatch(/data-listed="events"[^>]*data-in-scope="false"/);
    expect(selected).not.toContain('张新表未选');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const profiled = await (await browser.get(`/sources/${id}`)).text();
    expect(profiled).toContain('data-table="customers"');
    expect(profiled).not.toContain('data-table="events"');
    // 范围内、有水位线候选未确认的表标为待确认水位线
    expect(profiled).toMatch(/data-lake-coverage[^>]*>[\s\S]*?未进湖 2 张：customers（待确认水位线）、regions（等待首次同步）；不在同步范围 2 张/);

    expect((await saveScope(browser, id, ['customers'])).status).toBe(302);
    expect(await (await browser.get(`/sources/${id}`)).text()).toMatch(/data-listed="regions"[^>]*data-in-scope="false"/);

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const seen = await (await analyst.get(`/sources/${id}`)).text();
    expect(seen).toMatch(/data-listed="customers"[^>]*data-in-scope="true"/);
    expect(seen).not.toContain('保存同步范围');
    expect((await saveScope(analyst, id, PG_TABLES)).status).toBe(403);

    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const audit = await (await (await loginAs(app, 'admin@acme.com')).get('/audit')).text();
    expect(audit).toContain('修改同步范围');
    expect(audit).toContain('「电商库」，选入 customers、regions');
    expect(audit).toContain('「电商库」，移出 regions');
  });

  it('源端删掉范围内的表后重新列出：页面标为源端已不存在；新出现的表提示未选', async () => {
    const { browser } = await engineerOf('acme');
    const id = await registerAndSelect(browser, await pgSourceInput(READER), ['regions', 'orders']);
    await grantOnSource(`DROP TABLE shop.regions; CREATE TABLE shop.coupons (code text PRIMARY KEY); GRANT SELECT ON shop.coupons TO ${READER.user};`);
    expect((await browser.post(`/sources/${id}`, { intent: 'refresh' })).status).toBe(302);
    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toMatch(/data-listed="regions"[^>]*data-in-scope="true"[\s\S]*?data-gone[^>]*>源端已不存在/);
    expect(html).toMatch(/data-lake-coverage[^>]*>[\s\S]*?regions（源端已删除）/);
    expect(html).toContain('有 1 张新表未选');
    expect(html).toMatch(/data-listed="coupons"[^>]*data-in-scope="false"[\s\S]*?data-new/);
  });
});

describe('湖中数据', () => {
  it('数据工程师触发核对；「湖中数据」标签页每表一行显示覆盖、位置与四项状态，汇总计入未进湖的表；有差异时可立即主键比对，列表标出有差异的数据源', async () => {
    const { tenantId, browser } = await engineerOf('acme');
    const id = await registerAndSelect(browser, await pgSourceInput(READER), ['customers', 'orders', 'regions']);
    await browser.post(`/sources/${id}`, { intent: 'confirm-watermark', table: 'orders', column: 'order_id' });
    await browser.post(`/sources/${id}`, { intent: 'sync' });
    const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    await drain();

    const lake = `/sources/${id}?tab=lake`;
    expect(await (await browser.get(lake)).text()).toContain('data-verify-status="none"');
    // 没有成功核对记录（没核对过、核对失败、排队中）的数据源是「未核对」，不计入「核对一致」
    /** 列表页上该数据源卡片从开头到核对状态 <span> 结束的一段 */
    const card = (html: string) => html.match(new RegExp(`data-source-id="${id}"[\\s\\S]*?data-verify-state="(\\w+)"[^>]*>[\\s\\S]*?</span>`))![0];
    const consistent = (html: string) => Number(html.match(/核对一致<\/div><div[^>]*>(\d+)</)![1]);
    let list = await (await browser.get('/sources')).text();
    expect(card(list)).toMatch(/data-verify-state="none"[\s\S]*?未核对/);
    expect(consistent(list)).toBe(0);
    await getDb().insert(tasks).values({ tenantId, kind: 'source.verify', params: { sourceId: id }, status: 'failed', error: 'x' });
    expect(card(await (await browser.get('/sources')).text())).toContain('data-verify-state="none"');
    const triggered = await browser.post(lake, { intent: 'verify' });
    expect(triggered.status).toBe(302);
    expect(triggered.headers.get('Location')).toBe(lake);
    expect(await (await browser.get(lake)).text()).toContain('data-verify-status="queued"');
    expect(card(await (await browser.get('/sources')).text())).toContain('data-verify-state="none"');
    await drain();

    const html = await (await browser.get(lake)).text();
    expect(html).toContain('data-verify-status="succeeded"');
    expect(html).toMatch(/data-verify-summary[^>]*>源端 4 张表：已进湖 2 张，未进湖 2 张（不在同步范围 1 张、待确认水位线 1 张）；有差异 0 张/);
    expect(html).toMatch(/data-verify-table="orders"[^>]*data-coverage="in_lake"[\s\S]*?bronze_[0-9a-f]{32}\.orders[\s\S]*?data-check="files" data-ok="true"[\s\S]*?data-check="structure" data-ok="true"[\s\S]*?data-check="data" data-ok="true"/);
    expect(html).toMatch(/data-verify-table="events"[^>]*data-coverage="out_of_scope"[\s\S]*?不在同步范围[\s\S]*?1,500/);
    expect(html).toMatch(/data-verify-table="customers"[^>]*data-coverage="needs_watermark"/);
    expect(html).not.toContain('name="intent" value="reconcile"');
    list = await (await browser.get('/sources')).text();
    expect(list).not.toContain('data-verify-differences');
    expect(card(list)).toMatch(/data-verify-state="ok"[\s\S]*?一致/);
    expect(consistent(list)).toBe(1);

    await grantOnSource('DELETE FROM shop.orders WHERE order_id = 3');
    await browser.post(lake, { intent: 'verify' });
    await drain();
    const diff = await (await browser.get(lake)).text();
    expect(diff).toMatch(/data-verify-table="orders"[^>]*data-verify-ok="false"[\s\S]*?湖中多出（源端已删）1 个：3[\s\S]*?data-check="data" data-ok="false"[^>]*>湖中多出 1</);
    expect(diff).toContain('name="intent" value="reconcile"');
    list = await (await browser.get('/sources')).text();
    expect(card(list)).toMatch(/data-verify-state="diff"[^>]*data-verify-differences="1"/);
    expect(consistent(list)).toBe(0);
    // 最近一次核对失败时仍取最近一次成功核对的结果
    await getDb().insert(tasks).values({ tenantId, kind: 'source.verify', params: { sourceId: id }, status: 'failed', error: 'x' });
    expect(card(await (await browser.get('/sources')).text())).toContain('data-verify-state="diff"');

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const seen = await (await analyst.get(lake)).text();
    expect(seen).toContain('data-verify-table="orders"');
    expect(seen).not.toContain('name="intent" value="verify"');
    expect(seen).not.toContain('name="intent" value="reconcile"');
    expect((await analyst.post(lake, { intent: 'verify' })).status).toBe(403);
    expect((await analyst.post(lake, { intent: 'reconcile' })).status).toBe(403);
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');
    expect((await (await loginAs(app, 'viewer@acme.com')).get(lake)).status).toBe(403);

    expect((await browser.post(lake, { intent: 'reconcile' })).headers.get('Location')).toBe(lake);
    // 主键比对在排队时不能再核对
    const busy = await browser.post(lake, { intent: 'verify' });
    expect(busy.status).toBe(400);
    expect(await busy.text()).toContain('已有一次同步在排队或运行中');
    await drain();
    await browser.post(lake, { intent: 'verify' });
    await drain();
    expect(await (await browser.get(lake)).text()).toMatch(/有差异 0 张/);
    expect(await (await browser.get('/sources')).text()).not.toContain('data-verify-differences');
  });
});

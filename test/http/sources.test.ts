// 数据源的 HTTP 接缝：数据工程师在界面上登记、修改与轮换凭据、测试连接、查看列统计并确认水位线；凭据在任何页面与接口里都不回显
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
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

describe('登记数据源', () => {
  it('数据工程师登记后跳到数据源页；页面与接口都不回显密码', async () => {
    const { browser } = await engineerOf('acme');
    const res = await register(browser, await pgSourceInput(READER));
    expect(res.status).toBe(302);
    const id = sourceIdOf(res);

    const list = await pageAndData(browser, '/sources');
    expect(list).toContain('电商库');
    expect(list).toContain(`href="/sources/${id}"`);
    const detail = await pageAndData(browser, `/sources/${id}`);
    expect(detail).toContain(READER.user);
    expect(detail).toContain('crm_source_test');
    expect(detail).not.toContain(READER.password);
    expect(detail).not.toContain(READER.password.replace(/'/g, '&#x27;'));
    expect(detail).toContain('data-profile-status="queued"');
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
  it('采集完成后展示每张表的列统计、同步方式；大表提示本期不支持；确认水位线后按增量同步', async () => {
    const { browser } = await engineerOf('acme');
    const id = sourceIdOf(await register(browser, await pgSourceInput(READER)));
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toContain('data-profile-status="succeeded"');
    expect(html).toMatch(/data-table="events"[^>]*data-sync-mode="unsupported"/);
    expect(html).toContain('无水位线的大表本期不支持');
    expect(html).toMatch(/data-table="regions"[^>]*data-sync-mode="full_compare"/);
    expect(html).toMatch(/data-table="customers"[^>]*data-sync-mode="needs_confirmation"/);
    expect(html).toMatch(/data-column="email"[\s\S]*?25(\.0)?%[\s\S]*?邮箱 100%/);

    const res = await browser.post(`/sources/${id}`, { intent: 'confirm-watermark', table: 'customers', column: 'updated_at' });
    expect(res.status).toBe(302);
    const after = await (await browser.get(`/sources/${id}`)).text();
    expect(after).toMatch(/data-table="customers"[^>]*data-sync-mode="watermark"/);
    expect(after).toContain('按 updated_at 增量同步');
  });

  it('账号读不了某些表时：测试连接与数据源页都列出这些表，采集跳过它们；一张都读不了时拒绝登记并给出授权语句', async () => {
    const { browser } = await engineerOf('acme');
    const input = await pgSourceInput(READER);
    await grantOnSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);
    const id = sourceIdOf(await register(browser, input));

    const tested = await (await browser.post(`/sources/${id}`, { intent: 'test' })).text();
    expect(tested).toContain('连接正常：3 张表，账号只读；1 张表没有读权限，采集时跳过：events');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const html = await (await browser.get(`/sources/${id}`)).text();
    expect(html).toContain('data-profile-status="succeeded"');
    expect(html).toContain('已跳过 1 张表：events');
    expect(html).not.toContain('data-table="events"');

    await grantOnSource(`REVOKE USAGE ON SCHEMA shop FROM ${READER.user}`);
    const rejected = await register(browser, { ...input, name: '电商库 2' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(`GRANT USAGE ON SCHEMA shop TO ${READER.user}`);
  });
});

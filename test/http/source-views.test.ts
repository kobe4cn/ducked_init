// 源视图的 HTTP 接缝：数据工程师在数据源页的「源视图」标签页新建源视图，保存后看到视图的列与样本（敏感列是哈希），读标准层的 SQL 被拒绝并给出原因；
// 最后保存草稿的人不能自己发布，由另一位数据工程师或管理员在页面上发布；没有登录会话的请求发布不了。分析师只读，查看者看不到，其他租户与别的数据源路径一律 404
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 开通租户 acme，de@acme.com 登记电商库、选入全部表，确认 customers 的水位线并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return { tenantId, sourceId: id };
}

const VIEW = 'SELECT customer_id, name, email, city, _op, _batch, _commit_ts FROM customers';

/** 新建源视图后跳转到的详情页路径（带 ?preview=1） */
const locationOf = (res: Response) => res.headers.get('location') ?? '';

describe('源视图', () => {
  it('数据工程师新建源视图后看到列与样本（邮箱是哈希）；读标准层被拒绝；最后保存的人发布不了，另一位成员在页面上发布', async () => {
    const { sourceId } = await syncedSource();
    const author = await loginAs(app, 'de@acme.com');
    const empty = await (await author.get(`/sources/${sourceId}?tab=views`)).text();
    expect(empty).toContain('还没有源视图');
    expect(empty).toContain(`/sources/${sourceId}/views/new`);

    const rejected = await author.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'customer_city', sql: 'SELECT * FROM silver.customer' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('源视图只能读本数据源原始层的表，不能读 silver.customer');

    const created = await author.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'customer_city', sql: VIEW });
    expect(created.status).toBe(302);
    const page = locationOf(created);
    expect(page).toMatch(new RegExp(`^/sources/${sourceId}/views/[0-9a-f-]{36}\\?preview=1$`));
    const html = await (await author.get(page)).text();
    expect(html).toContain('data-preview="1"');
    expect(html).toMatch(/data-preview-column="email" data-sensitive="true"/);
    expect(html).toMatch(/data-preview-column="city"(?! data-sensitive)/);
    expect(html.match(/data-preview-row/g)).toHaveLength(20);
    expect(html).toMatch(/>[0-9a-f]{64}</);
    expect(html).not.toMatch(/[\w.]+@example\.\w+/);
    expect(html).toContain('你最后改了这一版草稿');
    expect(await (await author.get(`/sources/${sourceId}?tab=views`)).text()).toContain('data-source-view="customer_city"');

    const viewPath = page.replace(/\?.*$/, '');
    expect((await author.post(viewPath, { intent: 'publish', version: '1' })).status).toBe(403);
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get(viewPath)).text()).toContain('发布 v1');
    expect((await admin.post(viewPath, { intent: 'publish', version: '1' })).status).toBe(302);
    expect((await admin.post(viewPath, { intent: 'publish', version: '1' })).status).toBe(400);
    expect(await (await author.get(`${viewPath}?tab=versions`)).text()).toContain('admin@acme.com，');

    // 没有登录会话的请求一律去登录，发布不了
    const anonymous = await app.client().post(viewPath, { intent: 'publish', version: '1' });
    expect(anonymous.status).toBe(302);
    expect(locationOf(anonymous)).toBe('/login');
  });

  it('分析师只读，查看者 403，其他租户与别的数据源路径 404', async () => {
    const { tenantId, sourceId } = await syncedSource();
    const author = await loginAs(app, 'de@acme.com');
    const viewPath = locationOf(await author.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'v', sql: VIEW })).replace(/\?.*$/, '');

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const html = await (await analyst.get(viewPath)).text();
    expect(html).toContain('只读。');
    expect(html).toContain('仅管理员、数据工程师可以发布映射与定义');
    expect(html).not.toContain('value="save"');
    expect((await analyst.get(`/sources/${sourceId}/views/new`)).status).toBe(403);
    for (const form of [{ intent: 'save', sql: VIEW }, { intent: 'publish', version: '1' }, { intent: 'discard' }] as Record<string, string>[]) {
      expect((await analyst.post(viewPath, form)).status, form.intent).toBe(403);
    }
    expect((await analyst.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'w', sql: VIEW })).status).toBe(403);

    await memberOf(tenantId, 'vi@acme.com', 'viewer');
    expect((await (await loginAs(app, 'vi@acme.com')).get(viewPath)).status).toBe(403);

    const other = await registerSource(await memberOf(tenantId, 'de@acme.com'), await pgSourceInput(READER, '另一个库'));
    expect((await author.get(viewPath.replace(sourceId, other.id))).status).toBe(404);
    expect((await author.post(viewPath.replace(sourceId, other.id), { intent: 'discard' })).status).toBe(404);

    const globex = await newTenant('globex');
    await memberOf(globex, 'de@globex.com', 'data_engineer');
    const outsider = await loginAs(app, 'de@globex.com');
    expect((await outsider.get(viewPath)).status).toBe(404);
    expect((await outsider.post(viewPath, { intent: 'save', sql: VIEW })).status).toBe(404);
    expect((await outsider.get(`/sources/${sourceId}/views/new`)).status).toBe(404);
  });
});

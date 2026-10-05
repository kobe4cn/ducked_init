// 自定义实体的 HTTP 接缝（ADR-0019）：数据工程师在「自定义实体」页新建登记（不合格时页面给出原因），最后保存的人发布不了，
// 另一位成员在详情页发布；再改是新的一版草稿。分析师只读，查看者 403，其他租户 404；导航「映射」后面是「自定义实体」。
// 有发布权限的成员删除实体后回到列表
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 新建表单：两个字段与三行空行，第 2 行勾选敏感 */
const STORE = {
  intent: 'create',
  name: 'custom_store',
  label: '门店',
  kind: 'dimension',
  fieldName: ['store_id', 'manager_phone', '', '', ''],
  fieldType: ['string', 'string', 'string', 'string', 'string'],
  fieldDescription: ['门店编号', '店长手机', '', '', ''],
  fieldSensitive: ['1'],
  primaryKey: 'store_id',
};

const locationOf = (res: Response) => res.headers.get('location') ?? '';

/** 开通租户 acme，de@acme.com 是数据工程师 */
async function acme() {
  const tenantId = await newTenant('acme');
  await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  return tenantId;
}

describe('自定义实体', () => {
  it('数据工程师新建登记，不合格时页面给出原因；最后保存的人发布不了，另一位成员发布后再改是新的一版草稿', async () => {
    await acme();
    const author = await loginAs(app, 'de@acme.com');
    const empty = await (await author.get('/entities')).text();
    expect(empty).toContain('还没有自定义实体');
    expect(empty).toContain('name="fieldName"');
    expect(empty).toMatch(/href="\/mappings"[^]*?映射[^]*?href="\/entities"[^]*?自定义实体/);

    const rejected = await author.post('/entities', { ...STORE, fieldType: ['string', 'integer', 'string', 'string', 'string'] });
    expect(rejected.status).toBe(400);
    const html = await rejected.text();
    expect(html).toContain('敏感字段在标准层只存哈希，类型只能是 string');
    expect(html).toContain('value="manager_phone"');
    expect((await author.post('/entities', { ...STORE, name: 'store' })).status).toBe(400);
    expect(await (await author.post('/entities', { ...STORE, primaryKey: 'store_code' })).text()).toContain('主键 store_code 不是已登记的字段');

    const created = await author.post('/entities', STORE);
    expect(created.status).toBe(302);
    const page = locationOf(created);
    expect(page).toMatch(/^\/entities\/[0-9a-f-]{36}$/);
    expect(await (await author.get('/entities')).text()).toContain('data-custom-entity="custom_store"');
    const detail = await (await author.get(page)).text();
    expect(detail).toContain('你最后改了这一版草稿');
    expect(detail).toContain('value="manager_phone"');
    expect((await author.post(page, { intent: 'publish', version: '1' })).status).toBe(403);

    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get(page)).text()).toContain('发布 v1');
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(302);
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(400);
    expect(await (await author.get(`${page}?tab=versions`)).text()).toContain('admin@acme.com，');

    // 再改是新的一版草稿；名称不随表单改变
    const { intent: _, name: __, ...rest } = STORE;
    expect((await author.post(page, { ...rest, intent: 'save', label: '线下门店', name: 'custom_other' })).status).toBe(302);
    const versions = await (await author.get(`${page}?tab=versions`)).text();
    expect(versions).toContain('data-version="2" data-version-status="draft"');
    expect(versions).toContain('data-version="1" data-version-status="published"');
    expect(versions).toContain('custom_store');
    expect(versions).not.toContain('custom_other');
  });

  it('分析师只读，查看者 403，其他租户 404', async () => {
    const tenantId = await acme();
    const author = await loginAs(app, 'de@acme.com');
    const page = locationOf(await author.post('/entities', STORE));

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    expect(await (await analyst.get('/entities')).text()).toContain('data-custom-entity="custom_store"');
    const html = await analyst.get(page).then(r => r.text());
    expect(html).toContain('只读。');
    expect(html).toContain('仅管理员、数据工程师可以发布映射与定义');
    expect(html).not.toContain('value="save"');
    expect(html).not.toContain('value="delete"');
    expect(html).toContain('data-field="manager_phone"');
    expect((await analyst.post('/entities', { ...STORE, name: 'custom_x' })).status).toBe(403);
    const { intent: _, ...rest } = STORE;
    for (const form of [{ ...rest, intent: 'save' }, { intent: 'publish', version: '1' }, { intent: 'discard' }, { intent: 'delete' }] as Record<string, string | string[]>[]) {
      expect((await analyst.post(page, form)).status, String(form.intent)).toBe(403);
    }

    await memberOf(tenantId, 'vi@acme.com', 'viewer');
    const viewer = await loginAs(app, 'vi@acme.com');
    expect((await viewer.get('/entities')).status).toBe(403);
    expect((await viewer.get(page)).status).toBe(403);

    const globex = await newTenant('globex');
    await memberOf(globex, 'de@globex.com', 'data_engineer');
    const outsider = await loginAs(app, 'de@globex.com');
    expect((await outsider.get(page)).status).toBe(404);
    expect((await outsider.post(page, { ...rest, intent: 'save' })).status).toBe(404);
    expect((await outsider.post(page, { intent: 'discard' })).status).toBe(404);
    expect((await outsider.post(page, { intent: 'delete' })).status).toBe(404);
    expect(await (await outsider.get('/entities')).text()).not.toContain('data-custom-entity=');

    // 从没发布过的实体丢弃草稿即整条删除，回到列表
    const discarded = await author.post(page, { intent: 'discard' });
    expect(locationOf(discarded)).toBe('/entities');
    expect((await author.get(page)).status).toBe(404);
  });

  it('有发布权限的成员删除实体，回到列表', async () => {
    await acme();
    const author = await loginAs(app, 'de@acme.com');
    const page = locationOf(await author.post('/entities', STORE));
    expect(await (await author.get(page)).text()).toContain('value="delete"');
    const deleted = await author.post(page, { intent: 'delete' });
    expect(locationOf(deleted)).toBe('/entities');
    expect((await author.get(page)).status).toBe(404);
    expect(await (await author.get('/entities')).text()).not.toContain('data-custom-entity=');
  });
});

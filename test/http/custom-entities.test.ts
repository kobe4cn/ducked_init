// test/http/custom-entities.test.ts —— 自定义实体的 HTTP 接缝（ADR-0019）：数据工程师在「自定义实体」页新建登记（不合格时页面给出原因），最后保存的人发布不了，
// 另一位成员在详情页发布；再改是新的一版草稿。分析师只读，查看者 403，其他租户 404；导航「映射」后面是「自定义实体」。
// 有发布权限的成员删除实体后回到列表；从源表一键生成后跳到实体详情页。已发布映射在用、但没登记的实体在列表与详情页标为待确认的推断登记，确认保存、另一位成员发布后提示消失；
// 登记发布前映射列表与详情页提示实体待补登；映射详情页的实体卡片链接到实体页，映射页用登记的中文名
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { customEntities } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
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

/** 映射详情页实体卡片的链接 */
const ENTITY_CARD = /href="([^"]+)"[^>]*><span class="grid size-11[^"]*bg-violet-100/;

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

  it('从源表一键生成：选数据源和表提交后跳到实体详情页；没有主键的表页面给出原因', async () => {
    const tenantId = await acme();
    const de = await memberOf(tenantId, 'de@acme.com');
    const { id: sourceId } = await registerSource(de, await pgSourceInput(READER));
    await selectAllTables(de, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const author = await loginAs(app, 'de@acme.com');
    expect(await (await author.get('/entities')).text()).toContain('从源表一键生成');
    const form = await (await author.get('/entities?passthrough=1')).text();
    expect(form).toContain('value="passthrough"');
    expect(form).toContain('>customers</option>');

    const rejected = await author.post('/entities?passthrough=1', { intent: 'passthrough', sourceId, table: 'regions' });
    expect(rejected.status).toBe(400);
    const error = await rejected.text();
    expect(error).toContain('没有主键，也没有声明业务主键');
    expect(error).toContain('>customers</option>');

    const created = await author.post('/entities?passthrough=1', { intent: 'passthrough', sourceId, table: 'customers' });
    expect(locationOf(created)).toMatch(/^\/entities\/[0-9a-f-]{36}$/);
    const detail = await (await author.get(locationOf(created))).text();
    expect(detail).toContain('custom_customers');
    expect(detail).toContain('value="customer_id"');
    expect(await (await author.get('/mappings')).text()).toMatch(/customers[^]*?custom_customers|custom_customers[^]*?customers/);
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

/** 已发布映射在用 custom_store、但它没有登记（模拟登记功能上线前就在用的实体）。返回映射 ID */
async function legacyStoreMapping() {
  const tenantId = await acme();
  const [de, de2] = [await memberOf(tenantId, 'de@acme.com'), await memberOf(tenantId, 'de2@acme.com')];
  const { id: sourceId } = await registerSource(de, await pgSourceInput(READER));
  await selectAllTables(de, sourceId);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  await publishCustomEntity(de2, await createCustomEntity(de, {
    name: 'custom_store',
    label: '门店',
    kind: 'dimension',
    fields: [
      { name: 'store_id', type: 'string', description: '', sensitive: false },
      { name: 'manager_phone', type: 'string', description: '', sensitive: true },
    ],
    primaryKey: ['store_id'],
  }), 1);
  const mappingId = await publish(de, de2, sourceId, `model: 1
entity: custom_store
table: customers
extensions:
  store_id: { type: string, expr: string(customer_id) }
  manager_phone: { type: string, expr: phone }
dedupe: { key: [store_id] }
`);
  // 模拟登记功能上线前就在用的实体
  await getDb().delete(customEntities);
  return mappingId;
}

describe('推断登记', () => {
  it('已发布映射在用、但没登记的实体在列表与详情页标为待确认；直接发布被拒，一位成员确认保存、另一位成员发布后提示消失', async () => {
    await legacyStoreMapping();
    const author = await loginAs(app, 'de@acme.com');
    const list = await (await author.get('/entities')).text();
    expect(list).toContain('推断登记 · 待确认 v1');
    const page = `/entities/${list.match(/href="\/entities\/([0-9a-f-]{36})"/)![1]}`;
    const detail = await (await author.get(page)).text();
    expect(detail).toContain('这份登记由已发布映射推断，请核对字段、类型和主键后保存确认');
    expect(detail).toContain('value="manager_phone"');

    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get(page)).text()).toContain('推断出的登记要先由一位成员确认（保存）后，再由另一位成员发布');
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(400);

    const { intent: _, name: __, ...rest } = STORE;
    expect((await author.post(page, { ...rest, intent: 'save' })).status).toBe(302);
    expect(await (await author.get('/entities')).text()).not.toContain('推断登记');
    expect(await (await admin.get(page)).text()).not.toContain('由已发布映射推断');
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await author.get('/entities')).text()).toContain('已发布 v1');
  });

  it('映射列表与详情页提示目标实体待补登并链接到实体页；只有草稿的登记也算，另一位成员发布登记后提示消失', async () => {
    const mappingId = await legacyStoreMapping();
    const author = await loginAs(app, 'de@acme.com');
    const list = await (await author.get('/mappings')).text();
    expect(list).toContain('实体待补登');
    const page = `/entities/${list.match(/href="\/entities\/([0-9a-f-]{36})"/)![1]}`;
    expect(await (await author.get(page)).text()).toContain('custom_store');
    const detail = await (await author.get(`/mappings/${mappingId}`)).text();
    expect(detail).toContain('实体待补登');
    expect(detail).toContain(`href="${page}"`);
    expect(detail).toContain('保存不了新草稿');

    // 确认保存后只有草稿，仍然待补登
    const { intent: _, name: __, ...rest } = STORE;
    expect((await author.post(page, { ...rest, intent: 'save' })).status).toBe(302);
    expect(await (await author.get('/mappings')).text()).toContain('实体待补登');

    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await author.get('/mappings')).text()).not.toContain('实体待补登');
    expect(await (await author.get(`/mappings/${mappingId}`)).text()).not.toContain('实体待补登');
  });

  it('映射详情页的实体卡片对自定义实体标「自定义实体」并链接到它的实体页；列表与详情页用登记的中文名，发布前取草稿的', async () => {
    const mappingId = await legacyStoreMapping();
    const author = await loginAs(app, 'de@acme.com');
    const detail = await (await author.get(`/mappings/${mappingId}`)).text();
    const page = `/entities/${detail.match(/href="\/entities\/([0-9a-f-]{36})"/)![1]}`;
    expect(detail).toContain('text-slate-500">自定义实体<');
    expect(detail.match(ENTITY_CARD)![1]).toBe(page);
    expect(detail).toContain('store（custom_store）');

    const { intent: _, name: __, ...rest } = STORE;
    expect((await author.post(page, { ...rest, intent: 'save' })).status).toBe(302);
    expect(await (await author.get('/mappings')).text()).toContain('门店（custom_store）');
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post(page, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await author.get(`/mappings/${mappingId}`)).text()).toContain('门店（custom_store）');
  });
});

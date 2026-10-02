// 标准模型与映射的 HTTP 接缝：任何成员都能浏览标准模型；数据工程师在界面上编写映射（不合格的 YAML 被拒绝并给出位置），
// 也能按规则生成草稿填进编辑框（不保存）；草稿作者不能自己发布，由另一位数据工程师或管理员发布；分析师只读，查看者看不到映射，其他租户一律 404
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 开通租户，登记电商库并把表全部选入同步范围、采集完；返回租户与数据源 */
async function tenantWithSource(slug: string) {
  const tenantId = await newTenant(slug);
  const engineer = await memberOf(tenantId, `de@${slug}.com`, 'data_engineer');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  return { tenantId, sourceId: id };
}

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
`;

/** 页面上映射编辑框里的 YAML */
const editorYaml = (html: string) => html.match(/<textarea[^>]*name="yaml"[^>]*>([\s\S]*?)<\/textarea>/)![1]
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const mappingIdOf = (res: Response) => res.headers.get('Location')!.match(/^\/mappings\/([0-9a-f-]{36})$/)![1];

describe('标准模型', () => {
  it('任何成员都能浏览标准模型的实体与字段说明', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = await (await viewer.get('/model')).text();
    expect(html).toContain('标准模型 v1.2');
    for (const entity of ['customer', 'order', 'order_item', 'product', 'event', 'touch', 'membership', 'points_transaction', 'consent', 'preference']) expect(html).toContain(`data-entity="${entity}"`);
    expect(html).toContain('标准枚举：created、paid、shipped、completed、cancelled、refunded');
    expect(html).toContain('标准枚举：earn、spend、redeem、expire、adjust');
    expect(html).toContain('标准枚举：granted、revoked');
    expect(html).toContain('data-function="from_timezone"');
    expect(await (await viewer.get('/')).text()).toContain('href="/model"');
    // 查看者看不到映射
    expect((await viewer.get('/mappings')).status).toBe(403);
  });
});

describe('编写与发布映射', () => {
  it('不符合 Schema 的映射被拒绝并给出位置；合格的保存为草稿，作者不能自己发布', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');

    const rejected = await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS.replace('amount: amount', "amount: sql('drop table x')") });
    expect(rejected.status).toBe(400);
    const html = await rejected.text();
    expect(html).toContain('映射有 1 处问题，未保存');
    expect(html).toContain('第 6 行第 11 列（fields.amount）：表达式错误：函数 sql 不在白名单内');
    expect(await (await engineer.get('/mappings')).text()).toContain('还没有映射');

    const created = await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS });
    expect(created.status).toBe(302);
    const id = mappingIdOf(created);
    const detail = await (await engineer.get(`/mappings/${id}`)).text();
    expect(detail).toContain('data-version-status="draft"');
    expect(detail).toContain('你改过这一版草稿，需由另一位数据工程师或管理员发布');
    expect((await engineer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(403);
  });

  it('另一位数据工程师发布后版本锁定并入队合并；审计记下起草与发布', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    expect(await (await reviewer.get(`/mappings/${id}`)).text()).toContain('name="intent" value="publish"');
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    const detail = await (await reviewer.get(`/mappings/${id}`)).text();
    expect(detail).toContain('data-version-status="published"');
    expect(detail).not.toContain('name="intent" value="publish"');
    expect(await (await reviewer.get('/tasks')).text()).toContain('合并到标准层');

    // 已发布的版本再保存是新的一版草稿
    expect((await author.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS.replace('amount: amount', 'amount: amount / 100') })).status).toBe(302);
    const after = await (await author.get(`/mappings/${id}`)).text();
    expect(after).toContain('data-version="2" data-version-status="draft"');
    expect(after).toContain('data-version="1" data-version-status="published"');

    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const audit = await (await (await loginAs(app, 'admin@acme.com')).get('/audit')).text();
    expect(audit).toContain('「电商库」orders → 订单，第 1 版草稿');
    expect(audit).toContain('「电商库」orders → 订单，第 1 版（作者 de@acme.com）');
  });

  it('分析师只能查看映射，不能起草与发布；其他租户看不到', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const id = mappingIdOf(await (await loginAs(app, 'de@acme.com')).post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const list = await (await analyst.get('/mappings')).text();
    expect(list).toContain(`data-mapping-id="${id}"`);
    expect(list).not.toContain('name="intent" value="create"');
    expect(await (await analyst.get(`/mappings/${id}`)).text()).toContain('仅管理员、数据工程师可以发布映射与定义');
    expect((await analyst.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS })).status).toBe(403);
    expect((await analyst.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(403);
    expect((await analyst.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS })).status).toBe(403);

    const other = await newTenant('globex');
    await memberOf(other, 'de@globex.com', 'data_engineer');
    const stranger = await loginAs(app, 'de@globex.com');
    expect((await stranger.get(`/mappings/${id}`)).status).toBe(404);
    expect((await stranger.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS })).status).toBe(404);
    expect((await stranger.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS })).status).toBe(400);
  });
});

describe('编写映射时的对照面板', () => {
  it('新建映射时显示所选源表的列统计与目标实体的字段，标出已对应与未对应的必填字段', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');

    const html = await (await engineer.get('/mappings')).text();
    // 表与实体下拉框，默认取模板里的 orders → order
    expect(html).toContain('id="mapping-table"');
    expect(html).toMatch(/<option[^>]*value="orders"[^>]*selected=""[^>]*>orders<\/option>/);
    expect(html).toMatch(/<option[^>]*value="order"[^>]*selected=""[^>]*>订单（order）<\/option>/);
    // 源表各列：类型、空值率、不同取值数、主键、常见取值
    expect(html).toContain('data-reference-table="orders"');
    expect(html).toMatch(/data-reference-column="order_id"[^>]*data-primary-key/);
    expect(html).toMatch(/data-reference-column="status"[\s\S]*?paid（50）/);
    // 目标实体的字段：模板里已对应的打勾，标准枚举一并给出
    expect(html).toMatch(/data-reference-field="order_id"[^>]*data-mapped/);
    expect(html).toMatch(/data-reference-field="paid_at"(?![^>]*data-mapped)/);
    expect(html).toContain('created、paid、shipped、completed、cancelled、refunded');

    // 校验不通过时按提交的 YAML 判断：没对应的主键突出显示
    const rejected = await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS.replace('  order_id: string(order_id)\n', '') });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toMatch(/data-reference-field="order_id"[^>]*data-missing-required/);
  });

  it('编辑草稿时对照映射的源表与实体', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    const html = await (await engineer.get(`/mappings/${id}`)).text();
    expect(html).toContain('data-reference-table="orders"');
    expect(html).toContain('data-reference-column="created_at"');
    expect(html).toMatch(/data-reference-field="amount"[^>]*data-mapped/);
    expect(html).toMatch(/data-reference-field="customer_id"(?![^>]*data-mapped)/);
  });
});

describe('按规则生成映射草稿', () => {
  it('新建页按所选的表与实体生成草稿填进编辑框，不保存；确认后保存为草稿', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');

    const generated = await engineer.post('/mappings', { intent: 'draft', sourceId, table: 'customers', entity: 'customer', yaml: '' });
    expect(generated.status).toBe(200);
    const html = await generated.text();
    const yaml = editorYaml(html);
    expect(yaml).toContain('table: customers');
    expect(yaml).toMatch(/customer_id: string\(customer_id\) # 同名；源表主键/);
    // 表与实体下拉框、对照面板跟着生成的草稿
    expect(html).toMatch(/<option[^>]*value="customers"[^>]*selected=""[^>]*>customers<\/option>/);
    expect(html).toMatch(/data-reference-field="customer_id"[^>]*data-mapped/);
    // 只生成，不保存
    expect(html).toContain('还没有映射');

    const saved = await engineer.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(saved.status).toBe(302);
    const id = mappingIdOf(saved);
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toContain('data-version-status="draft"');
  });

  it('详情页用映射的表与实体重新生成，保存后替换草稿；选的表不存在时说明原因', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    const yaml = editorYaml(await (await engineer.post(`/mappings/${id}`, { intent: 'draft' })).text());
    expect(yaml).toContain('order_id: string(order_id) # 同名；源表主键');
    expect(yaml).toMatch(/customer_id: string\(customer_id\)/);
    // 生成不改动草稿
    expect(editorYaml(await (await engineer.get(`/mappings/${id}`)).text())).toBe(ORDERS);

    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml })).status).toBe(302);
    expect(editorYaml(await (await engineer.get(`/mappings/${id}`)).text())).toBe(yaml);

    const missing = await engineer.post('/mappings', { intent: 'draft', sourceId, table: 'nope', entity: 'order' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('数据源中没有表 nope');
  });

  it('分析师不能生成草稿', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    await memberOf(tenantId, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    expect((await analyst.post('/mappings', { intent: 'draft', sourceId, table: 'orders', entity: 'order' })).status).toBe(403);
  });
});

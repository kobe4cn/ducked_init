// 标准模型与映射的 HTTP 接缝：任何成员都能浏览标准模型；数据工程师在界面上编写映射（不合格的 YAML 被拒绝并给出位置），
// 也能按规则生成草稿填进编辑框（不保存）；最后保存草稿的人不能自己发布，由另一位数据工程师或管理员发布，草稿也可以丢弃；合并时落入兜底的取值显示在详情页；
// 编辑区分表单 / YAML 标签页（没有脚本时只有 YAML 框），用表单填出的映射照常保存与发布；分析师只读，查看者看不到映射，其他租户一律 404
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { entityOf } from '../../app/lib/canonical-model';
import { readForm, writeField, type FieldChoice } from '../../app/lib/mapping-form';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 开通租户，登记电商库（sql 先在源库里加表）并把表全部选入同步范围、采集完；返回租户与数据源 */
async function tenantWithSource(slug: string, sql?: string) {
  const tenantId = await newTenant(slug);
  const engineer = await memberOf(tenantId, `de@${slug}.com`, 'data_engineer');
  const input = await pgSourceInput(READER);
  if (sql) await grantOnSource(sql);
  const { id } = await registerSource(engineer, input);
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

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  city: city
  registered_at: from_timezone(created_at, 'Asia/Shanghai')
  updated_at: updated_at
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
    expect(html).toContain('标准模型 v1.3');
    for (const entity of ['customer', 'order', 'order_item', 'product', 'event', 'touch', 'membership', 'points_transaction', 'consent', 'preference', 'coupon', 'coupon_template']) expect(html).toContain(`data-entity="${entity}"`);
    expect(html).toContain('标准枚举：created、paid、shipped、completed、cancelled、refunded');
    expect(html).toContain('标准枚举：earn、spend、redeem、expire、adjust');
    expect(html).toContain('标准枚举：granted、revoked');
    expect(html).toContain('标准枚举：issued、redeemed、expired、voided');
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
    expect(detail).toContain('你最后改了这一版草稿，需由另一位数据工程师或管理员发布');
    expect((await engineer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(403);
    // 只有草稿时不能合并
    expect(detail).not.toContain('name="intent" value="merge"');
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
    // 已发布后可以在详情页只合并这个映射（发布入队的合并还在排队，并进去）
    expect(detail).toContain('name="intent" value="merge"');
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'merge' })).status).toBe(302);

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

  it('合并时落入兜底的取值与行数显示在详情页的合并记录里', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    await confirmWatermark(engineer, sourceId, 'orders', 'order_id');
    await syncSource(engineer, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const author = await loginAs(app, 'de@acme.com');
    const yaml = ORDERS.replace('dictionary: { paid: paid, refunded: refunded }', 'dictionary: { paid: paid }, otherwise: cancelled');
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml }));
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    expect((await (await loginAs(app, 'de2@acme.com')).post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    expect(await (await author.get(`/mappings/${id}`)).text()).toContain('订单状态有 1 种取值（共 50 行）落入兜底：refunded（50）');
  });

  it('发布者不能是最后保存草稿的人：A 起草、B 修改后 A 能发布、B 不能，反过来也一样', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const a = await loginAs(app, 'de@acme.com');
    const b = await loginAs(app, 'admin@acme.com');
    const edited = ORDERS.replace('amount: amount', 'amount: amount / 100');

    const first = mappingIdOf(await a.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));
    expect((await b.post(`/mappings/${first}`, { intent: 'save', yaml: edited })).status).toBe(302);
    expect(await (await b.get(`/mappings/${first}`)).text()).toContain('你最后改了这一版草稿');
    expect((await b.post(`/mappings/${first}`, { intent: 'publish', version: '1' })).status).toBe(403);
    expect(await (await a.get(`/mappings/${first}`)).text()).toContain('name="intent" value="publish"');
    expect((await a.post(`/mappings/${first}`, { intent: 'publish', version: '1' })).status).toBe(302);
    // 已发布的版本仍锁定
    expect((await b.post(`/mappings/${first}`, { intent: 'publish', version: '1' })).status).toBe(400);

    const second = mappingIdOf(await b.post('/mappings', { intent: 'create', sourceId, yaml: CUSTOMERS }));
    expect((await a.post(`/mappings/${second}`, { intent: 'save', yaml: CUSTOMERS.replace('city: city', 'city: upper(city)') })).status).toBe(302);
    expect((await a.post(`/mappings/${second}`, { intent: 'publish', version: '1' })).status).toBe(403);
    expect((await b.post(`/mappings/${second}`, { intent: 'publish', version: '1' })).status).toBe(302);
  });

  it('丢弃草稿：有已发布版本时回到已发布版本；从没发布过时映射删除、可以重新新建；都记审计', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');

    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));
    expect((await admin.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS.replace('amount: amount', 'amount: amount / 100') });
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toContain('name="intent" value="discard"');
    const kept = await admin.post(`/mappings/${id}`, { intent: 'discard' });
    expect(kept.headers.get('Location')).toBe(`/mappings/${id}`);
    const detail = await (await engineer.get(`/mappings/${id}`)).text();
    expect(detail).not.toContain('data-version-status="draft"');
    expect(detail).toContain('data-version="1" data-version-status="published"');
    expect(detail).not.toContain('name="intent" value="discard"');
    expect((await admin.post(`/mappings/${id}`, { intent: 'discard' })).status).toBe(400);

    const fresh = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: CUSTOMERS }));
    const removed = await engineer.post(`/mappings/${fresh}`, { intent: 'discard' });
    expect(removed.headers.get('Location')).toBe('/mappings');
    expect((await engineer.get(`/mappings/${fresh}`)).status).toBe(404);
    expect((await engineer.post('/mappings', { intent: 'create', sourceId, yaml: CUSTOMERS })).status).toBe(302);

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    expect((await (await loginAs(app, 'an@acme.com')).post(`/mappings/${id}`, { intent: 'discard' })).status).toBe(403);

    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('「电商库」orders → 订单，丢弃第 2 版草稿，回到第 1 版');
    expect(audit).toContain('「电商库」customers → 消费者，丢弃第 1 版草稿，映射已删除');
  });

  it('租户里只有自己有发布权限时，发布区提示先邀请成员', async () => {
    const tenantId = await newTenant('solo');
    const admin = await memberOf(tenantId, 'admin@solo.com', 'admin');
    const { id: sourceId } = await registerSource(admin, await pgSourceInput(READER));
    await selectAllTables(admin, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const browser = await loginAs(app, 'admin@solo.com');
    const id = mappingIdOf(await browser.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    await memberOf(tenantId, 'an@solo.com', 'analyst');
    expect(await (await browser.get(`/mappings/${id}`)).text()).toContain('本租户只有你有发布权限，请先邀请一位数据工程师或管理员');
    // 没有发布权限的成员仍看到权限说明
    expect(await (await (await loginAs(app, 'an@solo.com')).get(`/mappings/${id}`)).text()).toContain('仅管理员、数据工程师可以发布映射与定义');

    await memberOf(tenantId, 'de@solo.com', 'data_engineer');
    const detail = await (await browser.get(`/mappings/${id}`)).text();
    expect(detail).not.toContain('本租户只有你有发布权限');
    expect(detail).toContain('你最后改了这一版草稿');
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
    expect((await analyst.post(`/mappings/${id}`, { intent: 'merge' })).status).toBe(403);

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

  it('面板有写法速查与白名单函数；校验不通过时报错附上改好的写法', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');

    const html = await (await engineer.get('/mappings')).text();
    for (const kind of ['field', 'expr', 'dictionary', 'extension', 'dedupe']) expect(html).toContain(`data-reference-snippet="${kind}"`);
    expect(html).toMatch(/data-reference-function="from_timezone"[\s\S]*?from_timezone\(x, &#x27;时区&#x27;\)/);

    const rejected = await engineer.post('/mappings', { intent: 'create', sourceId, yaml: `${ORDERS}  x_order_ts: created_at\n` });
    expect(rejected.status).toBe(400);
    const page = await rejected.text();
    expect(page).toMatch(/data-issue-path="fields.x_order_ts"[^>]*>[^<]*是不是想写 created_at（下单时间）？/);
    expect(page).toMatch(/<pre data-issue-hint[^>]*>created_at: created_at/);
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

/** 没有主键的订单流水：金额以分计，状态是中文 */
const ORDER_LOG = `
  CREATE TABLE shop.order_log (order_no text NOT NULL, status text NOT NULL, amount_fen int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.order_log VALUES ('A1', '已支付', 1990, '2024-06-01 10:00'), ('A2', '已退款', 500, '2024-06-02 10:00');
  GRANT SELECT ON shop.order_log TO ${READER.user};`;

/** 像在表单上逐个字段选择那样改 YAML（HTTP 测试不跑客户端脚本，直接用表单背后的 readForm / writeField） */
function fillForm(yaml: string, choices: Record<string, FieldChoice | null>) {
  const doc = parseDocument(yaml);
  for (const [field, choice] of Object.entries(choices)) writeField(doc, entityOf('order')!, field, choice);
  return doc.toString();
}

describe('表单式映射编辑器', () => {
  it('编辑区有表单与 YAML 两个标签页；没有脚本时只有 YAML 框可用，照常提交', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get('/mappings')).text();
    expect(html).toMatch(/<button[^>]*data-editor-tab="form"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*data-editor-tab="yaml"/);
    expect(html).toMatch(/<textarea[^>]*name="yaml"(?![^>]*hidden)/);

    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toMatch(/<button[^>]*data-editor-tab="form"/);
  });

  it('只用表单完成订单映射（选列、分换成元、时区转换）：保存的 YAML 保留注释与顺序，另一人能发布', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme', ORDER_LOG);
    const author = await loginAs(app, 'de@acme.com');
    // 新建页的模板，在下拉框里把表换成 order_log；手写一行注释，看它保留下来
    const template = editorYaml(await (await author.get('/mappings')).text()).replace('table: orders', 'table: order_log')
      .replace('fields:\n', 'fields:\n  # 金额以分计\n');
    const tz = (column: string): FieldChoice => ({ transform: 'timezone', column, args: ['Asia/Shanghai'] });
    const yaml = fillForm(template, {
      order_id: { transform: 'direct', column: 'order_no' },
      customer_id: null,
      status: { transform: 'fixed', args: ['paid'] },
      amount: { transform: 'cents', column: 'amount_fen' },
      created_at: tz('updated_at'),
      updated_at: tz('updated_at'),
    });
    const created = await author.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(created.status).toBe(302);
    const id = mappingIdOf(created);

    const saved = editorYaml(await (await author.get(`/mappings/${id}`)).text());
    expect(saved).toBe(yaml);
    expect(saved.split('\n')[0]).toBe(template.split('\n')[0]);
    expect(saved).toContain('# 金额以分计');
    expect(saved.indexOf('created_at')).toBeLessThan(saved.indexOf('updated_at'));
    expect(saved.indexOf('fields:')).toBeLessThan(saved.indexOf('dedupe:'));
    const form = readForm(parseDocument(saved), entityOf('order')!);
    const at = (field: string) => form.find(f => f.field === field)!;
    expect(at('amount')).toMatchObject({ transform: 'cents', column: 'amount_fen', readonly: false });
    expect(at('created_at')).toMatchObject({ transform: 'timezone', column: 'updated_at', args: ['Asia/Shanghai'] });
    expect(at('customer_id').transform).toBeNull();

    // 在表单里再改一个字段，保存草稿
    const edited = fillForm(saved, { channel: { transform: 'fixed', args: ['门店'] } });
    expect((await author.post(`/mappings/${id}`, { intent: 'save', yaml: edited })).status).toBe(302);
    expect(editorYaml(await (await author.get(`/mappings/${id}`)).text())).toBe(edited);

    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await reviewer.get(`/mappings/${id}`)).text()).toContain('data-version="1" data-version-status="published"');
  });
});

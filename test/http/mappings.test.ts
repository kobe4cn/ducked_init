// 标准模型与映射的 HTTP 接缝：任何成员都能浏览标准模型；数据工程师在界面上编写映射（不合格的 YAML 被拒绝并给出位置），
// 新建页默认是按规则生成的草稿（源没有已采集的表时是模板），也能按所选的表与实体重新生成填进编辑框（不保存）；最后保存草稿的人不能自己发布，由另一位数据工程师或管理员发布，草稿也可以丢弃；合并时落入兜底的取值显示在详情页；
// 编辑区分表单 / YAML 标签页（没有脚本时只有 YAML 框），用表单填出的映射（含勾选源列加的扩展字段、映射与引用字段的键空间）照常保存与发布；分析师只读，查看者看不到映射，其他租户一律 404
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { closeDb } from '../../app/.server/db/client';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, publishSourceView } from '../../app/.server/source-views';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { mappingTemplate } from '../../app/.server/pipeline/mapping-spec';
import { entityOf } from '../../app/lib/canonical-model';
import { referenceTables } from '../../app/.server/mappings';
import {
  keySpaceOf, newExtension, readForm, readKeySpace, unusedColumns, writeExtension, writeField, writeKeySpace, type FieldChoice,
} from '../../app/lib/mapping-form';
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
    expect(html).toContain('标准模型 v1.5');
    expect(html).toContain('data-ref="customer.customer_id"');
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
    expect(await (await engineer.get(`/mappings/${id}?tab=versions`)).text()).toContain('data-version-status="draft"');
    expect(detail).toContain('你最后改了这一版草稿，需由另一位数据工程师或管理员发布');
    // 标准实体的卡片链接到标准模型
    expect(detail).toContain('text-slate-500">标准实体<');
    expect(detail).toMatch(/href="\/model"[^>]*><span class="grid size-11[^"]*bg-violet-100/);
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
    expect(await (await reviewer.get(`/mappings/${id}?tab=versions`)).text()).toContain('data-version-status="published"');
    expect(detail).not.toContain('name="intent" value="publish"');
    expect(await (await reviewer.get('/tasks')).text()).toContain('合并到标准层');
    // 已发布后可以在详情页只合并这个映射（发布入队的合并还在排队，并进去）
    expect(detail).toContain('name="intent" value="merge"');
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'merge' })).status).toBe(302);

    // 已发布的版本再保存是新的一版草稿
    expect((await author.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS.replace('amount: amount', 'amount: amount / 100') })).status).toBe(302);
    const after = await (await author.get(`/mappings/${id}?tab=versions`)).text();
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

    const merges = await (await author.get(`/mappings/${id}?tab=merges`)).text();
    expect(merges).toContain('订单状态有 1 种取值（共 50 行）落入兜底：refunded（50）');
    // 一键加进值对照：打开编辑标签页的表单，定位到该字段并带上这些取值（不带版本，有草稿时也落在草稿上）
    const href = `/mappings/${id}?tab=edit&amp;field=status&amp;add=refunded`;
    expect(merges).toContain(`href="${href}"`);
    const edit = await author.get(href.replaceAll('&amp;', '&'));
    expect(edit.status).toBe(200);
    expect(await edit.text()).toMatch(/<textarea[^>]*name="yaml"/);
    // 不能编辑的成员看不到
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    expect(await (await (await loginAs(app, 'an@acme.com')).get(`/mappings/${id}?tab=merges`)).text()).not.toContain('data-add-to-dictionary');
  });

  it('被关系指向的实体主键跨映射重复时，后发布的映射在详情页的合并记录与任务页标红，列出冲突的键与映射', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    await confirmWatermark(engineer, sourceId, 'customers', 'updated_at');
    await confirmWatermark(engineer, sourceId, 'orders', 'order_id');
    await syncSource(engineer, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const author = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    const publish = async (yaml: string) => {
      const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml }));
      expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
      await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
      return id;
    };
    // order 是内置 ref 的终点；customers 表的 customer_id 1..40 与 orders 表的 order_id 1..100 重叠
    const orders = await publish(ORDERS);
    const clash = await publish('model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\n');
    const conflict = `主键 order_id 跨映射重复：1（映射 ${[orders, clash].sort().join('、')}）；10（映射`;

    const merges = await (await author.get(`/mappings/${clash}?tab=merges`)).text();
    expect(merges).toContain('data-merge-error');
    expect(merges).toContain(`失败：${conflict}`);
    expect(merges).toContain('等，共 40 个，请在映射里用字段表达式对齐（如加前缀）或去掉一边的映射');
    expect(await (await author.get(`/mappings/${orders}?tab=merges`)).text()).not.toContain('data-merge-error');
    expect(await (await author.get('/tasks')).text()).toContain(conflict);
  });

  it('分析师能在映射列表上运行主键冲突体检并查看报告：每对重叠的映射列出重叠数、样本键、一致比例与建议；其他操作仍然 403', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    const reviewer = await memberOf(tenantId, 'de2@acme.com');
    await confirmWatermark(engineer, sourceId, 'customers', 'updated_at');
    await confirmWatermark(engineer, sourceId, 'orders', 'order_id');
    await syncSource(engineer, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    // touch 不被关系指向：customers 的 id 1..40 全在 orders 的 1..100 里
    const a = await publish(engineer, reviewer, sourceId, 'model: 1\nentity: touch\ntable: customers\nfields:\n  touch_id: string(customer_id)\n  campaign_id: city\n');
    const b = await publish(engineer, reviewer, sourceId, 'model: 1\nentity: touch\ntable: orders\nfields:\n  touch_id: string(order_id)\n  campaign_id: status\n');
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');

    expect(await (await analyst.get('/mappings')).text()).toContain('data-keycheck-status="never"');
    expect((await analyst.post('/mappings', { intent: 'keycheck' })).status).toBe(302);
    expect(await (await analyst.get('/mappings')).text()).toContain('data-keycheck-status="running"');
    expect((await analyst.post('/mappings', { intent: 'keycheck' })).status).toBe(400);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const page = await (await analyst.get('/mappings')).text();
    expect(page).toContain('data-keycheck-status="ok"');
    expect(page).toContain(`data-keycheck-pair="touch:${[a, b].sort().join(':')}"`);
    expect(page).toContain('重叠 40 个键');
    expect(page).toContain('1、10、11、12、13');
    expect(page).toContain('一致 0%');
    expect(page).toContain('多半是重复接入');
    expect(page).toContain('电商库 / customers');

    for (const intent of ['merge', 'create', 'draft']) {
      expect((await analyst.post('/mappings', { intent, sourceId, yaml: ORDERS })).status).toBe(403);
    }
  });

  it('新建映射的表下拉框列出已发布的源视图；YAML 写 view 的映射保存后，详情页对照视图的列，空跑转换视图的样本', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    const reviewer = await memberOf(tenantId, 'de2@acme.com');
    await confirmWatermark(engineer, sourceId, 'orders', 'order_id');
    await syncSource(engineer, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const viewId = await createSourceView(engineer, sourceId, { name: 'paid_orders', sql: "SELECT order_id, amount, status, _op, _batch, _commit_ts FROM orders WHERE status = 'paid'" });
    const author = await loginAs(app, 'de@acme.com');
    expect(await (await author.get('/mappings')).text()).not.toContain('源视图 paid_orders');
    await publishSourceView(reviewer, sourceId, viewId, 1);
    expect(await (await author.get('/mappings')).text()).toMatch(/<option[^>]*value="view:paid_orders">源视图 paid_orders</);

    const yaml = ORDERS.replace('table: orders', 'view: paid_orders\nview_key: [order_id]');
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml }));
    expect(await (await author.get(`/mappings/${id}`)).text()).toContain('源视图 paid_orders（只有列与类型，没有列统计）');
    const dry = await author.post(`/mappings/${id}`, { intent: 'dryrun', version: '1' });
    expect(dry.status).toBe(200);
    expect(await dry.text()).toContain('data-dryrun="1"');
  });

  it('编辑页空跑正在查看的版本：展示样例行（邮箱是哈希）与断言，不保存；没同步时提示原因；分析师 403、其他租户 404', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    const author = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: `${CUSTOMERS}identity:\n  match: [email]\n` }));
    expect(await (await author.get(`/mappings/${id}`)).text()).toContain('name="intent" value="dryrun"');
    // 源表还没同步进原始层
    const early = await author.post(`/mappings/${id}`, { intent: 'dryrun', version: '1' });
    expect(early.status).toBe(400);
    expect(await early.text()).toContain('源表 customers 还没有同步进原始层，首次同步后再空跑');

    await confirmWatermark(engineer, sourceId, 'customers', 'updated_at');
    await syncSource(engineer, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const res = await author.post(`/mappings/${id}`, { intent: 'dryrun', version: '1' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-dryrun="1"');
    expect(html).toContain('取原始层里最新的 40 条记录（最多 50 条）转换');
    expect(html.match(/data-dryrun-row/g)).toHaveLength(40);
    expect(html).toMatch(/data-assertion="key-nulls" data-ok="true"/);
    expect(html).toMatch(/data-assertion="required-email" data-ok="false"/);
    expect(html).toContain('必填字段邮箱有 10 行为空');
    expect(html).toMatch(/>[0-9a-f]{64}</);
    expect(html).not.toMatch(/[\w.]+@example\.\w+/);
    // 空跑不保存：版本仍只有一版
    expect(await (await author.get(`/mappings/${id}?tab=versions`)).text()).toContain('版本（1）');

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    expect(await (await analyst.get(`/mappings/${id}`)).text()).not.toContain('value="dryrun"');
    expect((await analyst.post(`/mappings/${id}`, { intent: 'dryrun', version: '1' })).status).toBe(403);
    const other = await newTenant('globex');
    await memberOf(other, 'de@globex.com', 'data_engineer');
    expect((await (await loginAs(app, 'de@globex.com')).post(`/mappings/${id}`, { intent: 'dryrun', version: '1' })).status).toBe(404);
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
    const detail = await (await engineer.get(`/mappings/${id}?tab=versions`)).text();
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

  it('查看草稿时展示它与最新已发布版本的差异；没有已发布版本时是首个版本，查看已发布版本时不展示', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');

    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));
    const first = await (await reviewer.get(`/mappings/${id}`)).text();
    expect(first).toContain('data-draft-diff="1"');
    expect(first).toContain('v1 是首个版本');

    expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await reviewer.get(`/mappings/${id}`)).text()).not.toContain('data-draft-diff');

    const v2 = ORDERS
      .replace('amount: amount', 'amount: amount / 100')
      .replace(/  status: .*\n/, "  created_at: from_timezone(created_at, 'Asia/Shanghai')\n")
      + 'dedupe: { key: [order_id], latest: created_at }\n';
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: v2 })).status).toBe(302);
    const diff = await (await reviewer.get(`/mappings/${id}`)).text();
    expect(diff).toContain('v2 与已发布 v1 的差异');
    for (const item of ['added-created_at', 'removed-status', 'changed-amount', 'latest']) expect(diff).toContain(`data-diff-item="${item}"`);
    expect(diff).not.toContain('data-diff-item="key"');
    // 只改注释时计划相同
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: `# 只加注释\n${ORDERS}` })).status).toBe(302);
    expect(await (await reviewer.get(`/mappings/${id}`)).text()).toContain('data-diff-item="none"');
    // 查看已发布的 v1 时不展示
    expect(await (await reviewer.get(`/mappings/${id}?version=1`)).text()).not.toContain('data-draft-diff');
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

  it('详情页的编辑、版本、合并记录标签页由 ?tab= 在服务端渲染，发布与合并后回到原标签页', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));

    const edit = await (await author.get(`/mappings/${id}`)).text();
    expect(edit).toMatch(/<a(?=[^>]*aria-current="page")[^>]*data-tab="edit"/);
    expect(edit).toContain('name="yaml"');
    expect(edit).not.toContain('data-version-status=');
    expect(edit).not.toContain('还没有合并过');

    const versions = await (await author.get(`/mappings/${id}?tab=versions`)).text();
    expect(versions).toMatch(/<a(?=[^>]*aria-current="page")[^>]*data-tab="versions"/);
    expect(versions).toContain('data-version="1" data-version-status="draft"');
    expect(versions).not.toContain('name="yaml"');

    const merges = await (await author.get(`/mappings/${id}?tab=merges`)).text();
    expect(merges).toMatch(/<a(?=[^>]*aria-current="page")[^>]*data-tab="merges"/);
    expect(merges).toContain('还没有合并过');
    expect(merges).not.toContain('data-version-status=');

    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    expect((await reviewer.post(`/mappings/${id}?tab=versions`, { intent: 'publish', version: '1' })).headers.get('Location')).toBe(`/mappings/${id}?tab=versions`);
    expect((await reviewer.post(`/mappings/${id}?tab=merges`, { intent: 'merge' })).headers.get('Location')).toBe(`/mappings/${id}?tab=merges`);
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'merge' })).headers.get('Location')).toBe(`/mappings/${id}`);

    // 在版本页选中某一版，编辑页显示那一版
    await author.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS.replace('amount: amount', 'amount: amount / 100') });
    expect(editorYaml(await (await author.get(`/mappings/${id}`)).text())).toContain('amount / 100');
    expect(editorYaml(await (await author.get(`/mappings/${id}?version=1`)).text())).not.toContain('amount / 100');
  });
});

describe('编写映射时的对照面板', () => {
  it('新建映射时显示所选源表的列统计与目标实体的字段，标出已对应与未对应的必填字段', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');

    // 按所选的 orders → order 生成草稿后看页面
    const html = await (await engineer.post('/mappings', { intent: 'draft', sourceId, table: 'orders', entity: 'order' })).text();
    // 表与实体下拉框跟着草稿里的 orders → order
    expect(html).toContain('id="mapping-table"');
    expect(html).toMatch(/<option[^>]*value="orders"[^>]*selected=""[^>]*>orders<\/option>/);
    expect(html).toMatch(/<option[^>]*value="order"[^>]*selected=""[^>]*>订单（order）<\/option>/);
    // 源表各列：类型、空值率、不同取值数、主键、常见取值
    expect(html).toContain('data-reference-table="orders"');
    expect(html).toMatch(/data-reference-column="order_id"[^>]*data-primary-key/);
    expect(html).toMatch(/data-reference-column="status"[\s\S]*?paid（50）/);
    // 目标实体的字段：草稿里已对应的打勾，标准枚举一并给出
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

  it('自定义实体的映射对照它已发布登记的字段（类型、敏感、说明、主键）；没登记的提示去登记', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await memberOf(tenantId, 'de@acme.com');
    const coupon = await createCustomEntity(author, {
      name: 'custom_coupon', label: '优惠券', kind: 'dimension', primaryKey: ['code'],
      fields: [
        { name: 'code', type: 'string', description: '券码', sensitive: false },
        { name: 'owner_phone', type: 'string', description: '领券手机号', sensitive: true },
      ],
    });
    await publishCustomEntity(await memberOf(tenantId, 'de2@acme.com'), coupon, 1);
    // 只有草稿的登记不显示
    await createCustomEntity(author, { name: 'custom_store', label: '门店', kind: 'dimension', primaryKey: ['store_id'], fields: [{ name: 'store_id', type: 'string', description: '', sensitive: false }] });
    const engineer = await loginAs(app, 'de@acme.com');
    const yaml = 'model: 1\nentity: custom_coupon\ntable: orders\ndedupe: { key: [code] }\nextensions:\n  code: { type: string, expr: string(order_id) }\n';
    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml }));

    const html = await (await engineer.get(`/mappings/${id}`)).text();
    expect(html).toContain('data-reference-registered="custom_coupon"');
    expect(html).toMatch(/data-reference-field="code"[^>]*data-primary-key[\s\S]*?主键[\s\S]*?文本[\s\S]*?券码/);
    expect(html).toMatch(/data-reference-field="owner_phone"(?![^>]*data-primary-key)[\s\S]*?敏感[\s\S]*?领券手机号/);

    // 新建页：目标实体可选已发布登记的自定义实体，不列只有草稿的
    const page = await (await engineer.get('/mappings')).text();
    expect(page).toMatch(/<option[^>]*value="custom_coupon">优惠券（custom_coupon）<\/option>/);
    expect(page).not.toContain('value="custom_store"');
    // 新建时选了已登记的自定义实体（保存被拒后带着它渲染回来），面板显示其登记字段
    const chosen = await (await engineer.post('/mappings', { intent: 'create', sourceId, yaml: `${yaml}  x_bad: nope\n` })).text();
    expect(chosen).toMatch(/<option[^>]*value="custom_coupon"[^>]*selected=""/);
    expect(chosen).toContain('data-reference-registered="custom_coupon"');
    expect(chosen).toMatch(/data-reference-field="owner_phone"/);
    // 写了没登记的自定义实体，保存被拒后面板提示去登记
    const rejected = await (await engineer.post('/mappings', { intent: 'create', sourceId, yaml: yaml.replace('custom_coupon', 'custom_store') })).text();
    expect(rejected).toMatch(/<option[^>]*value="custom_store"[^>]*selected=""[^>]*>未登记（custom_store）<\/option>/);
    expect(rejected).toMatch(/data-reference-unregistered="custom_store"[\s\S]*?未登记[\s\S]*?href="\/entities"/);
  });
});

describe('按规则生成映射草稿', () => {
  it('打开新建页时编辑框默认是第一个数据源的草稿：取第一张能按表名认出实体的已采集表，不保存', async () => {
    await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get('/mappings')).text();
    const yaml = editorYaml(html);
    expect(yaml).toContain('entity: customer');
    expect(yaml).toContain('table: customers');
    expect(yaml).toMatch(/customer_id: string\(customer_id\) # 同名；源表主键/);
    // 表单里每个由草稿生成的字段带依据
    expect(readForm(parseDocument(yaml), entityOf('customer')!).find(f => f.field === 'customer_id')!.basis).toBe('同名；源表主键');
    expect(html).toMatch(/<option[^>]*value="customers"[^>]*selected=""[^>]*>customers<\/option>/);
    expect(html).toMatch(/<option[^>]*value="customer"[^>]*selected=""[^>]*>消费者（customer）<\/option>/);
    // 只生成，不保存
    expect(html).toContain('还没有映射');
  });

  it('数据源还没有已采集的表时，新建页的编辑框是模板', async () => {
    const other = await newTenant('globex');
    await registerSource(await memberOf(other, 'de@globex.com'), await pgSourceInput(READER));
    const fresh = await loginAs(app, 'de@globex.com');
    expect(editorYaml(await (await fresh.get('/mappings')).text())).toBe(mappingTemplate('order', 'orders'));
  });

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
    expect(await (await engineer.get(`/mappings/${id}?tab=versions`)).text()).toContain('data-version-status="draft"');
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
    // 从模板起头（源没有已采集的表时新建页给的就是它），表换成 order_log；手写一行注释，看它保留下来
    const template = mappingTemplate('order', 'order_log')
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
    expect(await (await reviewer.get(`/mappings/${id}?tab=versions`)).text()).toContain('data-version="1" data-version-status="published"');
  });

  it('在表单里为订单状态填好值对照（含未对应的源值）并选兜底：写出的 YAML 保存成功', async () => {
    const { sourceId } = await tenantWithSource('acme', ORDER_LOG);
    const author = await loginAs(app, 'de@acme.com');
    const yaml = fillForm(mappingTemplate('order', 'order_log'), {
      order_id: { transform: 'direct', column: 'order_no' },
      customer_id: null,
      status: {
        transform: 'direct', column: 'status',
        dictionary: [{ from: '已支付', to: 'paid' }, { from: '已退款', to: 'refunded' }, { from: '待审核', to: null }],
        otherwise: null,
      },
      amount: { transform: 'cents', column: 'amount_fen' },
      created_at: { transform: 'direct', column: 'updated_at' },
      updated_at: { transform: 'direct', column: 'updated_at' },
    });
    expect(parseDocument(yaml).toJS().fields.status).toEqual({ expr: 'status', dictionary: { 已支付: 'paid', 已退款: 'refunded' }, otherwise: null });
    const created = await author.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(created.status).toBe(302);
    expect(editorYaml(await (await author.get(`/mappings/${mappingIdOf(created)}`)).text())).toBe(yaml);
  });

  it('在表单里勾选没用到的源列加为扩展字段（名字与类型自动带出，可改名、填中文名）：写出的 YAML 保存成功', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    // 对照面板里 shop.orders 的列
    const orders = { columns: [
      { name: 'order_id', type: 'INTEGER' }, { name: 'customer_id', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL(10,2)' },
      { name: 'status', type: 'VARCHAR' }, { name: 'created_at', type: 'TIMESTAMP' },
    ] };
    const doc = parseDocument(ORDERS);
    expect(unusedColumns(doc, orders).map(c => c.name)).toEqual(['customer_id', 'created_at']);
    for (const c of unusedColumns(doc, orders)) {
      const ext = newExtension(orders, c.name, []);
      writeExtension(doc, ext.name, ext);
    }
    writeExtension(doc, 'x_customer_id', { name: 'x_buyer_id', type: 'string', expr: 'customer_id', label: '买家' });
    const yaml = doc.toString();
    expect(parseDocument(yaml).toJS().extensions).toEqual({
      x_buyer_id: { type: 'string', expr: 'customer_id', label: '买家' },
      x_created_at: { type: 'timestamp', expr: "from_timezone(created_at, 'Asia/Shanghai')" },
    });
    const created = await author.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(created.status).toBe(302);
    expect(editorYaml(await (await author.get(`/mappings/${mappingIdOf(created)}`)).text())).toBe(yaml);
  });
  it('键空间：表单里给订单映射填 pos 并发布；订单明细表单的 order_id 按同源订单映射预填 pos，打开时 YAML 不变，填写该字段后带上 key_space: pos 并能发布', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme', `
      CREATE TABLE shop.order_items (item_no text PRIMARY KEY, order_id int NOT NULL, qty int NOT NULL);
      GRANT SELECT ON shop.order_items TO ${READER.user};`);
    const author = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    const orders = parseDocument(ORDERS);
    writeKeySpace(orders, 'pos');
    expect(readKeySpace(parseDocument(orders.toString()))).toBe('pos');
    const ordersId = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: orders.toString() }));
    expect((await reviewer.post(`/mappings/${ordersId}`, { intent: 'publish', version: '1' })).status).toBe(302);

    const ITEM = entityOf('order_item')!;
    const items = 'model: 1\nentity: order_item\ntable: order_items\nfields:\n  order_item_id: item_no\n  order_id: string(order_id)\n  quantity: qty\n';
    const itemsId = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: items }));
    // 编辑页对照的源表带上同源订单映射的键空间，order_id 一行据此预填；只是打开表单时 YAML 不变
    const table = (await referenceTables(await memberOf(tenantId, 'de@acme.com'), sourceId)).find(t => t.name === 'order_items')!;
    const saved = parseDocument(editorYaml(await (await author.get(`/mappings/${itemsId}`)).text()));
    expect(saved.toString()).toBe(items);
    const orderId = readForm(saved, ITEM).find(f => f.field === 'order_id')!;
    const keySpace = keySpaceOf(orderId, ITEM.fields.find(f => f.name === 'order_id')!, table.keySpaces);
    expect(keySpace).toBe('pos');
    const rejected = await reviewer.post(`/mappings/${itemsId}`, { intent: 'publish', version: '1' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('order_id 应写 key_space: pos');

    writeField(saved, ITEM, 'order_id', { transform: 'text', column: 'order_id', keySpace });
    expect(saved.toJS().fields.order_id).toEqual({ expr: 'string(order_id)', key_space: 'pos' });
    expect((await author.post(`/mappings/${itemsId}`, { intent: 'save', yaml: saved.toString() })).status).toBe(302);
    expect((await reviewer.post(`/mappings/${itemsId}`, { intent: 'publish', version: '1' })).status).toBe(302);
  });

  it('敏感字段：表单里把扩展字段标成敏感后保存成功；YAML 里取消内置敏感字段的敏感标记被拒绝', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    const customers = { columns: [{ name: 'customer_id', type: 'INTEGER' }, { name: 'phone', type: 'VARCHAR' }, { name: 'created_at', type: 'TIMESTAMP' }] };
    const doc = parseDocument(CUSTOMERS);
    // 列名像手机号：默认标成敏感
    const phone = newExtension(customers, 'phone', []);
    expect(phone).toMatchObject({ name: 'x_phone', type: 'string', sensitive: true });
    writeExtension(doc, phone.name, phone);
    writeExtension(doc, 'x_phone', { ...phone, name: 'x_backup_phone' });
    const yaml = doc.toString();
    expect(parseDocument(yaml).toJS().extensions).toEqual({ x_backup_phone: { type: 'string', expr: 'phone', sensitive: true } });
    const created = await author.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(created.status).toBe(302);
    expect(editorYaml(await (await author.get(`/mappings/${mappingIdOf(created)}`)).text())).toBe(yaml);

    const rejected = await author.post(`/mappings/${mappingIdOf(created)}`, { intent: 'save', yaml: yaml.replace('  name: name\n', '  name: { expr: name, sensitive: false }\n') });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('（fields.name.sensitive）：姓名（name）是内置敏感字段，不能取消敏感标记');
  });
});

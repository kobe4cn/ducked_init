// 标准模型与映射的 HTTP 接缝：任何成员都能浏览标准模型；数据工程师在界面上编写映射（不合格的 YAML 被拒绝并给出位置），
// 保存通过但检查有提示（notices）时新建与保存都留在页面上列出提示；
// 新建页默认是按规则生成的草稿（源没有已采集的表时是模板），也能按所选的表与实体重新生成或用模型生成（模型服务替身 app.setLlmFetch）填进编辑框（不保存），详情页能把源表新增的列一键生成为扩展字段填进编辑框（不保存）；最后保存草稿的人不能自己发布，由另一位数据工程师或管理员发布，草稿也可以丢弃；合并时落入兜底的取值显示在详情页；
// 编辑区分表单 / YAML 标签页（没有脚本时只有 YAML 框），用表单填出的映射（含勾选源列加的扩展字段、映射与引用字段的键空间）照常保存与发布；分析师只读，查看者看不到映射，其他租户一律 404
// 有发布权限的成员在详情页提议停用、由另一位确认，停用后可恢复，停用前列出受影响的指标与标签，列表标出待确认与已停用（ADR-0031）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappingGenerations } from '../../app/.server/db/schema';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, publishSourceView } from '../../app/.server/source-views';
import { confirmWatermark, registerSource, relistSource } from '../../app/.server/sources';
import { memberOf, mergeUnchecked, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { mappingTemplate } from '../../app/.server/pipeline/mapping-spec';
import { entityOf } from '../../app/lib/canonical-model';
import { referenceTables } from '../../app/.server/mappings';
import {
  keySpaceOf, newExtension, readExtensions, readForm, readKeySpace, unusedColumns, writeExtension, writeField, writeKeySpace, type FieldChoice,
} from '../../app/lib/mapping-form';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });
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

/** 配上平台默认模型服务，替身每次都返回 content */
function modelReplies(content: unknown) {
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
  app.setLlmFetch((async () => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })) as typeof fetch);
}

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

  it('检查有提示时（customer_source 写的就是本数据源）新建与保存照常存下草稿，页面列出提示「可以省略」；没有提示时照常跳转', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    const customers = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: CUSTOMERS }));
    expect((await reviewer.post(`/mappings/${customers}`, { intent: 'publish', version: '1' })).status).toBe(302);

    const self = ORDERS.replace('  amount: amount\n', '  customer_id: { expr: string(customer_id), customer_source: 电商库 }\n  amount: amount\n');
    const created = await author.post('/mappings', { intent: 'create', sourceId, yaml: self });
    expect(created.status).toBe(200);
    const html = await created.text();
    expect(html).toContain('data-mapping-notices');
    expect(html).toContain('（fields.customer_id.customer_source）：电商库 就是本数据源，customer_source 可以省略');
    const id = html.match(/href="\/mappings\/([0-9a-f-]{36})"[^>]*>打开新建的映射/)![1];
    expect(editorYaml(await (await author.get(`/mappings/${id}`)).text())).toBe(self);

    const saved = await author.post(`/mappings/${id}`, { intent: 'save', yaml: self.replace('amount: amount', 'amount: amount * 1') });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('customer_source 可以省略');
    expect(editorYaml(await (await author.get(`/mappings/${id}`)).text())).toContain('amount: amount * 1');
    const plain = await author.post(`/mappings/${id}`, { intent: 'save', yaml: ORDERS });
    expect(plain.status).toBe(302);
    expect(await (await author.get(`/mappings/${id}`)).text()).not.toContain('data-mapping-notices');
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

  it('实体主键跨映射重复时，后发布的映射在详情页的合并记录与任务页标红，列出冲突的键与映射', async () => {
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
    // customers 的 id 1..40 全在 orders 的 1..100 里：b 合并时被独占检查拦下，不查主键再合并一次，模拟检查上线前就已存在的重叠
    const a = await publish(engineer, reviewer, sourceId, 'model: 1\nentity: touch\ntable: customers\nfields:\n  touch_id: string(customer_id)\n  campaign_id: city\n');
    const b = await publish(engineer, reviewer, sourceId, 'model: 1\nentity: touch\ntable: orders\nfields:\n  touch_id: string(order_id)\n  campaign_id: status\n');
    expect((await mergeUnchecked(tenantId, [b])).status).toBe('succeeded');
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
    expect(page).toContain('多半是重复接入，可以建合并组');
    expect(page).toContain('href="/merge-groups?entity=touch"');
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
    // 只加行过滤时不算相同，列出前后表达式
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: `${ORDERS}where: amount > 0\n` })).status).toBe(302);
    const filtered = await (await reviewer.get(`/mappings/${id}`)).text();
    expect(filtered).not.toContain('data-diff-item="none"');
    expect(filtered).toContain('data-diff-item="where"');
    expect(filtered).toContain('amount &gt; 0');
    // 查看已发布的 v1 时不展示
    expect(await (await reviewer.get(`/mappings/${id}?version=1`)).text()).not.toContain('data-draft-diff');
  });

  it('发布后源表新增一列、删除映射引用的列并重新采集：映射列表与详情页标出新列（带类型与常见取值）与源端已删除的列', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await memberOf(tenantId, 'de@acme.com');
    const id = await publish(author, await memberOf(tenantId, 'de2@acme.com'), sourceId, ORDERS);
    const browser = await loginAs(app, 'de@acme.com');
    expect(await (await browser.get('/mappings')).text()).not.toContain('data-drift-');

    await grantOnSource(`ALTER TABLE shop.orders ADD COLUMN channel text DEFAULT '门店'; ALTER TABLE shop.orders DROP COLUMN amount;`);
    await relistSource(author, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const list = await (await browser.get('/mappings')).text();
    expect(list).toContain('data-drift-new="channel">源表新增 1 列');
    expect(list).toContain('data-drift-missing="amount">源端已删除 1 列');
    const detail = await (await browser.get(`/mappings/${id}`)).text();
    expect(detail).toContain('data-drift-new="channel"');
    expect(detail).toMatch(/data-drift-column="channel">.*channel.*VARCHAR.*常见取值：门店/);
    expect(detail).toContain('data-drift-missing="amount">源端已删除 1 列：amount');
    expect(detail).toContain('合并时这一列为空值；若是去重键，合并会失败');
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

  it('有发布权限的成员提议停用、另一位确认，两步都先列出受影响的指标与标签；提议人看到等待另一位确认；停用后显示恢复；列表标出待确认与已停用', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await memberOf(tenantId, 'de@acme.com');
    const reviewer = await memberOf(tenantId, 'de2@acme.com');
    const id = await publish(engineer, reviewer, sourceId, ORDERS);
    await createDefinition(engineer, 'metric', 'order_count', 'base: order\nmeasure: { agg: count }\n');
    await publishDefinition(reviewer, 'metric', 'order_count', 1);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    await createDefinition(engineer, 'tag', 'buyer', 'metric: order_count\nrules:\n  - { value: yes, when: { gte: 1 } }\ndefault: no\n');
    await publishDefinition(reviewer, 'tag', 'buyer', 1);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const author = await loginAs(app, 'de@acme.com');
    const other = await loginAs(app, 'de2@acme.com');

    const before = await (await author.get(`/mappings/${id}`)).text();
    expect(before).toContain('name="intent" value="request-disable"');
    expect(before).toContain('data-disable-impact="metric-order_count"');
    expect(before).toContain('data-disable-impact="tag-buyer"');
    // 分析师没有发布权限：看不到也做不了
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    expect(await (await analyst.get(`/mappings/${id}`)).text()).not.toContain('request-disable');
    expect((await analyst.post(`/mappings/${id}`, { intent: 'request-disable' })).status).toBe(403);

    expect((await author.post(`/mappings/${id}`, { intent: 'request-disable' })).status).toBe(302);
    const mine = await (await author.get(`/mappings/${id}`)).text();
    expect(mine).toContain('等待另一位确认');
    expect(mine).toContain('data-disable-blocker');
    expect(mine).not.toContain('name="intent" value="confirm-disable"');
    expect((await author.post(`/mappings/${id}`, { intent: 'confirm-disable' })).status).toBe(403);
    const theirs = await (await other.get(`/mappings/${id}`)).text();
    expect(theirs).toContain('name="intent" value="confirm-disable"');
    expect(theirs).toContain('data-disable-impact="metric-order_count"');
    expect(await (await author.get('/mappings')).text()).toMatch(/data-mapping-disable="requested">待确认停用</);

    expect((await other.post(`/mappings/${id}`, { intent: 'confirm-disable' })).status).toBe(302);
    const disabled = await (await other.get(`/mappings/${id}`)).text();
    expect(disabled).toContain('name="intent" value="restore"');
    expect(disabled).not.toContain('name="intent" value="merge"');
    expect(await (await author.get('/mappings')).text()).toMatch(/data-mapping-disable="disabled">已停用</);

    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect((await author.post(`/mappings/${id}`, { intent: 'restore' })).status).toBe(302);
    const restored = await (await author.get(`/mappings/${id}`)).text();
    expect(restored).toContain('name="intent" value="request-disable"');
    expect(await (await author.get('/mappings')).text()).not.toContain('data-mapping-disable');
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

  it('新建页用模型生成草稿填进编辑框，不保存；确认后保存为草稿。模型输出不合 Schema 时显示错误、编辑框保持原内容；分析师 403', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    modelReplies({ fields: [
      { field: 'order_id', expr: 'string(order_id)', confidence: 0.95, reason: '源表主键' },
      { field: 'customer_id', expr: 'string(customer_id)', confidence: 0.9, reason: '同名列' },
      { field: 'amount', expr: 'amount', confidence: 0.7, reason: '金额列' },
    ] });
    const engineer = await loginAs(app, 'de@acme.com');

    const generated = await engineer.post('/mappings', { intent: 'model-draft', sourceId, table: 'orders', entity: 'order', yaml: '' });
    expect(generated.status).toBe(200);
    const html = await generated.text();
    const yaml = editorYaml(html);
    expect(yaml).toMatch(/^# 模型生成的草稿/);
    expect(yaml).toContain('amount: amount # 金额列');
    expect(html).toContain('还没有映射');

    const saved = await engineer.post('/mappings', { intent: 'create', sourceId, yaml });
    expect(saved.status).toBe(302);
    expect(await (await engineer.get(`/mappings/${mappingIdOf(saved)}?tab=versions`)).text()).toContain('data-version-status="draft"');

    modelReplies({ fields: [] });
    const rejected = await engineer.post('/mappings', { intent: 'model-draft', sourceId, table: 'customers', entity: 'customer', yaml: ORDERS });
    expect(rejected.status).toBe(422);
    const rejectedHtml = await rejected.text();
    expect(rejectedHtml).toContain('模型生成草稿失败');
    expect(editorYaml(rejectedHtml)).toBe(ORDERS);

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    expect((await analyst.post('/mappings', { intent: 'model-draft', sourceId, table: 'orders', entity: 'order' })).status).toBe(403);
  });

  it('模型草稿的「生成依据」按置信度升序列出每项，低置信度标红、中等琥珀色、其余绿色；理由照常转义；没配置模型服务时只写来源', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const ruled = await (await engineer.post('/mappings', { intent: 'model-draft', sourceId, table: 'orders', entity: 'order', yaml: '' })).text();
    expect(ruled).toMatch(/data-draft-origin="rules"[\s\S]*?按规则生成/);
    expect(ruled).not.toContain('data-confidence-path');

    modelReplies({ fields: [
      { field: 'order_id', expr: 'string(order_id)', confidence: 0.95, reason: '源表主键' },
      { field: 'amount', expr: 'amount', confidence: 0.3, reason: '<b>金额</b>，单位不确定' },
      { field: 'customer_id', expr: 'string(customer_id)', confidence: 0.6, reason: '同名列' },
    ] });
    const html = await (await engineer.post('/mappings', { intent: 'model-draft', sourceId, table: 'orders', entity: 'order', yaml: '' })).text();
    expect(html).toContain('data-draft-origin="model"');
    expect([...html.matchAll(/data-confidence-path="([^"]+)"/g)].map(m => m[1])).toEqual(['fields.amount', 'fields.customer_id', 'fields.order_id']);
    expect(html).toMatch(/data-confidence-path="fields.amount" data-confidence="0.3"[\s\S]*?data-confidence-level="low">低 30%/);
    expect(html).toMatch(/data-confidence-path="fields.customer_id"[\s\S]*?data-confidence-level="medium">中 60%/);
    expect(html).toMatch(/data-confidence-path="fields.order_id"[\s\S]*?data-confidence-level="high">高 95%/);
    expect(html).toContain('&lt;b&gt;金额&lt;/b&gt;，单位不确定');
  });

  it('源表结构命中已发布映射时，生成依据只写来源并链接到来源映射，不列条目', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await memberOf(tenantId, 'de@acme.com');
    const published = await publish(author, await memberOf(tenantId, 'de2@acme.com'), sourceId, ORDERS);
    const { id: shop2 } = await registerSource(author, await pgSourceInput(READER, '门店2'));
    await selectAllTables(author, shop2);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    modelReplies({ fields: [] });
    const engineer = await loginAs(app, 'de@acme.com');

    const html = await (await engineer.post('/mappings', { intent: 'model-draft', sourceId: shop2, table: 'orders', entity: 'order', yaml: '' })).text();
    expect(html).toMatch(new RegExp(`data-draft-origin="reuse"[\\s\\S]*?href="/mappings/${published}"`));
    expect(html).not.toContain('data-confidence-path');
  });

  it('详情页用模型重新生成：填进编辑框、不保存，显示生成依据，生成记录关联这个映射；读源视图的映射拒绝', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS }));
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toMatch(/value="model-draft"[^>]*>用模型重新生成/);
    modelReplies({ fields: [
      { field: 'order_id', expr: 'string(order_id)', confidence: 0.9, reason: '源表主键' },
      { field: 'amount', expr: 'amount', confidence: 0.4, reason: '金额列' },
    ] });

    const res = await engineer.post(`/mappings/${id}`, { intent: 'model-draft' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(editorYaml(html)).toMatch(/^# 模型生成的草稿/);
    expect([...html.matchAll(/data-confidence-path="([^"]+)"/g)].map(m => m[1])).toEqual(['fields.amount', 'fields.order_id']);
    expect(editorYaml(await (await engineer.get(`/mappings/${id}`)).text())).toBe(ORDERS);
    const generations = await getDb().select().from(mappingGenerations).where(eq(mappingGenerations.tenantId, tenantId));
    expect(generations).toEqual([expect.objectContaining({ mappingId: id, origin: 'model' })]);

    // 模型输出不合 Schema：422，编辑框保持提交时的内容；分析师 403
    modelReplies({ fields: [] });
    const failed = await engineer.post(`/mappings/${id}`, { intent: 'model-draft', yaml: CUSTOMERS });
    expect(failed.status).toBe(422);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain('模型生成草稿失败');
    expect(editorYaml(failedHtml)).toBe(CUSTOMERS);
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    expect((await (await loginAs(app, 'an@acme.com')).post(`/mappings/${id}`, { intent: 'model-draft' })).status).toBe(403);

    const member = await memberOf(tenantId, 'de@acme.com');
    const reviewer = await memberOf(tenantId, 'de2@acme.com');
    await confirmWatermark(member, sourceId, 'orders', 'order_id');
    await syncSource(member, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const viewId = await createSourceView(member, sourceId, { name: 'paid_orders', sql: "SELECT order_id, amount, status, _op, _batch, _commit_ts FROM orders WHERE status = 'paid'" });
    await publishSourceView(reviewer, sourceId, viewId, 1);
    const viewMapping = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml: ORDERS.replace('table: orders', 'view: paid_orders\nview_key: [order_id]') }));
    const rejected = await engineer.post(`/mappings/${viewMapping}`, { intent: 'model-draft' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('读源视图的映射请直接编辑');
  });

  it('生成草稿后改了再保存：表单带着生成记录，审计页显示修改了模型 / 规则生成的映射草稿与改动的字段数；校验不过时仍带着', async () => {
    const { sourceId } = await tenantWithSource('acme');
    const engineer = await loginAs(app, 'de@acme.com');
    const hiddenGeneration = (html: string) => html.match(/<input type="hidden" name="generationId" value="([0-9a-f-]{36})"/)?.[1];
    modelReplies({ fields: [
      { field: 'order_id', expr: 'string(order_id)', confidence: 0.95, reason: '源表主键' },
      { field: 'customer_id', expr: 'string(customer_id)', confidence: 0.9, reason: '同名列' },
      { field: 'amount', expr: 'amount', confidence: 0.7, reason: '金额列' },
    ] });

    const html = await (await engineer.post('/mappings', { intent: 'model-draft', sourceId, table: 'orders', entity: 'order', yaml: '' })).text();
    const generationId = hiddenGeneration(html)!;
    expect(generationId).toBeDefined();
    const yaml = editorYaml(html).replace(/amount: amount.*/, 'amount: amount / 100');
    const invalid = await engineer.post('/mappings', { intent: 'create', sourceId, yaml: yaml.replace('amount / 100', 'nope'), generationId });
    expect(invalid.status).toBe(400);
    expect(hiddenGeneration(await invalid.text())).toBe(generationId);
    const id = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId, yaml, generationId }));

    // 详情页按规则（没配置模型服务）重新生成，删掉一列保存到已有草稿
    vi.unstubAllEnvs();
    const regenerated = await (await engineer.post(`/mappings/${id}`, { intent: 'model-draft' })).text();
    const again = hiddenGeneration(regenerated)!;
    expect(again).toBeDefined();
    expect(hiddenGeneration(await (await engineer.get(`/mappings/${id}`)).text())).toBeUndefined();
    const trimmed = editorYaml(regenerated).replace(/^ {2}created_at: .*\n/m, '');
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: trimmed, generationId: again })).status).toBe(302);

    const audit = await (await loginAs(app, 'admin@acme.com')).get('/audit').then(r => r.text());
    expect(audit).toContain('修改了模型 / 规则生成的映射草稿');
    expect(audit).toContain('「电商库」orders → 订单，第 1 版：修改了模型生成的映射草稿，改动 1 个字段');
    expect(audit).toContain('「电商库」orders → 订单，第 1 版：修改了规则生成的映射草稿，改动 1 个字段');
    expect(audit).not.toContain('amount / 100');
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

  it('详情页把源表新增的列一键生成为扩展字段填进编辑框（像敏感信息的标成敏感），不保存；保存后不再提醒；不是新列时说明原因，分析师 403', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await memberOf(tenantId, 'de@acme.com');
    const id = await publish(author, await memberOf(tenantId, 'de2@acme.com'), sourceId, CUSTOMERS);
    await grantOnSource('ALTER TABLE shop.customers ADD COLUMN level text; ALTER TABLE shop.customers ADD COLUMN backup_mobile text;');
    await relistSource(author, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const engineer = await loginAs(app, 'de@acme.com');
    const before = await (await engineer.get(`/mappings/${id}`)).text();
    expect(before).toContain('data-add-columns="level,backup_mobile"');
    expect(before).toContain('data-add-column="level"');

    const generated = await engineer.post(`/mappings/${id}`, { intent: 'add-columns', column: ['level', 'backup_mobile'] });
    expect(generated.status).toBe(200);
    const yaml = editorYaml(await generated.text());
    expect(yaml).toContain(CUSTOMERS.trim());
    expect(yaml).toContain('x_level: { type: string, expr: level }');
    expect(yaml).toContain('x_backup_mobile: { type: string, expr: backup_mobile, sensitive: true }');
    // 只生成，不保存：仍只有已发布的 v1
    const versions = await (await engineer.get(`/mappings/${id}?tab=versions`)).text();
    expect(versions).not.toContain('data-version-status="draft"');
    expect(versions).not.toContain('data-version="2"');

    // 先只加 level 并保存：level 不再提醒
    const onlyLevel = editorYaml(await (await engineer.post(`/mappings/${id}`, { intent: 'add-columns', column: 'level' })).text());
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: onlyLevel })).status).toBe(302);
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toContain('data-drift-new="backup_mobile"');
    // 有草稿时基于草稿：带着已加的 x_level
    const fromDraft = editorYaml(await (await engineer.post(`/mappings/${id}`, { intent: 'add-columns', column: 'backup_mobile' })).text());
    expect(fromDraft).toBe(yaml);
    expect((await engineer.post(`/mappings/${id}`, { intent: 'save', yaml: fromDraft })).status).toBe(302);
    const after = await (await engineer.get(`/mappings/${id}`)).text();
    expect(after).not.toContain('data-drift-new');
    // 已用上的列不再是新列
    const again = await engineer.post(`/mappings/${id}`, { intent: 'add-columns', column: 'level' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('level 不是源表新增、映射还没用到的列');
    expect((await engineer.post(`/mappings/${id}`, { intent: 'add-columns', column: 'email' })).status).toBe(400);

    await memberOf(tenantId, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    expect((await analyst.post(`/mappings/${id}`, { intent: 'add-columns', column: 'level' })).status).toBe(403);
  });

  it('详情页把新列标记为忽略：映射列表与详情页不再提醒这一列，记审计；不是新列 400，分析师 403', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await memberOf(tenantId, 'de@acme.com');
    const id = await publish(author, await memberOf(tenantId, 'de2@acme.com'), sourceId, CUSTOMERS);
    await grantOnSource('ALTER TABLE shop.customers ADD COLUMN level text; ALTER TABLE shop.customers ADD COLUMN backup_mobile text;');
    await relistSource(author, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get(`/mappings/${id}`)).text()).toContain('data-ignore-column="level"');

    expect((await engineer.post(`/mappings/${id}`, { intent: 'ignore-column', column: 'level' })).status).toBe(302);
    const detail = await (await engineer.get(`/mappings/${id}`)).text();
    expect(detail).toContain('data-drift-new="backup_mobile"');
    expect(detail).not.toContain('data-drift-column="level"');
    expect(await (await engineer.get('/mappings')).text()).toContain('data-drift-new="backup_mobile">源表新增 1 列');

    const again = await engineer.post(`/mappings/${id}`, { intent: 'ignore-column', column: 'level' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('level 不是源表新增、映射还没用到的列');
    await memberOf(tenantId, 'analyst@acme.com', 'analyst');
    expect((await (await loginAs(app, 'analyst@acme.com')).post(`/mappings/${id}`, { intent: 'ignore-column', column: 'backup_mobile' })).status).toBe(403);

    await memberOf(tenantId, 'admin@acme.com', 'admin');
    const audit = await (await (await loginAs(app, 'admin@acme.com')).get('/audit')).text();
    expect(audit).toContain('「电商库」customers → 消费者，忽略新列 level');
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

  it('键空间：已登记关系起点的扩展字段（order.x_ticket → custom_ticket）出现在对照数据的 relationOrigins 里，表单给它填的键空间能保存并发布', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme');
    const author = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    // 关系起点的类型取自已发布的订单映射
    const published = `${ORDERS}extensions:\n  x_ticket: { type: string, expr: status } # 工单号\n`;
    const id = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: published }));
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '1' })).status).toBe(302);
    const ticket = await createCustomEntity(await memberOf(tenantId, 'de@acme.com'), {
      name: 'custom_ticket', label: '工单', kind: 'dimension', primaryKey: ['ticket_no'],
      fields: [{ name: 'ticket_no', type: 'string', description: '工单号', sensitive: false }],
      relations: [{ from: { entity: 'order', field: 'x_ticket' }, ref: { entity: 'custom_ticket', field: 'ticket_no' } }],
    });
    await publishCustomEntity(await memberOf(tenantId, 'de2@acme.com'), ticket, 1);
    const table = (await referenceTables(await memberOf(tenantId, 'de@acme.com'), sourceId)).find(t => t.name === 'orders')!;
    expect(table.relationOrigins).toEqual({ order: { x_ticket: 'custom_ticket' } });

    const doc = parseDocument(editorYaml(await (await author.get(`/mappings/${id}`)).text()));
    writeExtension(doc, 'x_ticket', { name: 'x_ticket', type: 'string', expr: 'status', keySpace: 'helpdesk' });
    const yaml = doc.toString();
    expect(yaml).toBe(published.replace('expr: status }', 'expr: status, key_space: helpdesk }'));
    expect(readExtensions(doc).extensions[0]).toMatchObject({ keySpace: 'helpdesk', readonly: false });
    expect((await author.post(`/mappings/${id}`, { intent: 'save', yaml })).status).toBe(302);
    expect((await reviewer.post(`/mappings/${id}`, { intent: 'publish', version: '2' })).status).toBe(302);
  });

  it('键空间：订单映射的草稿把键空间由 pos 改成 store 时，发布区列出同源订单明细映射与它的 order_id，这一版照常能发布', async () => {
    const { tenantId, sourceId } = await tenantWithSource('acme', `
      CREATE TABLE shop.order_items (item_no text PRIMARY KEY, order_id int NOT NULL, qty int NOT NULL);
      GRANT SELECT ON shop.order_items TO ${READER.user};`);
    const author = await loginAs(app, 'de@acme.com');
    await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
    const reviewer = await loginAs(app, 'de2@acme.com');
    const ordersId = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: `${ORDERS}key_space: pos\n` }));
    expect((await reviewer.post(`/mappings/${ordersId}`, { intent: 'publish', version: '1' })).status).toBe(302);
    const items = 'model: 1\nentity: order_item\ntable: order_items\nfields:\n  order_item_id: item_no\n  order_id: { expr: string(order_id), key_space: pos }\n  quantity: qty\n';
    const itemsId = mappingIdOf(await author.post('/mappings', { intent: 'create', sourceId, yaml: items }));
    expect((await reviewer.post(`/mappings/${itemsId}`, { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await reviewer.get(`/mappings/${ordersId}`)).text()).not.toContain('data-key-space-followers');

    expect((await author.post(`/mappings/${ordersId}`, { intent: 'save', yaml: `${ORDERS}key_space: store\n` })).status).toBe(302);
    const page = await (await reviewer.get(`/mappings/${ordersId}`)).text();
    const alert = page.slice(page.indexOf('data-key-space-followers'));
    expect(alert).toContain('由 pos 改为 store');
    expect(alert).toContain(`href="/mappings/${itemsId}"`);
    expect(alert).toContain('order_items');
    expect(alert).toContain('data-key-space-follower-field="order_id"');
    expect((await reviewer.post(`/mappings/${ordersId}`, { intent: 'publish', version: '2' })).status).toBe(302);
    expect(await (await reviewer.get(`/mappings/${ordersId}`)).text()).not.toContain('data-key-space-followers');
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

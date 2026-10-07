// test/http/lineage.test.ts —— 数据地图的 HTTP 接缝：任何成员都能打开 /lineage，关系图下的表与关系列表画出已接入的标准层表与 _identities、_device_owner，
// 页面不出现源表名；点表节点（?node=）给出按 lake 写的示例 SQL；_identities 显示匹配规则与最近一次合并的打通摘要（没有合并任务时显示尚未合并）；
// 「显示未接入的标准实体」开关（?all=1）灰显未接入的实体；没有已发布映射时显示空状态；流向图（?tab=flow）只对有 sources:read 的成员开放：列表带源表名、版本、行数与合并状态，失败的链到合并记录；
// 抽屉里的「聚焦此表」进入单表聚焦画布（?tab=flow&focus=），画布下的连线列表从源列连到标准层字段；查看者访问 ?focus= 回到关系图；
// 流向图与聚焦画布上反向查（?q=）标出命中的行，源表节点（?node=table:…）打开源表抽屉；查看者两者都不生效；
// 关系图下的「漂移检查」区块：数据工程师点按钮入队 lake.inspect（重复点提示已在排队），查看者看不到按钮、提交被拒，任何角色都看到最近一次结果；
// 最近一次成功检查里有差异的表在两张图的列表行上带漂移标记，孤表在区块里单独列出；缺列的表旁边有「重建合并」按钮（查看者没有、提交被拒），
// 类型不一致、多列与孤表只给提示
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, tasks } from '../../app/.server/db/schema';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { lastMergeByMapping, publishMapping, saveDraft } from '../../app/.server/mappings';
import { memberOf, newTenant, publish } from '../pipeline/fixtures';
import { CRM_ORDERS, publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/**
 * 把 CRM 订单映射的 status 改成兜底写空并发布第 2 版（不跑合并），再在它最近一次合并的结果里写上兜底统计；
 * 返回映射 ID 与各标准层表的行数（按实体，取自任务结果）
 */
async function fallbackOnCrmOrders(fixture: Awaited<ReturnType<typeof publishedIdentitySources>>) {
  const { acme, author, reviewer, sources } = fixture;
  const [{ id }] = await getDb().select({ id: mappings.id }).from(mappings)
    .where(and(eq(mappings.tenantId, acme), eq(mappings.sourceId, sources.crm), eq(mappings.tableName, 'orders')));
  await saveDraft(author, id, CRM_ORDERS.replace('refunded: refunded } }', 'refunded: refunded }, otherwise: null }'));
  await publishMapping(reviewer, id, 2);
  const { taskId } = (await lastMergeByMapping(acme, [id]))[id];
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  const result = task.result as { mappings: { mapping: string }[] };
  const fallback = [{ column: 'status', values: [{ value: '已关闭', rows: 3 }, { value: '作废', rows: 1 }], distinct: 2, rows: 4 }];
  await getDb().update(tasks).set({ result: { ...result, mappings: result.mappings.map(m => (m.mapping === id ? { ...m, fallback } : m)) } })
    .where(eq(tasks.id, taskId));
  return id;
}

/** 抽屉里一个字段的那一行 */
const fieldRow = (html: string, field: string) => html.match(new RegExp(`<li[^>]*data-field="${field}"[\\s\\S]*?</li>`))![0];

const decode = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

describe('数据地图', () => {
  it('查看者打开数据地图，看到已接入的表与经 _identities、_device_owner 的关系，页面不出现源表名；点表节点给出示例 SQL', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    expect(await (await viewer.get('/')).text()).toContain('href="/lineage"');

    const res = await viewer.get('/lineage');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-tab="graph"');
    for (const node of ['customer', 'order', 'event', '_identities', '_device_owner']) expect(html).toContain(`data-node="${node}"`);
    expect(html).toContain('data-edge="identity"');
    expect(html).toContain('data-edge="device"');
    expect(html).toContain('经 _identities 按 (_source, customer_id) 关联');
    expect(html).toContain('device_id（不带 _source，取最近一次登录）');
    expect(html).not.toContain('data-sql');
    // 源表名（customers、members、users、events、orders）不下发
    for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).not.toMatch(new RegExp(`(?<![-\\w])${table}\\b`));

    const order = decode(await (await viewer.get('/lineage?node=order')).text());
    expect(order).toContain('data-sql');
    expect(order).toContain('lake.silver."_identities" i ON i._source = t._source AND i.customer_id = t.customer_id');
    for (const banned of ['ATTACH', 'password', 's3://']) expect(order).not.toContain(banned);

    // 不认识的节点不出 SQL 面板
    expect(await (await viewer.get('/lineage?node=nope')).text()).not.toContain('data-sql');
  });

  it('_identities 显示匹配规则与最近一次合并的打通摘要；打开「显示未接入的标准实体」后灰显它们；没有合并任务时显示尚未合并', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    const [merge] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'silver.merge')))
      .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
    const { groups, records } = (merge.result as { identities: { groups: number; records: number } }).identities;
    expect(groups).toBeGreaterThan(0);

    const html = decode(await (await viewer.get('/lineage')).text());
    // 这些映射都没配 identity.match，用默认规则
    expect(html).toContain('手机号 > 邮箱 > 外部 ID');
    expect(html).toContain(`data-groups="${groups}"`);
    expect(html).toContain(`data-records="${records}"`);
    expect(html).not.toContain('尚未合并');
    expect(html).toMatch(/data-show-all[^>]*aria-checked="false"|aria-checked="false"[^>]*data-show-all/);
    expect(html).not.toContain('data-node="product"');
    expect(html).not.toContain('data-connected="false"');

    const all = decode(await (await viewer.get('/lineage?all=1&node=order')).text());
    expect(all).toContain('data-node="product"');
    expect(all).toContain('data-connected="false"');
    // 开关保留 node，指向关掉 all 的 URL
    expect(all).toMatch(/href="\/lineage\?node=order"[^>]*data-show-all|data-show-all[^>]*href="\/lineage\?node=order"/);

    await getDb().delete(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'silver.merge')));
    const none = await (await viewer.get('/lineage')).text();
    expect(none).toContain('尚未合并');
    expect(none).not.toContain('data-groups');
  });

  it('数据工程师打开流向图，看到各映射的源表、版本、最近一次合并与标准层表行数；合并失败的映射标红并链到合并记录', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    const eng = await loginAs(app, 'eng@acme.com');

    expect(await (await eng.get('/lineage')).text()).toContain('href="/lineage?tab=flow"');
    const res = await eng.get('/lineage?tab=flow');
    expect(res.status).toBe(200);
    const html = decode(await res.text());
    expect(html).toContain('data-tab="flow"');
    expect(html).toContain('data-flow-mapping');
    for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).toContain(table);
    expect(html).toMatch(/data-version="1"/);
    expect(html).toMatch(/data-rows="[1-9]\d*"/);
    expect(html).toContain('data-merge-status="ok"');
    expect(html).not.toContain('data-merge-status="failed"');
    // 流向图不带关系图的表与关系列表
    expect(html).not.toContain('data-edge=');

    const [merge] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'silver.merge')))
      .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
    const result = merge.result as { mappings: { mapping: string; entity: string; table: string; version: number; startedAt: string; durationMs: number }[] };
    const [first, ...rest] = result.mappings;
    const { mapping, entity, table, version, startedAt, durationMs } = first;
    await getDb().update(tasks).set({ result: { ...result, mappings: [{ mapping, entity, table, version, startedAt, durationMs, error: '源表读取失败' }, ...rest] } })
      .where(eq(tasks.id, merge.id));

    const failed = decode(await (await eng.get('/lineage?tab=flow')).text());
    const row = failed.match(new RegExp(`<tr[^>]*data-flow-mapping="${mapping}"[\\s\\S]*?</tr>`))![0];
    expect(row).toContain('data-merge-status="failed"');
    expect(row).toContain(`href="/mappings/${mapping}?tab=merges"`);
  });

  it('查看者没有流向图：看不到流向图 tab，?tab=flow 回到关系图，页面不出现源表名', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    const res = await viewer.get('/lineage?tab=flow');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('流向图');
    expect(html).not.toContain('data-tab="flow"');
    expect(html).not.toContain('data-flow-mapping');
    expect(html).toContain('data-tab="graph"');
    for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).not.toMatch(new RegExp(`(?<![-\\w])${table}\\b`));
  });

  it('数据工程师点标准层表节点打开字段抽屉：各映射的源表、源列与表达式，标出敏感哈希、值字典与兜底，兜底的字段附上最近一次合并的兜底统计', async () => {
    const fixture = await publishedIdentitySources({ orders: true });
    await fallbackOnCrmOrders(fixture);
    await memberOf(fixture.acme, 'eng@acme.com', 'data_engineer');
    const eng = await loginAs(app, 'eng@acme.com');

    // 流向图点标准层表：?node=silver.order，保留 tab=flow
    const html = decode(await (await eng.get('/lineage?tab=flow&node=silver.order')).text());
    expect(html).toContain('data-tab="flow"');
    expect(html).toContain('data-drawer="order"');
    expect(html).toMatch(/data-drawer-rows="[1-9]\d*"/);
    expect(html).toContain('href="/lineage?tab=flow"');
    const status = fieldRow(html, 'status');
    expect(status).toContain('订单状态');
    for (const text of ['orders', 'state', '值字典', '兜底：空', '已关闭', '作废']) expect(status).toContain(text);
    expect(status).toMatch(/4[^<]*行/);
    expect(status).toMatch(/2[^<]*种/);
    expect(fieldRow(html, 'customer_id')).toContain('string(customer)');
    // 值字典只标出有，不输出字典内容
    expect(status).not.toContain('已支付');

    // 关系图点表节点（?node=order）也打开同一个抽屉；customer 的手机号只存哈希
    const graph = decode(await (await eng.get('/lineage?node=order')).text());
    expect(graph).toContain('data-drawer="order"');
    expect(graph).toContain('data-sql');
    expect(fieldRow(graph, 'status')).toContain('已关闭');
    expect(fieldRow(decode(await (await eng.get('/lineage?node=silver.customer')).text()), 'phone')).toContain('敏感哈希');

    // 打通表与不认识的节点不开抽屉
    for (const node of ['silver._identities', 'silver.product', 'nope']) expect(await (await eng.get(`/lineage?node=${node}`)).text()).not.toContain('data-drawer');
  });

  it('查看者的字段抽屉只有字段说明与行数：返回的数据与页面都不出现源表名、源列、表达式或兜底取值', async () => {
    const fixture = await publishedIdentitySources({ orders: true });
    await fallbackOnCrmOrders(fixture);
    await memberOf(fixture.acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    for (const url of ['/lineage?node=order', '/lineage?tab=flow&node=silver.order']) {
      const html = decode(await (await viewer.get(url)).text());
      expect(html).toContain('data-drawer="order"');
      expect(html).toMatch(/data-drawer-rows="[1-9]\d*"/);
      expect(fieldRow(html, 'status')).toContain('订单状态');
      expect(fieldRow(html, 'status')).toContain('订单的当前状态');
      for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).not.toMatch(new RegExp(`(?<![-\\w])${table}\\b`));
      for (const banned of ['string(customer)', 'from_timezone', '已关闭', '作废', '兜底', '值字典', 'sourceColumns']) expect(html).not.toContain(banned);
    }
  });

  it('数据工程师从抽屉点「聚焦此表」进入单表聚焦画布：同名源表按数据源分开，连线从源列连到标准层字段，有返回流向图的入口', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    const eng = await loginAs(app, 'eng@acme.com');

    const drawer = decode(await (await eng.get('/lineage?tab=flow&node=silver.order')).text());
    expect(drawer).toContain('聚焦此表');
    expect(drawer).toContain('href="/lineage?tab=flow&focus=order"');

    const html = decode(await (await eng.get('/lineage?tab=flow&focus=order')).text());
    expect(html).toContain('data-tab="flow"');
    expect(html).toContain('data-focus="order"');
    expect(html).toMatch(/href="\/lineage\?tab=flow"[^>]*>(?:(?!<\/a>)[\s\S])*返回流向图/);
    // 两张 orders 各自连到字段；多列与单列表达式都按源列出边
    expect(html).toContain(`data-field-edge="${sources.crm}:orders.order_no→order_id"`);
    expect(html).toContain(`data-field-edge="${sources.crm}:orders.customer→customer_id"`);
    expect(html).toContain(`data-field-edge="${sources.loyalty}:orders.id→order_id"`);
    expect(html).toContain(`data-field-edge="${sources.loyalty}:orders.state→status"`);
    // 聚焦画布不带流向图的映射列表，也不画别的标准层表
    expect(html).not.toContain('data-flow-mapping');
    expect(html).not.toContain(`data-field-edge="${sources.crm}:customers.`);

    // 不认识的实体回到流向图
    expect(await (await eng.get('/lineage?tab=flow&focus=nope')).text()).toContain('data-flow-mapping');
  });

  it('数据工程师在流向图和聚焦画布上反向查一个源列：命中的映射、标准层表与字段连线带 data-hit，没有命中时显示没有找到', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    const eng = await loginAs(app, 'eng@acme.com');
    const orderMappings = await getDb().select({ id: mappings.id, sourceId: mappings.sourceId }).from(mappings)
      .where(and(eq(mappings.tenantId, acme), eq(mappings.tableName, 'orders')));
    const crmOrders = orderMappings.find(m => m.sourceId === sources.crm)!.id;
    const loyaltyOrders = orderMappings.find(m => m.sourceId === sources.loyalty)!.id;
    const mappingRow = (html: string, id: string) => html.match(new RegExp(`<tr[^>]*data-flow-mapping="${id}"[^>]*>`))![0];
    const silverRow = (html: string, entity: string) => html.match(new RegExp(`<tr[^>]*data-silver="${entity}"[^>]*>`))![0];

    expect(await (await eng.get('/lineage?tab=flow')).text()).toContain('name="q"');

    // 只有 CRM 的 orders 有 status 列（会员的叫 state）
    const html = decode(await (await eng.get('/lineage?tab=flow&q=STATUS')).text());
    expect(html).toMatch(/name="q"[^>]*value="STATUS"|value="STATUS"[^>]*name="q"/);
    expect(mappingRow(html, crmOrders)).toContain('data-hit');
    expect(mappingRow(html, loyaltyOrders)).not.toContain('data-hit');
    expect(silverRow(html, 'order')).toContain('data-hit');
    expect(silverRow(html, 'customer')).not.toContain('data-hit');
    expect(html).not.toContain('没有找到');

    // 表.列：两个数据源里的 orders 都命中
    const both = decode(await (await eng.get('/lineage?tab=flow&q=orders.updated_at')).text());
    for (const id of [crmOrders, loyaltyOrders]) expect(mappingRow(both, id)).toContain('data-hit');
    expect(silverRow(both, 'customer')).not.toContain('data-hit');

    expect(decode(await (await eng.get('/lineage?tab=flow&q=members.nope')).text())).toContain('没有找到');

    // 聚焦画布：命中的字段连线带 data-hit
    const focus = decode(await (await eng.get('/lineage?tab=flow&focus=order&q=state')).text());
    expect(focus).toContain('name="q"');
    expect(focus).toMatch(new RegExp(`data-field-edge="${sources.loyalty}:orders.state→status"[^>]*data-hit|data-hit[^>]*data-field-edge="${sources.loyalty}:orders.state→status"`));
    expect(focus.match(new RegExp(`<tr[^>]*data-field-edge="${sources.crm}:orders.status→status"[^>]*>`))![0]).not.toContain('data-hit');
    expect(focus).not.toContain('没有找到');
    // 只命中别的标准层表（CRM customers 的 mobile）时，聚焦画布上也算没有找到
    expect(decode(await (await eng.get('/lineage?tab=flow&focus=order&q=mobile')).text())).toContain('没有找到');
  });

  it('数据工程师点源表节点打开源表抽屉：按源列列出它影响的标准层字段、映射与表达式', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    const eng = await loginAs(app, 'eng@acme.com');

    const html = decode(await (await eng.get(`/lineage?tab=flow&node=table:${sources.crm}:orders`)).text());
    expect(html).toContain(`data-table-drawer="${sources.crm}:orders"`);
    for (const impact of ['status→order.status', 'customer→order.customer_id', 'order_no→order.order_id', 'updated_at→order.updated_at']) {
      expect(html).toContain(`data-impact="${impact}"`);
    }
    expect(html).toContain('string(customer)');
    // 只列这个数据源的 orders：会员的 state 不在里面
    expect(html).not.toContain('data-impact="state→');

    // 不认识的源表不开抽屉
    expect(await (await eng.get(`/lineage?tab=flow&node=table:${sources.crm}:nope`)).text()).not.toContain('data-table-drawer');
  });

  it('查看者没有反向查与源表抽屉：看不到搜索框，?q= 与 ?node=table:… 不生效，页面不出现源表名', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    for (const url of ['/lineage?q=status', '/lineage?tab=flow&q=orders.status', `/lineage?node=table:${sources.crm}:orders`, `/lineage?tab=flow&node=table:${sources.crm}:orders&q=status`]) {
      const html = decode(await (await viewer.get(url)).text());
      expect(html).toContain('data-tab="graph"');
      expect(html).not.toContain('name="q"');
      for (const banned of ['data-hit', 'data-impact', 'data-table-drawer', '没有找到']) expect(html).not.toContain(banned);
      for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).not.toMatch(new RegExp(`(?<![-\\w])${table}\\b`));
    }
  });

  it('查看者访问 ?focus= 时回到关系图，页面不出现源表名；抽屉里没有「聚焦此表」', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    for (const url of ['/lineage?tab=flow&focus=order', '/lineage?focus=order&node=order']) {
      const html = decode(await (await viewer.get(url)).text());
      expect(html).toContain('data-tab="graph"');
      expect(html).not.toContain('data-focus');
      expect(html).not.toContain('data-field-edge');
      expect(html).not.toContain('聚焦此表');
      for (const table of ['customers', 'members', 'users', 'events', 'orders']) expect(html).not.toMatch(new RegExp(`(?<![-\\w])${table}\\b`));
    }
  });

  it('自定义实体的表节点也能打开字段抽屉，字段说明取自实体登记', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources();
    const entity = await createCustomEntity(author, {
      name: 'custom_member_card', label: '会员卡', kind: 'dimension', primaryKey: ['card_id'],
      fields: [{ name: 'card_id', type: 'string', description: '会员卡号', sensitive: false }, { name: 'holder', type: 'string', description: '持卡人姓名', sensitive: false }],
    });
    await publishCustomEntity(reviewer, entity, 1);
    await publish(author, reviewer, sources.loyalty, `model: 1
entity: custom_member_card
table: members
extensions:
  card_id: { type: string, expr: string(member_id) }
  holder: { type: string, expr: full_name }
dedupe: { key: [card_id] }
`);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = decode(await (await viewer.get('/lineage?node=custom_member_card')).text());
    expect(html).toContain('data-drawer="custom_member_card"');
    expect(html).toContain('会员卡');
    expect(fieldRow(html, 'card_id')).toContain('会员卡号');
    expect(fieldRow(html, 'holder')).toContain('持卡人姓名');

    const eng = await loginAs(app, 'de@acme.com');
    const full = decode(await (await eng.get('/lineage?tab=flow&node=silver.custom_member_card')).text());
    expect(fieldRow(full, 'holder')).toContain('持卡人姓名');
    expect(fieldRow(full, 'holder')).toContain('full_name');
    expect(fieldRow(full, 'holder')).not.toContain('扩展字段');
  });

  it('数据工程师点「漂移检查」入队，重复点提示已在排队；查看者看不到按钮、提交被拒，但看得到最近一次结果的每条差异', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const eng = await loginAs(app, 'eng@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');

    const before = await (await eng.get('/lineage')).text();
    expect(before).toContain('data-inspect-status="never"');
    expect(before).toContain('尚未检查');
    expect(before).toContain('name="intent" value="inspect"');

    expect((await eng.post('/lineage', { intent: 'inspect' })).status).toBe(302);
    const [queued, ...more] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'lake.inspect')));
    expect(more).toEqual([]);
    expect(queued.status).toBe('queued');
    expect(queued.params).toHaveProperty('expected.customer.customer_id', 'VARCHAR');
    const again = await eng.post('/lineage', { intent: 'inspect' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('已有一次漂移检查在排队或运行中');
    expect(await (await eng.get('/lineage')).text()).toContain('data-inspect-status="running"');

    const viewerPage = await (await viewer.get('/lineage')).text();
    expect(viewerPage).toContain('data-inspect-status="running"');
    expect(viewerPage).not.toContain('value="inspect"');
    expect((await viewer.post('/lineage', { intent: 'inspect' })).status).toBe(403);

    await getDb().update(tasks).set({
      status: 'succeeded', finishedAt: new Date(),
      result: { drifts: [
        { table: 'customer', kind: 'missing', column: 'city', expected: 'VARCHAR' },
        { table: 'customer', kind: 'type', column: 'birthday', expected: 'DATE', actual: 'VARCHAR' },
        { table: 'stray', kind: 'orphan' },
      ] },
    }).where(eq(tasks.id, queued.id));
    const report = await (await viewer.get('/lineage')).text();
    expect(report).toContain('data-inspect-status="ok"');
    expect(report).toContain('检查时间');
    for (const drift of ['customer:missing:city', 'customer:type:birthday', 'stray:orphan:']) expect(report).toContain(`data-drift="${drift}"`);
    expect(report).toContain('应有 DATE / 实际 VARCHAR');

    await getDb().update(tasks).set({ result: { drifts: [] } }).where(eq(tasks.id, queued.id));
    expect(await (await viewer.get('/lineage')).text()).toContain('没有漂移');

    await getDb().update(tasks).set({ status: 'failed', error: '数据湖读取失败' }).where(eq(tasks.id, queued.id));
    const failed = await (await viewer.get('/lineage')).text();
    expect(failed).toContain('data-inspect-status="failed"');
    expect(failed).toContain('数据湖读取失败');
  });

  it('最近一次成功的漂移检查有差异的标准层表，在关系图与流向图上标出差异种类与数量；孤表在漂移检查区块单独列出', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const eng = await loginAs(app, 'eng@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');

    // 从没检查过：没有标记
    expect(await (await viewer.get('/lineage')).text()).not.toContain('data-node-drift');
    expect(await (await eng.get('/lineage?tab=flow')).text()).not.toContain('data-node-drift');

    await getDb().insert(tasks).values({
      tenantId: acme, kind: 'lake.inspect', status: 'succeeded', finishedAt: new Date(),
      result: { drifts: [
        { table: 'customer', kind: 'missing', column: 'city', expected: 'VARCHAR' },
        { table: 'customer', kind: 'missing', column: 'phone', expected: 'VARCHAR' },
        { table: 'customer', kind: 'type', column: 'birthday', expected: 'DATE', actual: 'VARCHAR' },
        { table: 'stray', kind: 'orphan' },
      ] },
    });
    const nodeRow = (html: string, node: string) => html.match(new RegExp(`<tr[^>]*data-node="${node}"[\\s\\S]*?</tr>`))![0];
    for (const who of [viewer, eng]) {
      const graph = await (await who.get('/lineage')).text();
      const customer = nodeRow(graph, 'customer');
      expect(customer).toContain('data-node-drift="missing,type"');
      expect(customer).toContain('缺 2 列 · 类型 1');
      expect(nodeRow(graph, 'order')).not.toContain('data-node-drift');
      expect(graph).not.toContain('data-node="stray"');
      const orphan = graph.match(/<li[^>]*data-orphan="stray"[\s\S]*?<\/li>/)![0];
      expect(orphan).toContain('湖里有这张表，但已没有任何已发布映射写入');
    }

    const flow = await (await eng.get('/lineage?tab=flow')).text();
    const silver = flow.match(/<tr[^>]*data-silver="customer"[\s\S]*?<\/tr>/)![0];
    expect(silver).toContain('data-node-drift="missing,type"');
    expect(silver).toContain('缺 2 列 · 类型 1');
    expect(flow.match(/<tr[^>]*data-silver="order"[^>]*>/)![0]).not.toContain('data-node-drift');
  });

  it('缺列的表旁边有「重建合并」按钮，提交后入队一次带强制重建标记的合并；类型不一致、多列、孤表只给提示；查看者看不到按钮、提交被拒', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const eng = await loginAs(app, 'eng@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');
    await getDb().insert(tasks).values({
      tenantId: acme, kind: 'lake.inspect', status: 'succeeded', finishedAt: new Date(),
      result: { drifts: [
        { table: 'customer', kind: 'missing', column: 'city', expected: 'VARCHAR' },
        { table: 'customer', kind: 'missing', column: 'phone', expected: 'VARCHAR' },
        { table: 'customer', kind: 'type', column: 'birthday', expected: 'DATE', actual: 'VARCHAR' },
        { table: 'order', kind: 'extra', column: 'legacy', actual: 'VARCHAR' },
        { table: 'stray', kind: 'orphan' },
      ] },
    });
    const driftRow = (html: string, drift: string) => decode(html.match(new RegExp(`<li[^>]*data-drift="${drift}"[\\s\\S]*?</li>`))![0]);

    const page = await (await eng.get('/lineage')).text();
    // 一张表一个按钮，放在它的第一条缺列上
    expect(page.match(/value="rebuild"/g)).toHaveLength(1);
    const city = driftRow(page, 'customer:missing:city');
    expect(city).toContain('name="intent" value="rebuild"');
    expect(city).toContain('name="entity" value="customer"');
    expect(city).toContain('重建合并');
    const type = driftRow(page, 'customer:type:birthday');
    expect(type).toContain('data-drift-hint="type"');
    expect(type).toContain('需要删表重建，暂不支持');
    for (const [drift, kind] of [['order:extra:legacy', 'extra'], ['stray:orphan:', 'orphan']]) {
      const row = driftRow(page, drift);
      expect(row).toContain(`data-drift-hint="${kind}"`);
      expect(row).toContain('不影响合并，平台不删除湖表');
      expect(row).not.toContain('value="rebuild"');
    }

    const viewerPage = await (await viewer.get('/lineage')).text();
    expect(viewerPage).not.toContain('value="rebuild"');
    expect(viewerPage).toContain('data-drift-hint="type"');
    expect((await viewer.post('/lineage', { intent: 'rebuild', entity: 'customer' })).status).toBe(403);

    const merges = () => getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'silver.merge'), eq(tasks.status, 'queued')));
    expect(await merges()).toEqual([]);
    expect((await eng.post('/lineage', { intent: 'rebuild', entity: 'customer' })).status).toBe(302);
    const [merge, ...more] = await merges();
    expect(more).toEqual([]);
    const planned = (merge.params as { mappings: { entity: string; rebuild?: boolean }[] }).mappings;
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every(m => m.entity === 'customer' && m.rebuild === true)).toBe(true);

    const again = await eng.post('/lineage', { intent: 'rebuild', entity: 'customer' });
    expect(again.status).toBe(400);
    const html = decode(await again.text());
    expect(html).toContain('没有开始重建');
    expect(html).toContain('已有一次合并在排队或运行中');
    expect((await eng.post('/lineage', { intent: 'rebuild', entity: 'stray' })).status).toBe(400);
  });

  it('没有已发布映射时显示空状态', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = await (await viewer.get('/lineage')).text();
    expect(html).toContain('还没有已发布的映射');
    expect(html).not.toContain('data-node=');
  });
});

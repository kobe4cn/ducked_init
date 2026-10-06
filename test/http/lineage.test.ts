// test/http/lineage.test.ts —— 数据地图的 HTTP 接缝：任何成员都能打开 /lineage，关系图下的表与关系列表画出已接入的标准层表与 _identities、_device_owner，
// 页面不出现源表名；点表节点（?node=）给出按 lake 写的示例 SQL；_identities 显示匹配规则与最近一次合并的打通摘要（没有合并任务时显示尚未合并）；
// 「显示未接入的标准实体」开关（?all=1）灰显未接入的实体；没有已发布映射时显示空状态；流向图（?tab=flow）只对有 sources:read 的成员开放：列表带源表名、版本、行数与合并状态，失败的链到合并记录
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

  it('没有已发布映射时显示空状态', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = await (await viewer.get('/lineage')).text();
    expect(html).toContain('还没有已发布的映射');
    expect(html).not.toContain('data-node=');
  });
});

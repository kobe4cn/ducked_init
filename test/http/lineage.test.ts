// test/http/lineage.test.ts —— 数据地图的 HTTP 接缝：任何成员都能打开 /lineage，关系图下的表与关系列表画出已接入的标准层表与 _identities、_device_owner，
// 页面不出现源表名；点表节点（?node=）给出按 lake 写的示例 SQL；没有已发布映射时显示空状态
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

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

  it('没有已发布映射时显示空状态', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = await (await viewer.get('/lineage')).text();
    expect(html).toContain('还没有已发布的映射');
    expect(html).not.toContain('data-node=');
  });
});

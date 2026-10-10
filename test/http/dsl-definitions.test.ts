// test/http/dsl-definitions.test.ts —— 指标定义的 HTTP 接缝：分析师在新建页填写键与 YAML 保存草稿 → 跳到定义页看到编译出的 SQL 与版本；在定义页再次保存改同一份草稿；
// 校验不通过时按行列列出问题；查看者看不到「新建指标」、打不开新建页、提交 403；分析页里 metric: 快照链接到定义页
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks } from '../../app/.server/db/schema';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';

describe('指标定义页', () => {
  it('分析师新建指标、再次保存改同一份草稿，定义页展示编译出的 SQL；校验不通过时按行列列出问题', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');

    expect(await (await analyst.get('/analytics')).text()).toContain('href="/analytics/definitions/new"');
    expect((await analyst.get('/analytics/definitions/new')).status).toBe(200);

    const bad = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: 'base: order\nmeasure: { agg: sum, field: channel }\n' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/data-issue-line="2"[^>]*>第 2 行第 \d+ 列（measure\.field）：sum 只能用整数或小数字段/);
    expect((await analyst.post('/analytics/definitions/new', { key: 'Revenue', yaml: REVENUE })).status).toBe(400);

    const created = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });
    expect(created.status).toBe(302);
    expect(created.headers.get('location')).toBe('/analytics/definitions/metric/revenue');
    const duplicate = await analyst.post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });
    expect(await duplicate.text()).toContain('已经有键为 revenue 的指标');

    const page = await (await analyst.get('/analytics/definitions/metric/revenue')).text();
    expect(page).toMatch(/data-compiled-sql[^>]*>[^<]*未关联[^<]*silver\._identities[^<]*LEFT JOIN silver\.&quot;customer&quot;/);
    expect(page).toContain('analyst@acme.com');

    const engineer = await loginAs(app, 'de@acme.com');
    const saved = await engineer.post('/analytics/definitions/metric/revenue', { intent: 'save', yaml: REVENUE.replace('sum', 'avg') });
    expect(saved.headers.get('location')).toBe('/analytics/definitions/metric/revenue?saved=1');
    const after = await (await engineer.get('/analytics/definitions/metric/revenue?saved=1')).text();
    expect(after).toContain('第 1 版草稿已保存');
    expect(after).toContain('analyst@acme.com、de@acme.com');
    expect(after).toContain('AVG(b.&quot;amount&quot;)');
    expect(after.match(/data-version="/g)).toHaveLength(1);

    expect((await engineer.get('/analytics/definitions/metric/missing')).status).toBe(404);
    expect((await engineer.get('/analytics/definitions/nope/revenue')).status).toBe(404);
  });

  it('查看者看不到「新建指标」、打不开新建页、不能保存，但能查看定义；其他租户 404', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    await (await loginAs(app, 'analyst@acme.com')).post('/analytics/definitions/new', { key: 'revenue', yaml: REVENUE });

    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/analytics')).text()).not.toContain('/analytics/definitions/new');
    expect((await viewer.get('/analytics/definitions/new')).status).toBe(403);
    expect((await viewer.post('/analytics/definitions/new', { key: 'other', yaml: REVENUE })).status).toBe(403);
    const page = await viewer.get('/analytics/definitions/metric/revenue');
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('校验并保存草稿');
    expect((await viewer.post('/analytics/definitions/metric/revenue', { intent: 'save', yaml: REVENUE })).status).toBe(403);

    const globex = await newTenant('globex');
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    expect((await (await loginAs(app, 'analyst@globex.com')).get('/analytics/definitions/metric/revenue')).status).toBe(404);
  });

  it('分析页里指标快照显示键，链接到定义页而不是快照页', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const [task] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'gold.metric', status: 'succeeded' }).returning();
    const [snapshot] = await getDb().insert(snapshots).values({
      tenantId: acme, template: 'metric:revenue', taskId: task!.id, table: `gold.metric__${task!.id}`, params: { asOf: '2024-07-01' }, rowCount: 3,
      expiresAt: new Date(Date.now() + 86_400_000),
    }).returning();

    const html = await (await (await loginAs(app, 'viewer@acme.com')).get('/analytics')).text();
    expect(html).toMatch(/href="\/analytics\/definitions\/metric\/revenue"[^>]*>revenue</);
    expect(html).not.toContain(`/analytics/snapshots/${snapshot!.id}`);
  });
});

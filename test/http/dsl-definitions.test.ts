// test/http/dsl-definitions.test.ts —— 指标定义的 HTTP 接缝：分析师在新建页填写键与 YAML 保存草稿 → 跳到定义页看到编译出的 SQL 与版本；在定义页再次保存改同一份草稿；
// 校验不通过时按行列列出问题；分析页「新建标签」进到标签种类的新建页；查看者看不到「新建指标」、打不开新建页、提交 403；分析页里 metric: 快照链接到定义页；
// 定义页点「预览」展示前 50 行与总行数（查看者也能预览），标准层缺表时给出说明，不存在的定义 404；有草稿且已发布过时点「预览影响」展示指标与下游标签的变化人数；
// 版本表里发布不了的成员看到原因，另一位数据工程师发布后入队 gold.dsl；丢弃草稿回到已发布版本，从没发布过时回到分析页；
// 数据工程师看到「删除」按钮（分析师看不到、提交 403），被已发布标签引用的指标删不了，删除后回到分析页
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks } from '../../app/.server/db/schema';
import { createDefinition, getDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';

describe('指标与标签定义页', () => {
  it('分析师新建指标、再次保存改同一份草稿，定义页展示编译出的 SQL；校验不通过时按行列列出问题', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');

    expect(await (await analyst.get('/analytics')).text()).toContain('href="/analytics/definitions/new?kind=metric"');
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

  it('分析页「新建标签」进到标签种类的新建页；引用未发布的指标时按行列列出问题，种类不存在时 404', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    expect(await (await analyst.get('/analytics')).text()).toContain('href="/analytics/definitions/new?kind=tag"');
    const page = await (await analyst.get('/analytics/definitions/new?kind=tag')).text();
    expect(page).toContain('新建标签');
    expect(page).toContain('name="kind" value="tag"');
    expect((await analyst.get('/analytics/definitions/new?kind=nope')).status).toBe(404);

    const bad = await analyst.post('/analytics/definitions/new', { kind: 'tag', key: 'value_tier', yaml: 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/data-issue-line="1"[^>]*>第 1 行第 9 列（metric）：没有已发布的指标 revenue/);
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

  it('定义页点「预览」展示结果与总行数，关联不到的维度显示「未关联」、没有明文；查看者也能预览；标准层缺表时给出说明；不存在的定义 404', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await createDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'metric', 'revenue', REVENUE);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/analytics/definitions/metric/revenue')).text()).toContain('预览第 1 版');

    // 5 个打通后的消费者有订单；CRM 的 customer 映射没有 city，全部「未关联」
    const res = await viewer.post('/analytics/definitions/metric/revenue', { intent: 'preview', version: '1' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-preview-total[^>]*>第 1 版，统计日 \d{4}-\d{2}-\d{2}：共 5 行</);
    expect(html).toContain('<th');
    expect(html.match(/>未关联</g)).toHaveLength(5);
    expect(html).not.toMatch(/zhang@crm\.test|13800000001/);

    const globex = await newTenant('globex');
    await createDefinition(await memberOf(globex, 'analyst@globex.com', 'analyst'), 'metric', 'revenue', REVENUE);
    const outsider = await loginAs(app, 'analyst@globex.com');
    const missing = await outsider.post('/analytics/definitions/metric/revenue', { intent: 'preview', version: '1' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('标准层还没有 silver.customer、silver.order：先发布 customer、order 的映射并合并');
    expect((await outsider.post('/analytics/definitions/metric/missing', { intent: 'preview' })).status).toBe(404);
  });

  it('有草稿且已发布过时定义页点「预览影响」：指标给出变化人数，下游标签按草稿不再通过校验时说明原因；标签草稿列出「原取值 → 新取值」；没有明文', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: count }\n');
    await publishDefinition(reviewer, 'metric', 'revenue', 1);
    await createDefinition(author, 'tag', 'buyer', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n');
    await publishDefinition(reviewer, 'tag', 'buyer', 1);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const metric = '/analytics/definitions/metric/revenue';
    // 没有草稿时不显示
    expect(await (await viewer.get(metric)).text()).not.toContain('预览影响');

    // 加了维度：5 个有订单的消费者行都变了；标签引用不了带维度的指标
    await saveDslDraft(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n');
    expect(await (await viewer.get(metric)).text()).toContain('预览影响');
    const res = await viewer.post(metric, { intent: 'impact' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-impact-metric[^>]*>指标 revenue：取值变化 5 人，新增 0 人，移出 0 人</);
    expect(html).toMatch(/data-impact-tag="buyer".*?带维度/s);
    expect(html).not.toMatch(/zhang@crm\.test|13800000001/);

    // 标签草稿换了取值的名字：有订单的 5 个消费者从 high 换成 vip
    await saveDslDraft(author, 'tag', 'buyer', 'metric: revenue\nrules:\n  - { value: vip, when: { gte: 1 } }\ndefault: low\n');
    const tag = await (await viewer.post('/analytics/definitions/tag/buyer', { intent: 'impact' })).text();
    expect(tag).toMatch(/data-impact-tag="buyer".*?high → vip：5 人/s);
    expect((await viewer.post('/analytics/definitions/metric/missing', { intent: 'impact' })).status).toBe(404);
  });

  it('发布不了的成员在版本表里看到原因；另一位数据工程师发布后入队 gold.dsl；丢弃草稿回到已发布版本，从没发布过时删除定义回到分析页', async () => {
    const acme = await newTenant('acme');
    const analystMember = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    await memberOf(acme, 'de2@acme.com', 'data_engineer');
    await createDefinition(analystMember, 'metric', 'revenue', REVENUE);
    const path = '/analytics/definitions/metric/revenue';

    const analyst = await loginAs(app, 'analyst@acme.com');
    expect(await (await analyst.get(path)).text()).toMatch(/data-publish-blocker[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect((await analyst.post(path, { intent: 'publish', version: '1' })).status).toBe(403);

    const engineer = await loginAs(app, 'de@acme.com');
    await engineer.post(path, { intent: 'save', yaml: REVENUE.replace('sum', 'avg') });
    expect(await (await engineer.get(path)).text()).toMatch(/data-publish-blocker[^>]*>.*?你最后改了这一版草稿/s);
    expect((await engineer.post(path, { intent: 'publish', version: '1' })).status).toBe(403);

    const reviewer = await loginAs(app, 'de2@acme.com');
    expect(await (await reviewer.get(path)).text()).toContain('发布 v1');
    const published = await reviewer.post(path, { intent: 'publish', version: '1' });
    expect(published.headers.get('location')).toBe(`${path}?published=1`);
    expect(await (await reviewer.get(`${path}?published=1`)).text()).toContain('第 1 版已发布');
    expect(await getDb().select({ kind: tasks.kind }).from(tasks)).toContainEqual({ kind: 'gold.dsl' });

    await analyst.post(path, { intent: 'save', yaml: REVENUE });
    expect((await analyst.post(path, { intent: 'discard' })).headers.get('location')).toBe(path);
    expect(await getDefinition(analystMember, 'metric', 'revenue')).toMatchObject({ draft: null, published: { version: 1 } });
    expect((await analyst.post(path, { intent: 'discard' })).status).toBe(404);

    await createDefinition(analystMember, 'metric', 'orders', REVENUE);
    expect((await analyst.post('/analytics/definitions/metric/orders', { intent: 'discard' })).headers.get('location')).toBe('/analytics');
    expect((await analyst.get('/analytics/definitions/metric/orders')).status).toBe(404);
  });

  it('数据工程师看到删除按钮，分析师看不到且提交 403；被已发布标签引用的指标在按钮处说明原因、提交 400 并列出标签，删掉标签后能删，回到分析页', async () => {
    const acme = await newTenant('acme');
    const analystMember = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineerMember = await memberOf(acme, 'de@acme.com', 'data_engineer');
    await createDefinition(analystMember, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await publishDefinition(engineerMember, 'metric', 'revenue', 1);
    await createDefinition(analystMember, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
    await publishDefinition(engineerMember, 'tag', 'value_tier', 1);
    const metric = '/analytics/definitions/metric/revenue';

    const analyst = await loginAs(app, 'analyst@acme.com');
    expect(await (await analyst.get(metric)).text()).not.toContain('删除指标');
    expect((await analyst.post(metric, { intent: 'delete' })).status).toBe(403);

    const engineer = await loginAs(app, 'de@acme.com');
    const page = await (await engineer.get(metric)).text();
    expect(page).toMatch(/data-delete-blocker[^>]*>.*?被已发布的标签引用，不能删除：value_tier/s);
    expect(page).not.toContain('删除指标');
    // 绕过页面直接提交也被拒
    const blocked = await engineer.post(metric, { intent: 'delete' });
    expect(blocked.status).toBe(400);
    expect(await blocked.text()).toContain('指标 revenue 被已发布的标签引用，不能删除：value_tier');

    expect((await engineer.post('/analytics/definitions/tag/value_tier', { intent: 'delete' })).headers.get('location')).toBe('/analytics');
    expect(await (await engineer.get(metric)).text()).toContain('删除指标');
    expect((await engineer.post(metric, { intent: 'delete' })).headers.get('location')).toBe('/analytics');
    expect((await engineer.get(metric)).status).toBe(404);
  });
});

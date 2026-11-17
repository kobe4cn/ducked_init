// 分析页的 HTTP 接缝：有结果层查看权限的成员在「分析」页看到本租户的 RFM 快照，打开看各人群与分页的消费者明细（只有 consumer_id 与分值，没有明文）；
// 其他租户的快照 404，已过期的快照标灰、打不开；RFM 模板参数页的权限矩阵：查看者只读，分析师能起草不能发布，
// 最后保存草稿的人不能发布，另一位数据工程师或管理员发布后入队 gold.rfm；按生效版本重新计算（分析师 403、未来日期与重复入队被拒）；
// 用户 360 走注册表里的通用参数表单（只读、起草、校验报错、多余字段不传、发布后入队 gold.user360、未登记模板 404）与通用快照明细（全部列、是 / 否、分页、没有明文）
// 流失预警快照页（#834）：顶部汇总卡片写有风险人数、占比与总人数（与湖上一致），明细默认只列有风险的人（沉默比从高到低），?tab=all 看全部，分页总数按筛选后的行数算
// 复购与 CLV 快照页（#835）：复购率（X / Y 人）与到第二单天数中位数、CLV 头部 10% 贡献占比与十档分布（与湖上一致，空值显示「—」），下方仍是按 consumer_id 的通用分页明细，没有明文
// 同期群与复购同样走通用表单（周期下拉框、起草、双人发布入队 gold.cohort / gold.repurchase 并登记快照，周期偏移列表用顿号连接）；
// 模板升级（测试开关 TEMPLATE_TEST_VERSIONS=1）：提示条、预览差异（RFM 分群迁移表、流失预警变化人数，没有 consumer_id）、分析师起草升级但发布 403；
// 指标与标签（DSL）快照详情（#816）：定义页「快照」区未过期的行点统计日进快照详情页，DSL 快照走通用明细（页头写类型、键、版本、统计日与来源，按行分页），
// 标签快照带各取值人数汇总，过期 / 其他租户 / 表名与类型对不上 404，未登录跳转登录页
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { dslDefinitions, dslVersions, snapshots, tasks, templateVersions } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { listSnapshots, readChurnSnapshot, readClvSnapshot, readRepurchaseSnapshot, readTemplateSnapshot } from '../../app/.server/snapshots';
import { drain, memberOf, newTenant, onLake, runTask } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
const fresh = async () => { await resetDb(); app.outbox.length = 0; };
afterEach(() => { vi.unstubAllEnvs(); });

/** 打通好的 acme 跑一次 RFM，返回租户与快照 */
async function rfmSnapshot() {
  const { acme } = await publishedIdentitySources({ orders: true });
  await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  const [snapshot] = await listSnapshots(acme);
  return { acme, snapshot };
}

/**
 * 只读用例共用的夹具：清库、跑一次 RFM，登录 acme 的查看者与另一租户 globex 的查看者。
 * 用它的用例不能写库、不能依赖执行顺序，也不能断言「恰好 N 条」（打开页面可能入队任务或写审计）
 */
async function sharedSnapshot() {
  await fresh();
  const { acme, snapshot } = await rfmSnapshot();
  await memberOf(acme, 'viewer@acme.com', 'viewer');
  await memberOf(await newTenant('globex'), 'viewer@globex.com', 'viewer');
  return { snapshot, browser: await loginAs(app, 'viewer@acme.com'), globexBrowser: await loginAs(app, 'viewer@globex.com') };
}

// 源表里的姓名、手机、邮箱、外部 ID，页面上一个都不能出现
const PLAINTEXT = ['张三', '钱七', '13800000002', '138 0000 0001', 'zhang@crm.test', 'qian7@example.com', 'wx_union_8'];

describe('分析页', () => {
  beforeEach(fresh);

  it('登记时有映射合并失败的快照标「数据不完整」，列出源表、实体、原因摘要与数据停在的时间；完整的快照不标', async () => {
    const { acme, snapshot } = await rfmSnapshot();
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    expect(await (await browser.get(`/analytics/snapshots/${snapshot.id}`)).text()).not.toContain('data-snapshot-incomplete');

    const lastSuccessAt = '2024-06-30T08:00:00.000Z';
    await getDb().update(snapshots).set({ incomplete: [
      { mapping: '00000000-0000-0000-0000-000000000001', entity: 'order', table: 'orders', error: '字段 status 有值字典里没有的取值', lastSuccessAt },
      { mapping: '00000000-0000-0000-0000-000000000002', entity: 'customer', table: 'members', error: '源表读取失败', lastSuccessAt: null },
    ] }).where(eq(snapshots.id, snapshot.id));
    const html = await (await browser.get(`/analytics/snapshots/${snapshot.id}`)).text();
    expect(html).toContain('data-snapshot-incomplete');
    expect(html).toContain('数据不完整');
    expect(html).toContain('源表 orders → order：字段 status 有值字典里没有的取值，数据停在 ');
    expect(html).toContain('源表 members → customer：源表读取失败，从未成功合并');
  });

  it('带数据不完整标记的快照在列表里显示「数据不完整」，不带标记的照旧可查看', async () => {
    const { acme, snapshot } = await rfmSnapshot();
    await runTask(acme, 'gold.rfm', { asOf: '2024-08-01' });
    const complete = (await listSnapshots(acme)).find(s => s.id !== snapshot.id)!;
    await getDb().update(snapshots).set({ incomplete: [
      { mapping: '00000000-0000-0000-0000-000000000001', entity: 'order', table: 'orders', error: '源表读取失败', lastSuccessAt: null },
    ] }).where(eq(snapshots.id, snapshot.id));
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    const html = await (await browser.get('/analytics')).text();
    expect(html).toMatch(new RegExp(`data-snapshot="${snapshot.id}"(?:(?!</tr>).)*data-snapshot-status="incomplete">数据不完整`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${complete.id}"(?:(?!</tr>).)*data-snapshot-status="available">可查看`, 's'));
    expect(html).toContain(`href="/analytics/snapshots/${snapshot.id}"`);
  });

  it('已过期的快照（即使带数据不完整标记）在列表中标为已过期、没有链接，直接打开返回 404', async () => {
    const { acme, snapshot } = await rfmSnapshot();
    // 同时带数据不完整标记：过期优先
    await getDb().update(snapshots).set({ expiredAt: new Date(), incomplete: [
      { mapping: '00000000-0000-0000-0000-000000000001', entity: 'order', table: 'orders', error: '源表读取失败', lastSuccessAt: null },
    ] }).where(eq(snapshots.id, snapshot.id));
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    const html = await (await browser.get('/analytics')).text();
    expect(html).toContain('data-snapshot-status="expired">已过期');
    expect(html).not.toContain(`href="/analytics/snapshots/${snapshot.id}"`);
    expect((await browser.get(`/analytics/snapshots/${snapshot.id}`)).status).toBe(404);
  });
});

describe('分析页', () => {
  // 只读用例共用一次 RFM 快照：不改快照、不跑任务、不写库，也不断言条数
  let shared: Awaited<ReturnType<typeof sharedSnapshot>>;
  beforeAll(async () => { shared = await sharedSnapshot(); });

  it('查看者在分析页看到本租户的快照，打开看各人群人数与金额、分页的消费者明细，页面上没有明文', async () => {
    const { snapshot, browser } = shared;

    const home = await (await browser.get('/')).text();
    expect(home).toContain('href="/analytics"');

    const list = await browser.get('/analytics');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain(`href="/analytics/snapshots/${snapshot.id}"`);
    expect(listHtml).toContain('RFM 分层');
    expect(listHtml).toContain('2024-07-01');

    const result = await browser.get(`/analytics/snapshots/${snapshot.id}`);
    expect(result.status).toBe(200);
    const html = await result.text();
    expect(html).toMatch(/data-segment="重要价值".*?data-segment-consumers="true">1</s);
    expect(html).toMatch(/data-segment="一般挽留".*?data-segment-consumers="true">3<.*?data-segment-monetary="true">¥1,380\.00</s);

    const consumers = await (await browser.get(`/analytics/snapshots/${snapshot.id}?tab=consumers`)).text();
    expect(consumers.match(/data-consumer="/g)).toHaveLength(5);
    for (const text of [listHtml, html, consumers]) for (const p of PLAINTEXT) expect(text).not.toContain(p);
  });

  it('其他租户的快照返回 404，也不出现在它的列表里', async () => {
    const { snapshot, globexBrowser: browser } = shared;
    expect(await (await browser.get('/analytics')).text()).not.toContain(snapshot.id);
    expect((await browser.get(`/analytics/snapshots/${snapshot.id}`)).status).toBe(404);
    expect((await browser.get('/analytics/snapshots/not-a-uuid')).status).toBe(404);
  });
});

/** 指标定义的 YAML：在空租户上就能通过校验（不依赖已发布的登记与映射） */
const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';

describe('分析页 · 指标与标签列表', () => {
  beforeEach(fresh);

  it('只有草稿的定义也出现在列表里：viewer 看到键与类型、「未发布」「有草稿」及最后保存人、「未计算」，链接到定义页，页面没有新建入口', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const html = await (await viewer.get('/analytics')).text();
    const row = /data-definition-row="metric:revenue"(?:(?!<\/tr>).)*/s;
    expect(html).toMatch(row);
    expect(html).toMatch(/href="\/analytics\/definitions\/metric\/revenue"[^>]*>revenue</);
    expect(html).toMatch(new RegExp('data-definition-row="metric:revenue"(?:(?!</tr>).)*>指标<', 's'));
    expect(html).toMatch(new RegExp('data-definition-row="metric:revenue"(?:(?!</tr>).)*>未发布<', 's'));
    expect(html).toMatch(new RegExp('data-definition-row="metric:revenue"(?:(?!</tr>).)*有草稿 · analyst@acme\\.com<', 's'));
    expect(html).toMatch(new RegExp('data-definition-row="metric:revenue"(?:(?!</tr>).)*>未计算<', 's'));
    expect(html).not.toContain('/analytics/definitions/new');
  });

  it('快照表区分系统内置模板与自建指标、标签：rfm 显示「分析模板」「系统内置」，metric:revenue 显示「指标」「自建」及创建人，找不到定义的 tag:buyer 显示「标签」「自建」；「最近计算」显示最新快照与最新任务的状态；可按定义筛选；定义页的「快照」区按时间列出', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(analyst, 'metric', 'revenue', REVENUE);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const [definition] = await getDb().select({ id: dslDefinitions.id }).from(dslDefinitions)
      .where(and(eq(dslDefinitions.tenantId, acme), eq(dslDefinitions.key, 'revenue')));
    const taskRows = await getDb().insert(tasks).values([
      { tenantId: acme, kind: 'gold.rfm', status: 'succeeded' },
      // 算出 2024-08-01 那张快照的任务：成功，但比下面失败的那次重算早
      { tenantId: acme, kind: 'gold.dsl', status: 'succeeded', params: { definitionId: definition!.id }, createdAt: new Date(Date.now() - 3_600_000) },
      { tenantId: acme, kind: 'gold.dsl', status: 'succeeded' },
      { tenantId: acme, kind: 'gold.dsl', status: 'succeeded' },
      // revenue 最新一次计算失败：「最近计算」的状态取这一条
      { tenantId: acme, kind: 'gold.dsl', status: 'failed', params: { definitionId: definition!.id } },
    ]).returning();
    const [rfm, revenue, , buyer] = await getDb().insert(snapshots).values([
      { tenantId: acme, template: 'rfm', taskId: taskRows[0]!.id, table: `gold.rfm__${taskRows[0]!.id}`, params: { asOf: '2024-07-01' }, rowCount: 5, expiresAt: new Date(Date.now() + 86_400_000) },
      { tenantId: acme, template: 'metric:revenue', taskId: taskRows[1]!.id, table: `gold.metric__${taskRows[1]!.id}`, params: { asOf: '2024-08-01' }, trigger: 'manual', rowCount: 3, expiresAt: new Date(Date.now() + 86_400_000) },
      // 同一定义更早的一张：定义页的「快照」区要排在 2024-08-01 后面，「最近计算」也不取它
      { tenantId: acme, template: 'metric:revenue', taskId: taskRows[2]!.id, table: `gold.metric__${taskRows[2]!.id}`, params: { asOf: '2024-07-15' }, rowCount: 2, createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() + 86_400_000) },
      // 没有对应定义的自建标签快照：类型「标签」，归属只写「自建」（找不到创建人）
      { tenantId: acme, template: 'tag:buyer', taskId: taskRows[3]!.id, table: `gold.tag__${taskRows[3]!.id}`, params: { asOf: '2024-08-01' }, rowCount: 4, expiresAt: new Date(Date.now() + 86_400_000) },
    ]).returning();
    const viewer = await loginAs(app, 'viewer@acme.com');

    const html = await (await viewer.get('/analytics')).text();
    expect(html).toMatch(new RegExp(`data-snapshot="${rfm!.id}"(?:(?!</tr>).)*>分析模板<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${rfm!.id}"(?:(?!</tr>).)*>系统内置<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${revenue!.id}"(?:(?!</tr>).)*>指标<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${revenue!.id}"(?:(?!</tr>).)*>自建 · analyst@acme\\.com<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${buyer!.id}"(?:(?!</tr>).)*>标签<`, 's'));
    expect(html).toMatch(new RegExp(`data-snapshot="${buyer!.id}"(?:(?!</tr>).)*>自建<`, 's'));

    // 「指标与标签」列表的「最近计算」：最新一张快照的统计日、来源、行数
    const defRow = new RegExp('data-definition-row="metric:revenue"(?:(?!</tr>).)*', 's').exec(html)?.[0] ?? '';
    expect(defRow).toContain('2024-08-01 · 手动 · 3 行');
    // 「最近计算」的状态取本定义最新一条 gold.dsl 任务（失败），不是更早成功的那条
    expect(defRow).toContain('失败');
    expect(defRow).not.toContain('成功');

    // 快照表按定义筛选：只剩 revenue 这一张
    const filtered = await (await viewer.get('/analytics?definition=metric:revenue')).text();
    expect(filtered).toContain(`data-snapshot="${revenue!.id}"`);
    expect(filtered).not.toContain(`data-snapshot="${rfm!.id}"`);

    // 定义页的「快照」区按时间倒序列出本定义的快照（版本、统计日、来源、行数）
    const page = await (await viewer.get('/analytics/definitions/metric/revenue')).text();
    expect(page).toMatch(new RegExp(`data-definition-snapshot="[^"]+"(?:(?!</tr>).)*>2024-08-01<`, 's'));
    expect(page).toMatch(new RegExp(`data-definition-snapshot="[^"]+"(?:(?!</tr>).)*>2024-07-15<`, 's'));
    expect(page.indexOf('2024-08-01')).toBeGreaterThan(-1);
    expect(page.indexOf('2024-08-01')).toBeLessThan(page.indexOf('2024-07-15'));
  });

  it('列表不显示其他租户的定义；类型与状态筛选走 URL；没有定义的租户显示空状态，有起草权限的成员看到「新建定义」入口', async () => {
    const acme = await newTenant('acme');
    await createDefinition(await memberOf(acme, 'analyst@acme.com', 'analyst'), 'metric', 'revenue', REVENUE);
    await createDefinition(await memberOf(await newTenant('globex'), 'analyst@globex.com', 'analyst'), 'metric', 'churn_score', REVENUE);
    const analyst = await loginAs(app, 'analyst@acme.com');

    const html = await (await analyst.get('/analytics')).text();
    expect(html).toContain('data-definition-row="metric:revenue"');
    expect(html).not.toContain('data-definition-row="metric:churn_score"');

    // 类型筛选走 URL：?type=tag 时没有标签定义，显示「没有符合条件的定义」而不是整个列表的空状态
    const typed = await (await analyst.get('/analytics?type=tag')).text();
    expect(typed).not.toContain('data-definition-row="metric:revenue"');
    expect(typed).toContain('没有符合条件的定义');
    expect(typed).toMatch(/data-tab="tag"[^>]*aria-current="page"/);

    // 状态筛选：只有草稿的定义不在「已发布」里，在「有草稿」「未发布」里
    expect(await (await analyst.get('/analytics?status=published')).text()).not.toContain('data-definition-row="metric:revenue"');
    for (const status of ['draft', 'unpublished']) {
      const filtered = await (await analyst.get(`/analytics?status=${status}`)).text();
      expect(filtered).toContain('data-definition-row="metric:revenue"');
    }
    // 发布之后出现在「已发布」里
    await getDb().update(dslVersions).set({ status: 'published' }).where(eq(dslVersions.status, 'draft'));
    expect(await (await analyst.get('/analytics?status=published')).text()).toContain('data-definition-row="metric:revenue"');

    // 空租户：有起草权限的成员看到空状态与「新建定义」入口
    const other = await newTenant('other');
    await memberOf(other, 'analyst@other.com', 'analyst');
    const empty = await (await (await loginAs(app, 'analyst@other.com')).get('/analytics')).text();
    expect(empty).toContain('data-definitions-empty');
    expect(empty).toContain('还没有任何指标或标签定义');
    expect(empty).toContain('href="/analytics/definitions/new"');
  });
});

/** 模板参数页表单：回看 400 天、固定阈值分箱、两条分群规则 */
const FORM = {
  intent: 'save',
  lookbackDays: '400',
  status: ['paid', 'completed'],
  binning: 'thresholds',
  recency: '30, 90, 180, 365',
  frequency: '2，3，5，8',
  monetary: '100 500 1000 5000',
  segment: ['高价值', '其他', ''],
  rMin: ['', '', ''], rMax: ['', '', ''], fMin: ['', '', ''], fMax: ['', '', ''], mMin: ['3', '', ''], mMax: ['', '', ''],
};

describe('RFM 模板参数页', () => {
  beforeEach(fresh);

  it('查看者看到生效的默认参数，没有保存按钮，提交草稿返回 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    expect(await (await browser.get('/analytics')).text()).toContain('href="/analytics/templates/rfm"');
    const res = await browser.get('/analytics/templates/rfm');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('当前生效：默认参数');
    expect(html).toMatch(/name="lookbackDays"[^>]*value="365"/);
    expect(html).toContain('value="重要价值"');
    expect(html).not.toContain('校验并保存草稿');
    expect((await browser.post('/analytics/templates/rfm', FORM)).status).toBe(403);
    expect((await browser.get('/analytics/templates/nope')).status).toBe(404);
  });

  it('分析师保存草稿，参数不合法时报错；分析师和最后保存的人都不能发布，另一位数据工程师发布后入队 gold.rfm', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    await memberOf(acme, 'de2@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');

    const bad = await analyst.post('/analytics/templates/rfm', { ...FORM, segment: ['高价值', '其他'], mMin: ['3', '1'] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('最后一条不能带条件');

    expect((await analyst.post('/analytics/templates/rfm', FORM)).status).toBe(302);
    const page = await (await analyst.get('/analytics/templates/rfm')).text();
    expect(page).toContain('第 1 版草稿');
    expect(page).toMatch(/name="lookbackDays"[^>]*value="400"/);
    expect(page).toContain('value="2, 3, 5, 8"');
    expect(page).toMatch(/data-publish-blocker[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect((await analyst.post('/analytics/templates/rfm', { intent: 'publish', version: '1' })).status).toBe(403);

    // 数据工程师改过之后成了最后保存的人，不能发布
    const de = await loginAs(app, 'de@acme.com');
    expect((await de.post('/analytics/templates/rfm', { ...FORM, lookbackDays: '500' })).status).toBe(302);
    expect(await (await de.get('/analytics/templates/rfm')).text()).toContain('你最后改了这一版草稿');
    expect((await de.post('/analytics/templates/rfm', { intent: 'publish', version: '1' })).status).toBe(403);

    const de2 = await loginAs(app, 'de2@acme.com');
    const published = await de2.post('/analytics/templates/rfm', { intent: 'publish', version: '1' });
    expect(published.status).toBe(302);
    expect(published.headers.get('location')).toBe('/analytics/templates/rfm?published=1');
    expect(await (await de2.get('/analytics/templates/rfm?published=1')).text()).toContain('第 1 版已发布');
    const [task] = await getDb().select().from(tasks).where(eq(tasks.tenantId, acme));
    expect(task).toMatchObject({ kind: 'gold.rfm', status: 'queued', params: { lookbackDays: 500, statuses: ['completed', 'paid'], definitionVersion: 1 } });
  });

  it('有发布权限的成员按生效版本重新计算，可填参考日期；分析师看到无权限的说明且提交 403，未来日期与重复入队被拒，版本不变', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const de = await loginAs(app, 'de@acme.com');
    expect(await (await de.get('/analytics/templates/rfm')).text()).not.toContain('重新计算');
    expect((await de.post('/analytics/templates/rfm', { intent: 'recompute' })).status).toBe(400);

    await analyst.post('/analytics/templates/rfm', FORM);
    await de.post('/analytics/templates/rfm', { intent: 'publish', version: '1' });
    // 调度器不运行，发布入队的任务一直在排队
    const queued = await de.post('/analytics/templates/rfm', { intent: 'recompute', asOf: '' });
    expect(queued.status).toBe(400);
    expect(await queued.text()).toContain('已在排队或运行中');
    await getDb().update(tasks).set({ status: 'succeeded' }).where(eq(tasks.tenantId, acme));

    expect(await (await analyst.get('/analytics/templates/rfm')).text()).toMatch(/data-recompute-denied[^>]*>.*?仅管理员、数据工程师可以发布映射与定义/s);
    expect((await analyst.post('/analytics/templates/rfm', { intent: 'recompute' })).status).toBe(403);
    const future = await de.post('/analytics/templates/rfm', { intent: 'recompute', asOf: '2999-01-01' });
    expect(future.status).toBe(400);
    expect(await future.text()).toContain('晚于今天');

    const page = await (await de.get('/analytics/templates/rfm')).text();
    expect(page).toContain('name="asOf"');
    expect(page).toContain(`max="${new Date().toISOString().slice(0, 10)}"`);
    const recomputed = await de.post('/analytics/templates/rfm', { intent: 'recompute', asOf: '2026-09-30' });
    expect(recomputed.status).toBe(302);
    expect(recomputed.headers.get('location')).toBe('/analytics/templates/rfm?recomputed=1');
    expect(await (await de.get('/analytics/templates/rfm?recomputed=1')).text()).toContain('已按第 1 版参数入队一次计算');
    const rows = await getDb().select().from(tasks).where(eq(tasks.tenantId, acme)).orderBy(tasks.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'gold.rfm', status: 'queued', params: { lookbackDays: 400, asOf: '2026-09-30', definitionVersion: 1 } });
    expect(await getDb().select().from(templateVersions)).toHaveLength(1);
  });

  it('管理员能发布别人保存的草稿；丢弃草稿后回到已发布的参数', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    await analyst.post('/analytics/templates/rfm', FORM);
    expect((await admin.post('/analytics/templates/rfm', { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await admin.get('/analytics/templates/rfm')).text()).toContain('当前生效：第 1 版');

    await analyst.post('/analytics/templates/rfm', { ...FORM, lookbackDays: '30' });
    expect((await analyst.post('/analytics/templates/rfm', { intent: 'discard' })).status).toBe(302);
    const html = await (await analyst.get('/analytics/templates/rfm')).text();
    expect(html).not.toContain('草稿</span>');
    expect(html).toMatch(/name="lookbackDays"[^>]*value="400"/);
  });
});

describe('用户 360 模板参数页与快照（通用表单与通用明细）', () => {
  beforeEach(fresh);

  it('分析页列出每个已登记模板的参数入口；通用表单按 form 渲染，查看者只读、提交 403，未登记的模板 404', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    const list = await (await browser.get('/analytics')).text();
    expect(list).toContain('href="/analytics/templates/rfm"');
    expect(list).toContain('href="/analytics/templates/user360"');
    expect(list).toContain('用户 360 模板参数');

    const res = await browser.get('/analytics/templates/user360');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('用户 360 · 模板参数');
    expect(html).toContain('当前生效：默认参数');
    expect(html).toMatch(/name="lookbackDays"[^>]*value="365"/);
    expect(html).toMatch(/name="statuses" checked="" value="paid"/);
    expect(html).toMatch(/name="statuses"[^>]*value="cancelled"/);
    expect(html).not.toContain('分箱方式');
    expect(html).not.toContain('校验并保存草稿');
    expect((await browser.post('/analytics/templates/user360', { intent: 'save', lookbackDays: '30', statuses: ['paid'] })).status).toBe(403);
    expect((await browser.get('/analytics/templates/rfm2')).status).toBe(404);
    expect((await browser.get('/analytics/templates/__proto__')).status).toBe(404);
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post('/analytics/templates/rfm2', { intent: 'save', lookbackDays: '30', statuses: ['paid'] })).status).toBe(404);
  });

  it('分析师改回看天数与状态保存草稿，参数不合法时报错；分析师发布 403，另一位数据工程师发布后以新参数入队 gold.user360', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');

    const bad = await analyst.post('/analytics/templates/user360', { intent: 'save', lookbackDays: '0', statuses: ['paid'] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('lookbackDays 必须是 1 到 3650 之间的整数');
    const none = await analyst.post('/analytics/templates/user360', { intent: 'save', lookbackDays: '30' });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain('statuses 必须是非空的订单状态列表');

    // 表单里多出来的字段不交给 saveDraft
    expect((await analyst.post('/analytics/templates/user360', { intent: 'save', lookbackDays: '30', statuses: ['shipped', 'paid'], binning: 'quintile' })).status).toBe(302);
    const page = await (await analyst.get('/analytics/templates/user360')).text();
    expect(page).toContain('第 1 版草稿');
    expect(page).toMatch(/name="lookbackDays"[^>]*value="30"/);
    expect(page).toMatch(/name="statuses" checked="" value="shipped"/);
    expect(page).toMatch(/name="statuses" value="completed"/);
    expect((await analyst.post('/analytics/templates/user360', { intent: 'publish', version: '1' })).status).toBe(403);

    const de = await loginAs(app, 'de@acme.com');
    const published = await de.post('/analytics/templates/user360', { intent: 'publish', version: '1' });
    expect(published.status).toBe(302);
    expect(published.headers.get('location')).toBe('/analytics/templates/user360?published=1');
    const [task] = await getDb().select().from(tasks).where(eq(tasks.tenantId, acme));
    expect(task).toMatchObject({ kind: 'gold.user360', status: 'queued', params: { lookbackDays: 30, statuses: ['paid', 'shipped'], definitionVersion: 1 } });
    // RFM 的定义不受影响
    expect(await (await de.get('/analytics/templates/rfm')).text()).toContain('当前生效：默认参数');
  });

  it('user360 快照在快照页打开，分页显示全部列的明细（同意列为是 / 否），模板名取自注册表，页面上没有明文', async () => {
    const { acme } = await publishedIdentitySources({ orders: true, consents: true });
    await runTask(acme, 'gold.user360', { asOf: '2024-07-01' });
    const [snapshot] = await listSnapshots(acme);
    expect(snapshot!.template).toBe('user360');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

    const listHtml = await (await browser.get('/analytics')).text();
    expect(listHtml).toContain(`href="/analytics/snapshots/${snapshot!.id}"`);
    expect(listHtml).toContain('用户 360');

    const res = await browser.get(`/analytics/snapshots/${snapshot!.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('用户 360 · 2024-07-01');
    expect(html).toContain('回看 365 天');
    for (const column of ['consumer_id', 'orders', 'monetary', 'recency_days', 'consent_email']) expect(html).toMatch(new RegExp(`<th[^>]*>${column}</th>`));
    expect(html.match(/data-consumer="/g)).toHaveLength(8);
    expect(html).toMatch(/>是</);
    expect(html).toMatch(/>否</);
    expect(html).toContain('第 1 / 1 页');
    // 页码超出时停在最后一页
    expect(await (await browser.get(`/analytics/snapshots/${snapshot!.id}?page=9`)).text()).toContain('第 1 / 1 页');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);

    // 按 consumer_id 分页：每页 3 位时第 3 页只剩 2 位，三页合起来不重不漏
    const pages = await Promise.all([1, 2, 3].map(page => readTemplateSnapshot(snapshot!, { page, pageSize: 3 })));
    expect(pages.map(p => p.rows.length)).toEqual([3, 3, 2]);
    const ids = pages.flatMap(p => p.rows.map(r => String(r.consumer_id)));
    expect(ids).toEqual([...new Set(ids)].sort());
    expect(pages[0]!.columns[0]).toBe('consumer_id');
  });
});

describe('流失预警快照页（#834）', () => {
  beforeEach(fresh);

  /** 在湖上按同一口径算出这张快照的汇总（总数、有风险数）与两个口径下按沉默比排序的 consumer_id（表名来自快照登记） */
  const lakeExpected = async (tenantId: string, snapshot: { table: string }) => {
    const [schema, name] = snapshot.table.split('.');
    const table = `${schema}."${name}"`;
    const [totals] = await onLake<{ total: string; at_risk: string }>(tenantId,
      `SELECT count(*) AS total, count(*) FILTER (WHERE at_risk) AS at_risk FROM ${table}`);
    const ids = (where: string) => onLake<{ consumer_id: string }>(tenantId,
      `SELECT consumer_id FROM ${table} ${where} ORDER BY silence_ratio DESC NULLS LAST, consumer_id`).then(rs => rs.map(r => r.consumer_id));
    return { total: Number(totals!.total), atRisk: Number(totals!.at_risk), atRiskIds: await ids('WHERE at_risk'), allIds: await ids('') };
  };
  const consumerIds = (html: string) => [...html.matchAll(/data-consumer="([^"]+)"/g)].map(m => m[1]!);

  it('顶部汇总卡片写有风险人数、占比与总人数（与湖上一致），明细默认只列有风险的人、沉默比从高到低，?tab=all 看全部；页面上没有明文', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    // 默认参数 2024-10-15：共 1 位且在风险里；minOrders 2 的 2024-09-15：共 3 位、其中 2 位有风险（沉默比各不相同）
    await runTask(acme, 'gold.churn', { asOf: '2024-10-15' });
    await runTask(acme, 'gold.churn', { asOf: '2024-09-15', minOrders: 2 });
    const mixed = (await listSnapshots(acme, 'churn')).find(s => (s.params as { asOf: string }).asOf === '2024-09-15')!;
    const single = (await listSnapshots(acme, 'churn')).find(s => (s.params as { asOf: string }).asOf === '2024-10-15')!;
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

    const expected = await lakeExpected(acme, mixed);
    expect(expected).toMatchObject({ total: 3, atRisk: 2 });

    const html = await (await browser.get(`/analytics/snapshots/${mixed.id}`)).text();
    expect(html).toContain('流失预警 · 2024-09-15');
    expect(html).toMatch(/有风险人数.*?>2</s);
    expect(html).toMatch(/风险占比.*?>66\.7%</s);
    expect(html).toMatch(/总人数.*?>3</s);
    // 默认只列有风险的人，行序与湖上按沉默比降序的一致；标签页可以切到全部
    expect(consumerIds(html)).toEqual(expected.atRiskIds);
    expect(html).toContain('第 1 / 1 页');
    expect(html).toMatch(/data-tab="all"[^>]*href="[^"]*\?tab=all"/);

    const all = await (await browser.get(`/analytics/snapshots/${mixed.id}?tab=all`)).text();
    expect(consumerIds(all)).toEqual(expected.allIds);
    expect(all).toContain('data-tab="at-risk"');
    // 页码超出时停在最后一页
    expect(await (await browser.get(`/analytics/snapshots/${mixed.id}?tab=all&page=9`)).text()).toContain('第 1 / 1 页');
    for (const text of [html, all]) for (const p of PLAINTEXT) expect(text).not.toContain(p);

    // 只有一位且在风险里：卡片与明细同样成立
    const one = await lakeExpected(acme, single);
    expect(one).toMatchObject({ total: 1, atRisk: 1 });
    const singleHtml = await (await browser.get(`/analytics/snapshots/${single.id}`)).text();
    expect(singleHtml).toMatch(/有风险人数.*?>1</s);
    expect(singleHtml).toMatch(/风险占比.*?>100\.0%</s);
    expect(consumerIds(singleHtml)).toEqual(one.atRiskIds);
  });

  it('readChurnSnapshot 分页总数按筛选后的行数算：每页 2 位时「全部」2 页、「有风险」1 页，页码超出停在最后一页，两页合起来不重不漏', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.churn', { asOf: '2024-09-15', minOrders: 2 });
    const snapshot = (await listSnapshots(acme, 'churn'))[0]!;
    const expected = await lakeExpected(acme, snapshot);

    const atRisk = await readChurnSnapshot(snapshot, { page: 9, filter: 'at-risk', pageSize: 2 });
    expect(atRisk).toMatchObject({ page: 1, pages: 1, total: 3, atRisk: 2, filteredCount: 2 });
    expect(atRisk.rows.map(r => r.consumer_id)).toEqual(expected.atRiskIds);
    expect(atRisk.rows.every(r => r.at_risk)).toBe(true);
    // 沉默比从高到低（同值按 consumer_id）
    const ratios = atRisk.rows.map(r => r.silence_ratio);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);

    const first = await readChurnSnapshot(snapshot, { page: 1, filter: 'all', pageSize: 2 });
    const last = await readChurnSnapshot(snapshot, { page: 9, filter: 'all', pageSize: 2 });
    expect(first).toMatchObject({ page: 1, pages: 2, filteredCount: 3 });
    expect(last.page).toBe(2);
    expect([...first.rows, ...last.rows].map(r => r.consumer_id)).toEqual(expected.allIds);
    expect([...first.rows, ...last.rows].filter(r => r.at_risk)).toHaveLength(2);
  });
});

describe('复购与 CLV 快照页（#835）', () => {
  beforeEach(fresh);

  /** 在湖上按同一口径算出这张复购快照的汇总：总人数、复购人数与到第二单天数的中位数（median 自动跳过 NULL） */
  const repurchaseExpected = async (tenantId: string, snapshot: { table: string }) => {
    const [schema, name] = snapshot.table.split('.');
    const table = `${schema}."${name}"`;
    const [totals] = await onLake<{ total: string; repurchased: string; median_days_to_second: number | null }>(tenantId,
      `SELECT count(*) AS total, count(*) FILTER (WHERE repurchased) AS repurchased, median(days_to_second) AS median_days_to_second FROM ${table}`);
    return { total: Number(totals!.total), repurchased: Number(totals!.repurchased), medianDaysToSecond: totals!.median_days_to_second };
  };

  /** 在湖上按同一口径算出这张 CLV 快照的十档分布（ntile 同值按 consumer_id 排序，分档才稳定）与头部 10% 的贡献占比 */
  const clvExpected = async (tenantId: string, snapshot: { table: string }) => {
    const [schema, name] = snapshot.table.split('.');
    const table = `${schema}."${name}"`;
    const deciles = await onLake<{ decile: number; consumers: string; clv: string | null }>(tenantId, `
      SELECT decile, count(*) AS consumers, sum(clv)::VARCHAR AS clv FROM (
        SELECT ntile(10) OVER (ORDER BY clv DESC, consumer_id) AS decile, clv FROM ${table}
      ) GROUP BY decile ORDER BY decile`);
    const [total] = await onLake<{ total_clv: string | null }>(tenantId, `SELECT coalesce(sum(clv), 0)::VARCHAR AS total_clv FROM ${table}`);
    const top = deciles.find(d => Number(d.decile) === 1);
    return {
      deciles: deciles.map(d => ({ decile: Number(d.decile), consumers: Number(d.consumers), clv: Number(d.clv ?? 0) })),
      totalClv: Number(total!.total_clv ?? 0),
      topShare: Number(total!.total_clv ?? 0) > 0 && top ? Number(top.clv ?? 0) / Number(total!.total_clv) : null,
    };
  };

  /** 湖上这张快照全部 consumer_id，按 consumer_id 升序（与明细的分页顺序一致） */
  const lakeIds = async (tenantId: string, snapshot: { table: string }) => {
    const [schema, name] = snapshot.table.split('.');
    return (await onLake<{ consumer_id: string }>(tenantId, `SELECT consumer_id FROM ${schema}."${name}" ORDER BY consumer_id`)).map(r => r.consumer_id);
  };
  const consumerIds = (html: string) => [...html.matchAll(/data-consumer="([^"]+)"/g)].map(m => m[1]!);
  /** 页面上金额的写法（与路由里的 money 一致） */
  const money = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  it('复购页顶部卡片写复购率（X / Y 人）与到第二单天数中位数（与湖上一致），下方有按 consumer_id 升序的分页明细；页面上没有明文', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01' });
    const snapshot = (await listSnapshots(acme, 'repurchase'))[0]!;
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

    const expected = await repurchaseExpected(acme, snapshot);
    // 默认 windowDays 90：crm 4 与 crm 5 在窗口内复购（相隔 29 与 80 天），中位数 (29+80)/2
    expect(expected).toMatchObject({ total: 5, repurchased: 2, medianDaysToSecond: 54.5 });

    const html = await (await browser.get(`/analytics/snapshots/${snapshot.id}`)).text();
    expect(html).toContain('复购 · 2024-07-01');
    expect(html).toContain(`data-repurchase-rate="${((expected.repurchased / expected.total) * 100).toFixed(1)}%"`);
    expect(html).toContain(`data-repurchase-count="${expected.repurchased}"`);
    expect(html).toContain(`data-total-count="${expected.total}"`);
    expect(html).toContain(`data-median-days="${expected.medianDaysToSecond} 天"`);
    expect(html).toContain(`${expected.repurchased} / ${expected.total} 人`);
    // 明细按 consumer_id 升序分页（通用明细，不筛选）：5 人一页全列出，与湖上按 consumer_id 排序的全部 id 一致
    expect(consumerIds(html)).toHaveLength(expected.total);
    expect(consumerIds(html)).toEqual(await lakeIds(acme, snapshot));
    expect(html).toContain('第 1 / 1 页');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);
  });

  it('CLV 页顶部卡片写前 10% 的人贡献的 clv 占比、CLV 合计，十档表的人数与合计和湖上 ntile(10) 分组一致；下方有分页明细；页面上没有明文', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.clv', { asOf: '2024-07-01' });
    const snapshot = (await listSnapshots(acme, 'clv'))[0]!;
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

    const expected = await clvExpected(acme, snapshot);
    // 这份数据只有 5 位消费者：只列出有人的 5 档，每档 1 人，第 1 档就是 clv 最高的那位
    expect(expected.deciles.map(d => d.consumers)).toEqual([1, 1, 1, 1, 1]);

    const html = await (await browser.get(`/analytics/snapshots/${snapshot.id}`)).text();
    expect(html).toContain('CLV · 2024-07-01');
    expect(html).toContain(`data-clv-top-share="${(expected.topShare! * 100).toFixed(1)}%"`);
    expect(html).toContain(money(expected.totalClv));
    // 十档表只列有人的档，每行的人数与 clv 合计与湖上分组一致
    const decileRows = [...html.matchAll(/data-clv-decile="(\d+)"([\s\S]*?)(?=data-clv-decile=|<\/tbody>)/g)];
    expect(decileRows.map(m => Number(m[1]))).toEqual(expected.deciles.map(d => d.decile));
    for (const [i, row] of decileRows.entries()) {
      expect(row[2]).toContain(`data-clv-decile-consumers="${expected.deciles[i]!.consumers}"`);
      expect(row[2]).toContain(money(expected.deciles[i]!.clv));
    }
    expect(html).toContain('第 1 / 1 页');
    expect(snapshot.rowCount).toBe(5);
    expect(consumerIds(html)).toHaveLength(snapshot.rowCount);
    expect(consumerIds(html)).toEqual(await lakeIds(acme, snapshot));
    for (const p of PLAINTEXT) expect(html).not.toContain(p);
  });

  it('readRepurchaseSnapshot / readClvSnapshot 翻页：每页 2 位时 3 页拼起来与湖上按 consumer_id 排序的全部 id 一致、不重不漏，汇总不随页码变化', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01' });
    await runTask(acme, 'gold.clv', { asOf: '2024-07-01' });
    const repurchase = (await listSnapshots(acme, 'repurchase'))[0]!;
    const clv = (await listSnapshots(acme, 'clv'))[0]!;

    const repurchaseIds = await lakeIds(acme, repurchase);
    expect(repurchaseIds).toHaveLength(5);
    const repurchasePages = await Promise.all([1, 2, 3].map(page => readRepurchaseSnapshot(repurchase, { page, pageSize: 2 })));
    expect(repurchasePages.map(p => p.rows.length)).toEqual([2, 2, 1]);
    expect(repurchasePages.flatMap(p => p.rows.map(r => r.consumer_id))).toEqual(repurchaseIds);
    const repurchaseSummary = await repurchaseExpected(acme, repurchase);
    for (const p of repurchasePages) {
      expect({ total: p.total, repurchased: p.repurchased, medianDaysToSecond: p.medianDaysToSecond }).toEqual(repurchaseSummary);
    }

    const clvIds = await lakeIds(acme, clv);
    expect(clvIds).toHaveLength(5);
    const clvPages = await Promise.all([1, 2, 3].map(page => readClvSnapshot(clv, { page, pageSize: 2 })));
    expect(clvPages.map(p => p.rows.length)).toEqual([2, 2, 1]);
    expect(clvPages.flatMap(p => p.rows.map(r => r.consumer_id))).toEqual(clvIds);
    const clvSummary = await clvExpected(acme, clv);
    for (const p of clvPages) {
      expect(p.deciles.map(d => ({ ...d, clv: Number(d.clv) }))).toEqual(clvSummary.deciles);
      expect(p.topShare).toBe(clvSummary.topShare);
      expect(Number(p.totalClv)).toBe(clvSummary.totalClv);
    }
  });

  it('没人复购时天数中位数显示「—」（复购率为 0.0%）、总 clv 为 0 时头部占比显示「—」，不除零；明细照常', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01' });
    await runTask(acme, 'gold.clv', { asOf: '2024-07-01' });
    const repurchase = (await listSnapshots(acme, 'repurchase'))[0]!;
    const clv = (await listSnapshots(acme, 'clv'))[0]!;
    // 在湖上直接改快照表：没有人有第二单、clv 全为 0
    const tableOf = (s: { table: string }) => { const [schema, name] = s.table.split('.'); return `${schema}."${name}"`; };
    await onLake(acme, `UPDATE ${tableOf(repurchase)} SET days_to_second = NULL, repurchased = false`);
    await onLake(acme, `UPDATE ${tableOf(clv)} SET clv = 0`);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

    const repurchaseHtml = await (await browser.get(`/analytics/snapshots/${repurchase.id}`)).text();
    expect(repurchaseHtml).toContain('data-repurchase-rate="0.0%"');
    expect(repurchaseHtml).toContain('data-median-days="—"');
    expect(repurchaseHtml).toContain('data-repurchase-count="0"');
    expect(repurchaseHtml).toContain('第 1 / 1 页');

    const clvHtml = await (await browser.get(`/analytics/snapshots/${clv.id}`)).text();
    expect(clvHtml).toContain('data-clv-top-share="—"');
    expect(clvHtml).toContain('第 1 / 1 页');
  });
});

describe('同期群与复购模板参数页（通用表单）', () => {
  beforeEach(fresh);

  /**
   * 打通好的 acme（映射合并后平台已按默认参数发布第 1 版），分析师起草第 2 版、另一位数据工程师发布，跑完发布入队的任务后按参考日期 2024-07-01 重新计算，
   * 返回租户、发布入队的任务、这个模板第 2 版的快照与重新计算后的快照
   */
  async function publishAndRecompute(id: 'cohort' | 'repurchase', form: Record<string, string | string[]>) {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');
    expect((await analyst.post(`/analytics/templates/${id}`, { intent: 'save', ...form })).status).toBe(302);
    expect((await analyst.post(`/analytics/templates/${id}`, { intent: 'publish', version: '2' })).status).toBe(403);
    const de = await loginAs(app, 'de@acme.com');
    expect((await de.post(`/analytics/templates/${id}`, { intent: 'publish', version: '2' })).status).toBe(302);
    const published = (await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, `gold.${id}`))))
      .find(t => t.params.definitionVersion === 2);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect((await de.post(`/analytics/templates/${id}`, { intent: 'recompute', asOf: '2024-07-01' })).status).toBe(302);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const registered = (await listSnapshots(acme)).filter(s => s.template === id && s.definitionVersion === 2);
    return { acme, de, published: published!, registered, recomputed: registered.find(s => s.taskId !== published!.id)! };
  }

  it('同期群：通用表单有周期下拉框，参数不合法时报错；按周起草、双人发布后以新参数入队 gold.cohort 并登记快照，快照页偏移列表用顿号连接', async () => {
    const other = await newTenant('other');
    await memberOf(other, 'analyst@other.com', 'analyst');
    const browser = await loginAs(app, 'analyst@other.com');
    const html = await (await browser.get('/analytics/templates/cohort')).text();
    expect(html).toContain('同期群 · 模板参数');
    expect(html).toMatch(/value="month" selected="">按月</);
    expect(html).toMatch(/name="periods"[^>]*value="12"/);
    const bad = await browser.post('/analytics/templates/cohort', { intent: 'save', granularity: 'day', periods: '12', statuses: ['paid'] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('granularity 必须是 month 或 week');

    const { de, published, registered, recomputed } = await publishAndRecompute('cohort', { granularity: 'week', periods: '30', statuses: ['paid', 'shipped', 'completed'] });
    expect(published).toMatchObject({ kind: 'gold.cohort', params: { granularity: 'week', periods: 30, definitionVersion: 2 } });
    expect(registered.map(s => s.template)).toEqual(['cohort', 'cohort']);
    expect(await (await de.get('/analytics/templates/cohort')).text()).toMatch(/value="week" selected="">按周</);

    const page = await (await de.get(`/analytics/snapshots/${recomputed.id}`)).text();
    expect(page).toContain('同期群 · 2024-07-01');
    for (const column of ['consumer_id', 'cohort_start', 'orders', 'active_periods']) expect(page).toMatch(new RegExp(`<th[^>]*>${column}</th>`));
    expect(page.match(/data-consumer="/g)).toHaveLength(5);
    // crm 5、crm 6 + 会员 5：4-01（4-01 那周）、6-20 与 6-25（6-17 与 6-24 那周）
    expect(page).toContain('0、11、12');
  });

  it('复购：windowDays 改成 60 起草、双人发布后入队 gold.repurchase 并登记快照，crm 5 那组 80 天才复购，不再算复购', async () => {
    const { de, published, recomputed } = await publishAndRecompute('repurchase', { lookbackDays: '365', windowDays: '60', statuses: ['paid', 'shipped', 'completed'] });
    expect(published).toMatchObject({ kind: 'gold.repurchase', params: { lookbackDays: 365, windowDays: 60, definitionVersion: 2 } });
    expect(recomputed.template).toBe('repurchase');
    const rows = (await readTemplateSnapshot(recomputed, { page: 1, pageSize: 50 })).rows;
    expect(rows.map(r => [r.days_to_second, r.repurchased]).sort()).toEqual([[29, true], [80, false], [null, false], [null, false], [null, false]].sort());
    const page = await (await de.get(`/analytics/snapshots/${recomputed.id}`)).text();
    expect(page).toContain('复购 · 2024-07-01');
    expect(page).toContain('回看 365 天');
  });
});

describe('模板升级', () => {
  beforeEach(fresh);

  it('有新模板版本时显示提示条，分析师可以预览差异（只有人数）、起草升级但不能发布，另一位数据工程师发布后按新版本入队；没有新版本时没有提示条', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const analyst = await loginAs(app, 'analyst@acme.com');

    // 开关关闭：没有新版本
    expect(await (await analyst.get('/analytics/templates/rfm')).text()).not.toContain('有新的模板版本');
    for (const intent of ['preview-upgrade', 'upgrade']) {
      const res = await analyst.post('/analytics/templates/rfm', { intent });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('已是最新模板版本');
    }

    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    const page = await (await analyst.get('/analytics/templates/rfm')).text();
    expect(page).toContain('有新的模板版本 v2（当前 v1）');
    expect(page).toContain('预览升级差异');
    expect(page).toContain('升级到新版本');

    const preview = await analyst.post('/analytics/templates/rfm', { intent: 'preview-upgrade', asOf: '2024-12-31' });
    expect(preview.status).toBe(200);
    const diff = await preview.text();
    expect(diff).toContain('data-upgrade-diff');
    expect(diff).toContain('v1 → v2，统计日 2024-12-31');
    expect(diff.match(/data-upgrade-segment/g)!.length).toBeGreaterThan(0);
    expect(diff).toMatch(/<td[^>]*>v2:[^<]+<\/td>/);
    expect(diff).not.toMatch(/[0-9a-f]{64}/);

    // 流失预警：变化、新增、移出人数
    const churn = await (await analyst.post('/analytics/templates/churn', { intent: 'preview-upgrade', asOf: '2024-10-15' })).text();
    expect(churn).toMatch(/data-upgrade-metric[^>]*>取值变化 [1-9]\d* 人，新增 0 人，移出 0 人/);
    expect(churn).not.toMatch(/[0-9a-f]{64}/);

    const upgraded = await analyst.post('/analytics/templates/rfm', { intent: 'upgrade' });
    expect(upgraded.status).toBe(302);
    expect(upgraded.headers.get('location')).toBe('/analytics/templates/rfm?upgraded=2');
    const drafted = await (await analyst.get('/analytics/templates/rfm?upgraded=2')).text();
    expect(drafted).toContain('已起草第 2 版，锁定模板 v2');
    expect(drafted).toContain('第 2 版草稿已锁定模板 v2');
    expect(drafted).not.toContain('升级到新版本');
    expect((await analyst.post('/analytics/templates/rfm', { intent: 'publish', version: '2' })).status).toBe(403);

    const de = await loginAs(app, 'de@acme.com');
    expect((await de.post('/analytics/templates/rfm', { intent: 'publish', version: '2' })).status).toBe(302);
    const [task] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'gold.rfm'), eq(tasks.status, 'queued')));
    expect(task!.params).toMatchObject({ definitionVersion: 2, templateVersion: 2 });
    expect(await (await de.get('/analytics/templates/rfm')).text()).not.toContain('有新的模板版本');
  });
});

/** 不带维度的指标（标签只能引用没有维度的指标） */
const REVENUE_TOTAL = 'base: order\nmeasure: { agg: sum, field: amount }\n';

/**
 * 只读用例共用的夹具：清库、打通订单后双人发布一个不带维度与一个带城市维度的指标、一个引用前者的标签（各 drain 一次跑完计算），
 * 登录 acme 的查看者与另一租户 globex 的查看者；返回带维度那张指标快照与标签快照。
 * 用它的用例除了插元数据行的那个都不能改共享的快照、不能依赖执行顺序
 */
async function publishedMetricAndTagSnapshots() {
  await fresh();
  const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
  await createDefinition(author, 'metric', 'revenue', REVENUE_TOTAL);
  // REVENUE 自带城市维度：快照表每个消费者可能多行（consumer_id、city、value）
  await createDefinition(author, 'metric', 'revenue_by_city', REVENUE);
  await publishDefinition(reviewer, 'metric', 'revenue', 1);
  await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
  await drain();
  await createDefinition(author, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
  await publishDefinition(reviewer, 'tag', 'value_tier', 1);
  await drain();
  const of = async (template: string) => (await listSnapshots(acme)).find(s => s.template === template)!;
  await memberOf(acme, 'viewer@acme.com', 'viewer');
  await memberOf(await newTenant('globex'), 'viewer@globex.com', 'viewer');
  return { acme, metric: await of('metric:revenue_by_city'), tag: await of('tag:value_tier'), browser: await loginAs(app, 'viewer@acme.com'), globexBrowser: await loginAs(app, 'viewer@globex.com') };
}

describe('指标与标签快照详情', () => {
  // 只读用例共用一次夹具：发布一个带维度的指标与一个标签并跑完，不逐用例重造（#816）
  let shared: Awaited<ReturnType<typeof publishedMetricAndTagSnapshots>>;
  beforeAll(async () => { shared = await publishedMetricAndTagSnapshots(); });

  it('查看者从定义页「快照」区的统计日打开指标快照：页头有类型、键、版本、统计日与来源，明细按行分页列出全部列，页面没有明文也没有取值汇总', async () => {
    const { metric, browser } = shared;
    const asOf = String(metric.params.asOf);

    // 定义页「快照」区：未过期的行统计日链接到快照详情页
    const definitions = await (await browser.get('/analytics/definitions/metric/revenue_by_city')).text();
    expect(definitions).toMatch(new RegExp(`data-definition-snapshot="${metric.id}"(?:(?!</tr>).)*href="/analytics/snapshots/${metric.id}"`, 's'));

    const res = await browser.get(`/analytics/snapshots/${metric.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('指标 · revenue_by_city');
    expect(html).toContain('第 1 版');
    expect(html).toContain(`统计日 ${asOf}`);
    expect(html).toContain('来源 发布');
    // 带维度的指标每个消费者有多行：统计卡片按行数说
    expect(html).toContain('行数');
    for (const column of ['consumer_id', 'city', 'value']) expect(html).toMatch(new RegExp(`<th[^>]*>${column}</th>`));
    expect(html.match(/data-consumer="/g)!.length).toBeGreaterThan(0);
    expect(html).not.toContain('data-tag-summary');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);
  });

  it('标签快照在明细上方带各取值人数的汇总，人数与直接在湖上 GROUP BY tag_value 的一致；明细只有 consumer_id、tag_key、tag_value', async () => {
    const { acme, tag, browser } = shared;
    const res = await browser.get(`/analytics/snapshots/${tag.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('标签 · value_tier');
    for (const column of ['consumer_id', 'tag_key', 'tag_value']) expect(html).toMatch(new RegExp(`<th[^>]*>${column}</th>`));

    const expected = await onLake<{ value: string | null; consumers: number }>(acme,
      `SELECT tag_value::VARCHAR AS value, count(*) AS consumers FROM gold."tag__${tag.taskId}" GROUP BY 1 ORDER BY 2 DESC, 1`);
    expect(expected.length).toBeGreaterThan(0);
    expect(html.match(/data-tag-value="/g)).toHaveLength(expected.length);
    for (const { value, consumers } of expected) {
      expect(html).toMatch(new RegExp(`data-tag-value="${value ?? ''}"(?:(?!</tr>).)*>${consumers.toLocaleString('zh-CN')}<`, 's'));
    }
  });

  it('已过期的快照在定义页「快照」区没有链接、直接打开 404；其他租户的、表名与类型对不上的快照 404；未登录的请求跳转登录页', async () => {
    const { acme, metric, browser, globexBrowser } = shared;
    // 插一行已过期的 metric:revenue_by_city（不会影响前面用例的断言）与一行表名对不上的（metric 快照记了 tag 的表）
    const taskRows = await getDb().insert(tasks).values([
      { tenantId: acme, kind: 'gold.dsl', status: 'succeeded' },
      { tenantId: acme, kind: 'gold.dsl', status: 'succeeded' },
    ]).returning();
    const [expired, mismatched] = await getDb().insert(snapshots).values([
      { tenantId: acme, template: 'metric:revenue_by_city', taskId: taskRows[0]!.id, table: `gold.metric__${taskRows[0]!.id}`, params: { asOf: '2024-06-01' }, rowCount: 3, createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() - 3_600_000), expiredAt: new Date() },
      { tenantId: acme, template: 'metric:x', taskId: taskRows[1]!.id, table: `gold.tag__${randomUUID()}`, params: { asOf: '2024-06-01' }, rowCount: 3, expiresAt: new Date(Date.now() + 86_400_000) },
    ]).returning();

    const definitions = await (await browser.get('/analytics/definitions/metric/revenue_by_city')).text();
    expect(definitions).toMatch(new RegExp(`data-definition-snapshot="${expired!.id}"(?:(?!</tr>).)*>2024-06-01<`, 's'));
    expect(definitions).not.toContain(`href="/analytics/snapshots/${expired!.id}"`);
    expect((await browser.get(`/analytics/snapshots/${expired!.id}`)).status).toBe(404);

    expect((await globexBrowser.get(`/analytics/snapshots/${metric.id}`)).status).toBe(404);
    expect((await browser.get(`/analytics/snapshots/${mismatched!.id}`)).status).toBe(404);

    const anon = await app.client().get(`/analytics/snapshots/${metric.id}`);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('Location')).toBe('/login');
  });
});

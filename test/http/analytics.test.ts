// 分析页的 HTTP 接缝：有结果层查看权限的成员在「分析」页看到本租户的 RFM 快照，打开看各人群与分页的消费者明细（只有 consumer_id 与分值，没有明文）；
// 其他租户的快照 404，已过期的快照标灰、打不开；RFM 模板参数页的权限矩阵：查看者只读，分析师能起草不能发布，
// 最后保存草稿的人不能发布，另一位数据工程师或管理员发布后入队 gold.rfm；按生效版本重新计算（分析师 403、未来日期与重复入队被拒）
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks, templateVersions } from '../../app/.server/db/schema';
import { listSnapshots } from '../../app/.server/snapshots';
import { memberOf, newTenant, runTask } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 打通好的 acme 跑一次 RFM，返回租户与快照 */
async function rfmSnapshot() {
  const { acme } = await publishedIdentitySources({ orders: true });
  await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  const [snapshot] = await listSnapshots(acme);
  return { acme, snapshot };
}

// 源表里的姓名、手机、邮箱、外部 ID，页面上一个都不能出现
const PLAINTEXT = ['张三', '钱七', '13800000002', '138 0000 0001', 'zhang@crm.test', 'qian7@example.com', 'wx_union_8'];

describe('分析页', () => {
  it('查看者在分析页看到本租户的快照，打开看各人群人数与金额、分页的消费者明细，页面上没有明文', async () => {
    const { acme, snapshot } = await rfmSnapshot();
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');

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

  it('其他租户的快照返回 404，也不出现在它的列表里', async () => {
    const { snapshot } = await rfmSnapshot();
    const globex = await newTenant('globex');
    await memberOf(globex, 'viewer@globex.com', 'viewer');
    const browser = await loginAs(app, 'viewer@globex.com');
    expect(await (await browser.get('/analytics')).text()).not.toContain(snapshot.id);
    expect((await browser.get(`/analytics/snapshots/${snapshot.id}`)).status).toBe(404);
    expect((await browser.get('/analytics/snapshots/not-a-uuid')).status).toBe(404);
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

// 分析页的 HTTP 接缝：有结果层查看权限的成员在「分析」页看到本租户的 RFM 快照，打开看各人群与分页的消费者明细（只有 consumer_id 与分值，没有明文）；
// 其他租户的快照 404，已过期的快照标灰、打不开；RFM 模板参数页的权限矩阵：查看者只读，分析师能起草不能发布，
// 最后保存草稿的人不能发布，另一位数据工程师或管理员发布后入队 gold.rfm；按生效版本重新计算（分析师 403、未来日期与重复入队被拒）；
// 用户 360 走注册表里的通用参数表单（只读、起草、校验报错、多余字段不传、发布后入队 gold.user360、未登记模板 404）与通用快照明细（全部列、是 / 否、分页、没有明文）
// 同期群与复购同样走通用表单（周期下拉框、起草、双人发布入队 gold.cohort / gold.repurchase 并登记快照，周期偏移列表用顿号连接）
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots, tasks, templateVersions } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { listSnapshots, readTemplateSnapshot } from '../../app/.server/snapshots';
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

describe('用户 360 模板参数页与快照（通用表单与通用明细）', () => {
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

describe('同期群与复购模板参数页（通用表单）', () => {
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

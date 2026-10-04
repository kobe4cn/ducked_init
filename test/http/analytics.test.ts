// 分析页的 HTTP 接缝：有结果层查看权限的成员在「分析」页看到本租户的 RFM 快照，打开看各人群与分页的消费者明细（只有 consumer_id 与分值，没有明文）；
// 其他租户的快照 404，已过期的快照标灰、打不开
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots } from '../../app/.server/db/schema';
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

  it('其他租户的快照返回 404，也不出现在它的列表里', async () => {
    const { snapshot } = await rfmSnapshot();
    const globex = await newTenant('globex');
    await memberOf(globex, 'viewer@globex.com', 'viewer');
    const browser = await loginAs(app, 'viewer@globex.com');
    expect(await (await browser.get('/analytics')).text()).not.toContain(snapshot.id);
    expect((await browser.get(`/analytics/snapshots/${snapshot.id}`)).status).toBe(404);
    expect((await browser.get('/analytics/snapshots/not-a-uuid')).status).toBe(404);
  });

  it('已过期的快照在列表中标为已过期、没有链接，直接打开返回 404', async () => {
    const { acme, snapshot } = await rfmSnapshot();
    await getDb().update(snapshots).set({ expiredAt: new Date() }).where(eq(snapshots.id, snapshot.id));
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const browser = await loginAs(app, 'viewer@acme.com');
    const html = await (await browser.get('/analytics')).text();
    expect(html).toContain('data-snapshot-status="expired">已过期');
    expect(html).not.toContain(`href="/analytics/snapshots/${snapshot.id}"`);
    expect((await browser.get(`/analytics/snapshots/${snapshot.id}`)).status).toBe(404);
  });
});

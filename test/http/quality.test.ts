// test/http/quality.test.ts —— 数据质量页的 HTTP 接缝：往源库注入负金额订单 → 同步合并 → gold.rfm 断言失败，不合格行写进隔离区；
// 有 sources:read 的成员在 /quality 看到本租户最近的断言结果（失败标出）与隔离区样本，页面上没有明文；没有该权限的成员 403，其他租户的成员看不到
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { memberOf, newTenant, runTask } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { grantOnSource } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

// 源表里的姓名、手机、邮箱、外部 ID，页面上一个都不能出现
const PLAINTEXT = ['张三', '钱七', '13800000002', '138 0000 0001', 'zhang@crm.test', 'qian7@example.com', 'wx_union_8'];

/** 打通好的 acme 先成功算一次 RFM，再注入一单负金额订单 A7 并重算：断言失败 */
async function failedRfm() {
  const { acme, sources } = await publishedIdentitySources({ orders: true });
  await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
  await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  expect(task).toMatchObject({ status: 'failed' });
  return { acme, task: task! };
}

describe('数据质量页', () => {
  it('分析师在数据质量页看到最近的断言结果（失败标出）与隔离区样本，页面上没有明文；查看者 403、导航里没有入口', async () => {
    const { acme, task } = await failedRfm();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');
    expect(await (await browser.get('/')).text()).toContain('href="/quality"');

    const res = await browser.get('/quality');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('数据质量');
    expect(html).toMatch(/data-assertion="amount_non_negative"[^>]*data-failed="true"/);
    expect(html).toContain('金额非负');
    expect(html).toContain(task.id);
    expect(html).toMatch(/data-quarantine-key="A7"/);
    expect(html).toContain('&quot;order_id&quot;:&quot;A7&quot;');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);

    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/')).text()).not.toContain('href="/quality"');
    expect((await viewer.get('/quality')).status).toBe(403);
  });

  it('其他租户的成员只看到自己湖里的断言结果，看不到本租户的断言结果与隔离区', async () => {
    const { task } = await failedRfm();
    const globex = await newTenant('globex');
    const session = await openTenantLake(lakeSpecOf((await lakeRow(globex))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`INSERT INTO silver._assertion_runs VALUES ('globex-task', 'order', 3, '[{"name":"amount_non_negative","level":"error","entity":"order","failed":0}]', now())`);
    } finally {
      session.close();
    }
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    const browser = await loginAs(app, 'analyst@globex.com');
    const res = await browser.get('/quality');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('globex-task');
    expect(html).not.toContain(task.id);
    expect(html).not.toContain('data-quarantine-key');
    expect(html).not.toContain('A7');
  });
});

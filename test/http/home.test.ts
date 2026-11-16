// 首页「待你发布」的 HTTP 接缝：eng 保存源视图草稿后 admin 首页出现该项并链到源视图页，eng 自己（最后保存的人，publishBlocker）只看到空状态；
// admin 发布后该项消失；别的租户看不到；analyst / viewer（没有 publish 权限）整个区块不出现；别的种类（指标定义草稿）也列出
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDefinition } from '../../app/.server/dsl-definitions';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView } from '../../app/.server/source-views';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 开通租户 acme，de@acme.com 登记电商库、选入全部表，确认 customers 的水位线并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return { tenantId, sourceId: id };
}

const VIEW = 'SELECT customer_id, name, email, city, _op, _batch, _commit_ts FROM customers';

describe('首页「待你发布」', () => {
  it('eng 保存源视图草稿后 admin 首页出现该项并链到源视图页；eng 自己只看到空状态；发布后消失', async () => {
    const { tenantId, sourceId } = await syncedSource();
    const engineer = await memberOf(tenantId, 'de@acme.com');
    const viewId = await createSourceView(engineer, sourceId, { name: 'customer_city', sql: VIEW });

    const admin = await loginAs(app, 'admin@acme.com');
    const home = await (await admin.get('/')).text();
    expect(home).toContain('待你发布');
    expect(home).toMatch(new RegExp(`data-pending-kind="source_view"[^]*href="/sources/${sourceId}/views/${viewId}"`));
    expect(home).toContain('customer_city');
    expect(home).toContain('de@acme.com');

    // 最后保存的人被 publishBlocker 拦住：自己的首页不出现这一项，只有空状态
    const author = await loginAs(app, 'de@acme.com');
    const own = await (await author.get('/')).text();
    expect(own).toContain('待你发布');
    expect(own).toContain('没有等你发布的草稿');
    expect(own).not.toContain('customer_city');

    // admin 在源视图页发布后，首页上这一项消失
    expect((await admin.post(`/sources/${sourceId}/views/${viewId}`, { intent: 'publish', version: '1' })).status).toBe(302);
    const after = await (await admin.get('/')).text();
    expect(after).not.toMatch(/data-pending-kind=/);
    expect(after).not.toContain(viewId);
  });

  it('别的租户看不到这一项', async () => {
    const { tenantId, sourceId } = await syncedSource();
    await createSourceView(await memberOf(tenantId, 'de@acme.com'), sourceId, { name: 'customer_city', sql: VIEW });

    await newTenant('globex');
    const outsider = await loginAs(app, 'admin@globex.com');
    const home = await (await outsider.get('/')).text();
    expect(home).toContain('待你发布'); // globex 的 admin 有发布权限，看到的是空状态
    expect(home).toContain('没有等你发布的草稿');
    expect(home).not.toContain('customer_city');
    expect(home).not.toMatch(/data-pending-kind=/);
  });

  it('analyst 与 viewer 没有发布权限，首页不显示这个区块', async () => {
    const { tenantId, sourceId } = await syncedSource();
    await createSourceView(await memberOf(tenantId, 'de@acme.com'), sourceId, { name: 'customer_city', sql: VIEW });

    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await (await (await loginAs(app, 'an@acme.com')).get('/')).text();
    expect(analyst).not.toContain('待你发布');
    expect(analyst).not.toMatch(/data-pending-kind=/);

    await memberOf(tenantId, 'vi@acme.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'vi@acme.com')).get('/')).text();
    expect(viewer).not.toContain('待你发布');
  });

  it('别的种类也列出：eng 起草的指标定义出现在 admin 首页', async () => {
    const tenantId = await newTenant('acme');
    await createDefinition(await memberOf(tenantId, 'de@acme.com'), 'metric', 'order_count', 'base: order\nmeasure: { agg: count }\n');

    const admin = await loginAs(app, 'admin@acme.com');
    const home = await (await admin.get('/')).text();
    expect(home).toMatch(/data-pending-kind="metric"[^]*href="\/analytics\/definitions\/metric\/order_count"/);
    expect(home).toContain('order_count');
    expect(home).toContain('指标');
  });
});

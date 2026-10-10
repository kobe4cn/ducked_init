// test/pipeline/assertions.test.ts —— 内置断言的流水线接缝：往源库注入坏数据 → 同步并合并进标准层 → runTask('gold.rfm' / 'gold.dsl') → 工作进程计算前跑断言 →
// 任务结果 result.assertions、listSnapshots（不登记新快照、旧快照仍可读）、数据湖里没有新的快照表、告警邮件与审计 assertion.failed；
// warn 断言只记录：任务照常成功、登记快照，结果与湖里的 silver._assertion_runs 都带这条 warn
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { setMailer, type Mail } from '../../app/.server/mailer';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { lit } from '../../app/.server/pipeline/merge-engine';
import { listSnapshots, readRfmSnapshot } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { resetDb } from '../http/harness';
import { memberOf, mergeUnchecked, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

const outbox: Mail[] = [];
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  await resetDb();
  outbox.length = 0;
  setMailer({ async send(m) { outbox.push(m); } });
});
afterEach(() => { setMailer(undefined); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 在本租户数据湖里执行 SQL（查看表与文件） */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

const goldTables = async (tenantId: string) => (await onLake<{ name: string }>(tenantId, `
  SELECT table_name AS name FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = 'gold' ORDER BY ALL`)).map(t => t.name);

/** 往 CRM 订单表插一行，同步进原始层并跑完同步后的合并 */
async function insertCrmOrder(acme: string, crm: string, values: string) {
  await grantOnSource(`INSERT INTO crm.orders VALUES (${values})`);
  await syncSource(await memberOf(acme, 'de@acme.com'), crm);
  await drain();
}

/** 先成功算一次 RFM，返回租户、数据源与这版快照 */
async function withRfmSnapshot() {
  const fixture = await publishedIdentitySources({ orders: true });
  const task = await runTask(fixture.acme, 'gold.rfm', { asOf: '2024-07-01' });
  expect(task).toMatchObject({ status: 'succeeded' });
  expect((task!.result as { assertions: unknown[] }).assertions).toEqual(expect.arrayContaining([
    { name: 'primary_key_unique', level: 'error', entity: 'order', failed: 0, detail: 'order_id, _key_space' },
    { name: 'amount_non_negative', level: 'error', entity: 'order', failed: 0, detail: 'amount' },
    { name: 'primary_key_unique', level: 'error', entity: 'customer', failed: 0, detail: 'customer_id, _source, _key_space' },
  ]));
  const [snapshot] = await listSnapshots(fixture.acme);
  return { ...fixture, snapshot };
}

/** 断言失败后：没有新快照、没有新的快照表，旧快照仍可读；管理员收到一封只带断言名、实体与行数的邮件，审计里一条断言失败 */
async function expectBlocked(acme: string, snapshot: Awaited<ReturnType<typeof withRfmSnapshot>>['snapshot'], summary: RegExp) {
  expect(await listSnapshots(acme)).toEqual([snapshot]);
  expect(await goldTables(acme)).toEqual([snapshot.table.slice('gold.'.length)]);
  expect((await readRfmSnapshot(snapshot, { page: 1 })).consumers).toHaveLength(5);

  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ to: 'admin@acme.com', subject: expect.stringContaining('数据检查未通过') });
  expect(outbox[0].text).toMatch(summary);
  const audits = (await listAuditLogs(acme)).filter(a => a.action === '断言失败');
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actor: '平台', summary: expect.stringMatching(summary) });
}

describe('error 断言阻断快照并告警', () => {
  it('标准层出现负金额：gold.rfm 失败，结果带断言名、实体与不合格行数；不登记新快照，旧快照仍可读', async () => {
    const { acme, sources, snapshot } = await withRfmSnapshot();
    await insertCrmOrder(acme, sources.crm, `'A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now()`);

    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'failed', error: expect.stringContaining('金额非负（silver.order，1 行不合格）') });
    expect((task!.result as { assertions: unknown[] }).assertions).toContainEqual(
      { name: 'amount_non_negative', level: 'error', entity: 'order', failed: 1, detail: 'amount' });
    await expectBlocked(acme, snapshot, /金额非负（silver\.order，1 行不合格）/);
    expect(outbox[0].text).not.toContain('A7');
  });

  it('标准层出现重复主键：gold.rfm 失败并告警，不登记新快照', async () => {
    const { acme, sources, snapshot } = await withRfmSnapshot();
    // 与会员订单 1 撞主键：正常合并会被独占检查挡住，用 mergeUnchecked 造出重复
    await insertCrmOrder(acme, sources.crm, `'1', 1, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now()`);
    const [crmOrders] = await getDb().select({ id: mappings.id }).from(mappings)
      .where(and(eq(mappings.sourceId, sources.crm), eq(mappings.entity, 'order')));
    expect(await mergeUnchecked(acme, [crmOrders.id])).toMatchObject({ status: 'succeeded' });
    outbox.length = 0;

    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'failed' });
    expect((task!.result as { assertions: unknown[] }).assertions).toContainEqual(
      { name: 'primary_key_unique', level: 'error', entity: 'order', failed: 2, detail: 'order_id, _key_space' });
    await expectBlocked(acme, snapshot, /主键唯一（silver\.order，2 行不合格）/);
  });

  it('gold.dsl 只检查参数里的实体：读到负金额的订单时失败并告警，不读订单时照常产出', async () => {
    const { acme, sources, snapshot } = await withRfmSnapshot();
    await insertCrmOrder(acme, sources.crm, `'A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now()`);
    const dsl = (entities: string[]) => ({ kind: 'metric', key: 'm', asOf: '2024-07-01', sql: 'SELECT consumer_id, 1 AS value FROM silver._identities', entities });

    const failed = await runTask(acme, 'gold.dsl', dsl(['order', 'customer']));
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('金额非负') });
    await expectBlocked(acme, snapshot, /金额非负（silver\.order，1 行不合格）/);

    const ok = await runTask(acme, 'gold.dsl', dsl(['customer']));
    expect(ok).toMatchObject({ status: 'succeeded' });
    expect(new Set((ok!.result as { assertions: { entity: string }[] }).assertions.map(a => a.entity))).toEqual(new Set(['customer']));
  });
});

/** 湖里某个任务的断言运行记录 */
const assertionRuns = (acme: string, taskId: string) => onLake<{ entity: string; rows: string; assertions: string }>(acme, `
  SELECT entity, rows::VARCHAR AS rows, assertions::VARCHAR AS assertions FROM silver._assertion_runs WHERE task_id = ${lit(taskId)} ORDER BY entity`);

describe('warn 断言只记录不阻断', () => {
  it('订单关联消费者的比例低于 80%：记一条 warn（带比例与孤儿数），任务成功、登记快照，运行记录里也有', async () => {
    const { acme, sources, snapshot } = await withRfmSnapshot();
    // 种子数据 11 单里 10 单关联得上，不触发
    expect((await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' }))!.result).toMatchObject({
      assertions: expect.arrayContaining([{ name: 'order_customer_link', level: 'warn', entity: 'order', failed: 0, ratio: 0.9091, orphans: 1 }]),
    });
    // 再来两单没有下单人：10/13 关联得上
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A8', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now()), ('A9', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
    await drain();
    outbox.length = 0;

    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'succeeded' });
    const warn = { name: 'order_customer_link', level: 'warn', entity: 'order', failed: 3, ratio: 0.7692, orphans: 3 };
    expect((task!.result as { assertions: unknown[] }).assertions).toContainEqual(warn);
    const snapshots = await listSnapshots(acme);
    expect(snapshots).toHaveLength(3);
    expect(snapshots).toContainEqual(snapshot);
    expect(outbox).toHaveLength(0);

    const runs = await assertionRuns(acme, task!.id);
    expect(runs.map(r => [r.entity, r.rows])).toEqual([['customer', expect.any(String)], ['order', '13']]);
    expect(JSON.parse(runs[1].assertions)).toContainEqual(warn);

    // gold.dsl 只读订单时同样检查（silver.customer 不在参数里也查）
    const dsl = await runTask(acme, 'gold.dsl', { kind: 'metric', key: 'm', asOf: '2024-07-01', sql: 'SELECT consumer_id, 1 AS value FROM silver._identities', entities: ['order'] });
    expect(dsl).toMatchObject({ status: 'succeeded' });
    expect((dsl!.result as { assertions: unknown[] }).assertions).toContainEqual(warn);
  });

  it('实体行数比上一次运行少一半以上：记一条 warn（带前后行数），首次运行没有基准不报', async () => {
    const { acme } = await withRfmSnapshot();
    const [firstTask] = await onLake<{ task_id: string }>(acme, `SELECT task_id FROM silver._assertion_runs`);
    const [firstRun] = await assertionRuns(acme, firstTask.task_id);
    expect(JSON.parse(firstRun.assertions).map((a: { name: string }) => a.name)).not.toContain('row_drop');

    await onLake(acme, `DELETE FROM silver."order" WHERE order_id IN (SELECT order_id FROM silver."order" ORDER BY order_id LIMIT 6)`);
    const [{ n }] = await onLake<{ n: string }>(acme, `SELECT count(*)::VARCHAR AS n FROM silver."order"`);
    expect(Number(n)).toBeLessThan(11 / 2);

    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'succeeded' });
    const assertions = (task!.result as { assertions: { name: string; entity: string }[] }).assertions;
    expect(assertions).toContainEqual({ name: 'row_drop', level: 'warn', entity: 'order', failed: 11 - Number(n), rows: Number(n), previous: 11 });
    expect(assertions).toContainEqual(expect.objectContaining({ name: 'row_drop', entity: 'customer', failed: 0 }));
    expect(await listSnapshots(acme)).toHaveLength(2);
    const runs = await assertionRuns(acme, task!.id);
    expect(JSON.parse(runs.find(r => r.entity === 'order')!.assertions)).toContainEqual(expect.objectContaining({ name: 'row_drop', previous: 11 }));
  });
});

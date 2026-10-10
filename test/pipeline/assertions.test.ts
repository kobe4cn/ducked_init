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
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, mergeUnchecked, publish, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

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
    const rows = await onLake<{ assertion: string; key: string }>(acme, `SELECT assertion, "key" FROM silver._quarantine WHERE task_id = ${lit(task!.id)}`);
    expect(rows).toEqual([{ assertion: 'primary_key_unique', key: '1' }, { assertion: 'primary_key_unique', key: '1' }]);
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

/** 湖里某个任务写进隔离区的行 */
const quarantine = (acme: string, taskId: string) => onLake<{ assertion: string; level: string; entity: string; key: string; row: string }>(acme, `
  SELECT assertion, level, entity, "key", "row"::VARCHAR AS "row" FROM silver._quarantine WHERE task_id = ${lit(taskId)} ORDER BY "key"`);

describe('隔离区', () => {
  it('error 断言失败时把不合格行写进 silver._quarantine（断言名、级别、实体、键、行 JSON），再让任务失败', async () => {
    const { acme, sources } = await withRfmSnapshot();
    await insertCrmOrder(acme, sources.crm, `'A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now()`);

    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'failed' });
    const rows = await quarantine(acme, task!.id);
    expect(rows).toEqual([{ assertion: 'amount_non_negative', level: 'error', entity: 'order', key: 'A7', row: expect.any(String) }]);
    expect(JSON.parse(rows[0].row)).toMatchObject({ order_id: 'A7', amount: -10 });
  });

  it('订单关联消费者告警时写孤儿订单；行数骤降不写行；没有失败的任务不写', async () => {
    const { acme, sources } = await withRfmSnapshot();
    const [first] = await onLake<{ task_id: string }>(acme, `SELECT task_id FROM silver._assertion_runs`);
    expect(await quarantine(acme, first.task_id)).toEqual([]);

    await grantOnSource(`INSERT INTO crm.orders VALUES ('A8', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now()), ('A9', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
    await drain();
    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'succeeded' });
    const rows = await quarantine(acme, task!.id);
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.assertion === 'order_customer_link' && r.level === 'warn' && r.entity === 'order')).toBe(true);
    expect(rows.map(r => r.key)).toEqual(expect.arrayContaining(['A8', 'A9']));

    await onLake(acme, `DELETE FROM silver."order" WHERE order_id IN (SELECT order_id FROM silver."order" ORDER BY order_id LIMIT 8)`);
    const dropped = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect((dropped!.result as { assertions: unknown[] }).assertions).toContainEqual(expect.objectContaining({ name: 'row_drop', entity: 'order', failed: 8 }));
    expect((await quarantine(acme, dropped!.id)).map(r => r.assertion)).not.toContain('row_drop');
  });
});

/**
 * 积分源（shop schema）：积分流水同 mapping.test.ts 的 POINT_LOGS，M001 另有 6 笔同一时刻的 +1（id 6–11，按字符串排序 '10' 会排在 '6' 前面）；
 * 会员表里 M001 余额 56 与流水对得上，M002 余额 20：最后一笔余额是 20，但流水求和是 -10；M003 余额 10 但没有流水（按求和 0 算）
 */
const POINTS_SOURCE = `
  CREATE TABLE shop.point_logs (id serial PRIMARY KEY, customer_id int NOT NULL, member_no text NOT NULL, change_type text NOT NULL,
    points int NOT NULL, balance int NOT NULL, order_no text, created_at timestamp NOT NULL, expire_time timestamp);
  INSERT INTO shop.point_logs (customer_id, member_no, change_type, points, balance, order_no, created_at, expire_time) VALUES
    (1, 'M001', '获得', 200, 200, 'NO1', '2024-06-01 10:00', '2025-06-01 10:00'),
    (1, 'M001', '消费', -50, 150, 'NO2', '2024-06-02 10:00', NULL),
    (1, 'M001', '兑换', -100, 50, NULL, '2024-06-03 10:00', NULL),
    (2, 'M002', '过期', -30, 0, NULL, '2024-06-04 10:00', NULL),
    (2, 'M002', '调整', 20, 20, NULL, '2024-06-05 10:00', NULL);
  INSERT INTO shop.point_logs (customer_id, member_no, change_type, points, balance, order_no, created_at, expire_time)
    SELECT 1, 'M001', '获得', 1, 50 + i, NULL, '2024-06-07 10:00', NULL FROM generate_series(1, 6) i;
  CREATE TABLE shop.memberships (member_no text PRIMARY KEY, customer_id int NOT NULL, level text NOT NULL, points int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.memberships VALUES ('M001', 1, 'gold', 56, '2024-06-01'), ('M002', 2, 'silver', 20, '2024-06-01'), ('M003', 3, 'silver', 10, '2024-06-01');
  GRANT SELECT ON shop.point_logs, shop.memberships TO ${READER.user};`;

const POINT_LOGS_MAPPING = `model: 1
entity: points_transaction
table: point_logs
fields:
  points_transaction_id: string(id)
  customer_id: string(customer_id)
  membership_id: member_no
  change_type:
    expr: change_type
    dictionary: { 获得: earn, 消费: spend, 兑换: redeem, 过期: expire, 调整: adjust }
  points_change: points
  balance_after: balance
  order_id: order_no
  occurred_at: from_timezone(created_at, 'Asia/Shanghai')
  expires_at: from_timezone(expire_time, 'Asia/Shanghai')
`;

const MEMBERSHIPS_MAPPING = `model: 1
entity: membership
table: memberships
fields:
  membership_id: member_no
  customer_id: string(customer_id)
  level: level
  points: points
`;

/** 身份打通的租户上再登记积分源（shop schema），同步并发布会员与积分流水的映射 */
async function withPointsSource() {
  const fixture = await publishedIdentitySources();
  const { author, reviewer } = fixture;
  const input = await pgSourceInput(READER, '积分库');
  await grantOnSource(POINTS_SOURCE);
  const { id } = await registerSource(author, input);
  await drain();
  await setSyncScope(author, id, { add: ['point_logs', 'memberships'] });
  await drain();
  await confirmWatermark(author, id, 'point_logs', 'id');
  await confirmWatermark(author, id, 'memberships', 'updated_at');
  await syncSource(author, id);
  await drain();
  await publish(author, reviewer, id, POINT_LOGS_MAPPING);
  await publish(author, reviewer, id, MEMBERSHIPS_MAPPING);
  return { ...fixture, points: id };
}

const pointsDsl = { kind: 'metric', key: 'm', asOf: '2024-07-01', sql: 'SELECT consumer_id, 1 AS value FROM silver._identities', entities: ['membership', 'points_transaction'] };

describe('积分余额与积分流水的一致性', () => {
  it('余额与流水求和对不上（含没有流水）的会员报 warn（带会员数与差额合计），样本写会员号与差额；同一时刻的流水按 id 数值排序，断档不误报；任务照常产出', async () => {
    const { acme } = await withPointsSource();
    const task = await runTask(acme, 'gold.dsl', pointsDsl);
    expect(task).toMatchObject({ status: 'succeeded' });
    const assertions = (task!.result as { assertions: unknown[] }).assertions;
    expect(assertions).toContainEqual({ name: 'points_balance', level: 'warn', entity: 'membership', failed: 2, detail: '2 个会员不一致，差额合计 40' });
    expect(assertions).toContainEqual({ name: 'points_chain', level: 'warn', entity: 'points_transaction', failed: 0, detail: 'balance_after' });
    expect(await goldTables(acme)).toEqual([`metric__${task!.id}`]);
    expect(outbox).toHaveLength(0);

    const rows = await quarantine(acme, task!.id);
    expect(rows.map(r => [r.assertion, r.level, r.entity, r.key])).toEqual([['points_balance', 'warn', 'membership', 'M002'], ['points_balance', 'warn', 'membership', 'M003']]);
    expect(rows.map(r => JSON.parse(r.row))).toEqual([
      { membership_id: 'M002', points: 20, sum_change: -10, last_balance: 20, diff: 30 },
      { membership_id: 'M003', points: 10, sum_change: 0, last_balance: null, diff: 10 },
    ]);
  });

  it('流水 balance_after 不等于上一笔余额加本笔变动时报断档，样本写这笔流水；任务照常产出', async () => {
    const { acme, points } = await withPointsSource();
    await grantOnSource(`INSERT INTO shop.point_logs (customer_id, member_no, change_type, points, balance, order_no, created_at, expire_time)
      VALUES (2, 'M002', '获得', 5, 99, NULL, '2024-06-08 10:00', NULL)`);
    await syncSource(await memberOf(acme, 'de@acme.com'), points);
    await drain();

    const task = await runTask(acme, 'gold.dsl', pointsDsl);
    expect(task).toMatchObject({ status: 'succeeded' });
    const assertions = (task!.result as { assertions: unknown[] }).assertions;
    expect(assertions).toContainEqual({ name: 'points_chain', level: 'warn', entity: 'points_transaction', failed: 1, detail: 'balance_after' });
    expect(assertions).toContainEqual(expect.objectContaining({ name: 'points_balance', failed: 2, detail: '2 个会员不一致，差额合计 35' }));
    const chain = (await quarantine(acme, task!.id)).filter(r => r.assertion === 'points_chain');
    expect(chain.map(r => [r.entity, r.key])).toEqual([['points_transaction', '12']]);
    expect(JSON.parse(chain[0].row)).toMatchObject({ membership_id: 'M002', points_change: 5, balance_after: 99, previous_balance: 20 });
  });

  it('只读消费者的任务不跑积分断言', async () => {
    const { acme } = await withPointsSource();
    const task = await runTask(acme, 'gold.dsl', { ...pointsDsl, entities: ['customer'] });
    expect((task!.result as { assertions: { name: string }[] }).assertions.map(a => a.name)).not.toContain('points_balance');
  });
});

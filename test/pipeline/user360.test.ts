// test/pipeline/user360.test.ts —— 用户 360 的流水线接缝：CRM 与会员两个数据源的消费者、订单与同意同步、发布映射、合并并打通 → runTask('gold.user360') → 调度器派发到工作进程 →
// 结果层 gold."user360__<任务 ID>" 的快照表（每个统一消费者一行，只有 consumer_id、订单汇总与各渠道同意）、快照登记，断言失败时任务失败并告警
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { setMailer, type Mail } from '../../app/.server/mailer';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { CHANNELS } from '../../app/lib/canonical-model';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, runTask } from './fixtures';
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

type Row = Record<string, unknown> & { consumer_id: string };

/** 只读打开数据湖，读出快照表的列名、全部行（按 consumer_id 排序，金额转成文本）与 (_source, customer_id) → consumer_id */
async function readLake(tenantId: string, table: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 }, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const [schema, name] = table.split('.');
    const columns = (await read<{ column_name: string }>(`DESCRIBE ${schema}."${name}"`)).map(c => c.column_name);
    const rows = await read<Row>(`SELECT * REPLACE (monetary::VARCHAR AS monetary) FROM ${schema}."${name}" ORDER BY consumer_id`);
    const identities = await read<{ _source: string; customer_id: string; consumer_id: string }>('SELECT * FROM silver._identities');
    return { columns, rows, identities };
  } finally {
    session.close();
  }
}

const consents = (granted: string[]) => Object.fromEntries(CHANNELS.map(ch => [`consent_${ch}`, granted.includes(ch)]));
const none = { orders: 0, monetary: '0.00', avg_order_value: null, first_order_date: null, last_order_date: null, recency_days: null, tenure_days: null };

describe('gold.user360：以统一消费者为粒度汇总订单与同意', () => {
  it('两个数据源的订单与同意经打通合到同一消费者，与手算一致；没下过单的也在；快照表没有明文与 __source 列，登记为 user360，不重建服务库', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true, consents: true });
    // 映射合并后平台自动启用的 RFM 会重建服务库，这里只看 user360 有没有再触发
    const servingBuilds = () => getDb().select({ id: tasks.id }).from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'serving.build')));
    const builds = await servingBuilds();
    const task = await runTask(acme, 'gold.user360', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const result = task!.result as { table: string; rows: number };
    expect(result).toMatchObject({ table: `gold.user360__${task!.id}`, rows: 8, params: { asOf: '2024-07-01', lookbackDays: 365 } });

    const { columns, rows, identities } = await readLake(acme, result.table);
    expect(columns).toEqual([
      'consumer_id', 'orders', 'monetary', 'avg_order_value', 'first_order_date', 'last_order_date', 'recency_days', 'tenure_days',
      ...CHANNELS.map(ch => `consent_${ch}`),
    ]);
    const consumerOf = (source: string, customerId: string) => identities.find(i => i._source === source && i.customer_id === customerId)!.consumer_id;
    const { crm, loyalty, tracking } = sources;
    // 消费者（打通组）：crm 1 + 会员 1 + u1；crm 2 + 会员 2 + u2；crm 3 + 会员 3；crm 4；会员 4；crm 5、crm 6 + 会员 5；crm 7 + 会员 6；u9。as_of 2024-07-01
    const expected: Row[] = [
      // A1 6-30 ¥100 + B1 6-01 ¥400；短信：crm 6-01 同意、会员 6-05 撤回 → 撤回；邮件 crm 同意
      { consumer_id: consumerOf(crm, '1'), orders: 2, monetary: '500.00', avg_order_value: 250, first_order_date: '2024-06-01', last_order_date: '2024-06-30',
        recency_days: 1, tenure_days: 30, ...consents(['email']) },
      // A2 下单 4-30、支付 5-01 ¥300（按支付时间）；短信同一时刻同意与撤回，撤回优先
      { consumer_id: consumerOf(crm, '2'), orders: 1, monetary: '300.00', avg_order_value: 300, first_order_date: '2024-05-01', last_order_date: '2024-05-01',
        recency_days: 61, tenure_days: 61, ...consents([]) },
      // B3 3-01 ¥80
      { consumer_id: consumerOf(loyalty, '3'), orders: 1, monetary: '80.00', avg_order_value: 80, first_order_date: '2024-03-01', last_order_date: '2024-03-01',
        recency_days: 122, tenure_days: 122, ...consents([]) },
      { consumer_id: consumerOf(crm, '4'), ...none, ...consents([]) },
      { consumer_id: consumerOf(loyalty, '4'), ...none, ...consents([]) },
      // A6 4-01 ¥150 + A3 6-20 ¥200 + B2 6-25 ¥200
      { consumer_id: consumerOf(crm, '5'), orders: 3, monetary: '550.00', avg_order_value: 183.33, first_order_date: '2024-04-01', last_order_date: '2024-06-25',
        recency_days: 6, tenure_days: 91, ...consents([]) },
      // B4 6-15 ¥1000；A4 已退款、B5 晚于 as_of，不计入
      { consumer_id: consumerOf(crm, '7'), orders: 1, monetary: '1000.00', avg_order_value: 1000, first_order_date: '2024-06-15', last_order_date: '2024-06-15',
        recency_days: 16, tenure_days: 16, ...consents([]) },
      { consumer_id: consumerOf(tracking, 'u9'), ...none, ...consents([]) },
    ];
    // A5 的下单人 99 打通不到，不进表
    expect(rows).toEqual(expected.sort((a, b) => a.consumer_id.localeCompare(b.consumer_id)));

    // 映射合并后平台自动启用的模板快照来源是 publish，不算在内
    const snapshots = (await listSnapshots(acme)).filter(s => s.trigger !== 'publish');
    expect(snapshots).toEqual([expect.objectContaining({ taskId: task!.id, template: 'user360', table: result.table, rowCount: 8 })]);
    // 服务库只收 RFM 与指标、标签（ADR-0033）
    expect(await servingBuilds()).toEqual(builds);
    // 模板 ID 带数字，快照过期照样能删表
    expect(await runTask(acme, 'gold.expire', { tables: [result.table] })).toMatchObject({ status: 'succeeded' });
  });

  it('没有同意映射时同意列全为 false', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const task = await runTask(acme, 'gold.user360', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const { rows } = await readLake(acme, (task!.result as { table: string }).table);
    expect(rows).toHaveLength(8);
    expect(rows.every(r => CHANNELS.every(ch => r[`consent_${ch}`] === false))).toBe(true);
  });

  it('error 级断言失败（负金额订单）时任务失败、不登记快照，管理员收到告警邮件，审计一条断言失败', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true, consents: true });
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
    await drain();
    const task = await runTask(acme, 'gold.user360', { asOf: '2024-07-01' });
    expect(task).toMatchObject({ status: 'failed', error: expect.stringContaining('金额非负') });
    expect((await listSnapshots(acme)).filter(s => s.trigger !== 'publish')).toEqual([]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: 'admin@acme.com', subject: expect.stringContaining('数据检查未通过') });
    expect(outbox[0].text).toContain('用户 360');
    expect((await listAuditLogs(acme)).filter(a => a.action === '断言失败')).toHaveLength(1);
  });

  it('标准层还没有订单时任务失败并说明原因；参数不合法时任务失败', async () => {
    const acme = await newTenant('acme');
    expect(await runTask(acme, 'gold.user360', { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('silver.order') });
    expect(await runTask(acme, 'gold.user360', {})).toMatchObject({ status: 'failed', error: expect.stringContaining('asOf') });
  });
});

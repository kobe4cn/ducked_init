// test/pipeline/cohort-repurchase.test.ts —— 同期群与复购的流水线接缝：CRM 与会员两个数据源的消费者与订单同步、发布映射、合并并打通 →
// runTask('gold.cohort' / 'gold.repurchase') → 调度器派发到工作进程 → 结果层 gold."<模板 ID>__<任务 ID>" 的快照表（每个统一消费者一行）与快照登记
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listSnapshots } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

type Row = Record<string, unknown> & { consumer_id: string };

/** 只读打开数据湖，读出快照表的列名、全部行（按 consumer_id 排序）与 (_source, customer_id) → consumer_id */
async function readLake(tenantId: string, table: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 }, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const [schema, name] = table.split('.');
    const columns = (await read<{ column_name: string }>(`DESCRIBE ${schema}."${name}"`)).map(c => c.column_name);
    const rows = await read<Row>(`SELECT * FROM ${schema}."${name}" ORDER BY consumer_id`);
    const identities = await read<{ _source: string; customer_id: string; consumer_id: string }>('SELECT * FROM silver._identities');
    return { columns, rows, identities };
  } finally {
    session.close();
  }
}

const byConsumer = (rows: Row[]) => rows.sort((a, b) => a.consumer_id.localeCompare(b.consumer_id));

let acme: string;
let crm: string;
let loyalty: string;
afterAll(async () => { await closeDb(); });
beforeAll(async () => {
  await resetDb();
  ({ acme, sources: { crm, loyalty } } = await publishedIdentitySources({ orders: true }));
});

// 消费者（打通组）：crm 1 + 会员 1 + u1；crm 2 + 会员 2 + u2；crm 3 + 会员 3；crm 4；会员 4；crm 5、crm 6 + 会员 5；crm 7 + 会员 6；u9。as_of 2024-07-01
describe('gold.cohort / gold.repurchase：每个统一消费者一行，交给页面再聚合', () => {
  it('同期群按月：多源订单合到同一消费者，首单周期与有下单的周期偏移与手算一致；没下过单的不在；登记为 cohort', async () => {
    const task = await runTask(acme, 'gold.cohort', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const result = task!.result as { table: string; rows: number };
    expect(result).toMatchObject({ table: `gold.cohort__${task!.id}`, rows: 5, params: { asOf: '2024-07-01', granularity: 'month', periods: 12 } });

    const { columns, rows, identities } = await readLake(acme, result.table);
    expect(columns).toEqual(['consumer_id', 'cohort_start', 'orders', 'active_periods']);
    const consumerOf = (source: string, customerId: string) => identities.find(i => i._source === source && i.customer_id === customerId)!.consumer_id;
    expect(rows).toEqual(byConsumer([
      // B1 6-01 + A1 6-30
      { consumer_id: consumerOf(crm, '1'), cohort_start: '2024-06-01', orders: 2, active_periods: [0] },
      // A2 下单 4-30、支付 5-01（按支付时间）
      { consumer_id: consumerOf(crm, '2'), cohort_start: '2024-05-01', orders: 1, active_periods: [0] },
      { consumer_id: consumerOf(loyalty, '3'), cohort_start: '2024-03-01', orders: 1, active_periods: [0] },
      // A6 4-01 + A3 6-20 + B2 6-25
      { consumer_id: consumerOf(crm, '5'), cohort_start: '2024-04-01', orders: 3, active_periods: [0, 2] },
      // B4 6-15；A4 已退款、B5 晚于 as_of
      { consumer_id: consumerOf(crm, '7'), cohort_start: '2024-06-01', orders: 1, active_periods: [0] },
    ]));
    expect(await listSnapshots(acme)).toContainEqual(expect.objectContaining({ taskId: task!.id, template: 'cohort', table: result.table, rowCount: 5 }));
  });

  it('复购：首单与第二单与手算一致，只有一单的第二单为空；windowDays 从 90 改成 60 后 crm 5 那组不再算复购；登记为 repurchase', async () => {
    const task = await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const result = task!.result as { table: string; rows: number };
    expect(result).toMatchObject({ table: `gold.repurchase__${task!.id}`, rows: 5, params: { asOf: '2024-07-01', lookbackDays: 365, windowDays: 90 } });

    const { columns, rows, identities } = await readLake(acme, result.table);
    expect(columns).toEqual(['consumer_id', 'orders', 'first_order_date', 'second_order_date', 'days_to_second', 'repurchased']);
    const consumerOf = (source: string, customerId: string) => identities.find(i => i._source === source && i.customer_id === customerId)!.consumer_id;
    const once = (source: string, id: string, first: string) =>
      ({ consumer_id: consumerOf(source, id), orders: 1, first_order_date: first, second_order_date: null, days_to_second: null, repurchased: false });
    const expected = (crm5: boolean) => byConsumer([
      { consumer_id: consumerOf(crm, '1'), orders: 2, first_order_date: '2024-06-01', second_order_date: '2024-06-30', days_to_second: 29, repurchased: true },
      once(crm, '2', '2024-05-01'),
      once(loyalty, '3', '2024-03-01'),
      { consumer_id: consumerOf(crm, '5'), orders: 3, first_order_date: '2024-04-01', second_order_date: '2024-06-20', days_to_second: 80, repurchased: crm5 },
      once(crm, '7', '2024-06-15'),
    ]);
    expect(rows).toEqual(expected(true));
    expect(await listSnapshots(acme)).toContainEqual(expect.objectContaining({ taskId: task!.id, template: 'repurchase', table: result.table, rowCount: 5 }));

    const narrow = await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01', windowDays: 60 });
    expect(narrow?.status).toBe('succeeded');
    expect((await readLake(acme, (narrow!.result as { table: string }).table)).rows).toEqual(expected(false));
  });

  it('标准层还没有订单时任务失败并说明原因；参数不合法时任务失败', async () => {
    const other = await newTenant('other');
    for (const kind of ['gold.cohort', 'gold.repurchase'] as const) {
      expect(await runTask(other, kind, { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('silver.order') });
    }
    expect(await runTask(acme, 'gold.cohort', { asOf: '2024-07-01', periods: 0 })).toMatchObject({ status: 'failed', error: expect.stringContaining('periods') });
    expect(await runTask(acme, 'gold.repurchase', { asOf: '2024-07-01', windowDays: 731 })).toMatchObject({ status: 'failed', error: expect.stringContaining('windowDays') });
  });
});

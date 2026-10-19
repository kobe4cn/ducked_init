// test/pipeline/clv-churn.test.ts —— CLV 与流失预警的流水线接缝：CRM 与会员两个数据源的消费者与订单同步、发布映射、合并并打通 →
// runTask('gold.clv' / 'gold.churn') → 调度器派发到工作进程 → 结果层 gold."<模板 ID>__<任务 ID>" 的快照表与快照登记
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listSnapshots } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

type Row = Record<string, unknown> & { consumer_id: string };

/** 只读打开数据湖，读出快照表的列名与类型、全部行（按 consumer_id 排序，DECIMAL 列 clv 转成文本）与 (_source, customer_id) → consumer_id */
async function readLake(tenantId: string, table: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 }, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const [schema, name] = table.split('.');
    const described = await read<{ column_name: string; column_type: string }>(`DESCRIBE ${schema}."${name}"`);
    const columns = described.map(c => c.column_name);
    const types = Object.fromEntries(described.map(c => [c.column_name, c.column_type]));
    const rows = await read<Row>(`SELECT * ${columns.includes('clv') ? 'REPLACE (clv::VARCHAR AS clv) ' : ''}FROM ${schema}."${name}" ORDER BY consumer_id`);
    const identities = await read<{ _source: string; customer_id: string; consumer_id: string }>('SELECT * FROM silver._identities');
    return { columns, types, rows, identities };
  } finally {
    session.close();
  }
}

let acme: string;
let crm: string;
let loyalty: string;
afterAll(async () => { await closeDb(); });
beforeAll(async () => {
  await resetDb();
  ({ acme, sources: { crm, loyalty } } = await publishedIdentitySources({ orders: true }));
});

// 消费者（打通组）：crm 1 + 会员 1 + u1；crm 2 + 会员 2 + u2；crm 3 + 会员 3；crm 4；会员 4；crm 5、crm 6 + 会员 5；crm 7 + 会员 6；u9
describe('gold.clv / gold.churn', () => {
  it('CLV（as_of 2024-07-01）：窗口内有单的消费者各一行，各列与按公式手算的一致；打通不到的订单不算；登记为 clv', async () => {
    const task = await runTask(acme, 'gold.clv', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const result = task!.result as { table: string; rows: number };
    expect(result).toMatchObject({ table: `gold.clv__${task!.id}`, rows: 5, params: { asOf: '2024-07-01', lookbackDays: 730, horizonDays: 365, minTenureDays: 30, decay: 2 } });

    const { columns, types, rows, identities } = await readLake(acme, result.table);
    expect(columns).toEqual(['consumer_id', 'orders', 'monetary', 'avg_order_value', 'recency_days', 'tenure_days', 'freq_per_year', 'p_alive', 'clv']);
    expect(types).toMatchObject({ orders: 'INTEGER', monetary: 'DOUBLE', avg_order_value: 'DOUBLE', freq_per_year: 'DOUBLE', p_alive: 'DOUBLE', clv: 'DECIMAL(18,2)' });
    const consumerOf = (source: string, customerId: string) => identities.find(i => i._source === source && i.customer_id === customerId)!.consumer_id;
    // p_alive = exp(− recency / max(tenure / orders, 30) / 2)；clv = round(aov × orders × 365 / tenure × p_alive, 2)
    const expected = [
      // B1 6-01 400 + A1 6-30 100：客龄 30，沉默 1；exp(−1 / 30 / 2)
      { consumer_id: consumerOf(crm, '1'), orders: 2, monetary: 500, avg_order_value: 250, recency_days: 1, tenure_days: 30, freq_per_year: 24.33333, p_alive: 0.98347, clv: '5982.78' },
      // A2 5-01 300（按支付时间）：客龄 = 沉默 = 61；exp(−0.5)
      { consumer_id: consumerOf(crm, '2'), orders: 1, monetary: 300, avg_order_value: 300, recency_days: 61, tenure_days: 61, freq_per_year: 5.98361, p_alive: 0.60653, clv: '1088.77' },
      // B3 3-01 80：客龄 = 沉默 = 122；exp(−0.5)
      { consumer_id: consumerOf(loyalty, '3'), orders: 1, monetary: 80, avg_order_value: 80, recency_days: 122, tenure_days: 122, freq_per_year: 2.99180, p_alive: 0.60653, clv: '145.17' },
      // A6 4-01 150 + A3 6-20 200 + B2 6-25 200：客龄 91，沉默 6；exp(−6 / (91 / 3) / 2)
      { consumer_id: consumerOf(crm, '5'), orders: 3, monetary: 550, avg_order_value: 183.33333, recency_days: 6, tenure_days: 91, freq_per_year: 12.03297, p_alive: 0.90583, clv: '1998.31' },
      // B4 6-15 1000（A4 已退款、B5 晚于 as_of）：客龄 16 按 30，沉默 16；exp(−16 / 30 / 2)
      { consumer_id: consumerOf(crm, '7'), orders: 1, monetary: 1000, avg_order_value: 1000, recency_days: 16, tenure_days: 30, freq_per_year: 12.16667, p_alive: 0.76593, clv: '9318.79' },
    ].sort((a, b) => a.consumer_id.localeCompare(b.consumer_id));
    expect(rows.map(r => r.consumer_id)).toEqual(expected.map(e => e.consumer_id));
    expected.forEach(({ avg_order_value, freq_per_year, p_alive, ...exact }, i) => {
      expect(rows[i]).toMatchObject(exact);
      expect(rows[i].avg_order_value).toBeCloseTo(avg_order_value, 4);
      expect(rows[i].freq_per_year).toBeCloseTo(freq_per_year, 4);
      expect(rows[i].p_alive).toBeCloseTo(p_alive, 4);
    });
    expect(await listSnapshots(acme)).toContainEqual(expect.objectContaining({ taskId: task!.id, template: 'clv', table: result.table, rowCount: 5 }));
  });

  it('流失预警：as_of 2024-07-01 时只有 crm 5/6 + 会员 5 够 3 单且没有风险；2024-10-15 时这一组有风险，crm 7 + 会员 6 只有 2 单不在；登记为 churn', async () => {
    const at = async (asOf: string) => {
      const task = await runTask(acme, 'gold.churn', { asOf });
      expect(task?.status).toBe('succeeded');
      const result = task!.result as { table: string; rows: number };
      expect(result).toMatchObject({ table: `gold.churn__${task!.id}`, rows: 1, params: { asOf, lookbackDays: 730, minOrders: 3, silenceMultiplier: 2, minGapDays: 7 } });
      expect(await listSnapshots(acme)).toContainEqual(expect.objectContaining({ taskId: task!.id, template: 'churn', table: result.table, rowCount: 1 }));
      return readLake(acme, result.table);
    };

    const july = await at('2024-07-01');
    expect(july.columns).toEqual(['consumer_id', 'orders', 'avg_gap_days', 'recency_days', 'silence_ratio', 'at_risk']);
    expect(july.types).toMatchObject({ avg_gap_days: 'DOUBLE', silence_ratio: 'DOUBLE', at_risk: 'BOOLEAN' });
    const crm5 = july.identities.find(i => i._source === crm && i.customer_id === '5')!.consumer_id;
    // A6 4-01、A3 6-20、B2 6-25：(6-25 − 4-01) / 2 = 42.5；沉默 6 天
    expect(july.rows).toEqual([{ consumer_id: crm5, orders: 3, avg_gap_days: 42.5, recency_days: 6, silence_ratio: 0.14, at_risk: false }]);

    // 沉默 112 天 > 2 × 42.5；B4 6-15 + B5 7-02 只有 2 单
    expect((await at('2024-10-15')).rows).toEqual([{ consumer_id: crm5, orders: 3, avg_gap_days: 42.5, recency_days: 112, silence_ratio: 2.64, at_risk: true }]);
  });

  it('标准层还没有订单时任务失败并说明原因；参数不合法时任务失败', async () => {
    const other = await newTenant('other');
    for (const kind of ['gold.clv', 'gold.churn'] as const) {
      expect(await runTask(other, kind, { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('silver.order') });
    }
    expect(await runTask(acme, 'gold.clv', { asOf: '2024-07-01', decay: 0 })).toMatchObject({ status: 'failed', error: expect.stringContaining('decay') });
    expect(await runTask(acme, 'gold.churn', { asOf: '2024-07-01', minOrders: 1 })).toMatchObject({ status: 'failed', error: expect.stringContaining('minOrders') });
  });
});

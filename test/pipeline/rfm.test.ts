// RFM 分层的流水线接缝：CRM 与会员两个数据源的消费者和订单同步、发布映射、合并并打通 → runTask('gold.rfm') → 调度器派发到工作进程 →
// 结果层 gold."rfm__<任务 ID>" 的快照表（每个统一消费者一行，只有 consumer_id 与分值）与任务结果
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { listMappings, publishMapping, saveDraft } from '../../app/.server/mappings';
import { checkMetric, compileMetric, type DslContext } from '../../app/.server/pipeline/dsl/metric-spec';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, runTask } from './fixtures';
import { LOYALTY_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const SHOP_ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
`;

type Row = { consumer_id: string; recency_days: number; frequency: number; monetary: string; r: number; f: number; m: number; segment: string };

/** 只读打开数据湖，读出快照表的列名、全部行（按 consumer_id 排序）与整表 JSON，以及 (_source, customer_id) → consumer_id */
async function readLake(tenantId: string, table: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 }, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const [schema, name] = table.split('.');
    const columns = (await read<{ column_name: string }>(`DESCRIBE ${schema}."${name}"`)).map(c => c.column_name);
    const rows = await read<Row>(`SELECT * REPLACE (monetary::VARCHAR AS monetary) FROM ${schema}."${name}" ORDER BY consumer_id`);
    const identities = await read<{ _source: string; customer_id: string; consumer_id: string }>('SELECT * FROM silver._identities');
    return { columns, rows, text: JSON.stringify(rows), identities };
  } finally {
    session.close();
  }
}

describe('gold.rfm：基于打通后的消费者计算 RFM', () => {
  it('两个数据源的订单经打通合到同一消费者，分值与人群与手算一致；快照表只有 consumer_id 与分值，打通不到的订单单独计数', async () => {
    const { acme, sources } = await publishedIdentitySources({ orders: true });
    const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(task?.status).toBe('succeeded');
    const result = task!.result as { table: string; rows: number; unlinkedOrders: number };
    expect(result).toMatchObject({ table: `gold.rfm__${task!.id}`, rows: 5, unlinkedOrders: 1 });

    const { columns, rows, identities } = await readLake(acme, result.table);
    expect(columns).toEqual(['consumer_id', 'recency_days', 'frequency', 'monetary', 'r', 'f', 'm', 'segment']);
    const consumerOf = (source: string, customerId: string) => identities.find(i => i._source === source && i.customer_id === customerId)!.consumer_id;
    const { crm, loyalty } = sources;
    // 消费者（打通组）：crm 1 + 会员 1；crm 2 + 会员 2；crm 3 + 会员 3；crm 5、crm 6 + 会员 5；crm 7 + 会员 6。as_of 2024-07-01，默认回看 365 天
    const expected: Row[] = [
      // A1 6-30 ¥100 + B1 6-01 ¥400
      { consumer_id: consumerOf(crm, '1'), recency_days: 1, frequency: 2, monetary: '500.00', r: 5, f: 4, m: 3, segment: '一般价值' },
      // A2 下单 4-30、支付 5-01 ¥300（按支付时间）
      { consumer_id: consumerOf(crm, '2'), recency_days: 61, frequency: 1, monetary: '300.00', r: 2, f: 2, m: 2, segment: '一般挽留' },
      // B3 3-01 ¥80
      { consumer_id: consumerOf(loyalty, '3'), recency_days: 122, frequency: 1, monetary: '80.00', r: 1, f: 1, m: 1, segment: '一般挽留' },
      // A3 6-20 ¥200 + A6 4-01 ¥150 + B2 6-25 ¥200
      { consumer_id: consumerOf(crm, '5'), recency_days: 6, frequency: 3, monetary: '550.00', r: 4, f: 5, m: 4, segment: '重要价值' },
      // B4 6-15 ¥1000；A4 已退款、B5 晚于 as_of，不计入
      { consumer_id: consumerOf(crm, '7'), recency_days: 16, frequency: 1, monetary: '1000.00', r: 3, f: 3, m: 5, segment: '一般挽留' },
    ];
    expect(rows).toEqual(expected.sort((a, b) => a.consumer_id.localeCompare(b.consumer_id)));
    expect(consumerOf(crm, '6')).toBe(consumerOf(crm, '5'));
  });

  it('同一份定义、同一个 as_of 重复运行，两张快照表的内容完全一致', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const params = { asOf: '2024-07-01', lookbackDays: 120 };
    const first = await runTask(acme, 'gold.rfm', params);
    const second = await runTask(acme, 'gold.rfm', params);
    const a = (first!.result as { table: string }).table, b = (second!.result as { table: string }).table;
    expect(a).not.toBe(b);
    const [x, y] = [await readLake(acme, a), await readLake(acme, b)];
    expect(x.rows.length).toBeGreaterThan(0);
    expect(y.text).toBe(x.text);
  });

  it('会员订单声明 customer_id 属于 CRM 后，按 CRM 的消费者记录算进 RFM 与订单关联断言，不算孤儿', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    const { crm, loyalty } = sources;
    // B6 的下单人 7 只在 CRM 里有（会员只有 1-6）
    await grantOnSource(`INSERT INTO loyalty.orders VALUES (6, 7, '已支付', 60, '2024-06-10 10:00', '2024-07-03')`);
    await syncSource(author, loyalty);
    await drain();
    type Result = { table: string; unlinkedOrders: number; assertions: { name: string; orphans?: number }[] };
    const rfm = async () => {
      const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
      expect(task?.status).toBe('succeeded');
      return task!.result as Result;
    };
    const link = (r: Result) => r.assertions.find(a => a.name === 'order_customer_link')?.orphans;
    // 不声明时 B6 按会员 7 找，打通不到，与 A5 一起是孤儿
    const before = await rfm();
    expect([before.unlinkedOrders, link(before)]).toEqual([2, 2]);

    const orders = (await listMappings(author)).mappings.find(m => m.entity === 'order' && m.sourceId === loyalty)!;
    await publishMapping(reviewer, orders.id, await saveDraft(author, orders.id,
      LOYALTY_ORDERS.replace('  customer_id: string(member_id)\n', '  customer_id: { expr: string(member_id), customer_source: CRM }\n')));
    await drain();
    const after = await rfm();
    expect([after.unlinkedOrders, link(after)]).toEqual([1, 1]);
    const { rows, identities } = await readLake(acme, after.table);
    const consumerOf = (customerId: string) => identities.find(i => i._source === crm && i.customer_id === customerId)!.consumer_id;
    // 会员订单的下单人按 CRM 编号：B4（会员 6 → crm 6）归 crm 5、crm 6 那组，B6 归 crm 7
    expect(rows.map(({ consumer_id, recency_days, frequency, monetary }) => ({ consumer_id, recency_days, frequency, monetary }))).toEqual([
      { consumer_id: consumerOf('1'), recency_days: 1, frequency: 2, monetary: '500.00' },
      { consumer_id: consumerOf('2'), recency_days: 61, frequency: 1, monetary: '300.00' },
      { consumer_id: consumerOf('3'), recency_days: 122, frequency: 1, monetary: '80.00' },
      { consumer_id: consumerOf('5'), recency_days: 6, frequency: 4, monetary: '1550.00' },
      { consumer_id: consumerOf('7'), recency_days: 21, frequency: 1, monetary: '60.00' },
    ].sort((a, b) => a.consumer_id.localeCompare(b.consumer_id)));
  });

  it('老湖的订单表还没有 _customer_source、也没重新合并时，gold.rfm 与 gold.dsl 开头补列后照常算', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const dropColumn = async () => {
      const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
      try {
        await session.con.run('ALTER TABLE silver."order" DROP COLUMN _customer_source');
      } finally {
        session.close();
      }
    };
    await dropColumn();
    const rfm = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    expect(rfm).toMatchObject({ status: 'succeeded', result: { rows: 5, unlinkedOrders: 1 } });

    await dropColumn();
    const ctx: DslContext = { published: new Map(), plans: [], metrics: new Map() };
    const checked = checkMetric('base: order\nmeasure: { agg: count }\n', ctx);
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    const dsl = await runTask(acme, 'gold.dsl', { kind: 'metric', key: 'orders', asOf: '2024-07-01', sql: compileMetric(checked.spec, ctx, '2024-07-01'), entities: ['order'] });
    expect(dsl).toMatchObject({ status: 'succeeded', result: { rows: 5 } });
  });

  it('标准层还没有订单时任务失败并说明原因；参数不合法时任务失败', async () => {
    const acme = await newTenant('acme');
    expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('silver.order') });
    expect(await runTask(acme, 'gold.rfm', {})).toMatchObject({ status: 'failed', error: expect.stringContaining('asOf') });
  });

  it('有订单、还没有 customer 映射（没有打通结果）时任务失败并说明原因', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(author, await pgSourceInput(READER));
    await drain();
    await setSyncScope(author, id, { add: ['orders'] });
    await drain();
    await confirmWatermark(author, id, 'orders', 'order_id');
    await syncSource(author, id);
    await drain();
    await publish(author, await memberOf(acme, 'de2@acme.com'), id, SHOP_ORDERS);
    expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('silver._identities') });
  });
});

// 映射空跑的流水线接缝：同步到原始层 → 保存映射草稿 → dryRunMapping 在只读挂载的数据湖上转换原始层样本 → 返回的样例行与基础断言；
// 空跑不写标准层，也不记合并日志 silver._merges
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createMapping, dryRunMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 没有主键的订单流水：A1 有两行完全相同 */
const ORDER_LOG = `
  CREATE TABLE shop.order_log (order_no text NOT NULL, status text NOT NULL, amount_fen int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.order_log VALUES
    ('A1', '已支付', 1990, '2024-06-01 10:00'), ('A1', '已支付', 1990, '2024-06-01 10:00'),
    ('A1', '已退款', 1990, '2024-06-03 10:00'), ('A2', '已支付', 500, '2024-06-02 10:00');
  GRANT SELECT ON shop.order_log TO ${READER.user};`;

/** 两位数据工程师；登记电商库、选入全部表并采集完，sync 为真时确认水位线并同步一次 */
async function syncedSource({ sync = true } = {}) {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const input = await pgSourceInput(READER);
  await grantOnSource(ORDER_LOG);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  if (sync) {
    await confirmWatermark(author, id, 'customers', 'updated_at');
    await confirmWatermark(author, id, 'orders', 'order_id');
    await confirmWatermark(author, id, 'order_log', 'updated_at');
    await syncSource(author, id);
    await drain();
  }
  return { acme, author, reviewer, id };
}

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  city: city
identity:
  match: [email]
`;

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
`;

const ORDER_LOG_MAPPING = `model: 1
entity: order
table: order_log
fields:
  order_id: order_no
  amount: amount_fen / 100
  updated_at: updated_at
  status:
    expr: trim(status)
    dictionary: { 已支付: paid }
    otherwise: null
dedupe:
  key: [order_id]
  latest: updated_at
`;

/** 合并日志 silver._merges 的全部行 */
async function merges(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll('SELECT * FROM silver._merges ORDER BY started_at')).getRowObjectsJson();
  } finally {
    session.close();
  }
}

describe('映射空跑', () => {
  it('空跑展示转换后的样例行，敏感字段是与标准层相同的加盐哈希；断言列出必填字段的空值', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, CUSTOMERS);
    const result = await dryRunMapping(author, mapping, 1);
    expect(result.sampled).toBe(40);
    expect(result.rows).toHaveLength(40);
    const emails = result.rows.map(r => r.email).filter(e => e !== null);
    expect(emails).toHaveLength(30);
    for (const e of emails) expect(e).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain('@');
    const merged = await silver(acme, 'customer', 'customer_id');
    expect(new Set(emails)).toEqual(new Set(merged.map(r => r.email).filter(e => e !== null)));
    expect(result.columns.find(c => c.name === 'email')).toMatchObject({ sensitive: true, required: true, nulls: 10 });
    expect(result.columns.find(c => c.name === 'city')).toMatchObject({ sensitive: false, required: false, nulls: 0 });
    expect(result.assertions).toMatchObject({ key: ['customer_id'], keyNulls: 0, keyDuplicates: 0, requiredNulls: { customer_id: 0, email: 10 }, unknownValues: [] });
  });

  it('样例最多取 50 条；值字典里没有的取值列出来，并标明合并时是写兜底值还是报错', async () => {
    const { author, id } = await syncedSource();
    const orders = await createMapping(author, id, ORDERS);
    const version = await saveDraft(author, orders.id, ORDERS.replace('refunded: refunded', 'paid_twice: paid'));
    const result = await dryRunMapping(author, orders.id, version);
    expect(result.sampled).toBe(50);
    expect(result.rows).toHaveLength(50);
    const [refunded] = result.assertions.unknownValues;
    expect(refunded).toMatchObject({ column: 'status', fallback: false, distinct: 1, values: [{ value: 'refunded' }] });
    expect(refunded.rows).toBe(result.rows.filter(r => r.status === null).length);
  });

  it('没有主键的表按整行区分记录，重复的去重键计入断言，落入兜底的取值标成兜底', async () => {
    const { author, id } = await syncedSource();
    const log = await createMapping(author, id, ORDER_LOG_MAPPING);
    const result = await dryRunMapping(author, log.id, 1);
    // 完全相同的两行是同一条记录
    expect(result.sampled).toBe(3);
    expect(result.assertions).toMatchObject({ keyNulls: 0, keyDuplicates: 1 });
    expect(result.assertions.unknownValues).toEqual([{ column: 'status', values: [{ value: '已退款', rows: 1 }], distinct: 1, rows: 1, fallback: true }]);
  });

  it('空跑前后标准层与合并日志不变', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const silverBefore = await silver(acme, 'order', 'order_id');
    const mergesBefore = await merges(acme);
    expect(mergesBefore).toHaveLength(1);
    const version = await saveDraft(author, orders, ORDERS.replace('amount: amount', 'amount: amount * 2'));
    await dryRunMapping(author, orders, version);
    await dryRunMapping(author, orders, 1);
    const customers = await createMapping(author, id, CUSTOMERS);
    await dryRunMapping(author, customers.id, 1);
    expect(await silver(acme, 'order', 'order_id')).toEqual(silverBefore);
    expect(await merges(acme)).toEqual(mergesBefore);
  });

  it('源表还没有同步进原始层时给出提示；没有的版本 404', async () => {
    const { author, id } = await syncedSource({ sync: false });
    const mapping = await createMapping(author, id, CUSTOMERS);
    await expect(dryRunMapping(author, mapping.id, 1)).rejects.toThrow(/还没有同步进原始层/);
    await expect(dryRunMapping(author, mapping.id, 9)).rejects.toMatchObject({ status: 404 });
  });

  it('查看者与分析师空跑被拒（403）', async () => {
    const { acme, author, id } = await syncedSource({ sync: false });
    const mapping = await createMapping(author, id, CUSTOMERS);
    for (const role of ['analyst', 'viewer'] as const) {
      const member = await memberOf(acme, `${role}@acme.com`, role);
      await expect(dryRunMapping(member, mapping.id, 1)).rejects.toMatchObject({ init: { status: 403 } });
    }
  });
});

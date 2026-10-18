// test/pipeline/mapping-assertions.test.ts —— 映射级自定义断言在合并时执行（ADR-0026）：发布带 assertions 的订单映射 → 往源表注入坏数据、同步 →
// 同步后入队的 silver.merge 跑断言 → 合并记录（error 级不通过时这个映射失败、标准层不变，warn 级照常合并）与湖里的 silver._assertion_runs
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { getMapping } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { lit, type MergeRecord } from '../../app/.server/pipeline/merge-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, onLake, publish, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 两位数据工程师；登记电商库、选入全部表、确认水位线并同步一次 */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id };
}

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  city: city
`;

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
`;

/** 往源表写数据后同步并跑完同步后的合并，返回这次的合并任务 */
async function syncAndMerge(acme: string, id: string, sql: string) {
  await grantOnSource(sql);
  await syncSource(await memberOf(acme, 'de@acme.com'), id);
  await drain();
  const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
  return { ...merge, records: (merge.result as { mappings: MergeRecord[] }).mappings };
}

const orderCount = async (acme: string) => Number((await onLake<{ n: string }>(acme, `SELECT count(*)::VARCHAR AS n FROM silver."order"`))[0].n);

/** 湖里某个任务的断言运行记录 */
const assertionRuns = (acme: string, taskId: string) => onLake<{ entity: string; rows: string; assertions: string }>(acme, `
  SELECT entity, rows::VARCHAR AS rows, assertions::VARCHAR AS assertions FROM silver._assertion_runs WHERE task_id = ${lit(taskId)} ORDER BY entity`);

const NEW_CUSTOMER = `INSERT INTO shop.customers (name, city, created_at, updated_at) VALUES ('新客', '北京', now(), now() + INTERVAL '1 day');`;
const NEGATIVE_ORDERS = `INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (1, -5, 'paid', now()), (2, -7.5, 'paid', now());`;

describe('合并时执行映射的自定义断言', () => {
  it('error 级不通过：这个映射合并失败、标准层没有新行，原因只带断言名与行数；同一任务里别的映射照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, `${ORDERS}assertions:\n  - { field: amount, check: range, min: 0, level: error }\n`);
    expect(await orderCount(acme)).toBe(100);

    const merge = await syncAndMerge(acme, id, NEW_CUSTOMER + NEGATIVE_ORDERS);
    expect(merge.status).toBe('failed');
    const failed = merge.records.find(r => r.mapping === orders)!;
    expect(failed).toMatchObject({ error: '自定义断言 custom:amount:range 不通过：2 行' });
    expect('error' in failed && failed.error).not.toMatch(/-5|-7\.5/);
    expect(await orderCount(acme)).toBe(100);
    expect(merge.records.find(r => r.mapping === customers)).toMatchObject({ mode: 'incremental', inserted: 1 });
    expect(await assertionRuns(acme, merge.id)).toEqual([]);
    expect(await onLake(acme, `SELECT * FROM silver._quarantine`)).toEqual([]);
  });

  it('warn 级不通过：照常合并，合并记录与 silver._assertion_runs 都带自定义断言的结果', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, `${ORDERS}assertions:
  - { field: amount, check: range, min: 0, level: warn }
  - { field: status, check: not_null, level: error }
`);
    const merge = await syncAndMerge(acme, id, NEGATIVE_ORDERS);
    expect(merge.status).toBe('succeeded');
    expect(await orderCount(acme)).toBe(102);
    const results = [
      { name: 'custom:amount:range', level: 'warn', entity: 'order', failed: 2, detail: 'amount' },
      { name: 'custom:status:not_null', level: 'error', entity: 'order', failed: 0, detail: 'status' },
    ];
    expect(merge.records[0]).toMatchObject({ mapping: orders, inserted: 2, assertions: results });
    expect((await getMapping(author, orders)).merge.history[0]).toMatchObject({ assertions: results });

    const runs = await assertionRuns(acme, merge.id);
    expect(runs.map(r => [r.entity, r.rows])).toEqual([['order', '102']]);
    expect(JSON.parse(runs[0].assertions)).toEqual(results);
  });

  it('unique 查的是这个映射合并后的全部行，不只是本批新行；没写 assertions 的映射合并结果不带断言、不写运行记录', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, `${ORDERS}assertions:\n  - { field: amount, check: unique, level: warn }\n`);
    // 种子订单的金额 11..110 各不相同
    const [first] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect((first.result as { mappings: MergeRecord[] }).mappings[0]).toMatchObject({ assertions: [expect.objectContaining({ failed: 0 })] });

    // 新的一单金额 50 与上一批的一单重复：本批只有这一行
    const merge = await syncAndMerge(acme, id, NEW_CUSTOMER + `INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (3, 50, 'paid', now());`);
    expect(merge.status).toBe('succeeded');
    expect(merge.records.find(r => r.mapping === orders)).toMatchObject({
      mode: 'incremental', inserted: 1, assertions: [{ name: 'custom:amount:unique', level: 'warn', entity: 'order', failed: 1, detail: 'amount' }],
    });
    const plain = merge.records.find(r => r.mapping === customers)!;
    expect(plain).toMatchObject({ mode: 'incremental', inserted: 1 });
    expect('assertions' in plain).toBe(false);
    expect((await assertionRuns(acme, merge.id)).map(r => r.entity)).toEqual(['order']);
  });
});

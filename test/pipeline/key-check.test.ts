// test/pipeline/key-check.test.ts —— 跨映射主键冲突体检的流水线接缝：checkKeysNow 入队 silver.keycheck → 调度器派发、只读挂载数据湖 → getKeyCheckStatus 读出报告；
// 标准层与合并日志不变（ADR-0024「冲突体检」）
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { checkKeysNow, getKeyCheckStatus, KeyCheckError } from '../../app/.server/key-check';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, mergeUnchecked, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 营销同意：一位消费者一个渠道一行（主键含指向 customer 的 customer_id，按数据源比较）；副本 consents_copy 里 1 号的邮件改成了同意 */
const CONSENTS = `
  CREATE TABLE shop.consents (customer_id int NOT NULL, channel text NOT NULL, opt_in text NOT NULL, update_time timestamp NOT NULL,
    PRIMARY KEY (customer_id, channel));
  INSERT INTO shop.consents VALUES (1, 'sms', 'Y', '2024-06-01 10:00'), (1, 'email', 'N', '2024-06-05 10:00'), (2, 'wechat', 'N', '2024-06-02 10:00');
  CREATE TABLE shop.consents_copy AS SELECT * FROM shop.consents;
  UPDATE shop.consents_copy SET opt_in = 'Y' WHERE channel = 'email';
  GRANT SELECT ON shop.consents, shop.consents_copy TO ${READER.user};`;

/** 把同一个 shop 库登记成两个数据源，都同步完 customers、orders、consents 与 consents_copy；返回两个数据源的 ID */
async function syncedSources() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const ids: string[] = [];
  for (const name of ['电商库', '第二库']) {
    // pgSourceInput 会重建源库，之后再加表
    const input = await pgSourceInput(READER, name);
    await grantOnSource(CONSENTS);
    ids.push((await registerSource(author, input)).id);
  }
  for (const id of ids) await selectAllTables(author, id);
  await drain();
  for (const id of ids) {
    await confirmWatermark(author, id, 'customers', 'updated_at');
    await confirmWatermark(author, id, 'orders', 'order_id');
    await confirmWatermark(author, id, 'consents', 'update_time');
    await confirmWatermark(author, id, 'consents_copy', 'update_time');
    await syncSource(author, id);
  }
  await drain();
  return { acme, author, reviewer, id: ids[0], other: ids[1] };
}

// touch 两个映射的主键重叠：customers 的 id 是 1..40，orders 的 id 是 1..100；
// campaign_id 一边是城市、一边是订单状态，从不一致
const TOUCH_FROM_CUSTOMERS = 'model: 1\nentity: touch\ntable: customers\nfields:\n  touch_id: string(customer_id)\n  campaign_id: city\n';
const TOUCH_FROM_ORDERS = 'model: 1\nentity: touch\ntable: orders\nfields:\n  touch_id: string(order_id)\n  campaign_id: status\n  customer_id: string(customer_id)\n';
const ORDERS = 'model: 1\nentity: order\ntable: orders\nfields:\n  order_id: string(order_id)\n  customer_id: string(customer_id)\n';
const CONSENT = 'model: 1\nentity: consent\ntable: consents\nfields:\n  customer_id: string(customer_id)\n  channel: channel\n  status:\n    expr: opt_in\n    dictionary: { Y: granted, N: revoked }\n';

/** 合并日志的行数 */
async function mergeLogRows(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return Number((await session.con.runAndReadAll('SELECT count(*) AS n FROM silver._merges')).getRowObjectsJson()[0].n);
  } finally {
    session.close();
  }
}

describe('主键冲突体检', () => {
  it('报告每对主键重叠的映射：重叠键数、最多 5 个样本键、字段一致的比例与建议；没有重叠的实体不出现，标准层与合并日志不变', async () => {
    const { acme, author, reviewer, id, other } = await syncedSources();
    const fromCustomers = await publish(author, reviewer, id, TOUCH_FROM_CUSTOMERS);
    const fromOrders = await publish(author, reviewer, id, TOUCH_FROM_ORDERS);
    await publish(author, reviewer, id, ORDERS);
    const consentA = await publish(author, reviewer, id, CONSENT);
    const consentB = await publish(author, reviewer, id, CONSENT.replace('table: consents', 'table: consents_copy'));
    // 另一个数据源的同一批键不算撞上
    await publish(author, reviewer, other, CONSENT);
    // 后发布的 touch 与同源的第二个 consent 映射合并时被独占检查拦下，不查主键再合并一次，模拟检查上线前就已存在的重叠
    expect((await mergeUnchecked(acme, [fromOrders, consentB])).status).toBe('succeeded');
    expect((await silver(acme, 'consent', 'customer_id')).filter(c => c._source === other)).toHaveLength(3);
    const before = { touch: await silver(acme, 'touch', 'touch_id, _mapping'), order: await silver(acme, 'order', 'order_id'), merges: await mergeLogRows(acme) };

    expect((await getKeyCheckStatus(author)).status).toBe('none');
    await checkKeysNow(author);
    await expect(checkKeysNow(author)).rejects.toThrow(KeyCheckError);
    expect((await getKeyCheckStatus(author)).status).toBe('queued');
    await drain();

    const status = await getKeyCheckStatus(author);
    expect(status.status).toBe('succeeded');
    expect(status.checkedAt).not.toBeNull();
    // 只有一个映射的 order 没有重叠，不出现；customer 不参与
    expect(status.entities.map(e => e.entity)).toEqual(['consent', 'touch']);
    const [a, b] = [fromCustomers, fromOrders].sort();
    expect(status.entities.find(e => e.entity === 'touch')).toEqual({
      entity: 'touch',
      bySource: false,
      pairs: [{
        a, b, overlap: 40,
        // 主键按文本排序；customers 的键全在 orders 里，多半是重复接入
        samples: [['1'], ['10'], ['11'], ['12'], ['13']],
        agreement: 0,
        suggestion: 'duplicate',
      }],
    });
    // 主键含指向 customer 的字段：按数据源比较，只有同一个数据源的两个映射撞上；3 个键里 2 个两边的字段全部一致
    const [ca, cb] = [consentA, consentB].sort();
    const consent = status.entities.find(e => e.entity === 'consent')!;
    expect(consent).toMatchObject({ bySource: true, pairs: [{ a: ca, b: cb, overlap: 3, suggestion: 'duplicate' }] });
    expect(consent.pairs).toHaveLength(1);
    expect(consent.pairs[0].agreement).toBeCloseTo(2 / 3);

    expect(await silver(acme, 'touch', 'touch_id, _mapping')).toEqual(before.touch);
    expect(await silver(acme, 'order', 'order_id')).toEqual(before.order);
    expect(await mergeLogRows(acme)).toBe(before.merges);
  });
});

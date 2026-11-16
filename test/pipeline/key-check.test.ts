// test/pipeline/key-check.test.ts —— 跨映射主键冲突体检的流水线接缝：checkKeysNow 入队 silver.keycheck → 调度器派发、只读挂载数据湖 → getKeyCheckStatus 读出报告；
// 标准层与合并日志不变（ADR-0024「冲突体检」）。主键含指向 customer 的字段时按 _customer_source 比较（跨源引用，ADR-0030）；
// 同一合并组的映射对不报，组员与组外映射照报（ADR-0032）
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { checkKeysNow, getKeyCheckStatus, KeyCheckError } from '../../app/.server/key-check';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { runKeyCheck } from '../../app/.server/pipeline/key-check-engine';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { getMapping } from '../../app/.server/mappings';
import { mergeNow } from '../../app/.server/merges';
import { drain, memberOf, mergeUnchecked, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

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

  it('因撞号合并失败的映射从原始层现算比对：报告重叠数、样本键与建议键空间；体检前后标准层与合并日志不变', async () => {
    const { acme, author, reviewer, id } = await syncedSources();
    // 都不写键空间：customers 的键 21..40（20 个），orders 的键 1..30，重叠 21..30。后一个映射发布时合并已因独占失败
    const narrow = await publish(author, reviewer, id, `${TOUCH_FROM_CUSTOMERS}where: customer_id > 20\n`);
    const clashing = await publish(author, reviewer, id, `${TOUCH_FROM_ORDERS}where: order_id <= 30\n`);
    await mergeNow(author);
    await drain();
    expect((await getMapping(author, clashing)).merge.history[0]).toMatchObject({ error: expect.stringContaining('主键 touch_id 跨映射重复') });
    const before = { touch: await silver(acme, 'touch', 'touch_id, _mapping'), merges: await mergeLogRows(acme) };
    // 标准层里只有前一个映射的行：失败的那个一行也没进去
    expect(before.touch).toHaveLength(20);
    expect(new Set(before.touch.map(r => r._mapping))).toEqual(new Set([narrow]));

    await checkKeysNow(author);
    await drain();
    const status = await getKeyCheckStatus(author);
    expect(status.status).toBe('succeeded');
    const [a, b] = [narrow, clashing].sort();
    expect(status.entities).toEqual([{
      entity: 'touch',
      bySource: false,
      pairs: [{
        a, b, overlap: 10,
        samples: [['21'], ['22'], ['23'], ['24'], ['25']],
        // campaign_id 一边是城市、一边是订单状态，从不一致
        agreement: 0,
        suggestion: 'key_space',
      }],
    }]);

    expect(await silver(acme, 'touch', 'touch_id, _mapping')).toEqual(before.touch);
    expect(await mergeLogRows(acme)).toBe(before.merges);
  });

  it('撞号失败的映射现算时带租户盐：两边都映射的敏感扩展列计入一致比例；体检前后标准层与合并日志不变', async () => {
    const { acme, author, reviewer, id } = await syncedSources();
    // 不用 TOUCH_FROM_*：campaign_id 两边永远不一致。两边都映射敏感扩展列 x_ref，取值与各自的键相同，重叠的键（21..30）上两边一致
    const narrow = await publish(author, reviewer, id, 'model: 1\nentity: touch\ntable: customers\nfields:\n  touch_id: string(customer_id)\n'
      + 'extensions:\n  x_ref: { type: string, expr: string(customer_id), sensitive: true }\nwhere: customer_id > 20\n');
    const clashing = await publish(author, reviewer, id, 'model: 1\nentity: touch\ntable: orders\nfields:\n  touch_id: string(order_id)\n'
      + 'extensions:\n  x_ref: { type: string, expr: string(order_id), sensitive: true }\nwhere: order_id <= 30\n');
    await mergeNow(author);
    await drain();
    expect((await getMapping(author, clashing)).merge.history[0]).toMatchObject({ error: expect.stringContaining('主键 touch_id 跨映射重复') });
    const before = { touch: await silver(acme, 'touch', 'touch_id, _mapping'), merges: await mergeLogRows(acme) };
    // 标准层里只有前一个映射的行：失败的那个一行也没进去
    expect(before.touch).toHaveLength(20);
    expect(new Set(before.touch.map(r => r._mapping))).toEqual(new Set([narrow]));

    await checkKeysNow(author);
    await drain();
    const status = await getKeyCheckStatus(author);
    expect(status.status).toBe('succeeded');
    const [a, b] = [narrow, clashing].sort();
    // x_ref 两边按同一个租户盐哈希，现算一侧与标准层里的值可以直接比较：10 个重叠的键全部一致
    expect(status.entities).toEqual([{
      entity: 'touch',
      bySource: false,
      pairs: [{ a, b, overlap: 10, samples: [['21'], ['22'], ['23'], ['24'], ['25']], agreement: 1, suggestion: 'drop_one' }],
    }]);

    expect(await silver(acme, 'touch', 'touch_id, _mapping')).toEqual(before.touch);
    expect(await mergeLogRows(acme)).toBe(before.merges);
  });

  it('撞号失败的映射一边的键全在另一边里时建议合并组', async () => {
    const { acme, author, reviewer, id } = await syncedSources();
    // 都不带 where：customers 的键 1..40 全在 orders 的 1..100 里，后一个映射合并失败、一行也没进标准层
    const kept = await publish(author, reviewer, id, TOUCH_FROM_CUSTOMERS);
    const clashing = await publish(author, reviewer, id, TOUCH_FROM_ORDERS);
    await mergeNow(author);
    await drain();
    expect((await getMapping(author, clashing)).merge.history[0]).toMatchObject({ error: expect.stringContaining('主键 touch_id 跨映射重复') });
    const touchRows = await silver(acme, 'touch', 'touch_id, _mapping');
    expect(touchRows).toHaveLength(40);
    expect(new Set(touchRows.map(r => r._mapping))).toEqual(new Set([kept]));

    await checkKeysNow(author);
    await drain();

    const touch = (await getKeyCheckStatus(author)).entities.find(e => e.entity === 'touch');
    expect(touch).toMatchObject({ bySource: false, pairs: [{ overlap: 40, suggestion: 'duplicate' }] });
  });

  it('主键含 customer_id 的实体按 _customer_source 比较：两个数据源都指向电商库的同一批消费者时报冲突', async () => {
    const { author, reviewer, id, other } = await syncedSources();
    await publish(author, reviewer, id, 'model: 1\nentity: customer\ntable: customers\nfields:\n  customer_id: string(customer_id)\n');
    const local = await publish(author, reviewer, id, CONSENT);
    const cross = await publish(author, reviewer, other,
      CONSENT.replace('  customer_id: string(customer_id)\n', '  customer_id: { expr: string(customer_id), customer_source: 电商库 }\n'));
    await checkKeysNow(author);
    await drain();

    const [a, b] = [local, cross].sort();
    const consent = (await getKeyCheckStatus(author)).entities.find(e => e.entity === 'consent');
    expect(consent).toMatchObject({ bySource: true, pairs: [{ a, b, overlap: 3, suggestion: 'duplicate' }] });
  });

  it('同一合并组的映射对不报，组员与组外映射的重叠照报', async () => {
    const { acme, author, reviewer, id, other } = await syncedSources();
    const fromCustomers = await publish(author, reviewer, id, TOUCH_FROM_CUSTOMERS);
    const fromOrders = await publish(author, reviewer, id, TOUCH_FROM_ORDERS);
    // 组外的第三个映射（另一个数据源）只有 1..3 号订单，与两个组员都重叠
    const outsider = await publish(author, reviewer, other, `${TOUCH_FROM_ORDERS}where: order_id <= 3\n`);
    expect((await mergeUnchecked(acme, [fromOrders, outsider])).status).toBe('succeeded');

    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      const columns = ['touch_id', 'campaign_id'];
      // 这几条映射都没有 plan（不会现算），盐用空串
      const result = await runKeyCheck(session.con, { entities: [{
        entity: 'touch', key: ['touch_id'], bySource: false,
        mappings: [{ mapping: fromCustomers, columns, group: 'g1' }, { mapping: fromOrders, columns, group: 'g1' }, { mapping: outsider, columns }],
      }] }, '');
      const pairs = result.entities[0].pairs.map(p => [[p.a, p.b].sort(), p.overlap, p.suggestion]);
      expect(pairs.sort()).toEqual([[[fromCustomers, outsider].sort(), 3, 'duplicate'], [[fromOrders, outsider].sort(), 3, 'duplicate']].sort());
    } finally {
      session.close();
    }
  });
});

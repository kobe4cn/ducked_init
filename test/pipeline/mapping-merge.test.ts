// test/pipeline/mapping-merge.test.ts —— 映射与标准层合并的流水线接缝（合并语义）：同步到原始层 → 编写映射草稿 → 另一位成员发布 → 调度器派发合并 → 标准层；
// 表达式、值字典、时区转换与扩展字段，源端的新增、更新与删除随同步后的合并进入标准层，去重键与取最新规则、行过滤，跨映射的主键冲突（ADR-0015、0024）
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { createMapping, enqueueMerge, getMapping, mergeNow, publishMapping } from '../../app/.server/mappings';
import type { MergeMappingParam, MergeRecord } from '../../app/.server/pipeline/merge-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { drain, publish, silver } from './fixtures';
import { grantOnSource } from './source-fixtures';
import {
  CONSENTS_COPY, syncedSource, syncAllTables, CUSTOMERS, ORDERS, ORDER_LOG_MAPPING, POINT_LOGS_MAPPING, CONSENTS_MAPPING, PREFERENCES_MAPPING, COUPON_TEMPLATES_MAPPING, COUPONS_MAPPING, withEnv, events,
} from './mapping-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('发布映射并合并到标准层', () => {
  it('已发布的映射把原始层合并成标准实体：表达式、值字典、时区转换与扩展字段都生效', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const orders = await createMapping(author, id, ORDERS);
    await publishMapping(reviewer, orders.id, 1);
    await drain();

    const customers = await silver(acme, 'customer', 'customer_id::INT');
    expect(customers).toHaveLength(40);
    expect(customers[0]).toMatchObject({
      customer_id: '1', city: '上海', _source: id, _version: 1,
      // 敏感字段只存加盐哈希（见 pii.test.ts）
      name: expect.stringMatching(/^[0-9a-f]{64}$/), email: expect.stringMatching(/^[0-9a-f]{64}$/),
      // 源端 2024-01-02 00:00 是北京时间
      registered_at: '2024-01-01 16:00:00+00', updated_at: '2024-06-01 01:00:00+00',
      // 没映射的标准字段为空
      phone: null, gender: null,
    });
    const order = await silver(acme, 'order', 'order_id::INT');
    expect(order).toHaveLength(100);
    expect(order[0]).toMatchObject({ order_id: '1', customer_id: '2', amount: '11.00', status: 'refunded', x_amount_fen: '1100' });
    expect(new Set(order.map(o => o.status))).toEqual(new Set(['paid', 'refunded']));
  });

  it('积分流水：变动类型按值字典对应，变动积分保留正负，没有关联订单与到期时间的行为空', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, POINT_LOGS_MAPPING);
    const rows = await silver(acme, 'points_transaction', 'points_transaction_id::INT');
    expect(rows.map(r => [r.points_transaction_id, r.change_type, r.points_change, r.balance_after])).toEqual([
      ['1', 'earn', '200', '200'], ['2', 'spend', '-50', '150'], ['3', 'redeem', '-100', '50'], ['4', 'expire', '-30', '0'], ['5', 'adjust', '20', '20'],
    ]);
    expect(rows[0]).toMatchObject({
      customer_id: '1', membership_id: 'M001', order_id: 'NO1', _source: id,
      // 源端是北京时间
      occurred_at: '2024-06-01 02:00:00+00', expires_at: '2025-06-01 02:00:00+00',
    });
    expect(rows[2]).toMatchObject({ order_id: null, expires_at: null });
  });

  it('营销同意：渠道与同意状态按值字典对应，一位消费者一个渠道一行，没同意过或没撤回过的时间为空', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CONSENTS_MAPPING);
    const consents = await silver(acme, 'consent', 'customer_id, channel');
    expect(consents.map(r => [r.customer_id, r.channel, r.status, r.granted_at, r.revoked_at])).toEqual([
      // 源端是北京时间
      ['1', 'email', 'revoked', '2024-06-01 02:00:00+00', '2024-06-05 02:00:00+00'],
      ['1', 'sms', 'granted', '2024-06-01 02:00:00+00', null],
      ['2', 'wechat', 'revoked', null, '2024-06-02 02:00:00+00'],
    ]);
    expect(consents[0]).toMatchObject({ updated_at: '2024-06-05 02:00:00+00', _source: id });
  });

  it('兴趣偏好：按消费者 + 偏好类型 + 偏好值去重，同一类型下的多个值各占一行', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, PREFERENCES_MAPPING);
    const preferences = await silver(acme, 'preference', 'customer_id, preference_type, preference_value');
    expect(preferences.map(r => [r.customer_id, r.preference_type, r.preference_value])).toEqual([
      ['1', 'category', '彩妆'], ['1', 'category', '护肤'], ['2', 'brand', '自有品牌'],
    ]);
  });

  it('券模板：券类型按值字典对应，面额与门槛从分换成元，不适用的为空', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, COUPON_TEMPLATES_MAPPING);
    const templates = await silver(acme, 'coupon_template', 'coupon_template_id');
    expect(templates.map(r => [r.coupon_template_id, r.name, r.coupon_type, r.face_value, r.pay_percent, r.min_spend])).toEqual([
      ['TPL01', '满100减20', 'cash', '20.00', null, '100.00'],
      ['TPL02', '87.5折券', 'discount', null, '87.50', null],
      ['TPL03', '免运费券', 'shipping', null, null, null],
    ]);
  });

  it('优惠券：券状态按值字典对应，只有已核销的有核销时间、核销订单与抵扣金额', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, COUPONS_MAPPING);
    const coupons = await silver(acme, 'coupon', 'coupon_id');
    expect(coupons.map(r => [r.coupon_id, r.coupon_template_id, r.campaign_id, r.customer_id, r.status])).toEqual([
      ['CP01', 'TPL01', 'ACT1', '1', 'redeemed'],
      ['CP02', 'TPL02', null, '1', 'issued'],
      ['CP03', 'TPL03', 'ACT1', '2', 'expired'],
      ['CP04', 'TPL01', null, '2', 'voided'],
    ]);
    // 源端是北京时间
    expect(coupons[0]).toMatchObject({
      issued_at: '2024-06-01 02:00:00+00', redeemed_at: '2024-06-03 02:00:00+00', order_id: 'NO1', discount_amount: '20.00',
      expires_at: '2024-07-01 02:00:00+00', updated_at: '2024-06-03 02:00:00+00', _source: id,
    });
    expect(coupons[1]).toMatchObject({ redeemed_at: null, order_id: null, discount_amount: null });
  });

  it('同步后的合并把源端的新增、更新与删除带进标准层；没有新批次时合并不改动', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customerMapping = await publish(author, reviewer, id, CUSTOMERS);
      const orderMapping = await publish(author, reviewer, id, ORDERS);

      await grantOnSource(`
        UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;
        DELETE FROM shop.customers WHERE customer_id = 7;
        DELETE FROM shop.orders WHERE order_id = 3;
        INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
      await syncSource(author, id);
      // 同步结束后调度器随即入队合并
      await drain();

      const customers = await silver(acme, 'customer', 'customer_id::INT');
      expect(customers).toHaveLength(39);
      expect(customers.find(c => c.customer_id === '5')).toMatchObject({ city: '成都', updated_at: '2024-07-01 10:00:00+00' });
      expect(customers.find(c => c.customer_id === '7')).toBeUndefined();
      const orders = await silver(acme, 'order', 'order_id::INT');
      expect(orders.map(o => o.order_id)).not.toContain('3');
      expect(orders.find(o => o.order_id === '101')).toMatchObject({ customer_id: '5', amount: '99.00', status: 'paid' });
      expect(orders).toHaveLength(100);

      const [latest] = (await getMapping(author, customerMapping)).merge.history;
      expect(latest).toMatchObject({ mode: 'incremental', batchFrom: 1, updated: 1, deleted: 1, inserted: 0, rows: 39 });
      expect((await getMapping(author, orderMapping)).merge.history[0]).toMatchObject({ inserted: 1, deleted: 1, updated: 0, rows: 100 });

      // 没有新的变更批次：合并什么都不改
      await mergeNow(author);
      await drain();
      expect((await getMapping(author, customerMapping)).merge.history[0]).toMatchObject({ inserted: 0, updated: 0, deleted: 0, rows: 39 });
      expect(await silver(acme, 'customer', 'customer_id::INT')).toEqual(customers);
    });
  });

  it('合并记录带上各步骤的耗时（毫秒，非负），rows 与标准层里本映射的实际行数一致', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const orderMapping = await publish(author, reviewer, id, ORDERS);
      await grantOnSource(`
        DELETE FROM shop.orders WHERE order_id IN (3, 4);
        INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
      await syncSource(author, id);
      await drain();

      const [incremental, rebuild] = (await getMapping(author, orderMapping)).merge.history;
      expect(rebuild).toMatchObject({ mode: 'rebuild', rows: 100 });
      expect(incremental).toMatchObject({ mode: 'incremental', inserted: 1, deleted: 2, rows: 99 });
      expect(await silver(acme, 'order', 'order_id::INT')).toHaveLength(99);
      for (const record of [rebuild, incremental]) {
        expect(Object.keys(record.steps ?? {}).sort()).toEqual([
          'commit', 'deleteInsert', 'ensureTable', 'input', 'keys', 'lastMerge', 'live', 'maxBatch', 'mergeLog', 'records', 'rows', 'transform', 'unique', 'unknownValues',
        ]);
        for (const ms of Object.values(record.steps!)) expect(ms).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it('去重键与取最新规则：源端的重复行只计一次，删除最新的一行后回落到剩下的一行', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      await publish(author, reviewer, id, ORDER_LOG_MAPPING);
      const rows = () => silver(acme, 'order', 'order_id').then(r => r.map(o => [o.order_id, o.status, o.amount, o.updated_at]));
      expect(await rows()).toEqual([
        ['A1', 'refunded', '19.90', '2024-06-03 10:00:00+00'],
        ['A2', 'paid', '5.00', '2024-06-02 10:00:00+00'],
      ]);

      await grantOnSource(`DELETE FROM shop.order_log WHERE status = '已退款'; DELETE FROM shop.order_log WHERE order_no = 'A2';`);
      await syncSource(author, id);
      await drain();
      expect(await rows()).toEqual([['A1', 'paid', '19.90', '2024-06-01 10:00:00+00']]);
    });
  });

  it('行过滤 where：只合并满足条件的源记录，取值为空算不满足，过滤掉的行数记进合并记录', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, `${CUSTOMERS}where: email is not null\n`);
    const customers = await silver(acme, 'customer', 'customer_id::INT');
    expect(customers).toHaveLength(30);
    expect(customers.every(c => c.email !== null)).toBe(true);
    expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 30, filtered: 10 });
  });

  it('行过滤 where：记录更新后不再满足条件时，增量合并删掉它在标准层的行并回落到同去重键的其他记录', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const mapping = await publish(author, reviewer, id, `${ORDER_LOG_MAPPING}where: status <> '作废'\n`);
      const rows = () => silver(acme, 'order', 'order_id').then(r => r.map(o => [o.order_id, o.status, o.updated_at]));
      expect(await rows()).toEqual([['A1', 'refunded', '2024-06-03 10:00:00+00'], ['A2', 'paid', '2024-06-02 10:00:00+00']]);

      // 「作废」不在值字典里：先过滤，不会让合并失败
      await grantOnSource(`UPDATE shop.order_log SET status = '作废', updated_at = '2024-06-04 10:00' WHERE status = '已退款';`);
      await syncSource(author, id);
      await drain();
      expect(await rows()).toEqual([['A1', 'paid', '2024-06-01 10:00:00+00'], ['A2', 'paid', '2024-06-02 10:00:00+00']]);
      expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'incremental', updated: 1, filtered: 1 });
    });
  });

  it('值字典里没有的取值让这个映射合并失败（不悄悄写入），其他映射照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const broken = await createMapping(author, id, ORDER_LOG_MAPPING.replace(', 已退款: refunded', ''));
    await publishMapping(reviewer, broken.id, 1);
    await drain();

    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('failed');
    expect(merge.error).toMatch(/字段 status 有值字典里没有的取值：'已退款'（1 行）/);
    expect((await getMapping(author, broken.id)).merge.history[0]).toMatchObject({ error: expect.stringContaining('已退款') });
    expect(await silver(acme, 'customer', 'customer_id::INT')).toHaveLength(40);
  });

  it('源端把映射引用的列改成文本（没有行变化）：同步后这个映射合并失败、报错写明列名；之后每次合并都失败，其他实体照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    // customer_id 改成文本：写成文本后取值不变，这张表本次没有写入行；改成 VARCHAR 不算放宽（表达式按原类型写）
    await grantOnSource('ALTER TABLE shop.orders ALTER COLUMN customer_id TYPE text;');
    await syncSource(author, id);
    await drain();
    const [sync] = (await listTasks(acme)).filter(t => t.kind === 'source.sync');
    expect((sync.result as { tables: { table: string; rows: number }[] }).tables.find(t => t.table === 'orders')).toMatchObject({ rows: 0 });

    const failed = async () => ((await getMapping(author, orders)).merge.history[0] as { error: string }).error;
    expect(await failed()).toMatch(/^映射引用的源列 customer_id 的类型由 INTEGER 改成了 VARCHAR：/);
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);

    await grantOnSource(`UPDATE shop.customers SET city = '杭州', updated_at = '2024-07-01' WHERE customer_id = 1;`);
    await syncSource(author, id);
    await drain();
    expect((await getMapping(author, customers)).merge.history[0]).not.toHaveProperty('error');
    expect((await silver(acme, 'customer', 'customer_id::INT')).find(c => c.customer_id === '1')).toMatchObject({ city: '杭州' });
    expect(await failed()).toContain('customer_id');
  });

  it('order 是内置 ref 的终点：order_id 与已有映射重叠的映射合并失败；customer 不查，主键重叠照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    // customers 表的 customer_id 1..40 与 orders 表的 order_id 1..100 重叠
    const clash = await publish(author, reviewer, id, 'model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\n');
    expect((await getMapping(author, clash)).merge.history[0]).toMatchObject({
      error: expect.stringContaining(`主键 order_id 跨映射重复：1（映射 ${[orders, clash].sort().join('、')}）`),
    });
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);

    const again = await publish(author, reviewer, id, 'model: 1\nentity: customer\ntable: orders\nfields:\n  customer_id: string(customer_id)\n');
    expect((await getMapping(author, again)).merge.history[0]).not.toHaveProperty('error');
    expect((await silver(acme, 'customer', 'customer_id::INT')).filter(c => c.customer_id === '1').map(c => c._mapping).sort())
      .toEqual([customers, again].sort());
  });

  it('不被关系指向的 event 也跨映射查主键：event_id 与已有映射重叠的映射合并失败，列出冲突的键与映射，标准层不变', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const fromOrders = await publish(author, reviewer, id, events('orders', 'order_id'));
    const before = await silver(acme, 'event', 'event_id::INT');
    expect(before).toHaveLength(100);
    // customers 表的 customer_id 1..40 全在 orders 表的 order_id 1..100 里
    const clash = await publish(author, reviewer, id, events('customers', 'customer_id'));
    const { error } = (await getMapping(author, clash)).merge.history[0] as { error: string };
    expect(error).toContain(`主键 event_id 跨映射重复：1（映射 ${[fromOrders, clash].sort().join('、')}）；10（映射`);
    expect(error).toContain('共 40 个');
    expect(await silver(acme, 'event', 'event_id::INT')).toEqual(before);
  });

  it('一次合并里不同实体的映射并行、同一实体的串行，合并记录按入队的映射顺序', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    await publish(author, reviewer, id, ORDERS);
    await publish(author, reviewer, id, events('orders', 'order_id'));
    await publish(author, reviewer, id, events('order_log', 'order_no', 'dedupe:\n  key: [event_id]\n'));
    const task = await getDb().transaction(tx => enqueueMerge(tx, acme, undefined, { rebuild: true }));
    await drain();

    const merge = (await listTasks(acme)).find(t => t.id === task!.id)!;
    expect(merge.status).toBe('succeeded');
    const records = (merge.result as { mappings: MergeRecord[] }).mappings;
    expect(records.map(r => r.mapping)).toEqual((task!.params.mappings as MergeMappingParam[]).map(p => p.mapping));
    expect(records.every(r => 'mode' in r && r.mode === 'rebuild')).toBe(true);
    const span = (r: MergeRecord) => [Date.parse(r.startedAt), Date.parse(r.startedAt) + r.durationMs];
    const overlaps = (a: MergeRecord, b: MergeRecord) => span(a)[0] < span(b)[1] && span(b)[0] < span(a)[1];
    const [first, second] = records.filter(r => r.entity === 'event');
    expect(overlaps(first, second)).toBe(false);
    const byEntity = (entity: string) => records.find(r => r.entity === entity)!;
    // 各实体的队列同时开跑，每条队列的第一个映射互相重叠
    expect(overlaps(byEntity('customer'), byEntity('order'))).toBe(true);
    expect(overlaps(byEntity('customer'), first)).toBe(true);
  });

  it('增量合并新增了和其他映射冲突的主键：这次合并失败，报错格式与全量时一样，标准层不变', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const fromOrders = await publish(author, reviewer, id, events('orders', 'order_id'));
    const fromLog = await publish(author, reviewer, id, events('order_log', 'order_no', 'dedupe:\n  key: [event_id]\n'));
    expect((await getMapping(author, fromLog)).merge.history[0]).not.toHaveProperty('error');
    const before = await silver(acme, 'event', 'event_id');
    expect(before).toHaveLength(102);

    // 订单流水新增的 7、8 与 orders 表的 order_id 重叠
    await grantOnSource(`INSERT INTO shop.order_log VALUES ('7', '已支付', 100, '2024-06-04 10:00'), ('8', '已支付', 100, '2024-06-04 10:00');`);
    await syncSource(author, id);
    await drain();
    const mappings = [fromOrders, fromLog].sort().join('、');
    expect((await getMapping(author, fromLog)).merge.history[0]).toMatchObject({
      error: expect.stringContaining(`主键 event_id 跨映射重复：7（映射 ${mappings}）；8（映射 ${mappings}）。如果两边的编号各自独立`),
    });
    expect(await silver(acme, 'event', 'event_id')).toEqual(before);
  });

  it('同一个映射内部主键重复（去重键与主键不同）不算跨映射重复，照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, events('customers', 'customer_id', 'key_space: crm\n'));
    // 一位消费者有多笔订单：event_id 取 customer_id，按 (event_id, page) 去重后同一个 event_id 有多行
    const fromOrders = await publish(author, reviewer, id, events('orders', 'customer_id', '  page: string(order_id)\ndedupe:\n  key: [event_id, page]\n'));
    expect((await getMapping(author, fromOrders)).merge.history[0]).not.toHaveProperty('error');
    const rows = (await silver(acme, 'event', 'event_id, page')).filter(e => e._mapping === fromOrders);
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map(e => e.event_id)).size).toBeLessThan(100);
  });

  it('映射用去重键、没映射实体主键时照常合并：主键全为空，不算跨映射重复', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, events('orders', 'order_id'));
    const pages = await publish(author, reviewer, id, 'model: 1\nentity: event\ntable: order_log\nfields:\n  page: order_no\ndedupe:\n  key: [page]\n');
    expect((await getMapping(author, pages)).merge.history[0]).not.toHaveProperty('error');
    const rows = (await silver(acme, 'event', 'event_id, page')).filter(e => e._mapping === pages);
    expect(rows.map(e => [e.event_id, e.page])).toEqual([[null, 'A1'], [null, 'A2']]);
  });

  it('consent 的主键含指向 customer 的 customer_id：两个数据源有相同的 (customer_id, channel) 照常合并，同一数据源的两个映射重复时后合并的失败', async () => {
    const { acme, author, reviewer, id, input } = await syncedSource(CONSENTS_COPY);
    await confirmWatermark(author, id, 'consents_copy', 'update_time');
    await syncSource(author, id);
    await drain();
    const { id: other } = await registerSource(author, { ...input, name: '第二库' });
    await syncAllTables(author, other);
    const first = await publish(author, reviewer, id, CONSENTS_MAPPING);
    const elsewhere = await publish(author, reviewer, other, CONSENTS_MAPPING);
    expect((await getMapping(author, elsewhere)).merge.history[0]).not.toHaveProperty('error');
    const before = await silver(acme, 'consent', 'customer_id, channel, _source');
    expect(before.map(c => c._source).sort()).toEqual([id, id, id, other, other, other].sort());

    const clash = await publish(author, reviewer, id, CONSENTS_MAPPING.replace('table: consents', 'table: consents_copy'));
    expect((await getMapping(author, clash)).merge.history[0]).toMatchObject({
      error: expect.stringContaining(`主键 customer_id、channel 跨映射重复：1, email（映射 ${[first, clash].sort().join('、')}）`),
    });
    // 主键按数据源比较的实体建不了合并组，只提键空间与体检
    const { error } = (await getMapping(author, clash)).merge.history[0] as { error: string };
    expect(error).toContain('键空间');
    expect(error).toContain('主键冲突体检');
    expect(error).not.toContain('合并组');
    expect(await silver(acme, 'consent', 'customer_id, channel, _source')).toEqual(before);
  });
});

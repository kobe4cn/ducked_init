// 映射与标准层合并的流水线接缝：同步到原始层 → 编写映射草稿 → 另一位成员发布 → 调度器派发合并 → 标准层；
// 之后源端的新增、更新与删除随同步后的合并进入标准层，去重键与取最新规则让源端的重复行只计一次；漂移检查报告缺列时，重建合并补上标准层缺的列
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, mappingVersions, tasks, tenants } from '../../app/.server/db/schema';
import { createMapping, enqueueDueMerges, getMapping, MappingError, mergeAfterSync, mergeMapping, mergeNow, publishMapping, rebuildEntity, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/**
 * 没有主键的订单流水：同一订单的多个版本（含完全相同的重复行），状态是中文
 */
const ORDER_LOG = `
  CREATE TABLE shop.order_log (order_no text NOT NULL, status text NOT NULL, amount_fen int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.order_log VALUES
    ('A1', '已支付', 1990, '2024-06-01 10:00'), ('A1', '已支付', 1990, '2024-06-01 10:00'),
    ('A1', '已退款', 1990, '2024-06-03 10:00'), ('A2', '已支付', 500, '2024-06-02 10:00');
  GRANT SELECT ON shop.order_log TO ${READER.user};`;

/** 带主键的积分流水：变动类型是中文，变动积分带正负，只有部分行有关联订单与到期时间 */
const POINT_LOGS = `
  CREATE TABLE shop.point_logs (id serial PRIMARY KEY, customer_id int NOT NULL, member_no text NOT NULL, change_type text NOT NULL,
    points int NOT NULL, balance int NOT NULL, order_no text, created_at timestamp NOT NULL, expire_time timestamp);
  INSERT INTO shop.point_logs (customer_id, member_no, change_type, points, balance, order_no, created_at, expire_time) VALUES
    (1, 'M001', '获得', 200, 200, 'NO1', '2024-06-01 10:00', '2025-06-01 10:00'),
    (1, 'M001', '消费', -50, 150, 'NO2', '2024-06-02 10:00', NULL),
    (1, 'M001', '兑换', -100, 50, NULL, '2024-06-03 10:00', NULL),
    (2, 'M002', '过期', -30, 0, NULL, '2024-06-04 10:00', NULL),
    (2, 'M002', '调整', 20, 20, NULL, '2024-06-05 10:00', NULL);
  GRANT SELECT ON shop.point_logs TO ${READER.user};`;

/** 营销同意：一位消费者一个渠道一行，渠道与同意状态要按值字典对应；一开始就拒绝的没有同意时间 */
const CONSENTS = `
  CREATE TABLE shop.consents (customer_id int NOT NULL, channel text NOT NULL, opt_in text NOT NULL,
    agree_time timestamp, revoke_time timestamp, update_time timestamp NOT NULL, PRIMARY KEY (customer_id, channel));
  INSERT INTO shop.consents VALUES
    (1, '短信', 'Y', '2024-06-01 10:00', NULL, '2024-06-01 10:00'),
    (1, '邮件', 'N', '2024-06-01 10:00', '2024-06-05 10:00', '2024-06-05 10:00'),
    (2, '微信', 'N', NULL, '2024-06-02 10:00', '2024-06-02 10:00');
  GRANT SELECT ON shop.consents TO ${READER.user};`;

/** 兴趣偏好：自增主键，一行一个键值，同一类型下可有多个值 */
const PREFERENCES = `
  CREATE TABLE shop.preferences (id serial PRIMARY KEY, customer_id int NOT NULL, pref_type text NOT NULL, pref_value text NOT NULL,
    updated_at timestamp NOT NULL);
  INSERT INTO shop.preferences (customer_id, pref_type, pref_value, updated_at) VALUES
    (1, 'category', '护肤', '2024-06-01 10:00'), (1, 'category', '彩妆', '2024-06-01 10:00'), (2, 'brand', '自有品牌', '2024-06-02 10:00');
  GRANT SELECT ON shop.preferences TO ${READER.user};`;

/** 券模板：字符串主键，券类型是中文，面额与门槛以分为单位，不适用的为空 */
const COUPON_TEMPLATES = `
  CREATE TABLE shop.coupon_templates (template_id text PRIMARY KEY, title text NOT NULL, coupon_type text NOT NULL,
    face_value_fen int, pay_rate numeric(5, 2), threshold_fen int);
  INSERT INTO shop.coupon_templates VALUES
    ('TPL01', '满100减20', '满减', 2000, NULL, 10000), ('TPL02', '87.5折券', '折扣', NULL, 87.5, NULL), ('TPL03', '免运费券', '免运费', NULL, NULL, NULL);
  GRANT SELECT ON shop.coupon_templates TO ${READER.user};`;

/** 优惠券：券码作主键，状态是中文，只有已使用的有核销时间、核销订单与抵扣金额（以分为单位） */
const COUPONS = `
  CREATE TABLE shop.coupons (coupon_code text PRIMARY KEY, template_id text NOT NULL, activity_id text, user_id int NOT NULL,
    status text NOT NULL, receive_time timestamp NOT NULL, use_time timestamp, order_no text, discount_fen int,
    expire_time timestamp NOT NULL, update_time timestamp NOT NULL);
  INSERT INTO shop.coupons VALUES
    ('CP01', 'TPL01', 'ACT1', 1, '已使用', '2024-06-01 10:00', '2024-06-03 10:00', 'NO1', 2000, '2024-07-01 10:00', '2024-06-03 10:00'),
    ('CP02', 'TPL02', NULL, 1, '未使用', '2024-06-02 10:00', NULL, NULL, NULL, '2024-07-02 10:00', '2024-06-02 10:00'),
    ('CP03', 'TPL03', 'ACT1', 2, '已过期', '2024-06-01 10:00', NULL, NULL, NULL, '2024-07-01 10:00', '2024-07-01 10:00'),
    ('CP04', 'TPL01', NULL, 2, '已作废', '2024-06-01 10:00', NULL, NULL, NULL, '2024-07-01 10:00', '2024-06-05 10:00');
  GRANT SELECT ON shop.coupons TO ${READER.user};`;

/** 两位数据工程师：一位起草、一位发布。登记数据源、选入全部表、确认水位线并同步一次 */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const input = await pgSourceInput(READER);
  await grantOnSource(ORDER_LOG + POINT_LOGS + CONSENTS + PREFERENCES + COUPON_TEMPLATES + COUPONS);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
  await confirmWatermark(author, id, 'order_log', 'updated_at');
  await confirmWatermark(author, id, 'point_logs', 'id');
  await confirmWatermark(author, id, 'consents', 'update_time');
  await confirmWatermark(author, id, 'preferences', 'updated_at');
  await confirmWatermark(author, id, 'coupons', 'update_time');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id, input };
}

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  city: city
  registered_at: from_timezone(created_at, 'Asia/Shanghai')
  updated_at: updated_at
`;

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
extensions:
  x_amount_fen: { type: integer, expr: amount * 100 }
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
    dictionary: { 已支付: paid, 已退款: refunded }
dedupe:
  key: [order_id]
  latest: updated_at
`;

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

const CONSENTS_MAPPING = `model: 1
entity: consent
table: consents
fields:
  customer_id: string(customer_id)
  channel:
    expr: channel
    dictionary: { 短信: sms, 邮件: email, 微信: wechat }
  status:
    expr: opt_in
    dictionary: { Y: granted, N: revoked }
  granted_at: from_timezone(agree_time, 'Asia/Shanghai')
  revoked_at: from_timezone(revoke_time, 'Asia/Shanghai')
  updated_at: from_timezone(update_time, 'Asia/Shanghai')
`;

const PREFERENCES_MAPPING = `model: 1
entity: preference
table: preferences
fields:
  customer_id: string(customer_id)
  preference_type: pref_type
  preference_value: pref_value
  updated_at: from_timezone(updated_at, 'Asia/Shanghai')
`;

const COUPON_TEMPLATES_MAPPING = `model: 1
entity: coupon_template
table: coupon_templates
fields:
  coupon_template_id: template_id
  name: title
  coupon_type:
    expr: coupon_type
    dictionary: { 满减: cash, 折扣: discount, 免运费: shipping }
  face_value: face_value_fen / 100
  pay_percent: pay_rate
  min_spend: threshold_fen / 100
`;

const COUPONS_MAPPING = `model: 1
entity: coupon
table: coupons
fields:
  coupon_id: coupon_code
  coupon_template_id: template_id
  campaign_id: activity_id
  customer_id: string(user_id)
  status:
    expr: status
    dictionary: { 已使用: redeemed, 未使用: issued, 已过期: expired, 已作废: voided }
  issued_at: from_timezone(receive_time, 'Asia/Shanghai')
  redeemed_at: from_timezone(use_time, 'Asia/Shanghai')
  order_id: order_no
  discount_amount: discount_fen / 100
  expires_at: from_timezone(expire_time, 'Asia/Shanghai')
  updated_at: from_timezone(update_time, 'Asia/Shanghai')
`;

/** 合并任务带的映射（按映射 ID 排序） */
const mergedMappings = (task: { params: unknown }) => ((task.params as { mappings: { mapping: string }[] }).mappings).map(m => m.mapping).sort();

/** 在 fn 执行期间设置环境变量（调度器派发的工作进程继承它） */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

  it('写了兜底值时值字典里没有的取值写成兜底值，合并照常完成，并记下落入兜底的取值与行数', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, ORDER_LOG_MAPPING
      .replace(', 已退款: refunded', '')
      .replace('    expr: trim(status)\n', '    expr: trim(status)\n    otherwise: cancelled\n'));

    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('succeeded');
    expect((await silver(acme, 'order', 'order_id')).map(o => [o.order_id, o.status])).toEqual([['A1', 'cancelled'], ['A2', 'paid']]);
    // 统计的是源表里的行（A1 的两行已支付是重复行，各计一次），不是标准层的行
    expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({
      fallback: [{ column: 'status', values: [{ value: '已退款', rows: 1 }], distinct: 1, rows: 1 }],
    });
  });

  it('增量合并只统计本次变更的记录落入兜底的取值；没有新批次时不带统计', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, ORDER_LOG_MAPPING
      .replace(', 已退款: refunded', '')
      .replace('    expr: trim(status)\n', '    expr: trim(status)\n    otherwise: null\n'));

    // 新增的两种取值：已关闭是两行完全相同的重复行；之前落入兜底的已退款没有变化，不再计入
    await grantOnSource(`INSERT INTO shop.order_log VALUES
      ('A3', '已关闭', 100, '2024-06-04 10:00'), ('A3', '已关闭', 100, '2024-06-04 10:00'), ('A4', '待审核', 200, '2024-06-05 10:00');`);
    await syncSource(author, id);
    await drain();
    const incremental = (await getMapping(author, mapping)).merge.history[0];
    expect(incremental).toMatchObject({ mode: 'incremental' });
    expect(incremental).toHaveProperty('fallback', [
      { column: 'status', values: [{ value: '已关闭', rows: 2 }, { value: '待审核', rows: 1 }], distinct: 2, rows: 3 },
    ]);
    expect((await silver(acme, 'order', 'order_id')).map(o => [o.order_id, o.status])).toEqual([['A1', null], ['A2', 'paid'], ['A3', null], ['A4', null]]);

    await mergeNow(author);
    await drain();
    const idle = (await getMapping(author, mapping)).merge.history[0];
    expect(idle).toMatchObject({ mode: 'incremental', batchFrom: (incremental as { batchTo: number }).batchTo });
    expect(idle).not.toHaveProperty('fallback');
  });

  it('草稿作者不能自己发布；发布后版本锁定，再改是新的一版草稿，发布新版本后按新版本重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    await expect(publishMapping(author, mapping.id, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('另一位') });
    // 最后保存草稿的成员不能发布
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    await expect(publishMapping(reviewer, mapping.id, 1)).rejects.toBeInstanceOf(MappingError);
    const third = await memberOf(acme, 'admin@acme.com', 'admin');
    await publishMapping(third, mapping.id, 1);
    await drain();
    await expect(publishMapping(third, mapping.id, 1)).rejects.toThrow(/已锁定/);

    expect(await saveDraft(author, mapping.id, CUSTOMERS.replace('city: city', "city: concat(city, '市')"))).toBe(2);
    const detail = await getMapping(author, mapping.id);
    expect(detail.versions.map(v => [v.version, v.status])).toEqual([[2, 'draft'], [1, 'published']]);
    expect(detail.versions[1].yaml).toContain('upper(city)');
    // 草稿不影响标准层
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).toMatchObject({ city: '上海', _version: 1 });

    await publishMapping(reviewer, mapping.id, 2);
    await drain();
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).toMatchObject({ city: '上海市', _version: 2 });
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', version: 2, rows: 40 });
  });

  it('发布者不能是最后保存草稿的人：A 起草、B 修改后 A 能发布，作者仍记下两人', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    // A 再保存后作者顺序不变，最后保存的人换回 A
    await saveDraft(author, mapping.id, CUSTOMERS.replace('city: city', 'city: lower(city)'));
    await expect(publishMapping(author, mapping.id, 1)).rejects.toMatchObject({ status: 403 });
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    await publishMapping(author, mapping.id, 1);
    expect((await getMapping(author, mapping.id)).versions[0]).toMatchObject({ status: 'published', authors: [author.email, reviewer.email], lastEditor: reviewer.email });
  });

  it('发布等锁期间草稿被丢弃时，发布被拒绝并提示刷新', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    let publishing!: Promise<unknown>;
    await getDb().transaction(async tx => {
      await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mapping.id)).for('update');
      publishing = publishMapping(reviewer, mapping.id, 1).then(() => null, (e: unknown) => e);
      // 等发布阻塞在映射行的锁上，再像丢弃草稿那样删掉草稿
      for (let i = 0; i < 100; i++) {
        const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (rows[0].n > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      await tx.delete(mappingVersions).where(eq(mappingVersions.mappingId, mapping.id));
    });
    // 提交后发布才拿到锁
    const error = await publishing;
    expect(error).toBeInstanceOf(MappingError);
    expect((error as MappingError).message).toMatch(/请刷新/);
  });

  it('已被已发布映射引用的表不能移出同步范围；映射引用的字段在源表里没有时不能保存；扩展字段不能换类型', async () => {
    const { author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    await expect(setSyncScope(author, id, { remove: ['customers'] })).rejects.toThrow(/已被已发布的映射引用/);
    await setSyncScope(author, id, { remove: ['regions'] });

    const error = await createMapping(author, id, ORDERS.replace('amount: amount', 'amount: pay_amount')).catch(e => e);
    expect(error).toBeInstanceOf(MappingError);
    expect(error.issues).toEqual([expect.objectContaining({ line: 7, path: 'fields.amount', message: '源表 orders 中没有字段 pay_amount' })]);
    await expect(createMapping(author, id, CUSTOMERS)).rejects.toThrow(/已有到 消费者 的映射/);

    // 扩展字段建好后不改类型：新版本换了类型时不能发布
    const orders = await publish(author, reviewer, id, ORDERS);
    await saveDraft(author, orders, ORDERS.replace('type: integer, expr: amount * 100', 'type: string, expr: string(amount)'));
    await expect(publishMapping(reviewer, orders, 2)).rejects.toThrow(/字段 x_amount_fen 在已发布的映射里是 integer，这里是 string/);
  });

  it('只有映射引用的表同步写入了变更才合并：别的表、别的数据源、没有变更的同步都不合并，定时检查也不补；发布只合并一次', async () => {
    const { acme, author, reviewer, id, input } = await syncedSource();
    const merges = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge').length;
    const mapping = await publish(author, reviewer, id, CUSTOMERS);
    // 发布后合并一次，定时检查不再补
    expect(await merges()).toBe(1);
    expect(await enqueueDueMerges()).toEqual([]);

    // 只改了映射没引用的表
    await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
    await syncSource(author, id);
    await drain();
    // 同步没有写入变更
    await syncSource(author, id);
    await drain();
    // 另一个数据源的同名表写入了变更
    const other = await registerSource(author, { ...input, name: '电商库副本' });
    await setSyncScope(author, other.id, { add: ['customers'] });
    await drain();
    await confirmWatermark(author, other.id, 'customers', 'updated_at');
    await syncSource(author, other.id);
    await drain();
    // 第 2、4 次同步确实写入了变更（任务按新到旧排列）
    const changed = (t: { result: unknown }, table: string) =>
      ((t.result as { tables: { table: string; rows?: number }[] }).tables).some(r => r.table === table && r.rows! > 0);
    const syncs = (await listTasks(acme)).filter(t => t.kind === 'source.sync');
    expect(syncs).toHaveLength(4);
    expect([changed(syncs[0], 'customers'), changed(syncs[1], 'customers') || changed(syncs[1], 'orders'), changed(syncs[2], 'orders')]).toEqual([true, false, true]);
    expect(await merges()).toBe(1);
    expect(await enqueueDueMerges()).toEqual([]);

    // 映射引用的表写入了变更：同步后合并一次
    await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
    await syncSource(author, id);
    await drain();
    expect(await merges()).toBe(2);
    expect(await enqueueDueMerges()).toEqual([]);
    expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'incremental', updated: 1 });

    // 发布时已有合并在排队：新发布的映射补进排队中的那个合并，定时检查不再补
    const queued = await mergeNow(author);
    const orders = await createMapping(author, id, ORDERS);
    const extended = await publishMapping(reviewer, orders.id, 1);
    expect(extended?.id).toBe(queued.id);
    expect(mergedMappings(extended!)).toEqual([mapping, orders.id].sort());
    await drain();
    expect(await merges()).toBe(3);
    expect(await enqueueDueMerges()).toEqual([]);
    expect((await getMapping(author, orders.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 101 });
  });

  it('合并只带受影响的映射：发布只带刚发布的映射，同步只带源表写入了变更的映射，别的映射不新增合并记录', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const mergeTasks = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);
      // 发布订单映射时只合并订单映射
      expect((await mergeTasks()).map(mergedMappings)).toEqual([[orders], [customers]]);
      expect((await getMapping(author, customers)).merge.history).toHaveLength(1);

      await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
      await syncSource(author, id);
      await drain();
      const [latest] = await mergeTasks();
      expect(mergedMappings(latest)).toEqual([orders]);
      expect((await getMapping(author, orders)).merge.history[0]).toMatchObject({ mode: 'incremental', inserted: 1 });
      expect((await getMapping(author, customers)).merge.history).toHaveLength(1);
      expect(await enqueueDueMerges()).toEqual([]);

      // 订单映射发布新版本、合并还在排队时，又一次同步给消费者表写入了变更：消费者映射补进同一个合并
      await saveDraft(author, orders, ORDERS.replace('customer_id: string(customer_id)', 'customer_id: trim(string(customer_id))'));
      const queued = await publishMapping(reviewer, orders, 2);
      expect(mergedMappings(queued!)).toEqual([orders]);
      // 首次同步给全部表写入了变更
      const [firstSync] = (await listTasks(acme)).filter(t => t.kind === 'source.sync').slice(-1);
      const extended = await mergeAfterSync(acme, firstSync.id);
      expect(extended?.id).toBe(queued!.id);
      expect((extended!.params as { mappings: { mapping: string; version: number }[] }).mappings.map(m => [m.mapping, m.version]))
        .toEqual([[customers, 1], [orders, 2]].sort());

      // 手动合并仍带全部映射
      await drain();
      expect(mergedMappings(await mergeNow(author))).toEqual([customers, orders].sort());
    });
  });

  it('合并运行期间同步写入的变更，在它结束后由定时检查补上，只带变更了的映射', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);
      // 让同步能与“运行中”的合并同时进行
      await getDb().update(tenants).set({ maxConcurrentTasks: 2 }).where(eq(tenants.id, acme));
      // 模拟一次正在运行的合并（领取后还没结束）
      const running = await mergeNow(author);
      await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, running.id));

      await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
      await syncSource(author, id);
      await drain();
      // 合并在运行，同步后不入队
      expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge' && t.status === 'queued')).toEqual([]);
      expect(await enqueueDueMerges()).toEqual([]);

      await getDb().update(tasks).set({ status: 'succeeded', finishedAt: sql`now()`, result: { mappings: [] } }).where(eq(tasks.id, running.id));
      expect(await enqueueDueMerges()).toEqual([acme]);
      const [due] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
      expect(mergedMappings(due)).toEqual([customers]);
      await drain();
      expect((await getMapping(author, customers)).merge.history[0]).toMatchObject({ mode: 'incremental', updated: 1 });
      expect((await getMapping(author, orders)).merge.history).toHaveLength(1);
      expect(await enqueueDueMerges()).toEqual([]);
    });
  });

  it('详情页只合并这一个映射：任务只带它、只有它新增合并记录；已有合并在排队时并进去，在运行时提示由定时检查补上', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);

      const task = await mergeMapping(author, customers);
      expect(mergedMappings(task)).toEqual([customers]);
      await drain();
      expect((await getMapping(author, customers)).merge.history).toHaveLength(2);
      expect((await getMapping(author, orders)).merge.history).toHaveLength(1);

      // 已有合并在排队：并进同一个任务
      const queued = await mergeMapping(author, customers);
      const extended = await mergeMapping(author, orders);
      expect(extended.id).toBe(queued.id);
      expect(mergedMappings(extended)).toEqual([customers, orders].sort());

      // 合并在运行：不入队，提示稍后补上
      await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, queued.id));
      await expect(mergeMapping(author, orders)).rejects.toThrow('已有一次合并在运行');
      expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge' && t.status === 'queued')).toEqual([]);

      // 只有草稿的映射、别的租户的映射
      const draft = await createMapping(author, id, ORDER_LOG_MAPPING);
      await expect(mergeMapping(author, draft.id)).rejects.toThrow('这个映射还没有已发布的版本');
      const other = await memberOf(await newTenant('globex'), 'de@globex.com');
      await expect(mergeMapping(other, customers)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('重建合并补上标准层缺的列：只带写入这个实体的映射并都带强制重建标记，行数不变；不带标记的合并补不上；已有合并在排队或运行、没有映射、查看者都被拒', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'customer', 'customer_id::INT');
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run('ALTER TABLE silver.customer DROP COLUMN city');
    } finally {
      session.close();
    }

    // 没有新批次的普通合并提前返回，缺的列补不上
    await mergeMapping(author, customers);
    await drain();
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).not.toHaveProperty('city');

    const task = await rebuildEntity(author, 'customer');
    expect(mergedMappings(task)).toEqual([customers]);
    expect((task.params as { mappings: { rebuild?: boolean }[] }).mappings.every(m => m.rebuild === true)).toBe(true);
    await drain();
    const rebuilt = await silver(acme, 'customer', 'customer_id::INT');
    expect(before[0]).toMatchObject({ customer_id: '1', city: '上海' });
    expect(rebuilt).toEqual(before);

    // 合并在排队或运行、没有映射写入的实体、查看者
    const queued = await rebuildEntity(author, 'customer');
    await expect(rebuildEntity(author, 'customer')).rejects.toThrow('已有一次合并在排队或运行中');
    await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, queued.id));
    await expect(rebuildEntity(author, 'customer')).rejects.toThrow('已有一次合并在排队或运行中');
    await expect(rebuildEntity(author, 'coupon')).rejects.toThrow('没有已发布的映射写入');
    await expect(rebuildEntity(await memberOf(acme, 'v@acme.com', 'viewer'), 'customer')).rejects.toMatchObject({ init: { status: 403 } });
  });
});

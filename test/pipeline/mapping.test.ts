// 映射与标准层合并的流水线接缝：同步到原始层 → 编写映射草稿 → 另一位成员发布 → 调度器派发合并 → 标准层；
// 之后源端的新增、更新与删除随同步后的合并进入标准层，去重键与取最新规则让源端的重复行只计一次
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mappings, mappingVersions } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createMapping, getMapping, MappingError, mergeNow, publishMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 读取本租户标准层某个实体的表（时间按 UTC 文本、金额按文本显示） */
async function silver(tenantId: string, entity: string, orderBy: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    const columns = (await session.con.runAndReadAll(`DESCRIBE silver."${entity}"`)).getRowObjectsJson() as { column_name: string; column_type: string }[];
    // 带时区的时间在会话里按 UTC 转成文本（不交给客户端按本机时区换算）
    const times = columns.filter(c => c.column_type === 'TIMESTAMP WITH TIME ZONE' && c.column_name !== '_merged_at').map(c => `"${c.column_name}"::VARCHAR AS "${c.column_name}"`);
    const reader = await session.con.runAndReadAll(`SELECT * EXCLUDE (_merged_at) REPLACE (_version::INT AS _version${times.map(t => `, ${t}`).join('')})
      FROM silver."${entity}" ORDER BY ${orderBy}`);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    session.close();
  }
}

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

/** 起草并由另一位成员发布，让调度器跑完合并 */
async function publish(author: Awaited<ReturnType<typeof memberOf>>, reviewer: typeof author, sourceId: string, yaml: string) {
  const mapping = await createMapping(author, sourceId, yaml);
  await publishMapping(reviewer, mapping.id, 1);
  await drain();
  return mapping.id;
}

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
      customer_id: '1', name: '消费者1', email: 'user1@example.com', city: '上海', _source: id, _version: 1,
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
});

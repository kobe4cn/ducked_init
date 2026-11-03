// test/pipeline/mapping-fixtures.ts —— 映射与合并测试的夹具（mapping-merge / mapping-rules / mapping-disable 共用）：带订单流水、积分、同意、偏好、券等源表的
// 数据源 syncedSource 与 syncAllTables，各实体的映射 YAML，事件映射 events，合并任务带的映射 mergedMappings，以及临时设环境变量的 withEnv
import type { CurrentMember } from '../../app/.server/auth';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

/**
 * 没有主键的订单流水：同一订单的多个版本（含完全相同的重复行），状态是中文
 */
export const ORDER_LOG = `
  CREATE TABLE shop.order_log (order_no text NOT NULL, status text NOT NULL, amount_fen int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.order_log VALUES
    ('A1', '已支付', 1990, '2024-06-01 10:00'), ('A1', '已支付', 1990, '2024-06-01 10:00'),
    ('A1', '已退款', 1990, '2024-06-03 10:00'), ('A2', '已支付', 500, '2024-06-02 10:00');
  GRANT SELECT ON shop.order_log TO ${READER.user};`;

/** 带主键的积分流水：变动类型是中文，变动积分带正负，只有部分行有关联订单与到期时间 */
export const POINT_LOGS = `
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
export const CONSENTS = `
  CREATE TABLE shop.consents (customer_id int NOT NULL, channel text NOT NULL, opt_in text NOT NULL,
    agree_time timestamp, revoke_time timestamp, update_time timestamp NOT NULL, PRIMARY KEY (customer_id, channel));
  INSERT INTO shop.consents VALUES
    (1, '短信', 'Y', '2024-06-01 10:00', NULL, '2024-06-01 10:00'),
    (1, '邮件', 'N', '2024-06-01 10:00', '2024-06-05 10:00', '2024-06-05 10:00'),
    (2, '微信', 'N', NULL, '2024-06-02 10:00', '2024-06-02 10:00');
  GRANT SELECT ON shop.consents TO ${READER.user};`;

/** 兴趣偏好：自增主键，一行一个键值，同一类型下可有多个值 */
export const PREFERENCES = `
  CREATE TABLE shop.preferences (id serial PRIMARY KEY, customer_id int NOT NULL, pref_type text NOT NULL, pref_value text NOT NULL,
    updated_at timestamp NOT NULL);
  INSERT INTO shop.preferences (customer_id, pref_type, pref_value, updated_at) VALUES
    (1, 'category', '护肤', '2024-06-01 10:00'), (1, 'category', '彩妆', '2024-06-01 10:00'), (2, 'brand', '自有品牌', '2024-06-02 10:00');
  GRANT SELECT ON shop.preferences TO ${READER.user};`;

/** 券模板：字符串主键，券类型是中文，面额与门槛以分为单位，不适用的为空 */
export const COUPON_TEMPLATES = `
  CREATE TABLE shop.coupon_templates (template_id text PRIMARY KEY, title text NOT NULL, coupon_type text NOT NULL,
    face_value_fen int, pay_rate numeric(5, 2), threshold_fen int);
  INSERT INTO shop.coupon_templates VALUES
    ('TPL01', '满100减20', '满减', 2000, NULL, 10000), ('TPL02', '87.5折券', '折扣', NULL, 87.5, NULL), ('TPL03', '免运费券', '免运费', NULL, NULL, NULL);
  GRANT SELECT ON shop.coupon_templates TO ${READER.user};`;

/** 优惠券：券码作主键，状态是中文，只有已使用的有核销时间、核销订单与抵扣金额（以分为单位） */
export const COUPONS = `
  CREATE TABLE shop.coupons (coupon_code text PRIMARY KEY, template_id text NOT NULL, activity_id text, user_id int NOT NULL,
    status text NOT NULL, receive_time timestamp NOT NULL, use_time timestamp, order_no text, discount_fen int,
    expire_time timestamp NOT NULL, update_time timestamp NOT NULL);
  INSERT INTO shop.coupons VALUES
    ('CP01', 'TPL01', 'ACT1', 1, '已使用', '2024-06-01 10:00', '2024-06-03 10:00', 'NO1', 2000, '2024-07-01 10:00', '2024-06-03 10:00'),
    ('CP02', 'TPL02', NULL, 1, '未使用', '2024-06-02 10:00', NULL, NULL, NULL, '2024-07-02 10:00', '2024-06-02 10:00'),
    ('CP03', 'TPL03', 'ACT1', 2, '已过期', '2024-06-01 10:00', NULL, NULL, NULL, '2024-07-01 10:00', '2024-07-01 10:00'),
    ('CP04', 'TPL01', NULL, 2, '已作废', '2024-06-01 10:00', NULL, NULL, NULL, '2024-07-01 10:00', '2024-06-05 10:00');
  GRANT SELECT ON shop.coupons TO ${READER.user};`;

/** 营销同意的副本：与 consents 同样的行 */
export const CONSENTS_COPY = `
  CREATE TABLE shop.consents_copy (LIKE shop.consents INCLUDING ALL);
  INSERT INTO shop.consents_copy SELECT * FROM shop.consents;
  GRANT SELECT ON shop.consents_copy TO ${READER.user};`;

/** 订单明细：文本主键，order_id 对应 orders 的自增主键 */
export const ORDER_ITEMS = `
  CREATE TABLE shop.order_items (item_no text PRIMARY KEY, order_id int NOT NULL, qty int NOT NULL);
  INSERT INTO shop.order_items VALUES ('I1', 1, 2), ('I2', 1, 1), ('I3', 2, 5);
  GRANT SELECT ON shop.order_items TO ${READER.user};`;

/** 两位数据工程师：一位起草、一位发布。登记数据源、选入全部表（extra 是另加的源表）、确认水位线并同步一次 */
export async function syncedSource(extra = '') {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const input = await pgSourceInput(READER);
  await grantOnSource(ORDER_LOG + POINT_LOGS + CONSENTS + PREFERENCES + COUPON_TEMPLATES + COUPONS + extra);
  const { id } = await registerSource(author, input);
  await syncAllTables(author, id);
  return { acme, author, reviewer, id, input };
}

/** 选入数据源的全部表、确认水位线并同步一次 */
export async function syncAllTables(author: CurrentMember, id: string) {
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
}

export const CUSTOMERS = `model: 1
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

export const ORDERS = `model: 1
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

export const ORDER_LOG_MAPPING = `model: 1
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

export const POINT_LOGS_MAPPING = `model: 1
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

export const CONSENTS_MAPPING = `model: 1
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

export const PREFERENCES_MAPPING = `model: 1
entity: preference
table: preferences
fields:
  customer_id: string(customer_id)
  preference_type: pref_type
  preference_value: pref_value
  updated_at: from_timezone(updated_at, 'Asia/Shanghai')
`;

export const COUPON_TEMPLATES_MAPPING = `model: 1
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

export const COUPONS_MAPPING = `model: 1
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
export const mergedMappings = (task: { params: unknown }) => ((task.params as { mappings: { mapping: string }[] }).mappings).map(m => m.mapping).sort();

/** 在 fn 执行期间设置环境变量（调度器派发的工作进程继承它） */
export async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
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

/** 写入 event 的映射：event_id 取 table 的 column */
export const events = (table: string, column: string, extra = '') => `model: 1\nentity: event\ntable: ${table}\nfields:\n  event_id: string(${column})\n${extra}`;

// test/pipeline/identity-fixtures.ts —— 身份打通的夹具：CRM、会员、埋点三个数据源的映射 YAML，以及开通租户、登记同步三个源并发布映射的 publishedIdentitySources
import { memberOf, newTenant, publish } from './fixtures';
import { seedIdentitySources } from './source-fixtures';

export const CRM = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(id)
  name: name
  phone: mobile
  email: email
  external_id: unionid
`;

export const LOYALTY = `model: 1
entity: customer
table: members
fields:
  customer_id: string(member_id)
  name: full_name
  phone: phone
  email: mail
  external_id: unionid
`;

export const TRACKING_USERS = `model: 1
entity: customer
table: users
fields:
  customer_id: user_id
  phone: phone
  email: email
`;

export const TRACKING_EVENTS = `model: 1
entity: event
table: events
fields:
  event_id: event_id
  customer_id: user_id
  device_id: device_id
  event_type: event_type
  occurred_at: from_timezone(ts, 'UTC')
`;

export const CRM_ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: order_no
  customer_id: string(customer)
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  amount: amount
  created_at: from_timezone(created_at, 'UTC')
  paid_at: from_timezone(paid_at, 'UTC')
  updated_at: from_timezone(updated_at, 'UTC')
`;

export const LOYALTY_ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(id)
  customer_id: string(member_id)
  status: { expr: state, dictionary: { 已支付: paid, 已完成: completed } }
  amount: total
  created_at: from_timezone(ordered_at, 'UTC')
  updated_at: from_timezone(updated_at, 'UTC')
`;

/**
 * 开通租户 acme，由 de@acme.com 登记并同步三个身份打通数据源（seedIdentitySources），发布三个 customer 映射与埋点事件映射，
 * 由 de2@acme.com 审核发布；orders 为真时再发布 CRM 与会员的订单映射。返回租户、两位成员、数据源 ID、customer 映射 ID，
 * 以及数据源 ID → 简称（crm / loyalty / tracking）
 */
export async function publishedIdentitySources({ orders = false } = {}) {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { crm, loyalty, tracking } = await seedIdentitySources(author, { orders });
  const mappings = {
    crm: await publish(author, reviewer, crm, CRM),
    loyalty: await publish(author, reviewer, loyalty, LOYALTY),
    tracking: await publish(author, reviewer, tracking, TRACKING_USERS),
  };
  await publish(author, reviewer, tracking, TRACKING_EVENTS);
  if (orders) {
    await publish(author, reviewer, crm, CRM_ORDERS);
    await publish(author, reviewer, loyalty, LOYALTY_ORDERS);
  }
  return { acme, author, reviewer, sources: { crm, loyalty, tracking }, mappings, names: { [crm]: 'crm', [loyalty]: 'loyalty', [tracking]: 'tracking' } };
}

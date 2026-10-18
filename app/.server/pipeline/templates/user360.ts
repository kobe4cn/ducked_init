// app/.server/pipeline/templates/user360.ts —— 用户 360 模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 以统一消费者（silver._consumer，没下过单的也在）为粒度，汇总回看窗口内的订单（口径同 RFM，见 order-window.ts）与各渠道的营销同意。
// 只输出 consumer_id 与汇总值，不带 _consumer 的属性列、*__source 列和任何明文（ADR-0005）
import { CHANNELS } from '../../../lib/canonical-model';
import { ident, lit } from '../../../lib/mapping-expr';
import { CONSUMER, CONSUMER_CONSENT } from '../identity-engine';
import { parseAsOf, parseLookbackDays, parseStatuses, windowOrders, type OrderWindow } from './order-window';

/** asOf：recency_days、tenure_days 是到这一天的天数 */
export type User360Params = OrderWindow;

export const USER360_DEFAULTS: Omit<User360Params, 'asOf'> = {
  lookbackDays: 365,
  statuses: ['paid', 'shipped', 'completed'],
};

const KEYS = ['asOf', 'lookbackDays', 'statuses'];

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 USER360_DEFAULTS */
export function parseUser360Params(params: Record<string, unknown>): User360Params {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`用户 360 模板不认识的参数：${unknown.join('、')}`);
  const p = { ...USER360_DEFAULTS, ...params };
  return { asOf: parseAsOf(params.asOf), lookbackDays: parseLookbackDays(p.lookbackDays), statuses: parseStatuses(p.statuses) };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type User360Definition = Omit<User360Params, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseUser360Definition(params: Record<string, unknown>): User360Definition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseUser360Params({ ...params, asOf: '1970-01-01' });
  return definition;
}

/**
 * 编译成一条 SELECT：每个统一消费者一行 consumer_id, orders, monetary, avg_order_value, first_order_date, last_order_date,
 * recency_days, tenure_days 与每个渠道一列 consent_<渠道>，按 consumer_id 排序。0 单时 orders、monetary 为 0，其余订单列为空。
 * consent 为假（标准层没有 _consumer_consent）时同意列全为 false，否则这个渠道最新的状态是 granted 才为 true
 */
export function compileUser360(p: User360Params, { consent }: { consent: boolean }): string {
  const asOfDate = `DATE ${lit(p.asOf)}`;
  const column = (ch: string) => ident(`consent_${ch}`);
  return `WITH o AS (${windowOrders(p)}
), b AS (
  SELECT consumer_id, count(*) AS orders, sum(amount) AS monetary, min(order_date) AS first_order_date, max(order_date) AS last_order_date
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id
)${consent ? `, c AS (
  SELECT consumer_id,
    ${CHANNELS.map(ch => `bool_or(channel = ${lit(ch)} AND status = 'granted') AS ${column(ch)}`).join(',\n    ')}
  FROM ${CONSUMER_CONSENT} GROUP BY consumer_id
)` : ''}
SELECT u.consumer_id, coalesce(b.orders, 0)::INTEGER AS orders, coalesce(b.monetary, 0) AS monetary,
  round(b.monetary / b.orders, 2)::DOUBLE AS avg_order_value,
  b.first_order_date, b.last_order_date,
  (${asOfDate} - b.last_order_date)::INTEGER AS recency_days, (${asOfDate} - b.first_order_date)::INTEGER AS tenure_days,
  ${CHANNELS.map(ch => `${consent ? `coalesce(c.${column(ch)}, false)` : 'false'} AS ${column(ch)}`).join(',\n  ')}
FROM ${CONSUMER} u LEFT JOIN b ON b.consumer_id = u.consumer_id${consent ? ' LEFT JOIN c ON c.consumer_id = u.consumer_id' : ''}
ORDER BY u.consumer_id`;
}

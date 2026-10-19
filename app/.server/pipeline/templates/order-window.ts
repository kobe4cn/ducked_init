// app/.server/pipeline/templates/order-window.ts —— 按订单计算的模板共用的订单口径：基准日 asOf、回看天数与计入的订单状态的校验，
// 以及计入的订单（交易时间取 coalesce(paid_at, created_at)，按 UTC 日期计，带打通到的统一消费者）
import { entityOf } from '../../../lib/canonical-model';
import { customerSourceColumn } from '../../../lib/customer-source';
import { lit } from '../../../lib/mapping-expr';
import { IDENTITIES } from '../identity-engine';

export interface OrderWindow {
  /** 计算基准日（UTC，YYYY-MM-DD）：只计入这一天及之前的订单 */
  asOf: string;
  /** 回看天数：只计入 as_of 往前这么多天内（含 as_of 当天）的订单 */
  lookbackDays: number;
  /** 计入的订单状态 */
  statuses: string[];
}

export const ORDER_STATUSES = entityOf('order')!.fields.find(f => f.name === 'status')!.enum!;

export function parseAsOf(v: unknown) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new Error('参数 asOf 必须是 YYYY-MM-DD 格式的日期');
  }
  return v;
}

/** 模板的整数参数：min 到 max 之间（含） */
export function parseIntParam(key: string, v: unknown, min: number, max: number) {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`参数 ${key} 必须是 ${min} 到 ${max} 之间的整数`);
  return v as number;
}

export const parseLookbackDays = (v: unknown) => parseIntParam('lookbackDays', v, 1, 3650);

/** 去重并排序，同样的状态集合得到同样的 SQL */
export function parseStatuses(v: unknown) {
  if (!Array.isArray(v) || v.length === 0 || !v.every(s => ORDER_STATUSES.includes(s))) {
    throw new Error(`参数 statuses 必须是非空的订单状态列表，可选 ${ORDER_STATUSES.join('、')}`);
  }
  return [...new Set(v as string[])].sort();
}

const ORDER = 'silver."order"';
const day = (column: string) => `(${column} AT TIME ZONE 'UTC')::DATE`;

/**
 * 状态计入、不晚于 as_of 的订单 consumer_id, amount, order_date，带打通到的消费者（打通不到时为空）；
 * 给了 lookbackDays 时只取回看窗口内的，不给时不限下界（全部历史）
 */
export function qualifyingOrders(p: Omit<OrderWindow, 'lookbackDays'> & { lookbackDays?: number }) {
  const asOfDate = `DATE ${lit(p.asOf)}`;
  const orderDate = day('coalesce(o.paid_at, o.created_at)');
  return `
  SELECT i.consumer_id, o.amount, ${orderDate} AS order_date
  FROM ${ORDER} o
  LEFT JOIN ${IDENTITIES} i ON i._source = o.${customerSourceColumn('customer_id')} AND i.customer_id = o.customer_id
  WHERE o.status IN (${p.statuses.map(lit).join(', ')})
    AND ${p.lookbackDays === undefined ? `${orderDate} <= ${asOfDate}` : `${orderDate} BETWEEN ${asOfDate} - ${p.lookbackDays - 1} AND ${asOfDate}`}`;
}

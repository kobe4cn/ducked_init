// app/.server/pipeline/templates/repurchase.ts —— 复购模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 回看窗口内（口径同 RFM，见 order-window.ts）至少下过一单的统一消费者各一行：首单、第二单（都是窗口内的）与第二单是否在首单后
// windowDays 天内，交给页面再聚合成复购率。SQL 改写自 src/04_crm.ts 的复购
import { parseAsOf, parseIntParam, parseLookbackDays, parseStatuses, qualifyingOrders, type OrderWindow } from './order-window';

/** asOf：只看回看窗口内、这一天及之前的订单 */
export interface RepurchaseParams extends OrderWindow {
  /** 复购窗口：第二单在首单后这么多天内（含）算复购 */
  windowDays: number;
}

export const REPURCHASE_DEFAULTS: Omit<RepurchaseParams, 'asOf'> = {
  lookbackDays: 365,
  windowDays: 90,
  statuses: ['paid', 'shipped', 'completed'],
};

const KEYS = ['asOf', 'lookbackDays', 'windowDays', 'statuses'];

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 REPURCHASE_DEFAULTS */
export function parseRepurchaseParams(params: Record<string, unknown>): RepurchaseParams {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`复购模板不认识的参数：${unknown.join('、')}`);
  const p = { ...REPURCHASE_DEFAULTS, ...params };
  return {
    asOf: parseAsOf(params.asOf), lookbackDays: parseLookbackDays(p.lookbackDays), windowDays: parseIntParam('windowDays', p.windowDays, 1, 730),
    statuses: parseStatuses(p.statuses),
  };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type RepurchaseDefinition = Omit<RepurchaseParams, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseRepurchaseDefinition(params: Record<string, unknown>): RepurchaseDefinition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseRepurchaseParams({ ...params, asOf: '1970-01-01' });
  return definition;
}

/**
 * 编译成一条 SELECT：窗口内至少一单的每个统一消费者一行 consumer_id, orders, first_order_date, second_order_date（只有一单时为空）,
 * days_to_second, repurchased（第二单在首单后 windowDays 天内），按 consumer_id 排序。同一天的两单算首单与第二单（相隔 0 天）
 */
export function compileRepurchase(p: RepurchaseParams): string {
  return `WITH o AS (${qualifyingOrders(p)}
), b AS (
  SELECT consumer_id, count(*) AS orders, list(order_date ORDER BY order_date) AS dates
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id
)
SELECT consumer_id, orders::INTEGER AS orders, dates[1] AS first_order_date, dates[2] AS second_order_date,
  (dates[2] - dates[1])::INTEGER AS days_to_second, coalesce(dates[2] - dates[1] <= ${p.windowDays}, false) AS repurchased
FROM b ORDER BY consumer_id`;
}

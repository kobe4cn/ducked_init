// app/.server/pipeline/templates/churn.ts —— 流失预警模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 按个人购买节奏判断：回看窗口内（口径同 RFM，见 order-window.ts）订单数不少于 minOrders 的统一消费者各一行，沉默天数超过
// 平均间隔（不小于 minGapDays）的 silenceMultiplier 倍算有流失风险。不读其他快照，CLV、用户 360 的列需要时由页面关联。
// SQL 改写自 src/04_crm.ts 的流失预警
import { lit } from '../../../lib/mapping-expr';
import { parseAsOf, parseIntParam, parseLookbackDays, parseStatuses, qualifyingOrders, type OrderWindow } from './order-window';

/** asOf：recency_days 是到这一天的天数 */
export interface ChurnParams extends OrderWindow {
  /** 至少这么多单才算有购买节奏，不小于 2 */
  minOrders: number;
  /** 沉默天数超过平均间隔的这么多倍算有流失风险 */
  silenceMultiplier: number;
  /** 平均间隔的下限（天），避免短时间内连下几单的人很快被判为有风险 */
  minGapDays: number;
}

export const CHURN_DEFAULTS: Omit<ChurnParams, 'asOf'> = {
  lookbackDays: 730,
  minOrders: 3,
  silenceMultiplier: 2,
  minGapDays: 7,
  statuses: ['paid', 'shipped', 'completed'],
};

const KEYS = ['asOf', 'lookbackDays', 'minOrders', 'silenceMultiplier', 'minGapDays', 'statuses'];

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 CHURN_DEFAULTS */
export function parseChurnParams(params: Record<string, unknown>): ChurnParams {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`流失预警模板不认识的参数：${unknown.join('、')}`);
  const p = { ...CHURN_DEFAULTS, ...params };
  return {
    asOf: parseAsOf(params.asOf), lookbackDays: parseLookbackDays(p.lookbackDays), minOrders: parseIntParam('minOrders', p.minOrders, 2, 100),
    silenceMultiplier: parseIntParam('silenceMultiplier', p.silenceMultiplier, 1, 10), minGapDays: parseIntParam('minGapDays', p.minGapDays, 1, 365),
    statuses: parseStatuses(p.statuses),
  };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type ChurnDefinition = Omit<ChurnParams, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseChurnDefinition(params: Record<string, unknown>): ChurnDefinition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseChurnParams({ ...params, asOf: '1970-01-01' });
  return definition;
}

/**
 * 编译成一条 SELECT：窗口内订单数不少于 minOrders 的每个统一消费者一行 consumer_id, orders, avg_gap_days（(最后一单 − 首单) / (单数 − 1)）,
 * recency_days, silence_ratio（recency_days / max(avg_gap_days, minGapDays)，两位小数）, at_risk（沉默超过 silenceMultiplier 倍），
 * 按 consumer_id 排序。有风险的与没风险的都在
 */
export function compileChurn(p: ChurnParams): string {
  const asOfDate = `DATE ${lit(p.asOf)}`;
  return `WITH o AS (${qualifyingOrders(p)}
), b AS (
  SELECT consumer_id, count(*)::INTEGER AS orders, min(order_date) AS first_order_date, max(order_date) AS last_order_date
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id HAVING count(*) >= ${p.minOrders}
), r AS (
  SELECT consumer_id, orders, (last_order_date - first_order_date)::DOUBLE / (orders - 1) AS avg_gap_days,
    (${asOfDate} - last_order_date)::INTEGER AS recency_days
  FROM b
)
SELECT consumer_id, orders, avg_gap_days, recency_days,
  round(recency_days / greatest(avg_gap_days, ${p.minGapDays}), 2) AS silence_ratio,
  recency_days > ${p.silenceMultiplier} * greatest(avg_gap_days, ${p.minGapDays}) AS at_risk
FROM r ORDER BY consumer_id`;
}

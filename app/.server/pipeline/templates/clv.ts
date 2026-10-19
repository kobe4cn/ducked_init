// app/.server/pipeline/templates/clv.ts —— CLV 模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 回看窗口内（口径同 RFM，见 order-window.ts）至少下过一单的统一消费者各一行：历史频率与客单，乘上按个人购买节奏指数衰减的存活概率，
// 预测未来 horizonDays 天的价值（简化 BG 思路）。SQL 改写自 src/04_crm.ts 的 CLV
import { lit } from '../../../lib/mapping-expr';
import { parseAsOf, parseIntParam, parseLookbackDays, parseStatuses, qualifyingOrders, type OrderWindow } from './order-window';

/** asOf：recency_days、tenure_days 是到这一天的天数 */
export interface ClvParams extends OrderWindow {
  /** 预测未来这么多天的价值 */
  horizonDays: number;
  /** 客龄与购买间隔的下限（天），避免新客的频率被放大 */
  minTenureDays: number;
  /** 衰减系数：越大，沉默同样久时存活概率越高 */
  decay: number;
}

export const CLV_DEFAULTS: Omit<ClvParams, 'asOf'> = {
  lookbackDays: 730,
  horizonDays: 365,
  minTenureDays: 30,
  decay: 2,
  statuses: ['paid', 'shipped', 'completed'],
};

const KEYS = ['asOf', 'lookbackDays', 'horizonDays', 'minTenureDays', 'decay', 'statuses'];

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 CLV_DEFAULTS */
export function parseClvParams(params: Record<string, unknown>): ClvParams {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`CLV 模板不认识的参数：${unknown.join('、')}`);
  const p = { ...CLV_DEFAULTS, ...params };
  return {
    asOf: parseAsOf(params.asOf), lookbackDays: parseLookbackDays(p.lookbackDays), horizonDays: parseIntParam('horizonDays', p.horizonDays, 1, 3650),
    minTenureDays: parseIntParam('minTenureDays', p.minTenureDays, 1, 365), decay: parseIntParam('decay', p.decay, 1, 10),
    statuses: parseStatuses(p.statuses),
  };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type ClvDefinition = Omit<ClvParams, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseClvDefinition(params: Record<string, unknown>): ClvDefinition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseClvParams({ ...params, asOf: '1970-01-01' });
  return definition;
}

/**
 * 编译成一条 SELECT：窗口内至少一单的每个统一消费者一行 consumer_id, orders, monetary, avg_order_value, recency_days,
 * tenure_days（到 asOf 的客龄，不小于 minTenureDays）, freq_per_year, p_alive（exp(− recency / max(客龄 / 单数, minTenureDays) / decay)）,
 * clv（客单 × 单数 × horizonDays / 客龄 × p_alive，DECIMAL(18,2)），按 consumer_id 排序
 */
export function compileClv(p: ClvParams): string {
  const asOfDate = `DATE ${lit(p.asOf)}`;
  return `WITH o AS (${qualifyingOrders(p)}
), b AS (
  SELECT consumer_id, count(*)::INTEGER AS orders, sum(amount)::DOUBLE AS monetary, min(order_date) AS first_order_date, max(order_date) AS last_order_date
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id
), m AS (
  SELECT consumer_id, orders, monetary, monetary / orders AS avg_order_value, (${asOfDate} - last_order_date)::INTEGER AS recency_days,
    greatest(${asOfDate} - first_order_date, ${p.minTenureDays})::INTEGER AS tenure_days
  FROM b
), a AS (
  SELECT *, orders * 365 / tenure_days::DOUBLE AS freq_per_year,
    exp(- recency_days / greatest(tenure_days / orders::DOUBLE, ${p.minTenureDays}) / ${p.decay}) AS p_alive
  FROM m
)
SELECT consumer_id, orders, monetary, avg_order_value, recency_days, tenure_days, freq_per_year, p_alive,
  round(avg_order_value * orders * ${p.horizonDays} / tenure_days * p_alive, 2)::DECIMAL(18,2) AS clv
FROM a ORDER BY consumer_id`;
}

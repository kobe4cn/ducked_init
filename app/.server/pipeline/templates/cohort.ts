// app/.server/pipeline/templates/cohort.ts —— 同期群模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 按首单所在周期（月或周）把统一消费者分群，每个消费者一行，交给页面再聚合成留存矩阵。订单口径同 RFM（见 order-window.ts），
// 但不限回看下界：首单是 as_of 及之前全部历史里的第一单。SQL 改写自 src/04_crm.ts 的同期群
import { lit } from '../../../lib/mapping-expr';
import { parseAsOf, parseIntParam, parseStatuses, qualifyingOrders } from './order-window';

export const GRANULARITIES = ['month', 'week'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** asOf：只看这一天及之前的订单，最近的周期是 asOf 所在的周期 */
export interface CohortParams {
  asOf: string;
  /** 周期粒度：月（每月 1 日起）或周（周一起） */
  granularity: Granularity;
  /** 只收首单落在含 asOf 在内的最近这么多个周期里的消费者 */
  periods: number;
  /** 计入的订单状态 */
  statuses: string[];
}

export const COHORT_DEFAULTS: Omit<CohortParams, 'asOf'> = {
  granularity: 'month',
  periods: 12,
  statuses: ['paid', 'shipped', 'completed'],
};

const KEYS = ['asOf', 'granularity', 'periods', 'statuses'];

function parseGranularity(v: unknown) {
  if (!GRANULARITIES.includes(v as Granularity)) throw new Error(`参数 granularity 必须是 ${GRANULARITIES.join(' 或 ')}`);
  return v as Granularity;
}

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 COHORT_DEFAULTS */
export function parseCohortParams(params: Record<string, unknown>): CohortParams {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`同期群模板不认识的参数：${unknown.join('、')}`);
  const p = { ...COHORT_DEFAULTS, ...params };
  return { asOf: parseAsOf(params.asOf), granularity: parseGranularity(p.granularity), periods: parseIntParam('periods', p.periods, 1, 60), statuses: parseStatuses(p.statuses) };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type CohortDefinition = Omit<CohortParams, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseCohortDefinition(params: Record<string, unknown>): CohortDefinition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseCohortParams({ ...params, asOf: '1970-01-01' });
  return definition;
}

/**
 * 编译成一条 SELECT：首单在最近 periods 个周期里的每个统一消费者一行 consumer_id, cohort_start（首单周期的起点）,
 * orders（首单起到 as_of 的单数）, active_periods（有下单的周期相对首单周期的偏移，去重升序，首单周期为 0），按 consumer_id 排序。
 * 偏移在 date_trunc 之后的周期起点上算，不受每月天数不同的影响
 */
export function compileCohort(p: CohortParams): string {
  const g = lit(p.granularity);
  const period = (d: string) => `date_trunc(${g}, ${d})::DATE`;
  return `WITH o AS (${qualifyingOrders(p)}
), f AS (
  SELECT consumer_id, ${period('min(order_date)')} AS cohort_start
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id
), j AS (
  SELECT f.consumer_id, f.cohort_start, date_diff(${g}, f.cohort_start, ${period('o.order_date')})::INTEGER AS period_offset
  FROM f JOIN o ON o.consumer_id = f.consumer_id
  WHERE date_diff(${g}, f.cohort_start, ${period(`DATE ${lit(p.asOf)}`)}) < ${p.periods}
)
SELECT consumer_id, cohort_start, count(*)::INTEGER AS orders, list(DISTINCT period_offset ORDER BY period_offset) AS active_periods
FROM j GROUP BY consumer_id, cohort_start
ORDER BY consumer_id`;
}

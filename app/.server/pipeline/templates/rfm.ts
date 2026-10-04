// app/.server/pipeline/templates/rfm.ts —— RFM 分层模板：把参数确定性地编译成 DuckDB SQL（ADR-0004），同样的参数永远得到同样的 SQL。
// 按打通后的统一消费者（silver."order" join silver._identities）算最近一次购买距 as_of 的天数（R）、单数（F）与金额（M），
// 打 1–5 分后按分群规则表归入人群。交易时间取 coalesce(paid_at, created_at)，按 UTC 日期计；打通不到消费者的订单不计入。
// SQL 移植自 src/04_crm.ts 的 gold.rfm：五分位时 R 分为 6 - ntile(5)，并列值按 consumer_id 二级排序，结果不随执行顺序变化
import { entityOf } from '../../../lib/canonical-model';
import { lit } from '../../../lib/mapping-expr';
import { IDENTITIES } from '../identity-engine';

/** 一项分值的闭区间条件（1–5），不写的一端不限 */
export interface ScoreRange { min?: number; max?: number }

/** 分群规则：按顺序取第一条满足的；最后一条不带条件，兜住其余所有人 */
export interface SegmentRule { name: string; r?: ScoreRange; f?: ScoreRange; m?: ScoreRange }

/**
 * 分箱方式。quintile：按消费者排名五等分；thresholds：每项四个升序的切分点，
 * R 的天数每不超过一个切分点加 1 分，F 的单数、M 的金额每达到一个切分点加 1 分（都从 1 分起）
 */
export type RfmBinning =
  | { method: 'quintile' }
  | { method: 'thresholds'; recency: number[]; frequency: number[]; monetary: number[] };

export interface RfmParams {
  /** 计算基准日（UTC，YYYY-MM-DD）：只计入这一天及之前的订单，R 是到这一天的天数 */
  asOf: string;
  /** 回看天数：只计入 as_of 往前这么多天内（含 as_of 当天）的订单 */
  lookbackDays: number;
  /** 计入的订单状态 */
  statuses: string[];
  binning: RfmBinning;
  segments: SegmentRule[];
}

export const RFM_DEFAULTS: Omit<RfmParams, 'asOf'> = {
  lookbackDays: 365,
  statuses: ['paid', 'shipped', 'completed'],
  binning: { method: 'quintile' },
  segments: [
    { name: '重要价值', r: { min: 4 }, f: { min: 4 }, m: { min: 4 } },
    { name: '重要发展', r: { min: 4 }, f: { max: 2 }, m: { min: 4 } },
    { name: '重要保持', r: { max: 2 }, f: { min: 4 }, m: { min: 4 } },
    { name: '重要挽留', r: { max: 2 }, f: { max: 2 }, m: { min: 4 } },
    { name: '一般价值', r: { min: 4 }, f: { min: 4 } },
    { name: '新客/潜力', r: { min: 4 } },
    { name: '一般保持', r: { max: 2 }, f: { min: 3 } },
    { name: '一般挽留' },
  ],
};

const ORDER_STATUSES = entityOf('order')!.fields.find(f => f.name === 'status')!.enum!;
const KEYS = ['asOf', 'lookbackDays', 'statuses', 'binning', 'segments'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function asOf(v: unknown) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new Error('参数 asOf 必须是 YYYY-MM-DD 格式的日期');
  }
  return v;
}

function thresholds(v: unknown, key: string) {
  const ok = Array.isArray(v) && v.length === 4 && v.every(t => typeof t === 'number' && Number.isFinite(t) && t >= 0)
    && v.every((t, i) => i === 0 || v[i - 1] < t);
  if (!ok) throw new Error(`参数 binning.${key} 必须是四个严格升序的非负数`);
  return v as number[];
}

function binning(v: unknown): RfmBinning {
  if (isObject(v) && v.method === 'quintile') return { method: 'quintile' };
  if (isObject(v) && v.method === 'thresholds') {
    return { method: 'thresholds', recency: thresholds(v.recency, 'recency'), frequency: thresholds(v.frequency, 'frequency'), monetary: thresholds(v.monetary, 'monetary') };
  }
  throw new Error('参数 binning.method 必须是 quintile 或 thresholds');
}

function range(v: unknown, where: string): ScoreRange | undefined {
  if (v === undefined) return undefined;
  const score = (s: unknown) => s === undefined || (Number.isInteger(s) && (s as number) >= 1 && (s as number) <= 5);
  if (!isObject(v) || !score(v.min) || !score(v.max) || (v.min === undefined && v.max === undefined)
    || (v.min !== undefined && v.max !== undefined && (v.min as number) > (v.max as number))) {
    throw new Error(`${where} 必须是 { min?, max? }，取 1 到 5 的整数且 min 不大于 max`);
  }
  return { ...(v.min !== undefined && { min: v.min as number }), ...(v.max !== undefined && { max: v.max as number }) };
}

function segments(v: unknown): SegmentRule[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error('参数 segments 必须是非空的分群规则列表');
  const rules = v.map((s, i) => {
    if (!isObject(s) || typeof s.name !== 'string' || !s.name.trim()) throw new Error(`参数 segments 第 ${i + 1} 条缺少人群名称`);
    const where = `参数 segments 第 ${i + 1} 条（${s.name}）的`;
    const r = range(s.r, `${where} r`), f = range(s.f, `${where} f`), m = range(s.m, `${where} m`);
    return { name: s.name, ...(r && { r }), ...(f && { f }), ...(m && { m }) };
  });
  const last = rules[rules.length - 1];
  if (last.r || last.f || last.m) throw new Error('参数 segments 的最后一条不能带条件，用来兜住其余所有消费者');
  if (new Set(rules.map(s => s.name)).size !== rules.length) throw new Error('参数 segments 的人群名称不能重复');
  return rules;
}

/** 校验任务参数并补上默认值：asOf 必填，其余不写时取 RFM_DEFAULTS */
export function parseRfmParams(params: Record<string, unknown>): RfmParams {
  const unknown = Object.keys(params).filter(k => !KEYS.includes(k));
  if (unknown.length) throw new Error(`RFM 模板不认识的参数：${unknown.join('、')}`);
  const p = { ...RFM_DEFAULTS, ...params };
  if (!Number.isInteger(p.lookbackDays) || p.lookbackDays < 1 || p.lookbackDays > 3650) throw new Error('参数 lookbackDays 必须是 1 到 3650 之间的整数');
  const statuses = p.statuses as unknown;
  if (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every(s => ORDER_STATUSES.includes(s))) {
    throw new Error(`参数 statuses 必须是非空的订单状态列表，可选 ${ORDER_STATUSES.join('、')}`);
  }
  return { asOf: asOf(params.asOf), lookbackDays: p.lookbackDays, statuses: [...new Set(statuses as string[])].sort(), binning: binning(p.binning), segments: segments(p.segments) };
}

/** 模板定义里的参数：除每次运行时给定的 asOf 以外的全部参数 */
export type RfmDefinition = Omit<RfmParams, 'asOf'>;

/** 校验模板定义的参数并补上默认值；asOf 不属于定义，写了也报错 */
export function parseRfmDefinition(params: Record<string, unknown>): RfmDefinition {
  if ('asOf' in params) throw new Error('参数 asOf 在每次运行时给定，不属于模板定义');
  const { asOf: _, ...definition } = parseRfmParams({ ...params, asOf: '1970-01-01' });
  return definition;
}

const ORDER = 'silver."order"';
const day = (column: string) => `(${column} AT TIME ZONE 'UTC')::DATE`;

/** 回看窗口内、状态计入的订单，带打通到的消费者（打通不到时为空） */
function windowOrders(p: RfmParams) {
  const asOfDate = `DATE ${lit(p.asOf)}`;
  const orderDate = day('coalesce(o.paid_at, o.created_at)');
  return `
  SELECT i.consumer_id, o.amount, ${orderDate} AS order_date
  FROM ${ORDER} o
  LEFT JOIN ${IDENTITIES} i ON i._source = o._source AND i.customer_id = o.customer_id
  WHERE o.status IN (${p.statuses.map(lit).join(', ')})
    AND ${orderDate} BETWEEN ${asOfDate} - ${p.lookbackDays - 1} AND ${asOfDate}`;
}

const count = (column: string, op: '<=' | '>=', cuts: number[]) => `1 + ${cuts.map(t => `(${column} ${op} ${t})::INT`).join(' + ')}`;

function scores(b: RfmBinning) {
  if (b.method === 'quintile') {
    return `6 - ntile(5) OVER (ORDER BY recency_days, consumer_id) AS r,
         ntile(5) OVER (ORDER BY frequency, monetary, consumer_id) AS f,
         ntile(5) OVER (ORDER BY monetary, consumer_id) AS m`;
  }
  return `${count('recency_days', '<=', b.recency)} AS r,
         ${count('frequency', '>=', b.frequency)} AS f,
         ${count('monetary', '>=', b.monetary)} AS m`;
}

function condition(rule: SegmentRule) {
  const parts = (['r', 'f', 'm'] as const).flatMap(k => [
    ...(rule[k]?.min !== undefined ? [`${k} >= ${rule[k].min}`] : []),
    ...(rule[k]?.max !== undefined ? [`${k} <= ${rule[k].max}`] : []),
  ]);
  return parts.length ? parts.join(' AND ') : 'true';
}

/** 编译成一条 SELECT：每个统一消费者一行 consumer_id, recency_days, frequency, monetary, r, f, m, segment，按 consumer_id 排序 */
export function compileRfm(p: RfmParams): string {
  const rules = p.segments.slice(0, -1).map(s => `    WHEN ${condition(s)} THEN ${lit(s.name)}`).join('\n');
  return `WITH o AS (${windowOrders(p)}
), b AS (
  SELECT consumer_id, DATE ${lit(p.asOf)} - max(order_date) AS recency_days, count(*) AS frequency, sum(amount) AS monetary
  FROM o WHERE consumer_id IS NOT NULL GROUP BY consumer_id
), s AS (
  SELECT *,
         ${scores(p.binning)}
  FROM b
)
SELECT consumer_id, recency_days::INTEGER AS recency_days, frequency::INTEGER AS frequency, monetary,
  r::INTEGER AS r, f::INTEGER AS f, m::INTEGER AS m,
  CASE
${rules}
    ELSE ${lit(p.segments[p.segments.length - 1].name)}
  END AS segment
FROM s ORDER BY consumer_id`;
}

/** 编译成一条 SELECT：回看窗口内、状态计入、但打通不到消费者（所在数据源没有 customer 映射或没有这个 customer_id）的订单数 n */
export function compileRfmUnlinked(p: RfmParams): string {
  return `SELECT count(*) AS n FROM (${windowOrders(p)}
) WHERE consumer_id IS NULL`;
}

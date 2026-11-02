// app/.server/knowledge/derive.ts —— 系统事实：从已发布的指标与标签 DSL 结构确定性派生的口径文字（ADR-0046 入口①），不用模型。
// 指标：「<实体>中 <过滤>、<窗口>的行，<度量>」，没有过滤与窗口时是「<实体>中所有行，<度量>」；ratio 的度量写「分子：…；分母：…」，各带自己的过滤。
// 标签：「按指标 <指标>：<条件> 时为 <取值>；…；指标 <指标> 为空时为 <missing>；其余为 <default>」，all 用「且」、any 用「或」连接；
// 标签的窗口与过滤在被引用的指标里，这里只写指标键，不展开。字段用原名、不翻译；实体用 entityLabel。
// 每种 agg、过滤运算与标签条件的模板写成 satisfies Record<注册表的项, …>，注册表新增一项没写模板时类型检查不通过。
// 纯函数、不碰库：输出只依赖 spec 的内容（比较按 TAG_CONDITIONS 的顺序、missing 按指标键排序），同一份定义每次结果相同，不存表、读目录时现算
import { entityLabel } from '../../lib/canonical-model';
import { cmp } from '../../lib/compare';
import type { AGGS, FILTER_OPS, MetricSpec, RATIO_AGGS, RatioPart } from '../pipeline/dsl/metric-spec';
import { TAG_CONDITIONS, type MetricCondition, type TagSpec, type TagWhen } from '../pipeline/dsl/tag-spec';

/** 目录条目上的系统事实：口径文字 */
export interface SystemFacts { text: string }

type Measure = MetricSpec['measure'];
type Filter = NonNullable<MetricSpec['filter']>[number];
type Value = Filter['value'];

const show = (v: Value) => (Array.isArray(v) ? v.map(String).join('、') : String(v ?? ''));

const AGG_TEMPLATE = {
  count: m => (m.field ? `${m.field} 不为空的行数` : '行数'),
  count_distinct: m => `${m.field} 的不同取值个数`,
  sum: m => `${m.field} 求和`,
  avg: m => `${m.field} 平均值`,
  min: m => `${m.field} 最小值`,
  max: m => `${m.field} 最大值`,
  ratio: m => `分子：${ratioPart(m.numerator)}；分母：${ratioPart(m.denominator)}`,
  latest: m => `按 ${m.by} 取最新一行的 ${m.field}`,
  earliest: m => `按 ${m.by} 取最早一行的 ${m.field}`,
  days_since: m => `距 ${m.field} 最近一天的天数`,
} satisfies Record<(typeof AGGS)[number], (m: Measure) => string>;

const RATIO_AGG_TEMPLATE = {
  count: p => AGG_TEMPLATE.count({ agg: 'count', field: p.field }),
  count_distinct: p => AGG_TEMPLATE.count_distinct({ agg: 'count_distinct', field: p.field }),
  sum: p => AGG_TEMPLATE.sum({ agg: 'sum', field: p.field }),
} satisfies Record<(typeof RATIO_AGGS)[number], (p: RatioPart) => string>;

const FILTER_TEMPLATE = {
  eq: c => `${c.field} 等于 ${show(c.value)}`,
  ne: c => `${c.field} 不等于 ${show(c.value)}`,
  in: c => `${c.field} 在 ${show(c.value)} 中`,
  not_in: c => `${c.field} 不在 ${show(c.value)} 中`,
  gt: c => `${c.field} 大于 ${show(c.value)}`,
  gte: c => `${c.field} 大于等于 ${show(c.value)}`,
  lt: c => `${c.field} 小于 ${show(c.value)}`,
  lte: c => `${c.field} 小于等于 ${show(c.value)}`,
  is_null: c => `${c.field} 为空`,
  not_null: c => `${c.field} 不为空`,
} satisfies Record<(typeof FILTER_OPS)[number], (c: Filter) => string>;

const CONDITION_TEMPLATE = {
  gte: n => `大于等于 ${n}`,
  gt: n => `大于 ${n}`,
  lte: n => `小于等于 ${n}`,
  lt: n => `小于 ${n}`,
  eq: n => `等于 ${n}`,
} satisfies Record<(typeof TAG_CONDITIONS)[number], (n: number) => string>;

const filterTexts = (filter: readonly Filter[] | undefined) => (filter ?? []).map(c => FILTER_TEMPLATE[c.op](c));

function ratioPart(p: RatioPart | undefined): string {
  if (!p) return '';
  const conds = filterTexts(p.filter);
  const measure = RATIO_AGG_TEMPLATE[p.agg](p);
  return conds.length ? `${conds.join('、')}的行，${measure}` : measure;
}

/** 指标的口径文字 */
export function metricText(spec: MetricSpec): string {
  const conds = [...filterTexts(spec.filter), ...(spec.window ? [`${spec.window.field} 在最近 ${spec.window.days} 天内`] : [])];
  const rows = conds.length ? `${entityLabel(spec.base)}中 ${conds.join('、')}的行` : `${entityLabel(spec.base)}中所有行`;
  return `${rows}，${AGG_TEMPLATE[spec.measure.agg](spec.measure)}`;
}

/** 一组比较（按 TAG_CONDITIONS 的顺序，不看键顺序），多个时用「且」连接 */
const comparisonText = (c: Partial<Record<(typeof TAG_CONDITIONS)[number], number>>) =>
  TAG_CONDITIONS.flatMap(k => (typeof c[k] === 'number' ? [CONDITION_TEMPLATE[k](c[k])] : [])).join('且');

const isMulti = (w: TagWhen): w is { all?: MetricCondition[]; any?: MetricCondition[] } => 'all' in w || 'any' in w;

function whenText(w: TagWhen): string {
  if (!isMulti(w)) return comparisonText(w);
  const items = (list: MetricCondition[] | undefined, joiner: string) => (list ?? []).map(c => `${c.metric} ${comparisonText(c)}`).join(joiner);
  return [items(w.all, ' 且 '), items(w.any, ' 或 ')].filter(Boolean).join(' 且 ');
}

/** 规则里引用到的指标，按出现顺序去重 */
function tagMetrics(spec: TagSpec): string[] {
  if (spec.metric) return [spec.metric];
  return [...new Set(spec.rules.flatMap(r => (isMulti(r.when) ? [...(r.when.all ?? []), ...(r.when.any ?? [])].map(c => c.metric) : [])))];
}

/** 标签的口径文字 */
export function tagText(spec: TagSpec): string {
  const rules = spec.rules.map(r => `${whenText(r.when)} 时为 ${r.value}`);
  const missing = Object.keys(spec.missing ?? {}).sort(cmp).map(k => `指标 ${k} 为空时为 ${spec.missing?.[k] ?? '空值'}`);
  return `按指标 ${tagMetrics(spec).join('、')}：${[...rules, ...missing, `其余为 ${spec.default}`].join('；')}`;
}

// app/.server/catalog/ambiguity.ts —— 歧义判定（ADR-0047：歧义由服务端发现，#384 方案 A）：在 rank() 的结果上，把名称或别名出现在查询里的
// 同类候选（指标和指标、字段和字段）按这个词分组，逐维度对比口径（指标：度量、粒度、窗口、时间字段、过滤、口径声明；字段：粒度）。
// 先做点名排除（「成员明确说的永远不被覆盖」）：查询里点到的粒度、时间字段、过滤取值只留取值被点名的候选；再判定：
// 剩 1 个或各维度都相同（只是重名）不歧义，否则只有得分拉开且口径声明完全一致、不含未知时不追问；投影回退（得分全为 0）一律按差异追问。
// 查询里的词按最长匹配认：被更长的词覆盖的出现不算（「订单明细」里的「订单」、「触达渠道」里的「渠道」）。纯函数，只用传进来的目录，不读库
import { CLAIM_TYPE_ORDER, claimTypeLabel, claimValueLabel, type ClaimType } from '../../lib/semantic-claims';
import type { Catalog, CatalogEntry, FieldEntry, MetricEntry } from './index';
import type { Ranked } from './rank';

/** 第 1 名减第 2 名不小于它算得分拉开（RRF 分：别名一路相邻名次差约 0.001，多命中一路约 0.03） */
export const SCORE_GAP = 0.01;

export type Dimension = 'measure' | 'grain' | 'window' | 'timeField' | 'filter' | 'claims';
export interface AmbiguityGroup {
  term: string;
  /** 点名排除后剩下的候选标识，按 rank() 名次 */
  candidates: string[];
  /** 实际不同的维度，values 是每个候选的取值文字 */
  diffs: { dimension: Dimension; label: string; values: Record<string, string> }[];
  /** 每个不同的维度一句追问 */
  questions: string[];
}
/** groups 只列判为歧义的组 */
export interface Ambiguity { ambiguous: boolean; groups: AmbiguityGroup[] }

const DIMENSION_LABEL: Record<Dimension, string> = {
  measure: '度量', grain: '粒度', window: '窗口', timeField: '时间字段', filter: '过滤', claims: '口径声明',
};

/** 追问模板：{term} 是分组的词，{values} 是各候选的取值用「还是」连起来 */
const DIMENSION_QUESTION: Record<Dimension, string> = {
  measure: '{term}算的是{values}？',
  grain: '{term}按{values}统计？',
  window: '{term}看{values}？',
  timeField: '{term}按{values}算？',
  filter: '{term}的过滤条件是{values}？',
  claims: '{term}的口径声明是{values}？',
};

/** 枚举取值的中文标签；没有的用原值 */
const VALUE_LABELS: Record<string, string> = {
  paid: '已支付', shipped: '已发货', completed: '已完成', refunded: '已退款', cancelled: '已取消', created: '已下单',
  login: '登录', view: '浏览', add_to_cart: '加购',
};

const NONE = '无';
const OP_TEXT: Record<string, string> = {
  eq: '：', in: '：', ne: '不是', not_in: '不是', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于', is_null: '为空', not_null: '不为空',
};

type Condition = NonNullable<MetricEntry['filter']>[number];
const valueLabel = (v: unknown) => VALUE_LABELS[String(v)] ?? String(v);
function conditionValues(f: Condition): unknown[] {
  if (f.value === undefined) return [];
  return Array.isArray(f.value) ? f.value : [f.value];
}

/** 查询里按最长匹配出现了的那些词（q 已小写）：长的先认，被已认的出现覆盖的不算 */
function named(labels: Iterable<string>, q: string): Set<string> {
  const covered: [number, number][] = [];
  const out = new Set<string>();
  for (const label of [...new Set(labels)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const l = label.toLowerCase();
    for (let i = q.indexOf(l); i >= 0; i = q.indexOf(l, i + 1)) {
      if (covered.some(([s, e]) => i >= s && i + l.length <= e)) continue;
      out.add(label);
      covered.push([i, i + l.length]);
    }
  }
  return out;
}

/** values 是口径声明以外各维度的取值文字（字段只有粒度）；claims 是每种口径声明的取值，没声明的是 unknown */
interface Facts { grain: string; values: Partial<Record<Dimension, string>>; timeField?: string; filterLabels: string[]; claims: Map<ClaimType, string> }

/** 口径声明：指标用 system.claims，按类型用 knowledge.claims 覆盖；字段只有 knowledge.claims。没声明的类型记为 unknown（未声明即未知）。plan.ts 的口径检查也用它 */
export function claimsOf(e: MetricEntry | FieldEntry): Map<ClaimType, string> {
  const out = new Map<ClaimType, string>(CLAIM_TYPE_ORDER.map(t => [t, 'unknown']));
  for (const x of [...(e.kind === 'metric' ? e.system.claims : []), ...(e.knowledge?.claims ?? [])]) out.set(x.type, x.value);
  return out;
}

/** 一个候选在各维度上的取值；粒度、时间字段、过滤另留点名排除用的标签 */
function factsOf(e: MetricEntry | FieldEntry, c: Catalog): Facts {
  const byId = (id: string) => c.entries.find(x => x.id === id);
  const entityName = (id: string) => byId(id)?.name ?? id.replace(/^entity:/, '');
  if (e.kind === 'field') {
    const grain = entityName(e.entity);
    return { grain, values: { grain }, filterLabels: [], claims: claimsOf(e) };
  }
  const grain = entityName(e.base);
  const base = e.base.replace(/^entity:/, '');
  const fieldName = (entity: string, field: string) => byId(`field:${entity}.${field}`)?.name ?? field;
  // 窗口字段可以是 a.b -> c.d 的路径：取最后一跳的字段名称
  const last = e.window?.field.split('->').at(-1)?.trim();
  let timeField: string | undefined;
  if (last?.includes('.')) timeField = fieldName(last.slice(0, last.indexOf('.')), last.slice(last.indexOf('.') + 1));
  else if (last) timeField = fieldName(base, last);
  const filter = e.filter ?? [];
  return {
    grain,
    timeField,
    claims: claimsOf(e),
    filterLabels: filter.flatMap(f => conditionValues(f).map(valueLabel)),
    values: {
      measure: e.measure,
      grain,
      window: e.window ? `${e.window.days} 天` : NONE,
      timeField: timeField ?? NONE,
      filter: filter.length ? filter.map(f => `${fieldName(base, f.field)}${OP_TEXT[f.op] ?? f.op}${conditionValues(f).map(valueLabel).join('、')}`).join('；') : NONE,
    },
  };
}

const termsOf = (e: CatalogEntry) => [e.name, ...('knowledge' in e ? e.knowledge?.aliases ?? [] : [])];

export function judgeAmbiguity(ranked: Ranked[], c: Catalog, query: string): Ambiguity {
  const q = query.toLowerCase();
  // 跳过只有依赖展开理由的条目：它们不是查询直接点到的
  const direct = ranked.filter((r): r is Ranked & { entry: MetricEntry | FieldEntry } =>
    (r.entry.kind === 'metric' || r.entry.kind === 'field') && r.reasons.some(x => x.lane !== 'expand'));
  const present = named(direct.flatMap(r => termsOf(r.entry)), q);
  // 键是种类 + 小写的词：别名与名称大小写不同也算同一个词，term 取第一个候选上的原文
  const groups = new Map<string, { term: string; members: typeof direct }>();
  for (const r of direct) {
    for (const term of new Set(termsOf(r.entry).filter(t => present.has(t)))) {
      const key = `${r.entry.kind}\n${term.toLowerCase()}`;
      const g = groups.get(key) ?? { term, members: [] };
      g.members.push(r);
      groups.set(key, g);
    }
  }

  const out: AmbiguityGroup[] = [];
  let ambiguous = false;
  for (const { term, members } of groups.values()) {
    if (members.length < 2) continue;
    const facts = new Map(members.map(r => [r.entry.id, factsOf(r.entry, c)]));
    let left = members;
    // 点名排除：粒度、时间字段只留取值被点名的；过滤留取值包含全部被点名取值的（没有过滤的视为不包含）。没有候选取值被点名的维度不起作用
    const keep = (labelsOf: (f: Facts) => string[], ok: (f: Facts, hit: Set<string>) => boolean) => {
      const hit = named(left.flatMap(r => labelsOf(facts.get(r.entry.id)!)), q);
      if (!hit.size) return;
      const kept = left.filter(r => ok(facts.get(r.entry.id)!, hit));
      if (kept.length) left = kept;
    };
    keep(f => [f.grain], (f, hit) => hit.has(f.grain));
    keep(f => (f.timeField ? [f.timeField] : []), (f, hit) => f.timeField !== undefined && hit.has(f.timeField));
    keep(f => f.filterLabels, (f, hit) => [...hit].every(l => f.filterLabels.includes(l)));
    if (left.length < 2) continue;

    const factsLeft = left.map(r => [r.entry.id, facts.get(r.entry.id)!] as const);
    // 口径声明只比指标；取值文字只列各候选实际不同的那几种
    const claimTypes = CLAIM_TYPE_ORDER.filter(t => new Set(factsLeft.map(([, f]) => f.claims.get(t))).size > 1);
    const textOf = (f: Facts, dimension: Dimension) => {
      if (dimension !== 'claims') return f.values[dimension] ?? NONE;
      if (f.values.measure === undefined) return NONE;
      return claimTypes.map(t => `${claimTypeLabel(t)}：${claimValueLabel(t, f.claims.get(t)!)}`).join('；');
    };
    const diffs = (Object.keys(DIMENSION_LABEL) as Dimension[]).flatMap(dimension => {
      const values = Object.fromEntries(factsLeft.map(([id, f]) => [id, textOf(f, dimension)]));
      return new Set(Object.values(values)).size > 1 ? [{ dimension, label: DIMENSION_LABEL[dimension], values }] : [];
    });
    if (!diffs.length) continue;

    // 不追问只有一种情况：得分拉开，并且口径声明完全一致、不含 unknown；投影回退（得分全为 0）一律追问
    const scores = left.map(r => r.score).sort((a, b) => b - a);
    const fallback = left.every(r => r.score === 0);
    const settled = !fallback && scores[0] - scores[1] >= SCORE_GAP
      && !claimTypes.length && factsLeft.every(([, f]) => ![...f.claims.values()].includes('unknown'));
    if (settled) continue;

    ambiguous = true;
    out.push({
      term, candidates: left.map(r => r.entry.id), diffs,
      questions: diffs.map(d => DIMENSION_QUESTION[d.dimension].replace('{term}', term).replace('{values}', [...new Set(Object.values(d.values))].join('还是'))),
    });
  }
  return { ambiguous, groups: out };
}

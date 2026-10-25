// scripts/eval-requirements/score.ts —— 需求评测的跑分（ADR-0041）：对一个黄金样例走与产品相同的起草消息（definitionDraftMessages，固定目录）、
// 输出 Schema 与转 YAML，记下转出的定义能否过校验（checkMetric / checkTag），再与期望逐项比较结构。不读库、不写调用日志（用 callModel 而不是 chatJson）
import { stringify } from 'yaml';
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { DSL_KINDS, type DslKind } from '../../app/.server/pipeline/dsl';
import type { MetricSpec, RatioPart } from '../../app/.server/pipeline/dsl/metric-spec';
import { definitionDraftMessages, definitionDraftSchema, definitionOutputToYaml } from '../../app/.server/pipeline/dsl/model-draft';
import { tagMetrics, type TagSpec } from '../../app/.server/pipeline/dsl/tag-spec';
import { CATALOG, CONTEXT, type GoldenCase } from './golden';

/**
 * 逐项比较的结构：指标比种类、实体（base、consumer_via 与 device_attribution）、度量（agg、字段与 ratio 的分子分母）、用到的字段、过滤条件（含时间窗口）与维度路径；
 * 标签没有实体、字段与维度，比种类、引用的指标与规则（rules、default 与 missing）。
 * 字段项与度量、过滤项有意重叠：写错一个字段会在两项上都不命中
 */
const STRUCTURE = {
  metric: ['kind', 'entity', 'measure', 'fields', 'filter', 'dimensions'],
  tag: ['kind', 'metrics', 'rules'],
} as const satisfies Record<DslKind, readonly string[]>;

/** 失败在哪一步：模型调用（含输出不合 Schema）或定义校验 */
export type FailStage = 'model' | 'definition';

export interface CaseResult {
  id: string;
  kind: DslKind;
  /** 转出的定义过了校验 */
  valid: boolean;
  /** 各结构项是否与期望一致 */
  structure: Record<string, boolean>;
  hits: number;
  items: number;
  /** hits / items */
  hitRate: number;
  failed?: { stage: FailStage; message: string; issues?: number };
}

export interface Summary {
  cases: number;
  valid: number;
  /** 校验通过的样例数 / 样例数 */
  validRate: number;
  hits: number;
  items: number;
  /** 按结构项加权：命中的项总数 / 结构项总数 */
  hitRate: number;
}

/** 键排好序的 JSON：同一结构不同写法比较时不看键的顺序 */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object') {
    const entries = Object.entries(x).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(x);
}

const sorted = (xs: unknown[]) => xs.map(canonical).sort();

type Condition = NonNullable<MetricSpec['filter']>[number];

/** 字段路径：去掉空白差异；基础实体上的字段写成 order.amount 与 amount 视为相同 */
const path = (base: string, p: string | undefined) => {
  if (p === undefined) return undefined;
  const s = p.replace(/\s*->\s*/g, ' -> ').trim();
  return !s.includes('->') && s.startsWith(`${base}.`) ? s.slice(base.length + 1) : s;
};

/** 过滤条件：eq 视同只有一个取值的 in，ne 视同 not_in，取值不看顺序 */
const normalizedCondition = (base: string, c: Condition) => {
  const op = c.op === 'eq' ? 'in' : c.op === 'ne' ? 'not_in' : c.op;
  const value = op === 'in' || op === 'not_in' ? sorted([c.value ?? []].flat()) : c.value;
  return { field: path(base, c.field), op, value };
};

const conditions = (base: string, cs: Condition[] | undefined) => sorted((cs ?? []).map(c => normalizedCondition(base, c)));

const part = (base: string, p: RatioPart | undefined) => p && ({ agg: p.agg, field: path(base, p.field), filter: conditions(base, p.filter) });

/** 用到的字段自己收集而不用 metricDependencies：模型输出可能没过校验，依赖分析要的是校验过的 spec */
function metricStructure(s: MetricSpec): Record<string, string> {
  const { base, measure: m } = s;
  const fields = [m.field, m.by, m.numerator?.field, m.denominator?.field, s.window?.field,
    ...[...(s.filter ?? []), ...(m.numerator?.filter ?? []), ...(m.denominator?.filter ?? [])].map(c => c.field)];
  return {
    kind: 'metric',
    entity: canonical({ base, consumer_via: path(base, s.consumer_via), device_attribution: s.device_attribution }),
    measure: canonical({ agg: m.agg, field: path(base, m.field), by: path(base, m.by), numerator: part(base, m.numerator), denominator: part(base, m.denominator) }),
    fields: canonical([...new Set(fields.flatMap(f => (f === undefined ? [] : [path(base, f)!])))].sort()),
    filter: canonical({ filter: conditions(base, s.filter), window: s.window && { field: path(base, s.window.field), days: s.window.days } }),
    dimensions: canonical((s.dimensions ?? []).map(d => path(base, d.path)!).sort()),
  };
}

const tagStructure = (s: TagSpec): Record<string, string> => ({
  kind: 'tag',
  metrics: canonical([...new Set(tagMetrics(s))].sort()),
  rules: canonical({ rules: s.rules, default: s.default, missing: s.missing }),
});

const structureOf = (kind: DslKind, spec: object) =>
  (kind === 'metric' ? metricStructure(spec as MetricSpec) : tagStructure(spec as TagSpec));

/** 模型输出相对期望的结构命中；模型没给出输出时（null）全不命中 */
function scoreStructure(kind: DslKind, expected: object, got: object | null): Pick<CaseResult, 'structure' | 'hits' | 'items' | 'hitRate'> {
  const want = structureOf(kind, expected);
  const have = got && structureOf(kind, got);
  const structure = Object.fromEntries(STRUCTURE[kind].map(k => [k, have !== null && have[k] === want[k]]));
  const hits = Object.values(structure).filter(Boolean).length;
  const items = STRUCTURE[kind].length;
  return { structure, hits, items, hitRate: hits / items };
}

/** 跑一个样例；期望本身不过校验、目录里没东西可用时直接抛错（黄金集写错了） */
export async function runCase(provider: LlmProvider, c: GoldenCase): Promise<CaseResult> {
  const want = DSL_KINDS[c.kind].check(stringify(c.expected), CONTEXT);
  if (!want.ok) throw new Error(`黄金样例 ${c.id} 的期望不过校验：${want.issues.map(i => i.message).join('；')}`);
  const messages = definitionDraftMessages(c.kind, c.request, CATALOG);
  if (!Array.isArray(messages)) throw new Error(`黄金样例 ${c.id} 无法起草：${messages.unavailable}`);

  let out: object;
  try {
    out = await callModel<object>(provider, messages, definitionDraftSchema(c.kind));
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    return { id: c.id, kind: c.kind, valid: false, ...scoreStructure(c.kind, c.expected, null), failed: { stage: 'model', message: e.message } };
  }
  const got = DSL_KINDS[c.kind].check(definitionOutputToYaml(c.kind, out), CONTEXT);
  const result = { id: c.id, kind: c.kind, valid: got.ok, ...scoreStructure(c.kind, c.expected, out) };
  return got.ok ? result : { ...result, failed: { stage: 'definition', message: `定义校验不过：${got.issues.length} 个问题`, issues: got.issues.length } };
}

/** 总体：校验通过率按样例数算，命中率按结构项加权 */
export function summarize(results: CaseResult[]): Summary {
  const valid = results.filter(r => r.valid).length;
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { cases: results.length, valid, validRate: results.length ? valid / results.length : 1, hits, items, hitRate: items ? hits / items : 1 };
}

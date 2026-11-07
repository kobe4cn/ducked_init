// scripts/eval-requirements/score.ts —— 需求评测的跑分（ADR-0041）：对一个黄金样例走与产品相同的起草消息（definitionDraftMessages，固定目录）、
// 输出 Schema 与转 YAML，记下转出的定义能否过校验（checkMetric / checkTag），再与期望逐项比较结构。不读库、不写调用日志（用 callModel 而不是 chatJson）。
// 另有计划模式的评测（#423，ADR-0050）：runPlanCase 让模型对一条需求在五种模式里选一个并给出计划 JSON，validatePlan 解析出 mode，
// 与 plan-modes.ts 的期望比对。产品的 validate_plan 工具还没接入助手（P4⑮），这里的消息是评测自己拼的，接入后对齐
import { stringify } from 'yaml';
import { expand, overview, toMarkdown, type Catalog, type CatalogEntry } from '../../app/.server/catalog';
import { PLAN_MODES, PLAN_SCHEMA, semanticHash, validatePlan, type PlanMode } from '../../app/.server/catalog/plan';
import { callModel, LlmError, type LlmMessage, type LlmProvider } from '../../app/.server/llm';
import { DSL_KINDS, type DslKind } from '../../app/.server/pipeline/dsl';
import type { MetricSpec, RatioPart } from '../../app/.server/pipeline/dsl/metric-spec';
import { completeDraftPaths, definitionDraftMessages, definitionDraftSchema, definitionOutputToYaml } from '../../app/.server/pipeline/dsl/model-draft';
import { tagMetrics, type TagSpec } from '../../app/.server/pipeline/dsl/tag-spec';
import { CATALOG, CONTEXT, type GoldenCase, type GoldenEntry } from './golden';
import { expectedMode } from './plan-modes';
import { retrieve, viewerView } from './retrieval';
import { RETRIEVAL_CATALOG } from './retrieval-catalog';

/**
 * 逐项比较的结构：指标比种类、实体（base、consumer_via 与 device_attribution）、度量（agg、字段与 ratio 的分子分母）、用到的字段、过滤条件（含时间窗口）与维度路径；
 * 标签没有实体、字段与维度，比种类、引用的指标与规则（rules、default 与 missing）。
 * 字段项只收度量与时间窗口的字段（与度量项有意重叠：写错度量字段会在两项上都不命中）；过滤字段只由过滤项评，
 * ratio 分子分母的过滤在度量项里评，多一条或少一条过滤只扣一项
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
  const fields = [m.field, m.by, m.numerator?.field, m.denominator?.field, s.window?.field];
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
  // 按产品实际存下的定义打分：路径首段补过实体名的（definitionOutputToYaml 内部也补）
  const completed = completeDraftPaths(c.kind, out);
  const got = DSL_KINDS[c.kind].check(definitionOutputToYaml(c.kind, completed), CONTEXT);
  const result = { id: c.id, kind: c.kind, valid: got.ok, ...scoreStructure(c.kind, c.expected, completed) };
  return got.ok ? result : { ...result, failed: { stage: 'definition', message: `定义校验不过：${got.issues.length} 个问题`, issues: got.issues.length } };
}

/** 总体：校验通过率按样例数算，命中率按结构项加权 */
export function summarize(results: CaseResult[]): Summary {
  const valid = results.filter(r => r.valid).length;
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { cases: results.length, valid, validRate: results.length ? valid / results.length : 1, hits, items, hitRate: items ? hits / items : 1 };
}

/** 五种模式各自的含义（ADR-0050），写进 system 提示词 */
const MODE_HELP: Record<PlanMode, string> = {
  reuse_result: '目录里已有发布的指标或标签能直接回答（口径也对得上），用已有结果回答，不新增定义',
  draft_definition: '要新起草一个 DSL 指标或标签定义才能回答',
  draft_query: 'DSL 表达不了（如按消费者以外的粒度汇总、查源表或血缘、逐小时趋势），起草工作台 SQL',
  clarify: '需求有歧义或口径不明，先追问（questions 至少写一条）',
  unsupported: '平台做不到（如预测、推荐、跨窗口同比），说明原因（reason 必填）并给可行的下一步',
};

/** system 提示词：五种模式与计划 JSON 的字段（对齐 PLAN_SCHEMA 的约束） */
const PLAN_SYSTEM = [
  '你是 CRM 数据平台的分析助手：成员提一条数据分析需求，你先判断怎么回答，输出一份分析计划。只输出一个符合给定 JSON Schema 的 JSON 对象，不要输出别的文字。',
  '成员的消息里依次是语义目录总览、按需求搜出的目录条目、可选中条目的版本与语义哈希、需求原文。',
  '五种模式（mode 只能取这五个值之一）：',
  ...PLAN_MODES.map(m => `- ${m}：${MODE_HELP[m]}。`),
  '计划 JSON 的字段（schemaVersion 恒为 1）：',
  '- selected：计划要用到的目录条目，每项 { id, version, semanticHash }——id 只能取「与需求相关的条目」里出现的，version 与 semanticHash 照抄「可选中条目」清单（实体、字段条目没有版本，不写 version）；用不上条目时给空数组。',
  '- request：成员的要求。dimensions 必填（按什么分组、汇总到什么粒度）；unit、timeMeaning、windowDays、grain 只在成员明确说了才写。',
  '- steps：计划步骤，每项 { id, action, inputs }。action 是 fetch（取 selected 条目的逐消费者结果，inputs 只能是条目）、filter（收窄人群）、aggregate（分组汇总，必带 agg，inputs 恰好一个）、compare（对比，inputs 至少两个）、answer（给出回答）之一；inputs 只能引用前面出现的步骤或 selected 里的条目。',
  '- assumptions：你的假设，每项 { text, confirmed }，没有就空数组。',
  '- questions：要追问的问题，clarify 至少一条，其他模式空数组。',
  '- reason：mode 为 unsupported 时必填，其他模式不要写。',
].join('\n');

/** 该条目写进计划 selected 时的依据：指标 / 标签 / 模板带版本，语义哈希按当前目录现算（validatePlan 会比对） */
const selectableLine = (e: CatalogEntry) => {
  const versioned = e.kind === 'metric' || e.kind === 'tag' || e.kind === 'template';
  return `- ${e.id}（${versioned ? `第 ${e.version} 版，` : ''}semanticHash ${semanticHash(e)}）`;
};

export interface PlanCaseResult {
  id: string;
  /** 模型选的计划模式（validatePlan 解析出的 plan.mode）；模型调用失败或计划结构不合法时为 null */
  mode: PlanMode | null;
  /** 期望模式（plan-modes.ts 的标注） */
  expected: PlanMode;
  /** 模式一致为 true；不一致或解析失败为 false */
  correct: boolean;
  failed?: { stage: 'model' | 'plan'; message: string };
}

/**
 * 跑一条需求的计划模式：目录按角色取可见的（查看者用 viewerView），selected 只能从 retrieve 的前 20 里选，
 * 模型输出先过 PLAN_SCHEMA 再交给 validatePlan；只对解析出的 mode 计分，计划里的问题（版本 / 口径 / 可加性）不影响这一列
 */
export async function runPlanCase(provider: LlmProvider, g: GoldenEntry): Promise<PlanCaseResult> {
  const expected = expectedMode(g);
  const r = retrieve(g);
  const catalog: Catalog = g.role === 'viewer' ? viewerView(RETRIEVAL_CATALOG) : RETRIEVAL_CATALOG;
  const entries = r.top.flatMap(id => { const e = expand(catalog, id); return e ? [e] : []; });
  const user = [
    toMarkdown(overview(catalog)),
    `# 与需求相关的条目\n\n${toMarkdown(entries)}`,
    `# 可选中条目的版本与语义哈希\n\n${entries.map(selectableLine).join('\n') || '无'}`,
    `# 需求\n\n${g.request}`,
  ].join('\n\n');
  const messages: LlmMessage[] = [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: user },
  ];

  let out: object;
  try {
    out = await callModel<object>(provider, messages, PLAN_SCHEMA);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    return { id: g.id, mode: null, expected, correct: false, failed: { stage: 'model', message: e.message } };
  }
  const check = validatePlan(out, { catalog, retrieved: new Set(r.top) });
  const mode = check.plan?.mode ?? null;
  return mode === null
    ? { id: g.id, mode: null, expected, correct: false, failed: { stage: 'plan', message: `计划结构不合法（${check.issues.length} 个问题）：${check.issues[0]?.message ?? ''}` } }
    : { id: g.id, mode, expected, correct: mode === expected };
}

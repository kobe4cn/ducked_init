// scripts/eval-mapping/score.ts —— 映射评测的跑分（ADR-0035）：对一个黄金样例走与产品相同的规则草稿、表上下文（不带样本）、提示词（带固定目录，ADR-0041）
// 与模型输出转 YAML，并与产品同样部分采用（adoptModelDraft），再拿实际采用的映射与期望映射的合并计划逐字段比较。不读库、不写调用日志（用 callModel 而不是 chatJson）
import { parseDocument } from 'yaml';
import { entityOf } from '../../app/lib/canonical-model';
import { diffPlans, type PlanDiff } from '../../app/lib/mapping-diff';
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { buildTableContext } from '../../app/.server/pipeline/llm-context';
import { draftCustomMapping, draftMapping } from '../../app/.server/pipeline/mapping-draft';
import { checkMapping, type MappingIssue, type MappingSpec, type MergePlan } from '../../app/.server/pipeline/mapping-spec';
import { adoptModelDraft, MODEL_DRAFT_SCHEMA, modelDraftMessages, type ModelDraft } from '../../app/.server/pipeline/model-draft';
import { CATALOG, type GoldenCase } from './golden';

/** 失败在哪一步：模型调用（含输出不合 Schema）或映射校验 */
export type FailStage = 'model' | 'mapping';

export interface CaseResult {
  name: string;
  /** 期望列里模型做对的列数 / 期望列数 */
  accuracy: number;
  correct: number;
  expected: number;
  /** 把模型草稿改成期望映射要动的项数 */
  edits: number;
  /** problems：失败于映射校验时的问题清单（脱敏，见 redactIssues） */
  failed?: { stage: FailStage; message: string; issues?: number; problems?: Problem[] };
  /** 部分采用：去掉了哪些项（路径同审计 mapping.model_draft_partial 的 dropped）；整份通过时不带 */
  partial?: true;
  dropped?: string[];
}

/** 映射校验的一个问题：路径与消息，样本原文已换成 <值> */
export interface Problem { path: string; message: string }

const HIDDEN = '<值>';

/**
 * 映射校验问题脱敏，供评测打印与写结果文件：path 里值字典的源取值、message 里引号内的片段、「X 不是标准枚举值」的 X（模型给的值）
 * 与表达式错误「多余的内容：…」的片段都换成 <值>；标准枚举列表、列名与字段名保留；不带 hint 与行列
 */
export function redactIssues(issues: readonly MappingIssue[]): Problem[] {
  return issues.map(({ path, message }) => ({
    path: path.replace(/(^|\.)dictionary\..*$/, `$1dictionary.${HIDDEN}`),
    message: message
      .replace(/^[\s\S]*? (不是标准枚举值)/, `${HIDDEN} $1`)
      .replace(/(多余的内容：)[\s\S]*$/, `$1${HIDDEN}`)
      .replace(/「[^」]*」|"[^"]*"|“[^”]*”|'[^']*'/g, q => `${q[0]}${HIDDEN}${q.at(-1)}`),
  }));
}

export interface Score { accuracy: number; correct: number; edits: number }

/** 计划里有变化的单项配置 */
const PLAN_ITEMS = ['key', 'latest', 'identity', 'keySpace', 'survivorship', 'where'] as const;

/** 模型草稿相对期望映射的得分：期望列里没被删、没被改的算对；改动项数是增删改的列数、有变化的单项配置数与增删改的自定义断言数 */
export function scoreDiff(expected: MergePlan, diff: PlanDiff): Score {
  const total = expected.columns.length;
  if (diff.first) return { accuracy: 0, correct: 0, edits: total };
  const wrong = new Set([...diff.removed, ...diff.changed.map(c => c.name)]);
  const correct = expected.columns.filter(c => !wrong.has(c.name)).length;
  const { assertions } = diff;
  const edits = diff.added.length + diff.removed.length + diff.changed.length + PLAN_ITEMS.filter(k => diff[k] !== null).length
    + assertions.added.length + assertions.removed.length + assertions.changed.length;
  return { accuracy: total ? correct / total : 1, correct, edits };
}

/** 失败的样例：准确率 0，改动项数是期望的全部列加上写了的 dedupe / identity（各算一项：要整块手写，不按 key / latest 拆开） */
const failedScore = (spec: MappingSpec, plan: MergePlan): Score =>
  ({ accuracy: 0, correct: 0, edits: plan.columns.length + (spec.dedupe ? 1 : 0) + (spec.identity ? 1 : 0) });

/** 删掉顶层 extensions：规则草稿里的扩展字段会被 modelOutputToYaml 保留，期望映射没有，不去掉会多算新增列 */
function withoutExtensions(text: string) {
  const doc = parseDocument(text);
  doc.delete('extensions');
  return doc.toString({ nullStr: 'null', lineWidth: 0 });
}

/**
 * 跑一个样例；期望 YAML 本身不过校验、实体不存在时直接抛错（黄金集写错了）。
 * 自定义实体样例与产品一样：规则草稿用 draftCustomMapping，校验带登记，不删 extensions（自定义实体只有 extensions）
 */
export async function runCase(c: GoldenCase, provider: LlmProvider): Promise<CaseResult> {
  const columns = () => c.profile.columns.map(({ name, type }) => ({ name, type }));
  const reg = c.registration;
  const customEntities = reg && new Map([[reg.name, reg]]);
  // 标准实体去掉 extensions 再校验与算分：规则草稿里的扩展字段期望映射没有
  const check = (y: string) => checkMapping(reg ? y : withoutExtensions(y), columns, customEntities);
  const want = checkMapping(c.expectedYaml, columns, customEntities);
  if (!want.ok) throw new Error(`黄金样例 ${c.name} 的期望映射不过校验：${want.issues.map(i => i.message).join('；')}`);
  let rulesYaml: string;
  if (reg) {
    rulesYaml = draftCustomMapping(c.profile, reg);
  } else {
    const entity = entityOf(c.entity);
    if (!entity) throw new Error(`黄金样例 ${c.name} 的实体 ${c.entity} 不存在`);
    rulesYaml = draftMapping(c.profile, entity);
  }
  const base = { name: c.name, expected: want.plan.columns.length };
  const fail = (stage: FailStage, message: string, issues?: readonly MappingIssue[]): CaseResult =>
    ({ ...base, ...failedScore(want.spec, want.plan), failed: { stage, message, ...(issues && { issues: issues.length, problems: redactIssues(issues) }) } });

  let out: ModelDraft;
  try {
    out = await callModel<ModelDraft>(provider, modelDraftMessages(buildTableContext(c.profile), c.entity, rulesYaml, CATALOG), MODEL_DRAFT_SCHEMA);
  } catch (e) {
    if (e instanceof LlmError) return fail('model', e.message);
    throw e;
  }
  // 传给 adoptModelDraft 的是原始规则草稿（dropItems 按它退回个别项）
  const r = await adoptModelDraft(rulesYaml, out, (y) => {
    const g = check(y);
    return g.ok ? [] : g.issues;
  });
  if (r.status === 'rejected') return fail('mapping', `映射校验不过：${r.issues.length} 个问题`, r.issues);
  const got = check(r.yaml);
  if (!got.ok) throw new Error(`样例 ${c.name} 采用的映射不过校验`);
  return {
    ...base, ...scoreDiff(want.plan, diffPlans(want.plan, got.plan)),
    ...(r.status === 'partial' && { partial: true as const, dropped: r.dropped }),
  };
}

/** 按样例数计：整份通过、部分采用（去掉了个别项）、失败 */
export interface CaseCounts { full: number; partial: number; failed: number }

/** 总体：准确率按列加权（做对的列总数 / 期望列总数），改动项数取各例之和；另按样例数分开计整份通过、部分采用与失败 */
export function summarize(results: CaseResult[]): Score & { expected: number } & CaseCounts {
  const correct = results.reduce((n, r) => n + r.correct, 0);
  const expected = results.reduce((n, r) => n + r.expected, 0);
  const failed = results.filter(r => r.failed).length;
  const partial = results.filter(r => !r.failed && r.partial).length;
  return {
    accuracy: expected ? correct / expected : 1, correct, expected, edits: results.reduce((n, r) => n + r.edits, 0),
    full: results.length - failed - partial, partial, failed,
  };
}

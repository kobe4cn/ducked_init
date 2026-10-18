// scripts/eval-mapping/score.ts —— 映射评测的跑分（ADR-0035）：对一个黄金样例走与产品相同的规则草稿、表上下文（不带样本）、提示词与模型输出转 YAML，
// 再与期望映射的合并计划逐字段比较。不读库、不写调用日志（用 callModel 而不是 chatJson）
import { parseDocument } from 'yaml';
import { entityOf } from '../../app/lib/canonical-model';
import { diffPlans, type PlanDiff } from '../../app/lib/mapping-diff';
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { buildTableContext } from '../../app/.server/pipeline/llm-context';
import { draftMapping } from '../../app/.server/pipeline/mapping-draft';
import { checkMapping, type MappingSpec, type MergePlan } from '../../app/.server/pipeline/mapping-spec';
import { MODEL_DRAFT_SCHEMA, modelDraftMessages, modelOutputToYaml, type ModelDraft } from '../../app/.server/pipeline/model-draft';
import type { GoldenCase } from './golden';

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
  failed?: { stage: FailStage; message: string; issues?: number };
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

/** 跑一个样例；期望 YAML 本身不过校验、实体不存在时直接抛错（黄金集写错了） */
export async function runCase(c: GoldenCase, provider: LlmProvider): Promise<CaseResult> {
  const columns = () => c.profile.columns.map(({ name, type }) => ({ name, type }));
  const want = checkMapping(c.expectedYaml, columns);
  if (!want.ok) throw new Error(`黄金样例 ${c.name} 的期望映射不过校验：${want.issues.map(i => i.message).join('；')}`);
  const entity = entityOf(c.entity);
  if (!entity) throw new Error(`黄金样例 ${c.name} 的实体 ${c.entity} 不存在`);
  const base = { name: c.name, expected: want.plan.columns.length };
  const fail = (stage: FailStage, message: string, issues?: number): CaseResult =>
    ({ ...base, ...failedScore(want.spec, want.plan), failed: { stage, message, ...(issues !== undefined && { issues }) } });

  const rulesYaml = draftMapping(c.profile, entity);
  let out: ModelDraft;
  try {
    out = await callModel<ModelDraft>(provider, modelDraftMessages(buildTableContext(c.profile), c.entity, rulesYaml), MODEL_DRAFT_SCHEMA);
  } catch (e) {
    if (e instanceof LlmError) return fail('model', e.message);
    throw e;
  }
  const got = checkMapping(withoutExtensions(modelOutputToYaml(rulesYaml, out).yaml), columns);
  if (!got.ok) return fail('mapping', `映射校验不过：${got.issues.length} 个问题`, got.issues.length);
  return { ...base, ...scoreDiff(want.plan, diffPlans(want.plan, got.plan)) };
}

/** 总体：准确率按列加权（做对的列总数 / 期望列总数），改动项数取各例之和 */
export function summarize(results: CaseResult[]): Score & { expected: number } {
  const correct = results.reduce((n, r) => n + r.correct, 0);
  const expected = results.reduce((n, r) => n + r.expected, 0);
  return { accuracy: expected ? correct / expected : 1, correct, expected, edits: results.reduce((n, r) => n + r.edits, 0) };
}

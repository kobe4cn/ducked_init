// scripts/eval-assertions/score.ts —— 断言起草评测的跑分（ADR-0035）：对一个黄金样例走与产品相同的表上下文（不带样本）、提示词、输出 Schema 与转 YAML，
// 按模型给出的断言数必须给的命中几条、不该给的避开几条，再看转出的映射整份过不过校验。不读库、不写调用日志（用 callModel 而不是 chatJson）
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { buildTableContext, type TableContext } from '../../app/.server/pipeline/llm-context';
import { checkMapping } from '../../app/.server/pipeline/mapping-spec';
import { ASSERTION_DRAFT_SCHEMA, assertionDraftMessages, assertionsToYaml, type AssertionDraft } from '../../app/.server/pipeline/model-draft';
import { hashPrompt } from '../eval-shared/report';
import type { AssertionCase, Expected } from './golden';

export interface CaseResult {
  name: string;
  /** 必须给的都给了、不该给的都没给、转出的映射整份过校验 */
  pass: boolean;
  /** 命中的必须项数加避开的禁止项数 */
  hits: number;
  /** 必须项数加禁止项数 */
  items: number;
  /** 失败在哪一步：模型调用（含输出不合 Schema）或映射校验 */
  stage?: 'model' | 'mapping';
}

export interface Total { passRate: number; hitRate: number }

const EMPTY_CONTEXT: TableContext = { table: '', rows: 0, primaryKey: [], keyCandidates: [], columns: [] };

/** 提示词哈希：断言建议的 system 消息加输出 Schema */
export const PROMPT_HASH = hashPrompt(assertionDraftMessages(EMPTY_CONTEXT, '')[0].content, ASSERTION_DRAFT_SCHEMA);

/**
 * 跑一个样例。命中按模型原始输出算（不该给的给了就扣，哪怕映射校验会挡住它）；映射校验按整份算，
 * 不像产品那样丢掉个别不过校验的断言再采用其余（#1222），评测要看的是模型一次给对没有
 */
export async function runCase(c: AssertionCase, provider: LlmProvider): Promise<CaseResult> {
  const items = c.require.length + c.forbid.length;
  let out: AssertionDraft;
  try {
    out = await callModel<AssertionDraft>(provider, assertionDraftMessages(buildTableContext(c.profile), c.yaml), ASSERTION_DRAFT_SCHEMA);
  } catch (e) {
    if (e instanceof LlmError) return { name: c.name, pass: false, hits: 0, items, stage: 'model' };
    throw e;
  }
  const given = (e: Expected) => out.assertions.some(a => a.field === e.field && a.check === e.check);
  const required = c.require.filter(given).length;
  const avoided = c.forbid.filter(e => !given(e)).length;
  const hits = required + avoided;
  const checked = checkMapping(assertionsToYaml(c.yaml, out).yaml, () => c.profile.columns.map(({ name, type }) => ({ name, type })));
  if (!checked.ok) return { name: c.name, pass: false, hits, items, stage: 'mapping' };
  return { name: c.name, pass: hits === items, hits, items };
}

/** 总体：通过率按例，命中率按项加权（命中总数 / 项数总数） */
export function summarize(results: CaseResult[]): Total {
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { passRate: results.length ? results.filter(r => r.pass).length / results.length : 1, hitRate: items ? hits / items : 1 };
}

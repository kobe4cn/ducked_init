// scripts/eval-interpret/score.ts —— 工作台结果解读评测的跑分（ADR-0043）：对一个黄金样例走与产品相同的剔除、数值事实、提示词与输出 Schema（interpretRequest），
// 再按与产品相同的口径核对数字出处（uncitedNumbers，出处是发出去的 user 消息），看点名最大组、不出现敏感取值命中几项。
// 不查权限、不重跑 SQL、不写对话与审计、不写调用日志（用 callModel 而不是 chatJson）
// 先加载助手工具再加载 workbench-ai：两者循环引用（tools 顶层用到 workbench-ai 的 MAX_CELL），直接从 workbench-ai 进入时 node 报 MAX_CELL 未初始化；产品里一直是先加载 tools
import '../../app/.server/assistant/tools';
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { uncitedNumbers } from '../../app/.server/interpretation-numbers';
import type { WorkbenchResult } from '../../app/.server/pipeline/workbench-engine';
import { INTERPRET_SCHEMA, interpretRequest } from '../../app/.server/workbench-ai';
import { hashPrompt } from '../eval-shared/report';
import type { InterpretCase } from './golden';

export interface CaseResult {
  name: string;
  /** 各项全中 */
  pass: boolean;
  /** 命中的项数：数字都有出处、点名了最大组（有期望才算）、没出现敏感取值（有期望才算） */
  hits: number;
  /** 项数 */
  items: number;
  /** 失败在哪一步：模型调用（含输出不合 Schema） */
  stage?: 'model';
}

export interface Total { passRate: number; hitRate: number }

/** 算提示词哈希用的极小合成结果：一份分组、一份明细（带 customer_id） */
const GROUPED: WorkbenchResult = { columns: [{ name: 'city', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }], rows: [['a', 1]], truncated: false };
const DETAIL: WorkbenchResult = { columns: [{ name: 'customer_id', type: 'VARCHAR' }, { name: 'n', type: 'BIGINT' }], rows: [['a', 1]], truncated: false };

/** 提示词哈希：分组 / 明细 × 样本开 / 关四种 system 消息加输出 Schema，任何一种改了都会变 */
export const PROMPT_HASH = hashPrompt(
  [GROUPED, DETAIL].flatMap(r => [true, false].map(samples => interpretRequest(r, 'SELECT 1', samples).messages[0]!.content)).join('\n'),
  INTERPRET_SCHEMA,
);

/** 跑一个样例：只记命中，不带模型原文与错误信息（错误信息可能含 URL） */
export async function runCase(c: InterpretCase, provider: LlmProvider): Promise<CaseResult> {
  const items = 1 + (c.expect.maxAt ? 1 : 0) + (c.expect.noValues ? 1 : 0);
  const { messages } = interpretRequest(c.result, c.sql, c.samples);
  let text: string;
  try {
    ({ interpretation: text } = await callModel<{ interpretation: string }>(provider, messages, INTERPRET_SCHEMA));
  } catch (e) {
    if (e instanceof LlmError) return { name: c.name, pass: false, hits: 0, items, stage: 'model' };
    throw e;
  }
  const sent = messages.find(m => m.role === 'user')?.content ?? '';
  const hits = (uncitedNumbers(text, sent).length ? 0 : 1)
    + (c.expect.maxAt && text.includes(c.expect.maxAt) ? 1 : 0)
    + (c.expect.noValues && !c.expect.noValues.some(v => text.includes(v)) ? 1 : 0);
  return { name: c.name, pass: hits === items, hits, items };
}

/** 总体：通过率按例，命中率按项加权（命中总数 / 项数总数） */
export function summarize(results: CaseResult[]): Total {
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { passRate: results.length ? results.filter(r => r.pass).length / results.length : 1, hitRate: items ? hits / items : 1 };
}

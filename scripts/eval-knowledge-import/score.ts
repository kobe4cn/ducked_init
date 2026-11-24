// scripts/eval-knowledge-import/score.ts —— 知识导入评测的跑分（ADR-0035 / 0046）：对一个黄金样例走与产品相同的输入（restricted 目录投影，ADR-0047）、
// 提示词、输出 Schema 与 outputToProposals，按转出的提案输入（ProposalInput.content，不是模型原始输出）看期望的关键提案命中几条。
// 不读库、不写调用日志（用 callModel 而不是 chatJson，不调要连库的 importFromSource）；不调 dropKnown：固定目录没有已有别名，期望也避开了系统口径
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import {
  IMPORT_SCHEMA, importInput, importMessages, outputToProposals, type ImportDropReason, type ImportOutput,
} from '../../app/.server/knowledge/import-draft';
import type { ProposalInput } from '../../app/.server/knowledge/proposals';
import { hashPrompt } from '../eval-shared/report';
import { CATALOG } from '../eval-requirements/golden';
import type { ExpectedProposal, ImportCase } from './golden';

export interface CaseResult {
  name: string;
  /** 没有被丢弃的提案，期望的都命中；empty 例一条提案都没给 */
  pass: boolean;
  /** 命中的期望条数（empty 例没给提案记 1） */
  hits: number;
  /** 期望条数，empty 例记 1 */
  items: number;
  /** 失败在哪一步：模型调用（含输出不合 Schema）、outputToProposals 丢了条目、提案没命中期望（或 empty 例给了提案） */
  stage?: 'model' | 'dropped' | 'proposals';
  /** 被丢弃条目的原因（只有原因枚举，不放目标与内容） */
  dropped?: ImportDropReason[];
}

export interface Total { passRate: number; hitRate: number }

/** 提示词哈希：知识导入的 system 消息加输出 Schema */
export const PROMPT_HASH = hashPrompt(importMessages({ paragraphs: [], entries: [] })[0]!.content, IMPORT_SCHEMA);

const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/** 一条提案输入是否命中期望：kind 与 targetId 相同，alias 比 trim 后不分大小写（同 dropKnown），claim 比 type 与 value */
function matches(p: ProposalInput, e: ExpectedProposal): boolean {
  if (p.kind !== e.kind || p.targetId !== e.targetId) return false;
  const c = p.content;
  if (typeof c !== 'object' || c === null) return false;
  if (e.kind === 'alias') return 'alias' in c && norm(c.alias) === norm(e.alias);
  if (e.kind === 'claim') return 'type' in c && 'value' in c && c.type === e.claimType && c.value === e.claimValue;
  return true;
}

/** 跑一个样例：dropped 非空就不通过（stage: 'dropped'），否则看期望是否全中、empty 例是否一条都没给 */
export async function runCase(c: ImportCase, provider: LlmProvider): Promise<CaseResult> {
  const items = c.empty ? 1 : c.expect.length;
  const input = importInput({ paragraphs: c.paragraphs }, CATALOG);
  let output: ImportOutput;
  try {
    output = await callModel<ImportOutput>(provider, importMessages(input), IMPORT_SCHEMA);
  } catch (err) {
    if (err instanceof LlmError) return { name: c.name, pass: false, hits: 0, items, stage: 'model' };
    throw err;
  }
  const { inputs, dropped } = outputToProposals(output, input, { id: 'eval', version: 1 });
  const hits = c.empty ? (inputs.length ? 0 : 1) : c.expect.filter(x => inputs.some(p => matches(p, x))).length;
  if (dropped.length) return { name: c.name, pass: false, hits, items, stage: 'dropped', dropped: dropped.map(d => d.reason) };
  if (hits < items) return { name: c.name, pass: false, hits, items, stage: 'proposals' };
  return { name: c.name, pass: true, hits, items };
}

/** 总体：通过率按例，命中率按项加权（命中总数 / 项数总数），空集记 1 */
export function summarize(results: CaseResult[]): Total {
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { passRate: results.length ? results.filter(r => r.pass).length / results.length : 1, hitRate: items ? hits / items : 1 };
}

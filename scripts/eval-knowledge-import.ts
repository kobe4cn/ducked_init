// scripts/eval-knowledge-import.ts —— 用法：pnpm eval:knowledge-import（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 知识导入的评测（ADR-0035 / 0046）：对黄金集（scripts/eval-knowledge-import/golden）的每个样例，用真实模型服务走与产品相同的输入、提示词、输出 Schema
// 与 outputToProposals，看期望的关键提案命中几条、有没有被丢弃的条目、「做不到」的样例是否一条都没给，打印每例与总体的通过率、命中率；
// 结果另存到 scripts/eval-knowledge-import/out/<时间戳>-<模型>.json（只有 name / pass / hits / items / stage / dropped 原因）。
// 不连平台库，不进 CI；不打印也不保存 Key、完整 URL、段落、请求与模型原文
import { join } from 'node:path';
import { platformProvider } from '../app/.server/llm';
import { KNOWLEDGE_IMPORT_GOLDEN } from './eval-knowledge-import/golden';
import { PROMPT_HASH, runCase, summarize, type CaseResult } from './eval-knowledge-import/score';
import { reportMeta, requireLlmEnv, writeReport } from './eval-shared/report';

requireLlmEnv();
const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const STAGE = { model: '模型调用', dropped: '提案被丢弃', proposals: '提案不符' } as const;

const startedAt = new Date();
console.log(`模型 ${provider.model}，${KNOWLEDGE_IMPORT_GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of KNOWLEDGE_IMPORT_GOLDEN) {
  const r = await runCase(c, provider);
  results.push(r);
  const why = r.stage ? `  失败于${STAGE[r.stage]}${r.dropped ? `（${r.dropped.join('、')}）` : ''}` : '';
  console.log(`${r.name.padEnd(24)} ${r.pass ? '通过' : '未过'}  命中 ${r.hits}/${r.items}${why}`);
}
const total = summarize(results);
console.log(`${'总体'.padEnd(22)} 通过率 ${pct(total.passRate)}  命中率 ${pct(total.hitRate)}`);

const file = writeReport(join(import.meta.dirname, 'eval-knowledge-import', 'out'), {
  ...reportMeta({ model: provider.model, baseUrl: provider.baseUrl, startedAt }, PROMPT_HASH),
  cases: results,
  total,
});
console.log(`结果已写入 ${file}`);

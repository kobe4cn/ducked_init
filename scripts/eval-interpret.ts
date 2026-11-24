// scripts/eval-interpret.ts —— 用法：pnpm eval:interpret（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 工作台结果解读的评测（ADR-0043）：对黄金集（scripts/eval-interpret/golden，合成结果）的每个样例，用真实模型服务走与产品相同的剔除、数值事实、提示词与输出 Schema，
// 看解读里的数字有没有出处（与产品同一套核对）、有没有点名最大组、明细有没有带出敏感取值，打印每例与总体的通过率、命中率；
// 结果另存到 scripts/eval-interpret/out/<时间戳>-<模型>.json。不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { join } from 'node:path';
import { platformProvider } from '../app/.server/llm';
import { INTERPRET_GOLDEN } from './eval-interpret/golden';
import { PROMPT_HASH, runCase, summarize, type CaseResult } from './eval-interpret/score';
import { reportMeta, requireLlmEnv, writeReport } from './eval-shared/report';

requireLlmEnv();
const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const startedAt = new Date();
console.log(`模型 ${provider.model}，${INTERPRET_GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of INTERPRET_GOLDEN) {
  const r = await runCase(c, provider);
  results.push(r);
  console.log(`${r.name.padEnd(28)} ${r.pass ? '通过' : '未过'}  命中 ${r.hits}/${r.items}${r.stage ? '  失败于模型调用' : ''}`);
}
const total = summarize(results);
console.log(`${'总体'.padEnd(26)} 通过率 ${pct(total.passRate)}  命中率 ${pct(total.hitRate)}`);

const file = writeReport(join(import.meta.dirname, 'eval-interpret', 'out'), {
  ...reportMeta({ model: provider.model, baseUrl: provider.baseUrl, startedAt }, PROMPT_HASH),
  cases: results,
  total,
});
console.log(`结果已写入 ${file}`);

// scripts/eval-assertions.ts —— 用法：pnpm eval:assertions（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 断言起草的评测（ADR-0035）：对黄金集（scripts/eval-assertions/golden）的每个样例，用真实模型服务走与产品相同的表上下文、提示词、输出 Schema 与转 YAML，
// 看必须给的断言给了几条、不该给的避开几条、转出的映射过不过校验，打印每例与总体的通过率、命中率；结果另存到 scripts/eval-assertions/out/<时间戳>-<模型>.json。
// 与产品的差别：评测不带样本行，产品在数据源允许样本时会带（app/.server/model-provider.ts）；产品在个别断言不过校验时丢掉它们采用其余，评测按整份算。
// 不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { join } from 'node:path';
import { platformProvider } from '../app/.server/llm';
import { ASSERTION_GOLDEN } from './eval-assertions/golden';
import { PROMPT_HASH, runCase, summarize, type CaseResult } from './eval-assertions/score';
import { reportMeta, requireLlmEnv, writeReport } from './eval-shared/report';

requireLlmEnv();
const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const STAGE = { model: '模型调用', mapping: '映射校验' } as const;

const startedAt = new Date();
console.log(`模型 ${provider.model}，${ASSERTION_GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of ASSERTION_GOLDEN) {
  const r = await runCase(c, provider);
  results.push(r);
  console.log(`${r.name.padEnd(24)} ${r.pass ? '通过' : '未过'}  命中 ${r.hits}/${r.items}${r.stage ? `  失败于${STAGE[r.stage]}` : ''}`);
}
const total = summarize(results);
console.log(`${'总体'.padEnd(22)} 通过率 ${pct(total.passRate)}  命中率 ${pct(total.hitRate)}`);

const file = writeReport(join(import.meta.dirname, 'eval-assertions', 'out'), {
  ...reportMeta({ model: provider.model, baseUrl: provider.baseUrl, startedAt }, PROMPT_HASH),
  cases: results,
  total,
});
console.log(`结果已写入 ${file}`);

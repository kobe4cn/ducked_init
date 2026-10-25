// scripts/eval-requirements.ts —— 用法：pnpm eval:requirements（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 指标与标签起草的评测（ADR-0041，与 pnpm eval:mapping 并列）：对黄金集（scripts/eval-requirements/golden）的每条需求，用真实模型服务
// 走与产品相同的起草消息（固定目录）、输出 Schema 与转 YAML，打印每例与总体的校验通过率与结构命中率，没命中的项与失败阶段一并标出。
// 不连平台库，不进 CI；不打印 Key、完整 URL、请求与模型原文
import { platformProvider } from '../app/.server/llm';
import { GOLDEN } from './eval-requirements/golden';
import { runCase, summarize, type CaseResult } from './eval-requirements/score';

const VARS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;
const missing = VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}（写进 .env 或在命令前设置）`);
  process.exit(2);
}

const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`模型 ${provider.model}，${GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of GOLDEN) {
  const r = await runCase(provider, c);
  results.push(r);
  const misses = Object.entries(r.structure).filter(([, hit]) => !hit).map(([k]) => k);
  const failed = r.failed ? `  失败于${r.failed.stage === 'model' ? '模型调用' : '定义校验'}：${r.failed.message}` : '';
  console.log(`${`${r.id}（${r.kind}）`.padEnd(36)} 校验 ${r.valid ? '通过' : '不过'}  命中率 ${pct(r.hitRate).padStart(6)}（${r.hits}/${r.items}）${misses.length ? `  未命中：${misses.join('、')}` : ''}${failed}`);
}
const total = summarize(results);
console.log(`${'总体'.padEnd(34)} 校验通过率 ${pct(total.validRate)}（${total.valid}/${total.cases}）  命中率 ${pct(total.hitRate)}（${total.hits}/${total.items}）`);

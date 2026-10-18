// scripts/eval-mapping.ts —— 用法：pnpm eval:mapping（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 映射生成的评测（ADR-0035）：对黄金集（scripts/eval-mapping/golden）的每个样例，用真实模型服务走与产品相同的规则草稿、表上下文、提示词与转 YAML，
// 与期望映射逐字段比较，打印每例与总体的准确率、人工改动项数，失败的样例标出失败阶段；结果另存到 scripts/eval-mapping/out/<时间戳>-<模型>.json，
// 供 pnpm eval:mapping:compare 对比两次。不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformProvider } from '../app/.server/llm';
import { GOLDEN } from './eval-mapping/golden';
import { reportFileName, toReport } from './eval-mapping/report';
import { runCase, summarize, type CaseResult } from './eval-mapping/score';

const VARS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;
const missing = VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join('、')}（写进 .env 或在命令前设置）`);
  process.exit(2);
}

const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const startedAt = new Date();
console.log(`模型 ${provider.model}，${GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of GOLDEN) {
  const r = await runCase(c, provider);
  results.push(r);
  const failed = r.failed ? `  失败于${r.failed.stage === 'model' ? '模型调用' : '映射校验'}：${r.failed.message}` : '';
  console.log(`${r.name.padEnd(28)} 准确率 ${pct(r.accuracy).padStart(6)}（${r.correct}/${r.expected}）  改动 ${String(r.edits).padStart(2)}${failed}`);
}
const total = summarize(results);
console.log(`${'总体'.padEnd(26)} 准确率 ${pct(total.accuracy).padStart(6)}（${total.correct}/${total.expected}）  改动 ${String(total.edits).padStart(2)}`);

const report = toReport(results, total, { model: provider.model, baseUrl: provider.baseUrl, startedAt });
const outDir = join(import.meta.dirname, 'eval-mapping', 'out');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, reportFileName(report));
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`结果已写入 ${file}`);

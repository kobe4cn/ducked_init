// scripts/eval-workbench-draft.ts —— 用法：pnpm eval:workbench-draft（.env 或环境变量里要有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 工作台 SQL 起草的评测（ADR-0043）：对黄金集（scripts/eval-workbench-draft/golden）的每个样例，用真实模型服务走与产品相同的目录文本、提示词与输出 Schema，
// 在内存 DuckDB 上按工作台白名单校验（只解析，不挂湖、不执行），看引用的表与必须含的片段命中几项、做不到的样例有没有回答做不到，
// 打印每例与总体的通过率、命中率；结果另存到 scripts/eval-workbench-draft/out/<时间戳>-<模型>.json。
// 与产品的差别：目录是固定手写的，没有结果层快照、沙箱、分享与原始层。不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { platformProvider } from '../app/.server/llm';
import { WORKBENCH_DRAFT_GOLDEN } from './eval-workbench-draft/golden';
import { PROMPT_HASH, runCase, summarize, type CaseResult } from './eval-workbench-draft/score';
import { reportMeta, requireLlmEnv, writeReport } from './eval-shared/report';

requireLlmEnv();
const provider = platformProvider();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const STAGE = { model: '模型调用', sql: '该答做不到却给了 SQL', unsupported: '回答做不到', check: '白名单校验' } as const;

const con = await (await DuckDBInstance.create(':memory:')).connect();
const startedAt = new Date();
console.log(`模型 ${provider.model}，${WORKBENCH_DRAFT_GOLDEN.length} 个样例`);
const results: CaseResult[] = [];
for (const c of WORKBENCH_DRAFT_GOLDEN) {
  const r = await runCase(c, provider, con);
  results.push(r);
  console.log(`${r.name.padEnd(24)} ${r.pass ? '通过' : '未过'}  命中 ${r.hits}/${r.items}${r.stage ? `  失败于${STAGE[r.stage]}` : ''}`);
}
con.closeSync();
const total = summarize(results);
console.log(`${'总体'.padEnd(22)} 通过率 ${pct(total.passRate)}  命中率 ${pct(total.hitRate)}`);

const file = writeReport(join(import.meta.dirname, 'eval-workbench-draft', 'out'), {
  ...reportMeta({ model: provider.model, baseUrl: provider.baseUrl, startedAt }, PROMPT_HASH),
  cases: results,
  total,
});
console.log(`结果已写入 ${file}`);

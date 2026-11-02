// scripts/eval-requirements.ts —— 用法：pnpm eval:requirements（起草部分要 .env 或环境变量里有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 指标与标签起草的评测（ADR-0041，与 pnpm eval:mapping 并列）。先对全部黄金集跑检索（不调模型，总是输出）：按失败类型 a–d 与合计
// 打印 Recall@20、追问正确率、应追问召回（追问 = 服务端的歧义判定，ADR-0047），计划模式还没上线只留一列（ADR-0050）；调参集与验收集
// （golden.ts 的 HOLDOUT，不参与调参）各一张 Markdown 表，可直接贴进 docs/test-plans/requirements-eval-baseline.md。
// 再在有 LLM_* 时对有 expected 的样例用真实模型服务走与产品相同的起草消息（固定目录）、输出 Schema 与转 YAML，打印每例与调参集 / 验收集
// 的校验通过率与结构命中率；缺密钥只跳过起草。结果另存到 scripts/eval-requirements/out/<时间戳>-<模型名或 deterministic>.json。
// 不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformProvider } from '../app/.server/llm';
import { GOLDEN, GOLDEN_ALL, HOLDOUT } from './eval-requirements/golden';
import { GROUP_KEYS, groupByType, retrievalRows, type GroupKey, type GroupStats, type RetrievalRow } from './eval-requirements/retrieval';
import { runCase, summarize, type CaseResult, type Summary } from './eval-requirements/score';

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

/** 分组表（Markdown）：每类一行加合计 */
function table(title: string, groups: Record<GroupKey, GroupStats>) {
  console.log(`\n${title}\n`);
  console.log('| 失败类型 | 条数 | Recall@20 | 追问正确率 | 应追问召回 | 计划模式 |');
  console.log('|---|---|---|---|---|---|');
  for (const k of GROUP_KEYS) {
    const g = groups[k];
    console.log(`| ${k} | ${g.cases} | ${pct(g.recall)} | ${pct(g.clarifyAccuracy)} | ${pct(g.clarifyRecall)} | 未上线 |`);
  }
}

const startedAt = new Date();
const rows = retrievalRows(GOLDEN_ALL);
const split = (rs: RetrievalRow[]) => ({ tuning: groupByType(rs.filter(r => !r.holdout)), holdout: groupByType(rs.filter(r => r.holdout)) });
const retrieval = split(rows);
console.log(`检索与追问：${GOLDEN_ALL.length} 条（调参集 ${GOLDEN_ALL.length - HOLDOUT.size}，验收集 ${HOLDOUT.size}），确定性 search()`);
table('调参集', retrieval.tuning);
table('验收集（不参与调参，只在验收时看）', retrieval.holdout);

const VARS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;
const missing = VARS.filter(v => !process.env[v]);
let model = 'deterministic';
const drafts: CaseResult[] = [];
let draftTotals: { tuning: Summary; holdout: Summary } | null = null;
if (missing.length) {
  console.log(`\n起草：跳过（缺少环境变量 ${missing.join('、')}，写进 .env 或在命令前设置）`);
} else {
  const provider = platformProvider();
  model = provider.model;
  console.log(`\n起草：模型 ${provider.model}，${GOLDEN.length} 个样例`);
  for (const c of GOLDEN) {
    const r = await runCase(provider, c);
    drafts.push(r);
    const misses = Object.entries(r.structure).filter(([, hit]) => !hit).map(([k]) => k);
    const failed = r.failed ? `  失败于${r.failed.stage === 'model' ? '模型调用' : '定义校验'}：${r.failed.message}` : '';
    console.log(`${`${r.id}（${r.kind}）`.padEnd(36)} 校验 ${r.valid ? '通过' : '不过'}  命中率 ${pct(r.hitRate).padStart(6)}（${r.hits}/${r.items}）${misses.length ? `  未命中：${misses.join('、')}` : ''}${failed}`);
  }
  draftTotals = { tuning: summarize(drafts.filter(r => !HOLDOUT.has(r.id))), holdout: summarize(drafts.filter(r => HOLDOUT.has(r.id))) };
  for (const [label, total] of [['总体（调参集）', draftTotals.tuning], ['总体（验收集）', draftTotals.holdout]] as const) {
    console.log(`${label.padEnd(30)} 校验通过率 ${pct(total.validRate)}（${total.valid}/${total.cases}）  命中率 ${pct(total.hitRate)}（${total.hits}/${total.items}）`);
  }
}

const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();
const byId = new Map(drafts.map(r => [r.id, r]));
const report = {
  model,
  startedAt: startedAt.toISOString(),
  commit,
  retrieval,
  drafts: draftTotals,
  // rows 与 GOLDEN_ALL 按下标一一对应
  cases: rows.map(({ id, type, holdout, recall, top1, asked, shouldAsk }, i) =>
    ({ id, type, holdout, recall, top1, ambiguous: asked, shouldAsk, clarify: GOLDEN_ALL[i].clarify, draft: byId.get(id) ?? null })),
};
const outDir = join(import.meta.dirname, 'eval-requirements', 'out');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${report.startedAt.replace(/[:.]/g, '-')}-${model.replace(/[/\\]/g, '_')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n结果已写入 ${file}`);

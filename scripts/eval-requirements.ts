// scripts/eval-requirements.ts —— 用法：pnpm eval:requirements（调模型的部分要 .env 或环境变量里有 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY）
// 指标与标签起草的评测（ADR-0041，与 pnpm eval:mapping 并列）。先对全部黄金集跑检索（不调模型，总是输出）：按失败类型 a–d 与合计
// 打印 Recall@20、追问正确率、应追问召回（追问 = 服务端的歧义判定，ADR-0047）与计划模式正确率（ADR-0050：runPlanCase 让真实模型对每条
// 需求选五种模式之一，validatePlan 解析出的 mode 与 plan-modes.ts 的期望比对，调用或解析失败也算跑过、记错；没配 LLM_* 时这一列是「未运行」）；调参集与验收集
// （golden.ts 的 HOLDOUT，不参与调参）各一张 Markdown 表，可直接贴进 docs/test-plans/requirements-eval-baseline.md。
// 有 LLM_* 时先用真实模型对全部条目跑计划模式（runPlanCase）再打这两张表。
// 再在配了 LLM_EMBEDDING_*（三项都有，与 chat 的 LLM_* 互不影响）时对固定目录真实算一次向量，调参集与验收集各打印「向量关 / 向量开」
// 两组指标与合计 Recall@20 的差值（#416，ADR-0049）；没配只跳过开关对比。
// 最后在有 LLM_* 时对有 expected 的样例用真实模型服务走与产品相同的起草消息（固定目录）、输出 Schema 与转 YAML，打印每例与调参集 / 验收集
// 的校验通过率与结构命中率；缺密钥跳过计划模式与起草。结果另存到 scripts/eval-requirements/out/<时间戳>-<模型名或 deterministic>.json。
// 不连平台库，不进 CI；不打印也不保存 Key、完整 URL、请求与模型原文
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmp } from '../app/lib/compare';
import { callEmbeddings, platformEmbeddingProvider, platformProvider } from '../app/.server/llm';
import { GOLDEN, GOLDEN_ALL, HOLDOUT } from './eval-requirements/golden';
import { GROUP_KEYS, groupByType, retrievalRows, VIEWS, type GroupKey, type GroupStats, type RetrievalRow, type RetrievalVectors } from './eval-requirements/retrieval';
import { runCase, runPlanCase, summarize, type CaseResult, type Summary } from './eval-requirements/score';

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
/** 百分点差值（开 − 关），正数带 + */
const pp = (x: number | null) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`);
/** 没跑模型时模式正确率不可算，与 pct 的「—」区分开 */
const modePct = (x: number | null) => (x === null ? '未运行' : pct(x));

/** 分组表（Markdown）：每类一行加合计 */
function table(title: string, groups: Record<GroupKey, GroupStats>) {
  console.log(`\n${title}\n`);
  console.log('| 失败类型 | 条数 | Recall@20 | 追问正确率 | 应追问召回 | 计划模式 |');
  console.log('|---|---|---|---|---|---|');
  for (const k of GROUP_KEYS) {
    const g = groups[k];
    console.log(`| ${k} | ${g.cases} | ${pct(g.recall)} | ${pct(g.clarifyAccuracy)} | ${pct(g.clarifyRecall)} | ${modePct(g.modeAccuracy)} |`);
  }
}

const startedAt = new Date();
const rows = retrievalRows(GOLDEN_ALL);
const split = (rs: RetrievalRow[]) => ({ tuning: groupByType(rs.filter(r => !r.holdout)), holdout: groupByType(rs.filter(r => r.holdout)) });
const VARS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;
const missing = VARS.filter(v => !process.env[v]);
let model = 'deterministic';
const provider = missing.length ? null : platformProvider();

console.log(`检索与追问：${GOLDEN_ALL.length} 条（调参集 ${GOLDEN_ALL.length - HOLDOUT.size}，验收集 ${HOLDOUT.size}），确定性 rank()`);
if (!provider) {
  console.log(`\n计划模式：跳过（缺少环境变量 ${missing.join('、')}，写进 .env 或在命令前设置）`);
} else {
  model = provider.model;
  console.log(`\n计划模式：模型 ${provider.model}，${GOLDEN_ALL.length} 条（期望模式标在 scripts/eval-requirements/plan-modes.ts）`);
  for (const [i, g] of GOLDEN_ALL.entries()) {
    const p = await runPlanCase(provider, g);
    rows[i]!.planned = true;
    rows[i]!.mode = p.mode;
    const failed = p.failed ? `  失败于${p.failed.stage === 'model' ? '模型调用' : '计划解析'}：${p.failed.message}` : '';
    console.log(`${p.id.padEnd(24)} 期望 ${p.expected.padEnd(16)} 模型 ${(p.mode ?? '—').padEnd(16)} ${p.correct ? '对' : '错'}${failed}`);
  }
}
const retrieval = split(rows);
table('调参集', retrieval.tuning);
table('验收集（不参与调参，只在验收时看）', retrieval.holdout);

// 开关对比（#416）：单独判断 LLM_EMBEDDING_*（三项都有才跑，与 chat 的 LLM_* 互不影响，只配 embedding 也要跑）。
// 走 callEmbeddings（不查库、不记调用日志）；向量对两类视图的非能力行按 textHash 去重后现算，查询向量每条 golden 各一条
const EMBED_VARS = ['LLM_EMBEDDING_BASE_URL', 'LLM_EMBEDDING_MODEL', 'LLM_EMBEDDING_API_KEY'] as const;
type Split = ReturnType<typeof split>;
let retrievalHybrid: { off: Split; on: Split; recallDelta: { tuning: number | null; holdout: number | null } } | null = null;
if (EMBED_VARS.some(v => !process.env[v])) {
  console.log('\n开关对比：未配置 embedding，跳过开关对比');
} else {
  const provider = platformEmbeddingProvider();
  // 每批 64 条，对齐 embeddings.ts 的 EMBED_BATCH（一次 /embeddings 请求的输入条数）
  const BATCH = 64;
  const embedBatched = async (texts: string[]): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) out.push(...await callEmbeddings(provider, texts.slice(i, i + BATCH)));
    return out;
  };
  // 行向量：两类视图的非能力行按 textHash 去重（两类视图同一条目的文本可能不同、哈希不同，都要），按哈希排序让分批顺序确定
  const rowTexts = [...new Map([VIEWS.full, VIEWS.restricted]
    .flatMap(v => v.rows.filter(r => !r.entryId.startsWith('capability:')).map(r => [r.textHash, r.text] as const)))
    .entries()]
    .sort((a, b) => cmp(a[0], b[0]));
  const rowVectors = await embedBatched(rowTexts.map(([, text]) => text));
  const queries = GOLDEN_ALL.map(g => [g.id, g.retrieval.query] as const);
  const queryVectors = await embedBatched(queries.map(([, query]) => query));
  const vectors: RetrievalVectors = {
    rows: new Map(rowTexts.map(([hash], i) => [hash, rowVectors[i]!])),
    queries: new Map(queries.map(([id], i) => [id, queryVectors[i]!])),
  };
  const on = split(retrievalRows(GOLDEN_ALL, vectors));
  console.log(`\n开关对比：embedding 模型 ${provider.model}，向量关 / 向量开`);
  table('调参集（向量关）', retrieval.tuning);
  table('调参集（向量开）', on.tuning);
  table('验收集（向量关）', retrieval.holdout);
  table('验收集（向量开）', on.holdout);
  const recallDelta = {
    tuning: on.tuning.合计.recall === null || retrieval.tuning.合计.recall === null ? null : on.tuning.合计.recall - retrieval.tuning.合计.recall,
    holdout: on.holdout.合计.recall === null || retrieval.holdout.合计.recall === null ? null : on.holdout.合计.recall - retrieval.holdout.合计.recall,
  };
  console.log(`合计 Recall@20 差值（开 − 关）：调参集 ${pp(recallDelta.tuning)}、验收集 ${pp(recallDelta.holdout)}`);
  retrievalHybrid = { off: retrieval, on, recallDelta };
}

const drafts: CaseResult[] = [];
let draftTotals: { tuning: Summary; holdout: Summary } | null = null;
if (!provider) {
  console.log(`\n起草：跳过（缺少环境变量 ${missing.join('、')}，写进 .env 或在命令前设置）`);
} else {
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
  // 向量一路的开关对比（#416）：未配置 embedding 时为 null
  retrievalHybrid,
  drafts: draftTotals,
  // rows 与 GOLDEN_ALL 按下标一一对应
  cases: rows.map(({ id, type, holdout, recall, top1, asked, shouldAsk, planned, mode, expectedMode }, i) =>
    ({ id, type, holdout, recall, top1, ambiguous: asked, shouldAsk, planned, mode, expectedMode, clarify: GOLDEN_ALL[i].clarify, draft: byId.get(id) ?? null })),
};
const outDir = join(import.meta.dirname, 'eval-requirements', 'out');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${report.startedAt.replace(/[:.]/g, '-')}-${model.replace(/[/\\]/g, '_')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n结果已写入 ${file}`);

// scripts/test-duration-report.ts —— 汇总完整测试的耗时：读 vitest JSON reporter 的结果与 TEST_TIMING 写出的 jsonl（test/timing.ts），输出 Markdown 到标准输出。
// 用法：pnpm test:timing 跑完后 pnpm test:report，写到 /tmp/crm-test-report.md；也可以直接运行本脚本，参数为结果 JSON 与 jsonl 的路径
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

interface AssertionResult { fullName: string; duration?: number | null; status: string }
interface FileResult { name: string; startTime: number; endTime: number; status: string; assertionResults: AssertionResult[] }
interface Results { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; startTime: number; testResults: FileResult[] }
/** at：开始时刻的 epoch 毫秒（record 用结束时刻倒推；task:* 行的 ms 来自 platform.tasks，at 没有意义） */
interface Timing { name: string; ms: number; at?: number; file: string | null; test: string | null; status?: string }

const [resultsPath = '/tmp/crm-test-results.json', timingPath = '/tmp/crm-test-timing.jsonl'] = process.argv.slice(2);
const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as Results;
const timings: Timing[] = existsSync(timingPath)
  ? readFileSync(timingPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Timing)
  : [];

function groupBy<T>(items: T[], key: (t: T) => string) {
  const m = new Map<string, T[]>();
  for (const t of items) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  return m;
}

/** 超过它的任务耗时视为用例改写了时间戳（测试的 testTimeout 是 90 s） */
const MAX_TASK_MS = 10 * 60_000;
const isTask = (t: Timing) => t.name.startsWith('task:');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (ms: number, total: number) => `${((ms / total) * 100).toFixed(1)}%`;
const rel = (p: string) => relative(process.cwd(), p);
const seamOf = (file: string) => (file.startsWith('test/http/') ? 'test/http' : file.startsWith('test/pipeline/') ? 'test/pipeline' : '其他');

// 文件按 worker 并行执行，墙钟取开跑到最后一个文件结束。reporter 的 endTime − startTime 只含各测试（含 beforeEach / afterEach），
// 不含 beforeAll / afterAll 与 worker 启动、导入；所以文件的起点取 reporter 的 startTime 与本文件最早一条夹具计时（at，含 beforeAll 里的）中较早的那个，
// 文件耗时 = 起点 → endTime（含 beforeAll 里的夹具，不含导入与 worker 启动）。各文件耗时之和是 worker 时间，大于墙钟
const wall = Math.max(...results.testResults.map(f => f.endTime)) - results.startTime;
const firstAt = new Map<string, number>();
for (const t of timings) {
  if (!t.file || t.at == null || isTask(t)) continue;
  firstAt.set(t.file, Math.min(firstAt.get(t.file) ?? Infinity, t.at));
}
const files = results.testResults.map(f => {
  const file = rel(f.name);
  return {
    file,
    ms: f.endTime - Math.min(f.startTime, firstAt.get(file) ?? Infinity),
    tests: f.assertionResults.length,
    testMs: f.assertionResults.reduce((s, t) => s + (t.duration ?? 0), 0),
  };
});
const total = files.reduce((s, f) => s + f.ms, 0);

const out: string[] = [];
const table = (head: string[], rows: (string | number)[][]) => {
  out.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`), '');
};

out.push('## 总览', '');
table(['项', '值'], [
  ['文件数', files.length],
  ['测试数（通过 / 失败 / 跳过）', `${results.numTotalTests}（${results.numPassedTests} / ${results.numFailedTests} / ${results.numPendingTests}）`],
  ['墙钟时间（开跑 → 最后一个文件结束，含 global-setup）', sec(wall)],
  ['各文件耗时之和（worker 时间；下文的「占比」都以它为分母）', sec(total)],
  ['平均并行度（worker 时间 / 墙钟）', (total / wall).toFixed(2)],
  ['各测试 duration 之和（含 beforeEach / afterEach，不含 beforeAll / afterAll）', sec(files.reduce((s, f) => s + f.testMs, 0))],
]);

out.push('## 按接缝', '');
const seams = groupBy(files, f => seamOf(f.file));
table(['接缝', '文件', '测试', '耗时', '占比', '平均每文件'], [...seams].sort((a, b) => sum(b[1]) - sum(a[1])).map(([seam, fs]) =>
  [seam, fs.length, fs.reduce((s, f) => s + f.tests, 0), sec(sum(fs)), pct(sum(fs), total), sec(sum(fs) / fs.length)]));
function sum(fs: { ms: number }[]) { return fs.reduce((s, f) => s + f.ms, 0); }

out.push('## 最慢的 15 个文件', '', '耗时含 beforeAll 里的夹具与各测试，不含导入与 worker 启动；「测试 duration 之和」不含 beforeAll。', '');
table(['#', '文件', '测试', '耗时', '占比', '测试 duration 之和'], [...files].sort((a, b) => b.ms - a.ms).slice(0, 15).map((f, i) =>
  [i + 1, `\`${f.file}\``, f.tests, sec(f.ms), pct(f.ms, total), sec(f.testMs)]));

out.push('## 最慢的 20 个测试', '');
const tests = results.testResults.flatMap(f => f.assertionResults.map(t => ({ file: rel(f.name), name: t.fullName, ms: t.duration ?? 0 })));
table(['#', '文件', '测试', '耗时'], [...tests].sort((a, b) => b.ms - a.ms).slice(0, 20).map((t, i) =>
  [i + 1, `\`${t.file}\``, t.name.replaceAll('|', '\\|'), sec(t.ms)]));

if (timings.length) {
  const aggregate = (rows: Timing[]) => [...groupBy(rows, t => t.name)]
    .map(([name, ts]) => ({ name, count: ts.length, ms: ts.reduce((s, t) => s + t.ms, 0), median: median(ts.map(t => t.ms)), files: new Set(ts.map(t => t.file)).size }))
    .sort((a, b) => b.ms - a.ms);
  out.push('## 夹具的固定开销', '',
    '测试侧包装（test/timing.ts）量到的外层耗时。有嵌套：`publishedIdentitySources` 含 `newTenant` 与 `publish`，`mergeUnchecked` 含 `runTask:silver.merge`，各行不能相加。', '');
  table(['名字', '次数', '涉及文件', '总耗时', '平均', '中位数', '占 worker 时间'], aggregate(timings.filter(t => !isTask(t))).map(a =>
    [`\`${a.name}\``, a.count, a.files, sec(a.ms), `${Math.round(a.ms / a.count)} ms`, `${a.median} ms`, pct(a.ms, total)]));

  out.push('## 各种任务的耗时', '',
    '由 resetDb 清表前从 platform.tasks 读出（finished_at − started_at，应用内部的耗时）。只覆盖调用 resetDb 的文件；beforeAll 里清库的文件，最后一批任务记在下一个文件名下，所以只按种类整体统计。', '');
  // 有的用例直接改写任务的 started_at / finished_at（模拟过期、失联），算出的耗时为负或长得离谱，不计入
  const isReal = (t: Timing) => t.ms >= 0 && t.ms <= MAX_TASK_MS;
  const tasks = timings.filter(t => isTask(t) && isReal(t));
  const dropped = timings.filter(t => isTask(t) && !isReal(t)).length;
  table(['任务', '次数', '失败', '总耗时', '平均', '中位数', '占 worker 时间'], aggregate(tasks).map(a =>
    [`\`${a.name.slice(5)}\``, a.count, tasks.filter(t => t.name === a.name && t.status !== 'succeeded').length, sec(a.ms), `${Math.round(a.ms / a.count)} ms`, `${a.median} ms`, pct(a.ms, total)]));
  out.push(`另有 ${dropped} 个任务的耗时为负或超过 ${MAX_TASK_MS / 60_000} 分钟（用例改写了时间戳），未计入。`, '');

  out.push('## 固定开销按接缝', '');
  const bySeam = [...groupBy(timings.filter(t => t.file && !isTask(t)), t => `${seamOf(t.file!)}\t${t.name}`)]
    .map(([k, ts]) => ({ seam: k.split('\t')[0], name: k.split('\t')[1], count: ts.length, ms: ts.reduce((s, t) => s + t.ms, 0) }))
    .sort((a, b) => a.seam.localeCompare(b.seam) || b.ms - a.ms);
  table(['接缝', '名字', '次数', '总耗时', '占该接缝耗时'], bySeam.map(r => [r.seam, `\`${r.name}\``, r.count, sec(r.ms), pct(r.ms, sum(seams.get(r.seam) ?? []))]));
}

console.log(out.join('\n'));

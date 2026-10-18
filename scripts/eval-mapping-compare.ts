// scripts/eval-mapping-compare.ts —— 用法：pnpm eval:mapping:compare <a.json> <b.json>（两份 pnpm eval:mapping 写出的结果文件）
// 对比两次映射评测（ADR-0035）：模型、主机、提示词哈希是否相同，每例与总体的准确率、改动数及差值（b − a），只在一次里出现的样例单独列出
import { readFileSync } from 'node:fs';
import { compareReports, type EvalReport, type ReportCase, type ReportScore, type ScoreDelta } from './eval-mapping/report';

const files = process.argv.slice(2);
if (files.length !== 2) {
  console.error('用法：pnpm eval:mapping:compare <a.json> <b.json>');
  process.exit(2);
}
const [a, b] = files.map(f => JSON.parse(readFileSync(f, 'utf8')) as EvalReport);
const c = compareReports(a, b);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number, show: (x: number) => string) => (x > 0 ? '+' : x < 0 ? '-' : '±') + show(Math.abs(x));
const failedAt = (s: ReportScore) => (s.stage === 'model' ? '模型调用' : '映射校验');
const score = (s: ReportScore) => `${pct(s.accuracy).padStart(6)} / ${String(s.edits).padStart(2)}`;
const failed = (d: ScoreDelta) =>
  [d.a.stage && `a 失败于${failedAt(d.a)}`, d.b.stage && `b 失败于${failedAt(d.b)}`].filter(Boolean).map(t => `  ${t}`).join('');

for (const key of ['model', 'host', 'promptHash'] as const) {
  const label = { model: '模型', host: '主机', promptHash: '提示词哈希' }[key];
  console.log(c.same[key] ? `${label}相同：${c.a[key]}` : `${label}不同：a ${c.a[key]}，b ${c.b[key]}`);
}
console.log(`a 开始于 ${c.a.startedAt}，b 开始于 ${c.b.startedAt}`);
console.log('');
console.log(`${'样例'.padEnd(26)} ${'a 准确率 / 改动'.padEnd(12)}${'b 准确率 / 改动'.padEnd(12)}差值`);
const row = (name: string, d: ScoreDelta) =>
  console.log(`${name.padEnd(28)} ${score(d.a).padEnd(16)}${score(d.b).padEnd(16)}准确率 ${signed(d.delta.accuracy, pct)}  改动 ${signed(d.delta.edits, String)}${failed(d)}`);
for (const d of c.cases) row(d.name, d);
row('总体', c.total);
const listOnly = (label: string, cases: ReportCase[]) => {
  if (cases.length) console.log(`\n只在 ${label}：${cases.map(s => `${s.name}（${score(s).trim()}${s.stage ? `，失败于${failedAt(s)}` : ''}）`).join('，')}`);
};
listOnly('a', c.onlyA);
listOnly('b', c.onlyB);

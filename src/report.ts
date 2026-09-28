// src/report.ts —— 汇总 reports/bench.jsonl：每个规模下各步骤的最近一次耗时
import { readFileSync, existsSync } from 'node:fs';

if (!existsSync('./reports/bench.jsonl')) { console.log('还没有运行记录'); process.exit(0); }
type Row = { at: string; scale: number; target: string; script: string; step: string; ms: number; rows?: number };
const rows = readFileSync('./reports/bench.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l) as Row);

const latest = new Map<string, Row>();
for (const r of rows) latest.set(`${r.scale}|${r.target}|${r.script}|${r.step}`, r);

const byScale = new Map<string, Row[]>();
for (const r of latest.values()) {
  const k = `SCALE=${r.scale}（${r.target}）`;
  byScale.set(k, [...(byScale.get(k) ?? []), r]);
}
for (const [k, list] of byScale) {
  console.log(`\n=== ${k} ===`);
  console.table(list.map(r => ({
    脚本: r.script, 步骤: r.step,
    耗时: r.ms >= 10_000 ? `${(r.ms / 1000).toFixed(1)} s` : `${r.ms} ms`,
  })));
}

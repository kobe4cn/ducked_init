// scripts/bench-serving.ts —— 用法：node --import tsx scripts/bench-serving.ts [--consumers 100000] [--lookups 5000]
// 服务库点查的基准（ADR-0033）：在本机临时目录按服务库的表结构造一个约 --consumers 个消费者的加密服务库（标签、指标（含带维度的）、RFM、退役 ID），
// 用接口同一段代码（openServingFile、readServing）挂载后连续点查 --lookups 次（每次新开连接，与接口一样；混入查无此人与退役 ID），
// 结果写进 reports/serving-bench.md。不连平台库，不需要 .env
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import { openServingFile, readServing } from '../app/.server/serving-reader';

const { values } = parseArgs({ options: { consumers: { type: 'string', default: '100000' }, lookups: { type: 'string', default: '5000' } } });
const consumers = Number(values.consumers);
const lookups = Number(values.lookups);
const WARMUP = 200;
const TARGET_P99_MS = 50;

const dir = mkdtempSync(join(tmpdir(), 'serving-bench-'));
const file = join(dir, 'v1.duckdb');
const key = randomBytes(32).toString('base64');
const id = (n: string) => `md5(${n}::VARCHAR)`;

/** 照 serving-engine 的表结构写一个服务库：都按 consumer_id 排序 */
async function build() {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    await con.run(`INSTALL httpfs; LOAD httpfs; ATTACH '${file}' AS serving (ENCRYPTION_KEY '${key}');
      CREATE TABLE serving.tags AS SELECT * FROM (
        SELECT ${id('i')} AS consumer_id, 'tag_' || t AS tag, ['high', 'mid', 'low'][(i + t) % 3 + 1] AS tag_value
        FROM range(${consumers}) r(i), range(5) s(t)) ORDER BY consumer_id, tag;
      CREATE TABLE serving.metrics AS SELECT * FROM (
        SELECT ${id('i')} AS consumer_id, 'metric_' || k AS metric, '{}'::JSON AS dims, ((i * 7 + k) % 1000)::DOUBLE AS value
        FROM range(${consumers}) r(i), range(2) s(k)
        UNION ALL
        SELECT ${id('i')}, 'revenue_by_city', json_object('city', ['北京', '上海', '广州', '深圳'][c + 1]), ((i + c) % 500)::DOUBLE
        FROM range(${consumers}) r(i), range(4) s(c)) ORDER BY consumer_id, metric, dims::VARCHAR;
      CREATE TABLE serving.rfm AS SELECT * FROM (
        SELECT ${id('i')} AS consumer_id, ['champions', 'loyal', 'at_risk', 'lost'][i % 4 + 1] AS segment,
          (i % 5 + 1)::INTEGER AS r, (i % 4 + 1)::INTEGER AS f, (i % 3 + 1)::INTEGER AS m, (i % 365)::INTEGER AS recency_days,
          (i % 20)::BIGINT AS frequency, ((i % 10000) / 100)::DECIMAL(38, 2) AS monetary
        FROM range(${consumers}) r(i)) ORDER BY consumer_id;
      CREATE TABLE serving.consumer_aliases AS SELECT * FROM (
        SELECT md5('retired-' || i) AS retired_id, ${id('i')} AS consumer_id FROM range(0, ${consumers}, 20) r(i)) ORDER BY consumer_id, retired_id;
      CREATE TABLE serving.meta AS SELECT 1::INTEGER AS version, now() AS built_at;
      CHECKPOINT serving; DETACH serving;`);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

try {
  const buildStart = performance.now();
  await build();
  const buildMs = performance.now() - buildStart;
  const instance = await openServingFile(file, key, 1);
  try {
    // 先在库里算好要查的 ID，免得计时里算 md5
    const con = await instance.connect();
    const column = async (sql: string) => ((await con.runAndReadAll(sql)).getRowObjectsJson() as { id: string }[]).map(r => r.id);
    const all = await column('SELECT consumer_id AS id FROM serving.rfm');
    const retired = await column('SELECT retired_id AS id FROM serving.consumer_aliases');
    con.closeSync();
    // 多数是现有的，每 10 次一个退役 ID、每 25 次一个查无此人
    const targets = Array.from({ length: WARMUP + lookups }, (_, n) => n % 25 === 0 ? `nobody-${n}`
      : n % 10 === 0 ? retired[n % retired.length]! : all[Math.floor(Math.random() * all.length)]!);

    const times: number[] = [];
    let found = 0;
    for (const [n, target] of targets.entries()) {
      const start = performance.now();
      const c = await instance.connect();
      try {
        if (await readServing(c, target)) found += n >= WARMUP ? 1 : 0;
      } finally {
        c.closeSync();
      }
      if (n >= WARMUP) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const [p50, p95, p99] = [50, 95, 99].map(p => percentile(times, p));
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const fmt = (ms: number) => ms.toFixed(2);
    const pass = p99 < TARGET_P99_MS;
    const report = `# 服务库点查基准

由 \`scripts/bench-serving.ts\` 生成（${new Date().toISOString()}）。按服务库的表结构造一个加密的服务库，用接口同一段代码（\`openServingFile\`、\`readServing\`）挂载后单线程连续点查，每次新开连接；混入退役 ID（每 10 次一个）与查无此人（每 25 次一个）。计时只含挂载后的点查，不含每次请求查平台库指针（一次主键查询）与 HTTP 层。

## 环境

- 机器：${process.platform} ${process.arch}，${cpus().length} 核（${cpus()[0]?.model ?? '未知'}）；Node ${process.version}
- 实例限制：与接口相同（\`memory_limit\` 64MiB、1 线程）

## 数据

| 表 | 行数 |
|---|---|
| \`tags\`（5 个标签） | ${(consumers * 5).toLocaleString('en-US')} |
| \`metrics\`（2 个无维度指标 + 1 个带城市维度的指标） | ${(consumers * 6).toLocaleString('en-US')} |
| \`rfm\` | ${consumers.toLocaleString('en-US')} |
| \`consumer_aliases\` | ${retired.length.toLocaleString('en-US')} |

文件 ${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB，生成用时 ${(buildMs / 1000).toFixed(1)} s。

## 结果

预热 ${WARMUP} 次后计时 ${lookups.toLocaleString('en-US')} 次（查到 ${found.toLocaleString('en-US')} 人）：

| 平均 | p50 | p95 | p99 | 最慢 |
|---|---|---|---|---|
| ${fmt(mean)} ms | ${fmt(p50)} ms | ${fmt(p95)} ms | ${fmt(p99)} ms | ${fmt(times.at(-1)!)} ms |

目标 p99 < ${TARGET_P99_MS} ms：${pass ? '达到' : '**未达到**'}。
`;
    writeFileSync(join(import.meta.dirname, '../reports/serving-bench.md'), report);
    console.log(report);
    if (!pass) process.exitCode = 1;
  } finally {
    instance.closeSync();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

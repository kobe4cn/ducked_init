// src/lib/reader-worker.ts —— 只读查询进程（由 10_engineering.ts 以子进程方式启动多个）
// 参数：<库文件> <查询次数> <最大客户号>
import { DuckDBInstance } from '@duckdb/node-api';

const [file, nStr, maxStr] = process.argv.slice(2);
const t0 = performance.now();
const db = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY', threads: '1' });
const con = await db.connect();
const stmt = await con.prepare(`
  SELECT u.customer_id, u.tier, u.gmv, r.segment, ls.score
  FROM user_360 u LEFT JOIN rfm r USING (customer_id) LEFT JOIN loyalty_score ls USING (customer_id)
  WHERE u.customer_id = $1`);
const lat: number[] = [];
for (let i = 0; i < Number(nStr); i++) {
  stmt.bindBigInt(1, BigInt(1 + Math.floor(Math.random() * Number(maxStr))));
  const s = performance.now();
  await stmt.runAndReadAll();
  lat.push(performance.now() - s);
}
lat.sort((a, b) => a - b);
process.stdout.write(JSON.stringify({
  pid: process.pid, open_ms: Math.round(performance.now() - t0 - lat.reduce((a, b) => a + b, 0)),
  p50: +lat[Math.floor(lat.length * 0.5)].toFixed(2), p95: +lat[Math.floor(lat.length * 0.95)].toFixed(2),
  qps: Math.round(lat.length / (lat.reduce((a, b) => a + b, 0) / 1000)),
}));

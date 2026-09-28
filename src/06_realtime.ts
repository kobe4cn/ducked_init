// src/06_realtime.ts —— 实时性：微批流式写入 + 增量聚合、并发查询、点查延迟、大结果流式导出
import { createWriteStream } from 'node:fs';
import { connect, exec, q, show, record } from './lib/duck.ts';
import { sizes } from './lib/config.ts';

const con = await connect();

// =====================================================================
// 1. 微批流式写入（模拟 Kafka / 消息队列消费）+ 增量维护实时指标
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE silver.orders_rt (
  order_id BIGINT, customer_id INTEGER, channel VARCHAR, amount DECIMAL(12,2),
  order_ts TIMESTAMP, batch_id INTEGER);
CREATE OR REPLACE TABLE gold.user_rt (
  customer_id INTEGER PRIMARY KEY, orders_rt INTEGER, gmv_rt DECIMAL(14,2), last_order_ts TIMESTAMP);`);

const CHANNELS = ['app', 'mini_program', 'web', 'store'];
const BATCHES = 20, BATCH_SIZE = 5_000;
const lat: { append: number; merge: number; query: number }[] = [];
let nextId = 90_000_000;

for (let b = 1; b <= BATCHES; b++) {
  // (a) 消费一批消息 → Appender 写入（比逐条 INSERT 快两个数量级）
  const t0 = performance.now();
  const app = await con.createAppender('orders_rt', 'silver');
  const now = Date.now();
  for (let i = 0; i < BATCH_SIZE; i++) {
    app.appendBigInt(BigInt(nextId++));
    app.appendInteger(1 + Math.floor(sizes.customers * Math.random() ** 1.7));
    app.appendVarchar(CHANNELS[i % 4]);
    app.appendDouble(39 + Math.round(Math.random() ** 2.5 * 90000) / 100);
    app.appendVarchar(new Date(now - Math.random() * 60_000).toISOString().replace('T', ' ').slice(0, 23));
    app.appendInteger(b);
    app.endRow();
  }
  app.flushSync(); app.closeSync();
  const t1 = performance.now();

  // (b) 只把“这一批涉及的客户”合并进实时指标表（增量，不全量重算）
  await con.run(`
    MERGE INTO gold.user_rt AS u
    USING (SELECT customer_id, count(*) AS n, sum(amount) AS s, max(order_ts) AS last_ts
           FROM silver.orders_rt WHERE batch_id = ${b} GROUP BY ALL) AS d
    ON u.customer_id = d.customer_id
    WHEN MATCHED THEN UPDATE SET orders_rt = u.orders_rt + d.n, gmv_rt = u.gmv_rt + d.s,
                                 last_order_ts = greatest(u.last_order_ts, d.last_ts)
    WHEN NOT MATCHED THEN INSERT VALUES (d.customer_id, d.n, d.s, d.last_ts)`);
  const t2 = performance.now();

  // (c) 大屏查询：实时 GMV（新数据立即可见）
  await con.runAndReadAll(`SELECT channel, sum(amount) FROM silver.orders_rt GROUP BY ALL`);
  lat.push({ append: t1 - t0, merge: t2 - t1, query: performance.now() - t2 });
}
const avg = (k: 'append' | 'merge' | 'query') => (lat.reduce((s, x) => s + x[k], 0) / lat.length).toFixed(1);
record('微批写入（每批）', +avg('append')); record('增量合并（每批）', +avg('merge')); record('大屏查询（每批）', +avg('query'));
console.log(`\n▶ 1. 微批流式：${BATCHES} 批 × ${BATCH_SIZE} 行`);
console.table([{ 每批写入_ms: avg('append'), 增量合并_ms: avg('merge'), 大屏查询_ms: avg('query'),
                 端到端新鲜度_ms: (+avg('append') + +avg('merge')).toFixed(1) }]);

show(await q(con, `
SELECT u.customer_id, u.orders_rt AS 今日单数, u.gmv_rt AS 今日GMV, r.segment AS RFM人群, l.tier AS 等级
FROM gold.user_rt u
LEFT JOIN gold.rfm r USING (customer_id)
LEFT JOIN silver.loyalty l USING (customer_id)
ORDER BY u.gmv_rt DESC LIMIT 5`, undefined, '1b. 实时榜单 × 历史画像（实时表与离线表直接 JOIN）'));

// =====================================================================
// 2. 并发：一个 instance，多个 connection，同时跑 8 个重查询
// =====================================================================
const heavy = [
  `SELECT city, count(*), sum(gmv) FROM gold.user_360 GROUP BY ALL`,
  `SELECT date_trunc('month', order_ts) m, approx_count_distinct(customer_id) FROM silver.orders_clean GROUP BY ALL`,
  `SELECT p.category, sum(i.qty) FROM silver.order_items i JOIN silver.products p USING (sku) GROUP BY ALL`,
  `SELECT event, count(*) FROM silver.events GROUP BY ALL`,
  `SELECT touch_channel, approx_count_distinct(customer_id) FROM silver.v_touches GROUP BY ALL`,
  `SELECT segment, avg(gmv) FROM gold.rfm GROUP BY ALL`,
  `SELECT channel, approx_quantile(net_amount, [0.5, 0.9, 0.99]) FROM silver.orders_clean GROUP BY ALL`,
  `SELECT customer_id, count(*) c FROM silver.order_items i JOIN silver.orders_clean USING (order_id) GROUP BY ALL ORDER BY c DESC LIMIT 10`,
];
let t = performance.now();
for (const sql of heavy) await con.runAndReadAll(sql);
const serial = performance.now() - t;
const pool = await Promise.all(Array.from({ length: 4 }, () => connect()));
t = performance.now();
await Promise.all(heavy.map((sql, i) => pool[i % 4].runAndReadAll(sql)));
const parallel = performance.now() - t;
record('8 个重查询-串行', serial); record('8 个重查询-4 连接并发', parallel);
console.log('\n▶ 2. 8 个重查询：串行 vs 4 连接并发');
console.table([{ 串行_ms: serial.toFixed(0), 并发_ms: parallel.toFixed(0) }]);

// =====================================================================
// 3. 点查：预编译语句（Prepared Statement）查单个客户的 360 画像
// =====================================================================
const stmt = await con.prepare(`
  SELECT u.*, r.segment, ls.score AS loyalty, c.clv_12m, cr.silence_ratio
  FROM gold.user_360 u
  LEFT JOIN gold.rfm r USING (customer_id)
  LEFT JOIN gold.loyalty_score ls USING (customer_id)
  LEFT JOIN gold.clv c USING (customer_id)
  LEFT JOIN gold.churn_risk cr USING (customer_id)
  WHERE u.customer_id = $1`);
const times: number[] = [];
for (let i = 0; i < 1000; i++) {
  stmt.bindInteger(1, 1 + Math.floor(Math.random() * sizes.customers));
  const s = performance.now();
  await stmt.runAndReadAll();
  times.push(performance.now() - s);
}
times.sort((a, b) => a - b);
record('点查 p50', times[500]); record('点查 p95', times[950]); record('点查 p99', times[990]);
console.log('\n▶ 3. 客户 360 点查（5 表关联，1000 次随机客户）');
console.table([{ p50_ms: times[500].toFixed(2), p95_ms: times[950].toFixed(2), p99_ms: times[990].toFixed(2) }]);

// =====================================================================
// 4. 大结果流式导出：分块读取，内存恒定（推送给营销系统）
// =====================================================================
const out = createWriteStream('./data/export_winback.ndjson');
const res = await con.stream(`
  SELECT cr.customer_id, cr.city, cr.tier, round(cr.gmv, 2) AS gmv, cr.recency_days,
         u.fav_category, u.main_channel
  FROM gold.churn_risk cr JOIN gold.user_360 u USING (customer_id)
  WHERE cr.views_30d > 0 OR cr.clv_12m > 1000
  ORDER BY cr.clv_12m DESC`);
let exported = 0; t = performance.now();
for await (const rows of res.yieldRowObjectJson()) {       // 每次拿到一个 chunk（约 2048 行）
  for (const r of rows) out.write(JSON.stringify(r) + '\n');
  exported += rows.length;
}
out.end();
record('流式导出挽回名单', performance.now() - t, exported);
console.log(`\n▶ 4. 流式导出挽回名单：${exported} 行，${(performance.now() - t).toFixed(0)} ms，堆内存 ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);

// =====================================================================
// 5. 全量重算也很快：所有已支付订单从零算一遍 RFM
// =====================================================================
t = performance.now();
await con.runAndReadAll(`
  SELECT customer_id,
         ntile(5) OVER (ORDER BY max(order_ts) DESC) AS r,
         ntile(5) OVER (ORDER BY count(*))          AS f,
         ntile(5) OVER (ORDER BY sum(net_amount))   AS m
  FROM silver.orders_clean WHERE status = 'paid' GROUP BY customer_id`);
record('全量重算 RFM', performance.now() - t);
console.log(`\n▶ 5. 全量重算 RFM（全部已支付订单）：${(performance.now() - t).toFixed(0)} ms`);

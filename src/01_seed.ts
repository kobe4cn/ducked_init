// src/01_seed.ts —— 生成模拟数据源（规模由 SCALE 控制，SCALE=1 为千万会员 / 亿级订单）
//
//   ① PostgreSQL 业务库：crm.customers / crm.orders / crm.order_items（SEED_TARGET=pg）
//      或直接写成 landing Parquet（SEED_TARGET=lake，用于纯湖上压测）
//   ② 行为埋点：每天一个 JSONL.gz 文件，写到湖的 landing 区
//   ③ 营销触达：CSV.gz 分片
//   ④ 商品主数据：Parquet（10 万 SKU，含 8 维向量）
//   ⑤ 会员积分 SaaS 的后台库（mock_saas.duckdb），由 mock 接口对外提供分页 API
//
// 全部数据由 DuckDB 用 hash() 确定性生成：同样的 SCALE 每次生成的数据完全一样，可重复压测。
import { config, sizes, lakePath, outPath } from "./lib/config";
import { connect, exec, q, show, timed } from "./lib/duck";

const toPg = config.seedTarget === "pg";
const con = await connect({ pg: toPg });
const N = sizes.customers;
console.log(
  `SCALE=${config.scale} → 客户 ${N.toLocaleString()}，写入目标：${toPg ? "PostgreSQL" : "湖（landing Parquet）"}，湖：${config.lake}`,
);

// ------------------------------------------------------------------
// 0. 生成器宏：u01(x, salt) 返回 [0,1) 的确定性伪随机数
// ------------------------------------------------------------------
await con.run(`
CREATE SCHEMA IF NOT EXISTS gen;
CREATE OR REPLACE MACRO u01(x, s) AS (hash(x::BIGINT * 1000003 + s) % 10000000)::DOUBLE / 1e7;
CREATE OR REPLACE MACRO expo(x, s, mean) AS floor(-ln(u01(x, s) + 1e-9) * mean);
CREATE OR REPLACE MACRO sku_code(n) AS 'SKU' || lpad(n::VARCHAR, 6, '0');
`);

// ------------------------------------------------------------------
// 1. 客户（含生成用的隐藏属性：下单次数、活跃截止日、订单编号起点）
//    人群：15% 注册未购 / 35% 一次性 / 30% 偶尔复购 / 15% 常客 / 5% 超级用户
//    渠道影响忠诚度：邀请、App 注册更爱复购，Web 更“路过”
// ------------------------------------------------------------------
await exec(
  con,
  `
CREATE OR REPLACE TABLE gen.customers AS
WITH b AS (
  SELECT i AS customer_id,
         ['app','mini_program','web','store','referral'][1 + floor(u01(i, 1) * 5)::INT] AS register_channel,
         u01(i, 2) AS seg0, u01(i, 3) AS life_r,
         TIMESTAMP '2024-01-01' + to_seconds((u01(i, 4) * 83000000)::BIGINT) AS created_at
  FROM range(1, ${N} + 1) t(i)
),
b2 AS (
  SELECT *, seg0 + CASE register_channel WHEN 'referral' THEN 0.10 WHEN 'app' THEN 0.06
                                         WHEN 'web' THEN -0.06 ELSE 0 END AS seg
  FROM b
),
b3 AS (
  SELECT customer_id,
         '用户' || customer_id                                                   AS name,
         CASE WHEN u01(customer_id, 5) < 0.55 THEN 'F' ELSE 'M' END             AS gender,
         1965 + floor(u01(customer_id, 6) * 40)::INT                            AS birth_year,
         ['北京','上海','广州','深圳','杭州','成都','武汉','西安'][1 + floor(u01(customer_id, 7) * 8)::INT] AS city,
         register_channel,
         CASE WHEN u01(customer_id, 8) < 0.18 AND customer_id > 50
              THEN 1 + floor(u01(customer_id, 9) * (customer_id - 2))::BIGINT END AS referrer_id,
         created_at,
         created_at                                                              AS updated_at,
         CASE WHEN seg < 0.15 THEN 0
              WHEN seg < 0.50 THEN 1
              WHEN seg < 0.80 THEN 3  + expo(customer_id, 10, 4)
              WHEN seg < 0.95 THEN 10 + expo(customer_id, 10, 15)
              ELSE                 40 + expo(customer_id, 10, 60) END::INT       AS n_orders,
         created_at + to_days((30 + life_r * life_r * 900 * CASE WHEN seg >= 0.80 THEN 3 ELSE 1 END)::INT) AS active_until
  FROM b2
)
SELECT *, (sum(n_orders) OVER (ORDER BY customer_id ROWS UNBOUNDED PRECEDING) - n_orders)::BIGINT AS order_base
FROM b3`,
  `生成客户 ${N.toLocaleString()}`,
);

const [tot] = await q<{ orders: string }>(
  con,
  `SELECT sum(n_orders)::BIGINT AS orders FROM gen.customers`,
);
console.log(`  预计订单：${Number(tot.orders).toLocaleString()}`);

// 订单与明细的生成 SQL（按客户 ID 区间分块）
const ordersSql = (lo: number, hi: number) => `
SELECT order_id, customer_id,
       1 + floor(u01(order_id, 11) * 60)::INT                                         AS store_id,
       ['app','mini_program','web','store'][1 + floor(u01(order_id, 12) * 4)::INT]      AS channel,
       order_ts,
       CASE WHEN u01(order_id, 14) < 0.90 THEN 'paid'
            WHEN u01(order_id, 14) < 0.97 THEN 'refunded' ELSE 'cancelled' END          AS status,
       round(39 + 900 * pow(u01(order_id, 15), 2.5) + (customer_id % 5) * 20, 2)::DECIMAL(12,2) AS pay_amount,
       (CASE WHEN u01(order_id, 16) < 0.3 THEN round(5 + u01(order_id, 17) * 25, 2) ELSE 0 END)::DECIMAL(12,2) AS discount,
       order_ts                                                                          AS updated_at
FROM (
  SELECT c.order_base + r.k + 1 AS order_id, c.customer_id,
         c.created_at + to_microseconds((u01(c.order_base + r.k + 1, 13)
            * (epoch_us(least(c.active_until, TIMESTAMP '2026-09-26')) - epoch_us(c.created_at)))::BIGINT) AS order_ts
  FROM gen.customers c, range(c.n_orders) r(k)
  WHERE c.customer_id BETWEEN ${lo} AND ${hi}
)`;

const itemsSql = (lo: number, hi: number) => `
SELECT order_id,
       sku_code(CASE
         WHEN k = 0 AND u < 0.60 THEN (1 + floor(16664 * pow(u2, 1.5))) * 6 + pref
         WHEN k > 0 AND u < 0.45 THEN (1 + floor(16664 * pow(u2, 1.5))) * 6
              + CASE pref WHEN 0 THEN 1 WHEN 1 THEN 0 WHEN 2 THEN 4 WHEN 4 THEN 2 WHEN 3 THEN 5 ELSE 3 END
         WHEN k > 0 AND u < 0.75 THEN (1 + floor(16664 * pow(u2, 1.5))) * 6 + pref
         ELSE 1 + floor(99999 * pow(u2, 1.4)) END::BIGINT)                   AS sku,
       (1 + floor(pow(u01(order_id * 8 + k, 23), 3) * 4))::INT             AS qty
FROM (
  SELECT o.order_id, o.customer_id % 6 AS pref, r.k,
         u01(o.order_id * 8 + r.k, 21) AS u, u01(o.order_id * 8 + r.k, 22) AS u2
  FROM (SELECT c.order_base + r0.k + 1 AS order_id, c.customer_id
        FROM gen.customers c, range(c.n_orders) r0(k)
        WHERE c.customer_id BETWEEN ${lo} AND ${hi}) o,
       range((1 + floor(pow(u01(o.order_id, 20), 1.6) * 4))::INT) r(k)
)`;

const custCols = `customer_id, name, gender, birth_year, city, register_channel, referrer_id, created_at, updated_at`;
const chunks: [number, number][] = [];
for (let lo = 1; lo <= N; lo += sizes.customerChunk)
  chunks.push([lo, Math.min(lo + sizes.customerChunk - 1, N)]);

// ------------------------------------------------------------------
// 2. 业务数据 → PostgreSQL（或 landing Parquet）
// ------------------------------------------------------------------
if (toPg) {
  const S = config.pg.schema;
  await exec(
    con,
    `CALL postgres_execute('pg', '
    DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};
    CREATE TABLE ${S}.customers (customer_id bigint, name text, gender text, birth_year int, city text,
      register_channel text, referrer_id bigint, created_at timestamp, updated_at timestamp);
    CREATE TABLE ${S}.orders (order_id bigint, customer_id bigint, store_id int, channel text, order_ts timestamp,
      status text, pay_amount numeric(12,2), discount numeric(12,2), updated_at timestamp);
    CREATE TABLE ${S}.order_items (order_id bigint, sku text, qty int);
  ')`,
    "PG 建表（先不建索引，批量写入更快）",
  );
  await con.run(`CALL pg_clear_cache()`);

  await timed(`PG 写入客户 ${N.toLocaleString()}`, () =>
    con.run(
      `INSERT INTO pg.${S}.customers SELECT ${custCols} FROM gen.customers`,
    ),
  );

  for (const [i, [lo, hi]] of chunks.entries()) {
    const t0 = performance.now();
    await con.run(`INSERT INTO pg.${S}.orders ${ordersSql(lo, hi)}`);
    const t1 = performance.now();
    await con.run(`INSERT INTO pg.${S}.order_items ${itemsSql(lo, hi)}`);
    console.log(
      `  块 ${i + 1}/${chunks.length}（客户 ${lo}–${hi}）订单 ${((t1 - t0) / 1000).toFixed(1)} s，明细 ${((performance.now() - t1) / 1000).toFixed(1)} s`,
    );
  }

  await exec(
    con,
    `CALL postgres_execute('pg', '
    ALTER TABLE ${S}.customers ADD PRIMARY KEY (customer_id);
    ALTER TABLE ${S}.orders ADD PRIMARY KEY (order_id);
    CREATE INDEX ON ${S}.orders (updated_at);
    CREATE INDEX ON ${S}.customers (updated_at);
    CREATE INDEX ON ${S}.order_items (order_id);
    CREATE SEQUENCE ${S}.order_seq;
    SELECT setval(''${S}.order_seq'', (SELECT max(order_id) FROM ${S}.orders));
    ANALYZE;
  ')`,
    "PG 建主键与索引、ANALYZE",
  );
  show(
    await q(
      con,
      `
    SELECT (SELECT count(*) FROM pg.${S}.customers)   AS customers,
           (SELECT count(*) FROM pg.${S}.orders)      AS orders,
           (SELECT count(*) FROM pg.${S}.order_items) AS order_items`,
      undefined,
      "PostgreSQL 行数",
    ),
  );
} else {
  await exec(
    con,
    `COPY (SELECT ${custCols} FROM gen.customers) TO '${outPath("landing/pg_export/customers.parquet")}' (FORMAT parquet, COMPRESSION zstd)`,
    `客户 → landing Parquet`,
  );
  for (const [i, [lo, hi]] of chunks.entries()) {
    const t0 = performance.now();
    await con.run(
      `COPY (${ordersSql(lo, hi)}) TO '${outPath(`landing/pg_export/orders/part_${String(i).padStart(3, "0")}.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`,
    );
    const t1 = performance.now();
    await con.run(
      `COPY (${itemsSql(lo, hi)}) TO '${outPath(`landing/pg_export/order_items/part_${String(i).padStart(3, "0")}.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`,
    );
    console.log(
      `  块 ${i + 1}/${chunks.length}（客户 ${lo}–${hi}）订单 ${((t1 - t0) / 1000).toFixed(1)} s，明细 ${((performance.now() - t1) / 1000).toFixed(1)} s`,
    );
  }
}

// ------------------------------------------------------------------
// 3. 商品主数据（10 万 SKU）
// ------------------------------------------------------------------
await exec(
  con,
  `
COPY (
  SELECT sku_code(i) AS sku,
         ['服饰','美妆','数码','食品','家居','母婴'][1 + i % 6] AS category,
         ['A牌','B牌','C牌','D牌','E牌','F牌','G牌','H牌'][1 + floor(u01(i, 31) * 8)::INT] AS brand,
         round(19 + u01(i, 32) * 1800, 2)::DECIMAL(10,2) AS list_price,
         list_transform(range(8), lambda d: (CASE WHEN d = i % 6 THEN 0.8 ELSE 0.0 END
                                             + u01(i * 8 + d, 33) / 4)::FLOAT)::FLOAT[8] AS embedding
  FROM range(1, ${sizes.products} + 1) t(i)
) TO '${outPath("landing/products/products.parquet")}' (FORMAT parquet)`,
  "商品主数据 Parquet（10 万 SKU）",
);

// ------------------------------------------------------------------
// 4. 营销触达：CSV.gz，每片 500 万行
// ------------------------------------------------------------------
const TOUCH_PART = 5_000_000;
await timed(
  `营销触达 CSV.gz（${sizes.touches.toLocaleString()} 行）`,
  async () => {
    for (let p = 0, lo = 1; lo <= sizes.touches; p++, lo += TOUCH_PART) {
      const hi = Math.min(lo + TOUCH_PART - 1, sizes.touches);
      await con.run(`
      COPY (
        SELECT i AS touch_id,
               1 + floor(u01(i, 41) * ${N})::BIGINT AS customer_id,
               'CMP' || lpad((1 + floor(u01(i, 42) * 24))::VARCHAR, 2, '0') AS campaign_id,
               ['sms','push','email','ad'][1 + floor(u01(i, 43) * 4)::INT] AS touch_channel,
               TIMESTAMP '2024-01-01' + to_seconds((u01(i, 44) * 86400000)::BIGINT) AS touch_ts
        FROM range(${lo}, ${hi} + 1) t(i)
      ) TO '${outPath(`landing/marketing/touches_${String(p).padStart(3, "0")}.csv.gz`)}' (HEADER, COMPRESSION gzip)`);
    }
  },
);

// ------------------------------------------------------------------
// 5. 行为埋点：按会话生成，漏斗逐级流失；每天一个 JSONL.gz（landing/events/dt=YYYY-MM-DD/）
//    20% 的会话未登录：只有设备号
// ------------------------------------------------------------------
const perDay = Math.ceil(sizes.sessions / sizes.eventDays);
await timed(
  `行为埋点 JSONL.gz（${sizes.eventDays} 天 × ${perDay.toLocaleString()} 会话）`,
  async () => {
    for (let d = 0; d < sizes.eventDays; d++) {
      const day = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
      await con.run(`
      COPY (
        WITH s AS (
          SELECT ${d}::BIGINT * 100000000 + i AS sid,
                 1 + floor(${N} * pow(u01(${d}::BIGINT * 100000000 + i, 51), 1.7))::BIGINT AS uid,
                 TIMESTAMP '${day}' + to_seconds(floor(u01(${d}::BIGINT * 100000000 + i, 52) * 86000)::BIGINT) AS start_ts,
                 ['home','search','push','ad'][1 + floor(u01(${d}::BIGINT * 100000000 + i, 53) * 4)::INT] AS entry,
                 floor(u01(${d}::BIGINT * 100000000 + i, 54) * 100)::INT AS r,
                 u01(${d}::BIGINT * 100000000 + i, 55) < 0.2 AS anon
          FROM range(1, ${perDay} + 1) t(i)
        ),
        steps AS (
          SELECT s.*, st.step, st.k
          FROM s, (SELECT unnest(['login','view_item','view_item','view_item','search','add_cart','checkout','pay']) AS step,
                          unnest(range(8)) AS k) st
          WHERE (st.step <> 'login' OR NOT s.anon)
            AND (st.step <> 'search' OR s.entry = 'search')
            AND (st.step NOT IN ('add_cart','checkout','pay') OR s.r < CASE s.entry WHEN 'push' THEN 38 WHEN 'search' THEN 34 WHEN 'home' THEN 24 ELSE 16 END)
            AND (st.step NOT IN ('checkout','pay')            OR s.r < CASE s.entry WHEN 'push' THEN 22 WHEN 'search' THEN 20 WHEN 'home' THEN 12 ELSE 7 END)
            AND (st.step <> 'pay'                             OR s.r < CASE s.entry WHEN 'push' THEN 17 WHEN 'search' THEN 16 WHEN 'home' THEN 9 ELSE 4 END)
        )
        SELECT sid * 8 + k AS event_id,
               CASE WHEN anon AND step <> 'login' THEN NULL ELSE uid END AS user_id,
               'dev_' || uid AS device_id,
               step AS event,
               strftime(start_ts + to_seconds(k * 40 + floor(u01(sid * 8 + k, 56) * 30)::BIGINT), '%Y-%m-%dT%H:%M:%S') AS ts,
               CASE step
                 WHEN 'view_item' THEN {'sku': sku_code(1 + floor(u01(sid * 8 + k, 57) * 99999)::BIGINT), 'from': entry, 'stay_ms': 800 + r * 90}::JSON
                 WHEN 'search'    THEN {'keyword': ['连衣裙','口红','耳机','咖啡','收纳','奶粉'][1 + r % 6], 'results': r * 3}::JSON
                 WHEN 'add_cart'  THEN {'sku': sku_code(1 + floor(u01(sid, 58) * 99999)::BIGINT), 'qty': 1 + r % 3, 'from': entry}::JSON
                 WHEN 'checkout'  THEN {'items': 1 + r % 4, 'coupon': r < 10}::JSON
                 WHEN 'pay'       THEN {'amount': 39 + r * 21.5, 'method': ['wechat','alipay','card'][1 + r % 3]}::JSON
                 ELSE                  {'method': ['sms','password','wechat'][1 + r % 3], 'from': entry}::JSON
               END AS props
        FROM steps
      ) TO '${outPath(`landing/events/dt=${day}/events.jsonl.gz`)}' (FORMAT json, COMPRESSION gzip)`);
      if ((d + 1) % 20 === 0)
        console.log(`  已生成 ${d + 1}/${sizes.eventDays} 天`);
    }
  },
);

// ------------------------------------------------------------------
// 6. 会员积分 SaaS 的后台库（mock 接口从这里分页读取）
//    等级按“预估消费 ± 噪声”评定：真实系统的等级规则往往滞后、不准，后面会分析这种错配
// ------------------------------------------------------------------
await exec(
  con,
  `
ATTACH './data/mock_saas.duckdb' AS saas;
CREATE OR REPLACE TABLE saas.members AS
SELECT customer_id,
       CASE WHEN est < 1500 THEN '普通' WHEN est < 6000 THEN '银卡' WHEN est < 15000 THEN '金卡' ELSE '黑金' END AS tier,
       floor(est / 10)::INT AS points,
       TIMESTAMP '2026-09-01' + to_seconds(floor(u01(customer_id, 61) * 2200000)::BIGINT) AS updated_at
FROM (SELECT customer_id, n_orders * 420 * (0.5 + u01(customer_id, 60)) AS est FROM gen.customers)
ORDER BY customer_id;
DETACH saas;`,
  "会员 SaaS 后台库（mock_saas.duckdb）",
);

console.log("\n数据源准备完毕。");

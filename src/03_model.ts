// src/03_model.ts —— silver 清洗建模（身份打通、会话切分）+ gold.user_360 客户宽表（7 个数据源关联）
import { connect, exec, q, show } from './lib/duck';

const con = await connect();
const FROM_360 = process.argv[2] === '--from-360';   // 调试用：跳过前面已完成的步骤
await exec(con, `CREATE SCHEMA IF NOT EXISTS gold`);

if (!FROM_360) {
// ---------- 1. 订单清洗：统一类型、计算实付、只保留有效状态 ----------
await exec(con, `
CREATE OR REPLACE TABLE silver.orders_clean AS
SELECT order_id::BIGINT        AS order_id,
       customer_id::INTEGER    AS customer_id,
       store_id::INTEGER       AS store_id,
       channel,
       order_ts::TIMESTAMP     AS order_ts,
       status,
       pay_amount::DECIMAL(12,2)                    AS pay_amount,
       (pay_amount - discount)::DECIMAL(12,2)       AS net_amount,
       discount > 0                                 AS used_coupon
FROM silver.orders
WHERE status IN ('paid', 'refunded');`, '订单清洗 → silver.orders_clean');

// ---------- 2. 身份打通（ID Mapping）：设备号 → 用户 ----------
//    同一设备最近一次登录的用户，作为匿名行为的归属
await exec(con, `
CREATE OR REPLACE TABLE silver.id_map AS
SELECT device_id, arg_max(user_id, ts) AS user_id
FROM silver.v_events
WHERE user_id IS NOT NULL
GROUP BY device_id;`, '身份映射 device → user');

// ---------- 3. 行为事件：补全身份 + 解析 JSON 属性 + 会话切分 ----------
//    会话规则：同一用户两次事件间隔 > 30 分钟即开启新会话
await exec(con, `
CREATE OR REPLACE TABLE silver.events AS
WITH resolved AS (
  SELECT e.event_id,
         coalesce(e.user_id, m.user_id)       AS user_id,
         e.user_id IS NULL                     AS was_anonymous,
         e.event, e.ts, e.dt,
         e.props ->> '$.sku'                   AS sku,
         e.props ->> '$.from'                  AS entry_from,
         (e.props ->> '$.amount')::DOUBLE      AS pay_amount,
         e.props
  FROM silver.v_events e
  LEFT JOIN silver.id_map m USING (device_id)
),
gaps AS (
  SELECT *,
         CASE WHEN ts - lag(ts) OVER w > INTERVAL 30 MINUTE OR lag(ts) OVER w IS NULL THEN 1 ELSE 0 END AS is_new
  FROM resolved
  WINDOW w AS (PARTITION BY user_id ORDER BY ts)
)
SELECT * EXCLUDE (is_new),
       user_id || '-' || sum(is_new) OVER (PARTITION BY user_id ORDER BY ts) AS session_id
FROM gaps;`, '事件身份补全 + 会话切分 → silver.events');

show(await q(con, `
SELECT count(*)::INT                                        AS 事件总数,
       count(*) FILTER (WHERE was_anonymous)::INT           AS 匿名事件,
       count(*) FILTER (WHERE was_anonymous AND user_id IS NOT NULL)::INT AS 匿名被找回,
       count(DISTINCT session_id)::INT                      AS 会话数
FROM silver.events`, undefined, '身份打通效果'));

}

// ---------- 4. gold.user_360：一人一行的客户宽表 ----------
//    关联：customers(PG) × orders(PG) × order_items(PG) × products(Parquet)
//          × loyalty(API) × events(埋点) × touches(营销 CSV)
//
//    千万级客户 × 亿级明细时的要点：
//      ① 分步物化：每个维度先各自聚合成“一人一行”的中间表，最后再按 customer_id 关联，
//         比一条大 SQL 里套 6 个 CTE 的峰值内存低得多；
//      ② 避免“整体型”聚合：mode()、median()、count(DISTINCT) 在千万分组下需要为每组保留明细，
//         内存不受 memory_limit 约束、容易 OOM。改成“先按（客户, 值）计数，再 arg_max / count(*)”。
await con.run(`SET VARIABLE as_of = TIMESTAMP '2026-09-27'; CREATE SCHEMA IF NOT EXISTS work;`);

await exec(con, `
CREATE OR REPLACE TABLE work.u_orders AS
SELECT customer_id,
       count(*) FILTER (WHERE status = 'paid')          AS orders,
       sum(net_amount) FILTER (WHERE status = 'paid')   AS gmv,
       avg(net_amount) FILTER (WHERE status = 'paid')   AS aov,
       min(order_ts)                                    AS first_order_ts,
       max(order_ts) FILTER (WHERE status = 'paid')     AS last_order_ts,
       count(*) FILTER (WHERE status = 'refunded')      AS refunds,
       avg(used_coupon::INT)                            AS coupon_ratio
FROM silver.orders_clean GROUP BY customer_id`, '360 ① 交易画像');

await exec(con, `
CREATE OR REPLACE TABLE work.u_channel AS          -- 主渠道：替代 mode(channel)
SELECT customer_id, arg_max(channel, n) AS main_channel
FROM (SELECT customer_id, channel, count(*) AS n FROM silver.orders_clean GROUP BY ALL)
GROUP BY customer_id`, '360 ② 主渠道');

await exec(con, `
CREATE OR REPLACE TABLE work.u_category AS         -- 品类偏好：先按（客户, 品类）计数
SELECT customer_id, arg_max(category, cnt) AS fav_category, count(*) AS categories
FROM (SELECT oc.customer_id, p.category, count(*) AS cnt
      FROM silver.order_items i
      JOIN silver.orders_clean oc USING (order_id)
      JOIN silver.products p USING (sku)
      WHERE oc.status = 'paid'
      GROUP BY ALL)
GROUP BY customer_id`, '360 ③ 品类偏好（亿级明细 × 订单 × 商品）');

await exec(con, `
CREATE OR REPLACE TABLE work.u_events AS           -- 近 30 天行为；会话数 = 去重后再计数
SELECT customer_id,
       sum(views) AS views_30d, sum(carts) AS carts_30d,
       count(*)   AS sessions_30d, max(last_ts) AS last_active_ts
FROM (SELECT user_id AS customer_id, session_id,
             count(*) FILTER (WHERE event = 'view_item') AS views,
             count(*) FILTER (WHERE event = 'add_cart')  AS carts,
             max(ts) AS last_ts
      FROM silver.events
      WHERE ts >= getvariable('as_of') - INTERVAL 30 DAY AND user_id IS NOT NULL
      GROUP BY ALL)
GROUP BY customer_id`, '360 ④ 近 30 天行为');

await exec(con, `
CREATE OR REPLACE TABLE work.u_touches AS
SELECT customer_id, count(*) AS touches_90d
FROM silver.v_touches
WHERE touch_ts >= getvariable('as_of') - INTERVAL 90 DAY
GROUP BY customer_id`, '360 ⑤ 近 90 天营销触达（湖上 Parquet，分区裁剪）');

await exec(con, `
CREATE OR REPLACE TABLE work.u_ref AS
SELECT referrer_id AS customer_id, count(*) AS invited
FROM silver.customers WHERE referrer_id IS NOT NULL GROUP BY referrer_id`, '360 ⑥ 邀请人数');

await exec(con, `
CREATE OR REPLACE TABLE gold.user_360 AS
SELECT c.customer_id, c.city, c.gender, 2026 - c.birth_year AS age, c.register_channel,
       c.created_at::TIMESTAMP AS created_at,
       coalesce(o.orders, 0) AS orders, coalesce(o.gmv, 0) AS gmv, o.aov,
       o.first_order_ts, o.last_order_ts,
       date_diff('day', o.last_order_ts, getvariable('as_of')) AS recency_days,
       coalesce(o.refunds, 0) AS refunds, o.coupon_ratio, ch.main_channel,
       cat.fav_category, coalesce(cat.categories, 0) AS categories,
       l.tier, l.points,
       coalesce(ev.views_30d, 0) AS views_30d, coalesce(ev.carts_30d, 0) AS carts_30d,
       coalesce(ev.sessions_30d, 0) AS sessions_30d, ev.last_active_ts,
       coalesce(tc.touches_90d, 0) AS touches_90d,
       coalesce(ref.invited, 0) AS invited
FROM silver.customers c
LEFT JOIN work.u_orders   o   USING (customer_id)
LEFT JOIN work.u_channel  ch  USING (customer_id)
LEFT JOIN work.u_category cat USING (customer_id)
LEFT JOIN silver.loyalty  l   USING (customer_id)
LEFT JOIN work.u_events   ev  USING (customer_id)
LEFT JOIN work.u_touches  tc  USING (customer_id)
LEFT JOIN work.u_ref      ref USING (customer_id)
ORDER BY c.customer_id;                            -- 按客户号有序存储：点查时行组裁剪最有效
DROP SCHEMA work CASCADE;`, '360 ⑦ 7 源关联 → gold.user_360');

show(await q(con, `
SELECT customer_id, city, tier, orders, round(gmv)::INT AS gmv, recency_days,
       fav_category, categories, views_30d, sessions_30d, touches_90d, invited
FROM gold.user_360
ORDER BY gmv DESC LIMIT 5`, undefined, 'user_360 样例（GMV Top 5）'));

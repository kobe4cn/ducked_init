// src/05_journey.ts —— 用户旅程：会话漏斗、营销归因（ASOF JOIN）、购物篮关联、相似推荐、跨表 Top-N
import { connect, exec, q, show } from './lib/duck';

const con = await connect();
await con.run(`SET VARIABLE as_of = TIMESTAMP '2026-09-27'`);

// =====================================================================
// 1. 会话级转化漏斗（按入口来源）
//    一条 SQL：会话聚合 → 条件计数 → 逐级转化率
// =====================================================================
show(await q(con, `
WITH sess AS (
  SELECT session_id,
         any_value(entry_from) FILTER (WHERE entry_from IS NOT NULL) AS entry,
         bool_or(event = 'view_item') AS v, bool_or(event = 'add_cart') AS c,
         bool_or(event = 'checkout')  AS k, bool_or(event = 'pay')      AS p
  FROM silver.events WHERE user_id IS NOT NULL
  GROUP BY session_id
)
SELECT entry AS 入口,
       count(*) FILTER (WHERE v)::INT AS 浏览会话,
       round(100.0 * count(*) FILTER (WHERE c) / count(*) FILTER (WHERE v), 1) AS 加购率_pct,
       round(100.0 * count(*) FILTER (WHERE k) / count(*) FILTER (WHERE c), 1) AS 结算率_pct,
       round(100.0 * count(*) FILTER (WHERE p) / count(*) FILTER (WHERE k), 1) AS 支付率_pct,
       round(100.0 * count(*) FILTER (WHERE p) / count(*) FILTER (WHERE v), 2) AS 整体转化_pct
FROM sess WHERE entry IS NOT NULL
GROUP BY ALL ORDER BY 整体转化_pct DESC`, undefined, '1. 会话漏斗（按入口）'));

// =====================================================================
// 2. 营销归因：每笔订单找“下单前最近的一次触达”（7 天窗口，Last-Touch）
//    ASOF JOIN：全部触达 × 全部已支付订单，按客户分组、按时间就近匹配
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.attribution AS
SELECT o.order_id, o.customer_id, o.order_ts, o.net_amount,
       t.campaign_id, t.touch_channel, t.touch_ts,
       date_diff('hour', t.touch_ts, o.order_ts) AS hours_after_touch
FROM silver.orders_clean o
ASOF JOIN silver.v_touches t
  ON o.customer_id = t.customer_id AND o.order_ts >= t.touch_ts
WHERE o.status = 'paid'
  AND o.order_ts - t.touch_ts <= INTERVAL 30 DAY        -- 只保留 30 天内有触达的订单，表更小`, '2. ASOF 归因 → gold.attribution');

show(await q(con, `
SELECT touch_channel AS 触达渠道,
       count(*)::INT AS 归因订单,
       round(sum(net_amount))::BIGINT AS 归因GMV,
       round(approx_quantile(hours_after_touch, 0.5))::INT AS 触达到下单_中位小时
FROM gold.attribution
WHERE hours_after_touch <= 7 * 24                       -- 只认 7 天内的触达
GROUP BY ALL ORDER BY 归因GMV DESC`, undefined, '2b. 7 天窗口 Last-Touch 归因'));

show(await q(con, `
SELECT campaign_id AS 活动, touch_channel AS 渠道,
       count(*)::INT AS 订单, round(sum(net_amount))::INT AS GMV
FROM gold.attribution WHERE hours_after_touch <= 168
GROUP BY campaign_id, touch_channel               -- 注意：QUALIFY 不能与 GROUP BY ALL 同用
QUALIFY rank() OVER (PARTITION BY touch_channel ORDER BY GMV DESC) = 1   -- 每个渠道的冠军活动
ORDER BY GMV DESC`, undefined, '2c. 每个渠道表现最好的活动（QUALIFY）'));

// =====================================================================
// 3. 购物篮关联分析：哪些品类经常一起买？（支持度 / 置信度 / 提升度）
//    订单明细自连接 → 按订单配对。只看近 180 天订单：关联关系会随时间变化，旧数据参考价值低
// =====================================================================
show(await q(con, `
WITH basket AS (
  SELECT DISTINCT i.order_id, p.category
  FROM silver.order_items i
  JOIN silver.orders_clean o USING (order_id)
  JOIN silver.products p USING (sku)
  WHERE o.status = 'paid' AND o.order_ts >= getvariable('as_of') - INTERVAL 180 DAY
),
n AS (SELECT count(DISTINCT order_id) AS total FROM basket),
single AS (SELECT category, count(*) AS cnt FROM basket GROUP BY ALL),
pairs AS (
  SELECT a.category AS a, b.category AS b, count(*) AS both_cnt
  FROM basket a JOIN basket b ON a.order_id = b.order_id AND a.category < b.category
  GROUP BY ALL
)
SELECT a || ' + ' || b AS 品类组合,
       both_cnt::INT AS 同单次数,
       round(100.0 * both_cnt / n.total, 2) AS 支持度_pct,
       round(100.0 * both_cnt / sa.cnt, 1) AS 置信度_A到B_pct,
       round(both_cnt * n.total::DOUBLE / (sa.cnt * sb.cnt), 3) AS 提升度
FROM pairs, n
JOIN single sa ON sa.category = pairs.a
JOIN single sb ON sb.category = pairs.b
ORDER BY 提升度 DESC LIMIT 6`, undefined, '3. 品类关联（提升度 > 1 表示正相关）'));

// =====================================================================
// 4. 向量相似推荐：用户偏好向量（买过商品向量的加权平均）× 商品向量
//    list 聚合 + 余弦相似度 + QUALIFY 每人 Top 3，排除已购
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.user_vec AS
WITH sample AS (SELECT customer_id FROM gold.rfm WHERE segment = '重要价值' ORDER BY customer_id LIMIT 2000),
dims AS (   -- 把 8 维向量拆成 8 行，按维度求加权平均
  SELECT oc.customer_id, d.dim, sum(p.embedding[d.dim] * i.qty) / sum(i.qty) AS v
  FROM silver.order_items i
  JOIN silver.orders_clean oc USING (order_id)
  JOIN silver.products p USING (sku)
  CROSS JOIN range(1, 9) d(dim)
  WHERE oc.status = 'paid' AND oc.customer_id IN (FROM sample)
  GROUP BY ALL
)
SELECT customer_id, list(v ORDER BY dim)::FLOAT[8] AS pref   -- 再按维度顺序拼回数组
FROM dims GROUP BY customer_id`, '4. 用户偏好向量（重要价值人群 2000 人样本）');

show(await q(con, `
WITH candidates AS (   -- 召回：近 90 天最热的 5000 个商品（全量 10 万个商品逐一算相似度没必要）
  SELECT sku FROM silver.order_items i JOIN silver.orders_clean o USING (order_id)
  WHERE o.order_ts >= getvariable('as_of') - INTERVAL 90 DAY
  GROUP BY sku ORDER BY count(*) DESC LIMIT 5000
),
bought AS (
  SELECT DISTINCT oc.customer_id, i.sku
  FROM silver.order_items i JOIN silver.orders_clean oc USING (order_id)
  WHERE oc.customer_id IN (SELECT customer_id FROM gold.user_vec)
)
SELECT u.customer_id, p.sku, p.category, p.brand,
       round(array_cosine_similarity(u.pref, p.embedding), 4) AS 相似度
FROM gold.user_vec u
CROSS JOIN (SELECT * FROM silver.products WHERE sku IN (FROM candidates)) p
ANTI JOIN bought b ON b.customer_id = u.customer_id AND b.sku = p.sku      -- 排除已买过的
QUALIFY row_number() OVER (PARTITION BY u.customer_id ORDER BY 相似度 DESC) <= 3
ORDER BY u.customer_id, 相似度 DESC LIMIT 9`, undefined, '4b. 召回 5000 热门商品 → 每人 Top 3（2000 人 × 5000 = 1000 万次相似度）'));

// =====================================================================
// 5. 跨表 Top-N：每个城市“忠诚客户”最爱买的 3 个品牌
//    customers × loyalty_score × orders × items × products 五表关联 + 窗口排序
// =====================================================================
show(await q(con, `
SELECT c.city AS 城市, p.brand AS 品牌,
       count(DISTINCT oc.customer_id)::INT AS 忠诚客户数,
       round(sum(i.qty * p.list_price))::INT AS 销售额
FROM gold.loyalty_score ls
JOIN silver.customers    c  USING (customer_id)
JOIN silver.orders_clean oc USING (customer_id)
JOIN silver.order_items  i  USING (order_id)
JOIN silver.products     p  USING (sku)
WHERE ls.score >= 75 AND oc.status = 'paid'
GROUP BY c.city, p.brand
QUALIFY row_number() OVER (PARTITION BY c.city ORDER BY 销售额 DESC) <= 3
ORDER BY 城市, 销售额 DESC LIMIT 9`, undefined, '5. 每城市铁杆客户 Top 3 品牌（五表关联）'));

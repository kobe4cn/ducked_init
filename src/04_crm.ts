// src/04_crm.ts —— CRM 核心分析：复购、同期群、RFM、CLV、流失预警、忠诚度、等级迁移、邀请裂变
import { connect, exec, q, show } from './lib/duck.ts';

const con = await connect();
await exec(con, `SET VARIABLE as_of = TIMESTAMP '2026-09-27'`);

// =====================================================================
// 1. 复购分析：复购率、首单→二单转化、复购间隔
// =====================================================================
show(await q(con, `
WITH paid AS (
  SELECT customer_id, order_ts,
         row_number() OVER (PARTITION BY customer_id ORDER BY order_ts) AS nth
  FROM silver.orders_clean WHERE status = 'paid'
),
per_user AS (   -- 千万客户：不用 median() 等整体型聚合，平均间隔用 (末单 - 首单) / (单数 - 1)
  SELECT customer_id,
         count(*)                                                               AS orders,
         date_diff('day', min(order_ts), min(order_ts) FILTER (WHERE nth = 2))  AS days_to_2nd,
         CASE WHEN count(*) > 1
              THEN date_diff('day', min(order_ts), max(order_ts)) / (count(*) - 1) END AS avg_gap
  FROM paid GROUP BY customer_id
)
SELECT c.register_channel                                                 AS 注册渠道,
       count(*)::INT                                                       AS 下单客户,
       round(100.0 * count(*) FILTER (WHERE orders >= 2) / count(*), 1)    AS 复购率_pct,
       round(100.0 * count(*) FILTER (WHERE days_to_2nd <= 30) / count(*), 1) AS 首单30天内复购_pct,
       round(100.0 * count(*) FILTER (WHERE days_to_2nd <= 90) / count(*), 1) AS 首单90天内复购_pct,
       round(avg(orders), 2)                                                AS 人均订单,
       round(median(avg_gap))::INT                                          AS 平均复购间隔_中位数_天
FROM per_user JOIN silver.customers c USING (customer_id)
GROUP BY ALL ORDER BY 复购率_pct DESC`, undefined, '1. 复购分析（按注册渠道）'));

// 购买次数分布：一次性 / 2 次 / 3–5 次 / 6–10 次 / 10 次以上，看贡献
show(await q(con, `
SELECT CASE WHEN orders = 1 THEN '1 次' WHEN orders = 2 THEN '2 次' WHEN orders <= 5 THEN '3–5 次'
            WHEN orders <= 10 THEN '6–10 次' ELSE '10 次以上' END              AS 购买次数,
       count(*)::INT                                                         AS 客户数,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1)                    AS 客户占比_pct,
       round(100.0 * sum(gmv) / sum(sum(gmv)) OVER (), 1)                    AS GMV占比_pct
FROM gold.user_360 WHERE orders > 0
GROUP BY ALL ORDER BY min(orders)`, undefined, '1b. 多次消费的贡献结构'));

// =====================================================================
// 2. 同期群（Cohort）留存：按首单月份分组，看之后每个月还有多少人回来买
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.cohort_retention AS
WITH firsts AS (
  SELECT customer_id, date_trunc('month', min(order_ts)) AS cohort
  FROM silver.orders_clean WHERE status = 'paid' GROUP BY ALL
),
activity AS (
  SELECT DISTINCT o.customer_id, f.cohort,
         date_diff('month', f.cohort, date_trunc('month', o.order_ts)) AS m
  FROM silver.orders_clean o JOIN firsts f USING (customer_id)
  WHERE o.status = 'paid'
),
counts AS (SELECT cohort, m, count(*) AS active FROM activity GROUP BY ALL)
SELECT cohort::DATE AS cohort, m, active,
       round(100.0 * active / max(active) FILTER (WHERE m = 0) OVER (PARTITION BY cohort), 1) AS retention_pct
FROM counts`, '2. 同期群留存 → gold.cohort_retention');

show(await q(con, `
PIVOT (SELECT strftime(cohort, '%Y-%m') AS 首单月, 'M' || lpad(m::VARCHAR, 2, '0') AS m, retention_pct
       FROM gold.cohort_retention WHERE cohort >= DATE '2025-10-01' AND m BETWEEN 0 AND 6)
ON m USING first(retention_pct) ORDER BY 首单月`, undefined, '2b. 留存矩阵（%，PIVOT 行转列）'));

// =====================================================================
// 3. RFM 分层：五分位打分 + 8 类人群
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.rfm AS
WITH s AS (
  SELECT customer_id, recency_days, orders, gmv,
         6 - ntile(5) OVER (ORDER BY recency_days)  AS r,   -- 越近分越高
         ntile(5) OVER (ORDER BY orders, gmv)       AS f,
         ntile(5) OVER (ORDER BY gmv)               AS m
  FROM gold.user_360 WHERE orders > 0
)
SELECT *,
  CASE
    WHEN r >= 4 AND f >= 4 AND m >= 4 THEN '重要价值'
    WHEN r >= 4 AND f <= 2 AND m >= 4 THEN '重要发展'
    WHEN r <= 2 AND f >= 4 AND m >= 4 THEN '重要保持'
    WHEN r <= 2 AND f <= 2 AND m >= 4 THEN '重要挽留'
    WHEN r >= 4 AND f >= 4             THEN '一般价值'
    WHEN r >= 4                        THEN '新客/潜力'
    WHEN r <= 2 AND f >= 3             THEN '一般保持'
    ELSE '一般挽留'
  END AS segment
FROM s`, '3. RFM → gold.rfm');

show(await q(con, `
SELECT segment AS 人群, count(*)::INT AS 客户数,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS 占比_pct,
       round(avg(recency_days))::INT AS 平均R_天, round(avg(orders), 1) AS 平均F,
       round(avg(gmv))::INT AS 平均M, round(100.0 * sum(gmv) / sum(sum(gmv)) OVER (), 1) AS GMV贡献_pct
FROM gold.rfm GROUP BY ALL ORDER BY GMV贡献_pct DESC`, undefined, '3b. RFM 人群画像'));

// =====================================================================
// 4. CLV 客户终身价值：历史价值 + 未来 12 个月预测（简化 BG 思路：频率 × 客单 × 存活概率）
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.clv AS
WITH u AS (
  SELECT customer_id, orders, gmv, aov, recency_days, tier,
         greatest(date_diff('day', first_order_ts, getvariable('as_of')), 30) AS tenure_days
  FROM gold.user_360 WHERE orders > 0
)
SELECT *,
       orders * 365.0 / tenure_days                           AS freq_per_year,
       -- 存活概率：沉默越久、相对自身购买节奏越久，越可能已流失（指数衰减）
       exp(- recency_days / greatest(tenure_days / orders, 30) / 2.0) AS p_alive,
       round(aov * orders * 365.0 / tenure_days * exp(- recency_days / greatest(tenure_days / orders, 30) / 2.0), 2) AS clv_12m
FROM u`, '4. CLV → gold.clv');

show(await q(con, `
SELECT tier AS 会员等级, count(*)::INT AS 客户数,
       round(avg(gmv))::INT AS 历史价值_均值,
       round(avg(clv_12m))::INT AS 未来12月CLV_均值,
       round(avg(p_alive), 3) AS 平均存活概率,
       round(quantile_cont(clv_12m, 0.9))::INT AS CLV_P90
FROM gold.clv GROUP BY ALL ORDER BY 未来12月CLV_均值 DESC`, undefined, '4b. 各等级 CLV'));

// =====================================================================
// 5. 流失预警：按“个人购买节奏”判断——沉默时间超过自己平时间隔的 2 倍
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.churn_risk AS
WITH rhythm AS (
  -- 个人购买节奏 = (最后一单 - 第一单) / (订单数 - 1)，至少 3 单才算有节奏
  SELECT customer_id, count(*) AS orders,
         date_diff('day', min(order_ts), max(order_ts)) / (count(*) - 1) AS avg_gap
  FROM silver.orders_clean WHERE status = 'paid'
  GROUP BY ALL HAVING count(*) >= 3
)
SELECT u.customer_id, u.city, u.tier, u.gmv, u.recency_days, r.avg_gap, r.orders,
       round(u.recency_days / greatest(r.avg_gap, 7), 2) AS silence_ratio,
       c.clv_12m, u.views_30d, u.last_active_ts
FROM rhythm r
JOIN gold.user_360 u USING (customer_id)
JOIN gold.clv c USING (customer_id)
WHERE u.recency_days > 2 * greatest(r.avg_gap, 7)`, '5. 流失预警 → gold.churn_risk');

show(await q(con, `
SELECT city AS 城市, customer_id, tier, round(gmv)::INT AS gmv, recency_days AS 沉默天数,
       round(avg_gap)::INT AS 平均间隔_天, silence_ratio AS 沉默倍数, views_30d AS 近30天浏览
FROM gold.churn_risk
QUALIFY row_number() OVER (PARTITION BY city ORDER BY gmv DESC) <= 1   -- 每城市价值最高的一位
ORDER BY gmv DESC`, undefined, '5b. 各城市最值得挽回的高价值客户'));

show(await q(con, `
SELECT CASE WHEN views_30d > 0 THEN '近30天仍在浏览（可唤醒）' ELSE '近30天无行为（深度沉睡）' END AS 状态,
       count(*)::INT AS 人数, round(sum(gmv))::BIGINT AS 历史GMV
FROM gold.churn_risk GROUP BY ALL`, undefined, '5c. 流失风险人群的可唤醒性'));

// =====================================================================
// 6. 忠诚度评分：多维度百分位加权（交易 + 行为 + 会员 + 社交）
// =====================================================================
await exec(con, `
CREATE OR REPLACE TABLE gold.loyalty_score AS
WITH p AS (
  SELECT customer_id, tier, gmv, orders,
         1 - percent_rank() OVER (ORDER BY recency_days)       AS p_recency,
         percent_rank() OVER (ORDER BY orders)                 AS p_freq,
         percent_rank() OVER (ORDER BY gmv)                    AS p_money,
         percent_rank() OVER (ORDER BY sessions_30d)           AS p_engage,
         percent_rank() OVER (ORDER BY categories)             AS p_breadth,
         percent_rank() OVER (ORDER BY invited)                AS p_advocacy,
         1 - percent_rank() OVER (ORDER BY refunds)            AS p_refund
  FROM gold.user_360 WHERE orders > 0
)
SELECT *,
       round(100 * (0.25 * p_recency + 0.25 * p_freq + 0.20 * p_money + 0.10 * p_engage
                  + 0.08 * p_breadth + 0.07 * p_advocacy + 0.05 * p_refund), 1) AS score
FROM p`, '6. 忠诚度评分 → gold.loyalty_score');

show(await q(con, `
WITH b AS (
  SELECT *, CASE WHEN score >= 75 THEN '① 铁杆' WHEN score >= 55 THEN '② 忠诚'
                 WHEN score >= 35 THEN '③ 摇摆' ELSE '④ 疏离' END AS 忠诚度
  FROM gold.loyalty_score
)
PIVOT b ON tier IN ('普通','银卡','金卡','黑金') USING count(*) GROUP BY 忠诚度 ORDER BY 忠诚度`,
  undefined, '6b. 忠诚度 × 会员等级（发现“高等级却不忠诚”的错配）'));

// =====================================================================
// 7. 多次消费的“等级迁移”：按季度消费额分档，看客户从哪一档走到哪一档
// =====================================================================
show(await q(con, `
WITH q AS (
  SELECT customer_id, date_trunc('quarter', order_ts) AS qtr, sum(net_amount) AS spend
  FROM silver.orders_clean WHERE status = 'paid' AND order_ts >= DATE '2025-10-01' AND order_ts < DATE '2026-07-01'
  GROUP BY ALL
),
grid AS (   -- 补齐没有消费的季度（否则看不到“掉到 0”）
  SELECT c.customer_id, qs.qtr, coalesce(q.spend, 0) AS spend
  FROM (SELECT DISTINCT customer_id FROM q) c
  CROSS JOIN (SELECT unnest([DATE '2025-10-01', DATE '2026-01-01', DATE '2026-04-01'])::TIMESTAMP AS qtr) qs
  LEFT JOIN q USING (customer_id, qtr)
),
band AS (
  SELECT *, CASE WHEN spend = 0 THEN '0 未消费' WHEN spend < 500 THEN '1 低' WHEN spend < 2000 THEN '2 中' ELSE '3 高' END AS lvl,
         lead(CASE WHEN spend = 0 THEN '0 未消费' WHEN spend < 500 THEN '1 低' WHEN spend < 2000 THEN '2 中' ELSE '3 高' END)
           OVER (PARTITION BY customer_id ORDER BY qtr) AS next_lvl
  FROM grid
)
PIVOT (SELECT lvl AS 本季, next_lvl, customer_id FROM band WHERE next_lvl IS NOT NULL)
ON next_lvl USING count(*) GROUP BY 本季 ORDER BY 本季`, undefined, '7. 季度消费档位迁移矩阵（行=本季，列=下季，单位：人次）'));

// =====================================================================
// 8. 邀请裂变：递归 CTE 追踪多级下线，计算“带来的总 GMV”
// =====================================================================
show(await q(con, `
WITH RECURSIVE tree AS (
  SELECT customer_id AS root, customer_id, 0 AS depth
  FROM silver.customers WHERE customer_id IN (SELECT referrer_id FROM silver.customers)
  UNION ALL
  SELECT t.root, c.customer_id, t.depth + 1
  FROM tree t JOIN silver.customers c ON c.referrer_id = t.customer_id
  WHERE t.depth < 5
)
SELECT root AS 邀请人, max(depth) AS 最深层级, count(*) FILTER (WHERE depth > 0)::INT AS 下线人数,
       round(sum(u.gmv) FILTER (WHERE depth > 0))::INT AS 下线累计GMV
FROM tree JOIN gold.user_360 u USING (customer_id)
GROUP BY root ORDER BY 下线累计GMV DESC NULLS LAST LIMIT 5`, undefined, '8. 裂变价值 Top 5（递归 CTE，最多 5 层）'));

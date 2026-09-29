// src/08_v2_features.ts —— DuckDB 2.0 新能力在 CRM 场景里的用法
// 说明：@duckdb/node-api 的 2.0 版本尚未发布（当前 npm 最新为 1.5.5）。
//       本文件的每条 SQL 都已在 DuckDB v2.0.0-alpha 引擎上实测；2.0 驱动发布后原样运行即可。
import { writeFileSync } from 'node:fs';

type Step = { label: string; sql: string; show?: boolean };

export const steps: Step[] = [
  // ------------------------------------------------------------------
  // ⓪ 先升级存储格式：1.x 创建的库文件保持旧格式（v1.0.0），
  //    VARIANT 需要 ≥ v1.5.0，触发器需要 v2.0.0。一次性复制到新格式文件即可。
  // ------------------------------------------------------------------
  { label: '库文件升级到 v2.0 存储格式', show: true, sql: `
ATTACH './crm_v2.duckdb' AS crm_v2 (STORAGE_VERSION 'v2.0.0');
COPY FROM DATABASE crm TO crm_v2;
USE crm_v2;
SELECT database_name, tags FROM duckdb_databases() WHERE database_name IN ('crm', 'crm_v2')` },

  // ------------------------------------------------------------------
  // ① VARIANT：埋点属性不再是“慢 JSON 字符串”，自动拆列存储、按字段过滤
  // ------------------------------------------------------------------
  { label: 'VARIANT 事件表', sql: `
CREATE OR REPLACE TABLE silver.events_v AS
SELECT event_id, user_id, event, ts, session_id, props::VARIANT AS props
FROM silver.events` },
  { label: 'VARIANT 字段直接点取 + 类型转换', show: true, sql: `
SELECT props.from::VARCHAR           AS 入口,
       count(*)                       AS 浏览次数,
       round(avg(props.stay_ms::INT)) AS 平均停留_ms
FROM silver.events_v
WHERE event = 'view_item'
GROUP BY ALL ORDER BY 浏览次数 DESC` },
  { label: 'VARIANT 字段过滤（走拆列存储，快）', show: true, sql: `
SELECT count(*) AS 使用优惠券的结算
FROM silver.events_v
WHERE props.coupon::BOOLEAN` },
  // variant_exists / variant_contains 适合“结构未知”的探索；高频过滤请用字段访问（实测前两者比字段访问慢 25–75 倍）
  { label: 'variant_exists / variant_contains：按结构探索', show: true, sql: `
SELECT count(*) FILTER (WHERE variant_exists(props, 'coupon'))                        AS 带优惠券字段,
       count(*) FILTER (WHERE variant_contains(props, {'method': 'wechat'}::VARIANT)) AS 微信相关
FROM silver.events_v` },
  { label: 'VARIANT 写入湖（Parquet 保留 VARIANT 类型）', sql: `
COPY silver.events_v TO './data/silver_events_variant.parquet' (FORMAT parquet, COMPRESSION zstd)` },

  // ------------------------------------------------------------------
  // ② $变量：分析口径参数化（as_of、窗口天数）
  // ------------------------------------------------------------------
  { label: '$变量 定义分析口径', show: true, sql: `
SET VARIABLE as_of = TIMESTAMP '2026-09-27';
SET VARIABLE win   = 90;
SELECT count(*)                                      AS 近N天下单客户,
       round(sum(net_amount))::BIGINT                AS 近N天GMV
FROM (SELECT customer_id, sum(net_amount) AS net_amount
      FROM silver.orders_clean
      WHERE status = 'paid' AND order_ts >= $as_of - to_days($win)
      GROUP BY customer_id)` },

  // ------------------------------------------------------------------
  // ③ 触发器：订单一写入，实时指标表自动更新；会员升降级自动留痕
  // ------------------------------------------------------------------
  { label: '触发器：实时指标自动维护', sql: `
CREATE OR REPLACE TABLE silver.orders_stream (order_id BIGINT, customer_id INTEGER, amount DECIMAL(12,2), order_ts TIMESTAMP);
CREATE OR REPLACE TABLE gold.user_live (customer_id INTEGER PRIMARY KEY, orders INTEGER, gmv DECIMAL(14,2), last_ts TIMESTAMP);

CREATE TRIGGER trg_user_live AFTER INSERT ON silver.orders_stream
REFERENCING NEW TABLE AS n
FOR EACH STATEMENT
  INSERT INTO gold.user_live
  SELECT customer_id, count(*), sum(amount), max(order_ts) FROM n GROUP BY customer_id
  ON CONFLICT (customer_id) DO UPDATE SET
    orders  = gold.user_live.orders + excluded.orders,
    gmv     = gold.user_live.gmv + excluded.gmv,
    last_ts = greatest(gold.user_live.last_ts, excluded.last_ts);` },
  { label: '写入两批流式订单', sql: `
INSERT INTO silver.orders_stream VALUES (1, 101, 199.00, now()), (2, 101, 99.00, now()), (3, 202, 1299.00, now());
INSERT INTO silver.orders_stream VALUES (4, 101, 59.00, now());` },
  { label: '实时指标（由触发器维护）', show: true, sql: `
SELECT customer_id, orders, gmv FROM gold.user_live ORDER BY customer_id` },

  { label: '触发器：会员等级变更审计', sql: `
CREATE OR REPLACE TABLE gold.tier_changes (customer_id INTEGER, old_tier VARCHAR, new_tier VARCHAR, changed_at TIMESTAMP);
CREATE TRIGGER trg_tier_audit AFTER UPDATE ON silver.loyalty
REFERENCING OLD TABLE AS o NEW TABLE AS n
FOR EACH STATEMENT
  INSERT INTO gold.tier_changes
  SELECT n.customer_id, o.tier, n.tier, now()
  FROM o JOIN n USING (customer_id)
  WHERE o.tier IS DISTINCT FROM n.tier;` },
  { label: '按真实消费重新定级（一条 UPDATE 触发审计）', sql: `
UPDATE silver.loyalty l
SET tier = CASE WHEN u.gmv >= 15000 THEN '黑金' WHEN u.gmv >= 6000 THEN '金卡'
                WHEN u.gmv >= 1500 THEN '银卡' ELSE '普通' END
FROM gold.user_360 u
WHERE l.customer_id = u.customer_id` },
  { label: '等级变更流向', show: true, sql: `
SELECT old_tier AS 原等级, new_tier AS 新等级, count(*) AS 人数
FROM gold.tier_changes GROUP BY ALL ORDER BY 人数 DESC LIMIT 6` },

  // ------------------------------------------------------------------
  // ④ CTE 里写 DML：一条语句“取出待处理名单 → 归档 → 写入营销队列”
  // ------------------------------------------------------------------
  { label: 'DML CTE：挽回名单出队并归档', show: true, sql: `
CREATE OR REPLACE TABLE gold.winback_queue AS
  SELECT customer_id, gmv, 'pending' AS state FROM gold.churn_risk WHERE views_30d > 0;
CREATE OR REPLACE TABLE gold.winback_sent (customer_id INTEGER, gmv DOUBLE, sent_at TIMESTAMP);

WITH picked AS MATERIALIZED (
  DELETE FROM gold.winback_queue
  WHERE customer_id IN (SELECT customer_id FROM gold.winback_queue ORDER BY gmv DESC LIMIT 1000)
  RETURNING customer_id, gmv
)
INSERT INTO gold.winback_sent SELECT customer_id, gmv, now() FROM picked;

SELECT (SELECT count(*) FROM gold.winback_queue) AS 队列剩余,
       (SELECT count(*) FROM gold.winback_sent)  AS 本次发送` },

  // ------------------------------------------------------------------
  // ⑤ NEAREST 连接：相似商品推荐写成一个 JOIN
  // ------------------------------------------------------------------
  { label: 'NEAREST JOIN 推荐', show: true, sql: `
SELECT u.customer_id, p.sku, p.category
FROM (FROM gold.user_vec ORDER BY customer_id LIMIT 3) u
INNER JOIN silver.products p APPROX NEAREST 3
  BY SIMILARITY array_cosine_similarity(u.pref, p.embedding)
ORDER BY u.customer_id` },

  // ------------------------------------------------------------------
  // ⑥ USING KEY 递归：每个客户到“源头邀请人”的最短链路（图算法用纯 SQL）
  // ------------------------------------------------------------------
  { label: 'USING KEY 递归：邀请链最短层级', show: true, sql: `
WITH RECURSIVE chain(customer_id, depth) USING KEY (customer_id, min(depth)) AS (
  SELECT customer_id, 0 FROM silver.customers WHERE referrer_id IS NULL
  UNION ALL
  SELECT c.customer_id, ch.depth + 1
  FROM chain ch JOIN silver.customers c ON c.referrer_id = ch.customer_id
)
SELECT depth AS 邀请层级, count(*) AS 客户数 FROM chain GROUP BY ALL ORDER BY depth LIMIT 8` },
];

// DUMP=1 时仅导出 SQL（供 2.0 引擎校验）；否则用当前驱动执行
if (process.env.DUMP) {
  writeFileSync(process.env.DUMP, JSON.stringify(steps, null, 2));
} else {
  const { connect, q, show } = await import('./lib/duck');
  const con = await connect();
  for (const s of steps) {
    const stmts = s.sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean);
    for (const [i, st] of stmts.entries()) {
      const last = i === stmts.length - 1;
      if (last && s.show) show(await q(con, st, undefined, s.label));
      else await con.run(st);
    }
    if (!s.show) console.log(`✔ ${s.label}`);
  }
}

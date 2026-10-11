-- scripts/crm-seed/identity.sql —— 期望的身份打通（expected_identity），在真值库上执行：truth.sql 之后、round2.sql 之后各跑一次
-- 期望的身份打通：同一个人的记录，共享手机 / 邮箱 / unionid 任一项就连起来（同一个人的值都相同，没有高优先级冲突），取传递闭包。
-- 活动表的错号每人唯一：同一个人几次报名都填错时，这几条记录按同一个错号相连（phone_typo），与他别的记录连不上。
-- 统一消费者以分量里最小的 rid 标识（平台的 consumer_id 是另一套哈希，verify.ts 按分量比对，不比 ID 本身）
CREATE OR REPLACE TABLE expected_identity AS
WITH f AS (
  SELECT src, customer_id, pid, unnest(list_filter([CASE WHEN has_phone THEN 'phone' END, CASE WHEN has_email THEN 'email' END,
    CASE WHEN has_unionid THEN 'unionid' END,
    CASE WHEN src = 'activity' AND NOT has_phone THEN 'phone_typo' END], lambda x: x IS NOT NULL)) AS field
  FROM rec
), co AS (  -- 同一个人的两个字段出现在同一条记录里就连起来（每人最多 3 个字段，两轮取最小即可收敛）
  SELECT DISTINCT a.pid, a.field AS f1, b.field AS f2 FROM f a JOIN f b ON a.src = b.src AND a.customer_id = b.customer_id
), l1 AS (SELECT pid, f1 AS field, min(f2) AS lab FROM co GROUP BY ALL
), l2 AS (SELECT co.pid, co.f1 AS field, min(l1.lab) AS lab FROM co JOIN l1 ON l1.pid = co.pid AND l1.field = co.f2 GROUP BY ALL
), g AS (
  SELECT r.src, r.customer_id, r.pid, coalesce(r.pid || '/' || min(l2.lab), r.src || ':' || r.customer_id) AS comp
  FROM rec r LEFT JOIN f ON f.src = r.src AND f.customer_id = r.customer_id LEFT JOIN l2 ON l2.pid = f.pid AND l2.field = f.field
  GROUP BY r.src, r.customer_id, r.pid
)
SELECT src, customer_id, pid, min(src || ':' || customer_id) OVER (PARTITION BY comp) AS group_rid FROM g;


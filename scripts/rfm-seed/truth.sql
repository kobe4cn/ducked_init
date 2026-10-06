-- scripts/rfm-seed/truth.sql —— RFM 整体测试的真值数据（确定性造数，同样的人数总得到同样的数据）。
-- 由 seed.ts 在本机 truth.duckdb 里执行，${N} 换成人数；之后各数据源的表都从这里的三张表派生：
--   person：真实的人（pid），带画像（archetype）和在哪些数据源里有记录
--   rec：每个数据源里的一条消费者记录（src, customer_id）属于哪个 pid，以及这条记录在源端露出的手机号、邮箱、unionid 原文
--   ord：每笔订单的真值：数据源、源端订单号、标准层的 customer_id、pid（打通不到的为空）、标准状态、金额、UTC 下单与支付时间
-- 数据源代号：pg = Postgres 电商主站，my = MySQL 门店 POS，mg = MongoDB 小程序，s3 = S3 Parquet 天猫导出，dk = S3 上的 DuckDB 直播间
SET TimeZone = 'UTC';
CREATE OR REPLACE MACRO u(k, salt) AS (hash(CAST(k AS VARCHAR) || ':' || salt) % 1000000)::DOUBLE / 1000000;
-- 下单时间的终点：所有订单都在这一天及之前下单（支付最晚到第二天）
CREATE OR REPLACE MACRO data_end() AS TIMESTAMP '2026-10-03 00:00:00';

-- ---------- 人 ----------
CREATE OR REPLACE TABLE person AS
WITH a AS (
  SELECT range + 1 AS pid, (hash((range + 1)::VARCHAR || ':a') % 100)::INT AS a,
    u(range + 1, 'pg') < 0.60 AS pg0, u(range + 1, 'my') < 0.35 AS my, u(range + 1, 'mg') < 0.30 AS mg,
    u(range + 1, 's3') < 0.25 AS s3, u(range + 1, 'dk') < 0.20 AS dk
  FROM range(${N}))
SELECT pid,
  CASE WHEN a < 10 THEN 'champion' WHEN a < 25 THEN 'loyal' WHEN a < 40 THEN 'new' WHEN a < 60 THEN 'at_risk'
       WHEN a < 80 THEN 'occasional' WHEN a < 90 THEN 'one_time_old' WHEN a < 95 THEN 'big_ticket' ELSE 'no_order' END AS archetype,
  pg0 OR NOT (my OR mg OR s3 OR dk) AS in_pg, my AS in_my, mg AS in_mg, s3 AS in_s3, dk AS in_dk,
  '139' || lpad(pid::VARCHAR, 8, '0') AS phone,
  'user' || pid || '@rfm.test' AS email,
  'UN' || substr(md5(pid::VARCHAR), 1, 20) AS unionid,
  NULL::VARCHAR AS note
FROM a;

-- ---------- 每个数据源里的消费者记录 ----------
-- 露出哪些身份字段（保证同一个人的记录按 手机 > 邮箱 > unionid 的规则能连起来，不同的人不会连起来）：
--   pg：邮箱、unionid 总有；手机号一般有，只有这个人不在 my、dk 时有 15% 没有
--   my：手机号总有（+86 138-xxxx-xxxx 格式）；邮箱 80% 有（大写、前后带空格）
--   mg：邮箱总有（大小写混写、带空格）；这个人不在 pg 时还有手机号（0086 前缀）
--   s3：unionid 总有；这个人不在 pg 时还有手机号
--   dk：只有手机号（中间带空格）
CREATE OR REPLACE TABLE rec AS
WITH pg AS (
  SELECT 'pg' AS src, pid, row_number() OVER (ORDER BY pid)::VARCHAR AS customer_id,
    CASE WHEN NOT in_my AND NOT in_dk AND u(pid, 'pgph') < 0.15 THEN NULL ELSE phone END AS phone_raw,
    email AS email_raw, unionid AS unionid_raw
  FROM person WHERE in_pg
), my AS (
  SELECT 'my', pid, row_number() OVER (ORDER BY pid)::VARCHAR,
    '+86 ' || substr(phone, 1, 3) || '-' || substr(phone, 4, 4) || '-' || substr(phone, 8, 4),
    CASE WHEN u(pid, 'myem') < 0.8 THEN '  ' || upper(email) || ' ' END, NULL
  FROM person WHERE in_my
), mg AS (
  SELECT 'mg', pid, 'M' || lpad(row_number() OVER (ORDER BY pid)::VARCHAR, 7, '0'),
    CASE WHEN NOT in_pg THEN '0086' || phone END,
    ' User' || pid || '@RFM.test', NULL
  FROM person WHERE in_mg
), s3 AS (
  SELECT 's3', pid, 'tb_' || substr(md5('s3' || pid), 1, 12),
    CASE WHEN NOT in_pg THEN phone END, NULL, unionid
  FROM person WHERE in_s3
), dk AS (
  SELECT 'dk', pid, (500000 + row_number() OVER (ORDER BY pid))::VARCHAR,
    substr(phone, 1, 3) || ' ' || substr(phone, 4, 4) || ' ' || substr(phone, 8, 4), NULL, NULL
  FROM person WHERE in_dk
)
SELECT * FROM pg UNION ALL SELECT * FROM my UNION ALL SELECT * FROM mg UNION ALL SELECT * FROM s3 UNION ALL SELECT * FROM dk;

-- ---------- 订单 ----------
-- 每个人按画像定单数、日期分布与客单价，订单随机落在他有记录的数据源里
CREATE OR REPLACE TABLE ord_raw AS
WITH p AS (
  SELECT *,
    CASE archetype
      WHEN 'champion' THEN 15 + floor(u(pid, 'n') * 26) WHEN 'loyal' THEN 6 + floor(u(pid, 'n') * 10)
      WHEN 'new' THEN 1 + floor(u(pid, 'n') * 2) WHEN 'at_risk' THEN 5 + floor(u(pid, 'n') * 16)
      WHEN 'occasional' THEN 2 + floor(u(pid, 'n') * 4) WHEN 'one_time_old' THEN 1
      WHEN 'big_ticket' THEN 1 + floor(u(pid, 'n') * 2) ELSE 0 END::INT AS n,
    list_filter([CASE WHEN in_pg THEN 'pg' END, CASE WHEN in_my THEN 'my' END, CASE WHEN in_mg THEN 'mg' END,
                 CASE WHEN in_s3 THEN 's3' END, CASE WHEN in_dk THEN 'dk' END], x -> x IS NOT NULL) AS srcs
  FROM person
), k AS (
  SELECT p.*, unnest(range(n)) AS k FROM p WHERE n > 0
), d AS (
  SELECT pid, archetype, srcs, pid || '-' || k AS key,
    CASE archetype
      WHEN 'champion' THEN CASE WHEN k = 0 THEN floor(u(pid || '-' || k, 'd') * 30) ELSE floor(u(pid || '-' || k, 'd') * 1095) END
      WHEN 'loyal' THEN CASE WHEN k = 0 THEN floor(u(pid || '-' || k, 'd') * 90) ELSE floor(u(pid || '-' || k, 'd') * 730) END
      WHEN 'new' THEN floor(u(pid || '-' || k, 'd') * 60)
      WHEN 'at_risk' THEN 200 + floor(u(pid || '-' || k, 'd') * 700)
      WHEN 'occasional' THEN floor(u(pid || '-' || k, 'd') * 1095)
      WHEN 'one_time_old' THEN 365 + floor(u(pid || '-' || k, 'd') * 730)
      ELSE floor(u(pid || '-' || k, 'd') * 400) END::INT AS offset_days,
    CASE archetype
      WHEN 'champion' THEN [300, 1500] WHEN 'loyal' THEN [100, 400] WHEN 'new' THEN [50, 800] WHEN 'at_risk' THEN [80, 500]
      WHEN 'occasional' THEN [30, 300] WHEN 'one_time_old' THEN [20, 200] ELSE [2000, 8000] END AS aov
  FROM k
)
SELECT pid, key,
  srcs[1 + floor(u(key, 'src') * len(srcs))::INT] AS src,
  data_end() - to_days(offset_days) + to_seconds(floor(u(key, 't') * 86400)::BIGINT) AS created_utc,
  round(aov[1] + u(key, 'amt') * (aov[2] - aov[1]), 2)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(key, 'st') < 0.55 THEN 'paid' WHEN u(key, 'st') < 0.75 THEN 'completed' WHEN u(key, 'st') < 0.83 THEN 'shipped'
       WHEN u(key, 'st') < 0.90 THEN 'refunded' WHEN u(key, 'st') < 0.96 THEN 'cancelled' ELSE 'created' END AS status,
  -- 5% 的订单支付比下单晚 20 小时（多半跨天，验证按支付日期计）
  CASE WHEN u(key, 'late') < 0.05 THEN 72000 ELSE floor(u(key, 'pay') * 3600)::BIGINT END AS pay_delay
FROM d;

-- 打通不到消费者的订单：my 的散客单（没有会员号）与 mg 的孤儿单（会员号在 users 里不存在）
CREATE OR REPLACE TABLE ord_unlinked AS
SELECT NULL::BIGINT AS pid, 'u-' || src || '-' || i AS key, src,
  data_end() - to_days(floor(u(src || i, 'd') * 1095)::INT) + to_seconds(floor(u(src || i, 't') * 86400)::BIGINT) AS created_utc,
  round(20 + u(src || i, 'amt') * 480, 2)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(src || i, 'st') < 0.7 THEN 'paid' WHEN u(src || i, 'st') < 0.85 THEN 'completed' ELSE 'refunded' END AS status,
  floor(u(src || i, 'pay') * 3600)::BIGINT AS pay_delay,
  CASE WHEN src = 'mg' THEN 'M9' || lpad(i::VARCHAR, 6, '0') END AS customer_id
FROM (SELECT 'my' AS src, range AS i FROM range(3000) UNION ALL SELECT 'mg', range FROM range(1500));

-- 源端订单号：按数据源各自编号。pg 与 my 都用从 1 开始的整数（同号不同单，标准层按数据源区分）
CREATE OR REPLACE TABLE ord AS
WITH x AS (
  SELECT o.pid, o.key, o.src, r.customer_id, o.status, o.amount, o.created_utc,
    CASE WHEN o.status IN ('paid', 'shipped', 'completed', 'refunded') THEN o.created_utc + to_seconds(o.pay_delay) END AS paid_utc
  FROM ord_raw o JOIN rec r ON r.src = o.src AND r.pid = o.pid
  UNION ALL
  SELECT pid, key, src, customer_id, status, amount, created_utc, created_utc + to_seconds(pay_delay) FROM ord_unlinked
)
SELECT x.*,
  CASE src WHEN 'pg' THEN rn::VARCHAR WHEN 'my' THEN rn::VARCHAR WHEN 'mg' THEN 'MG' || lpad(rn::VARCHAR, 9, '0')
           WHEN 's3' THEN (3000000000000 + rn)::VARCHAR ELSE 'LV-' || lpad(rn::VARCHAR, 8, '0') END AS order_id
FROM (SELECT *, row_number() OVER (PARTITION BY src ORDER BY created_utc, key) AS rn FROM x) x;
ALTER TABLE ord DROP COLUMN rn;

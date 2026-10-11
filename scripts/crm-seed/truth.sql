-- scripts/crm-seed/truth.sql —— crmlab 多渠道 CRM 测试的真值（确定性造数：同样的人数与终点日得到同样的数据）。
-- 由 seed.ts 在本机 truth.duckdb 里执行：${N} 换成人数，${END} 换成数据终点日（默认造数当天，UTC）。各数据源的表都由这里派生，
-- verify.ts 也只读这里算期望。所有时间都是 UTC 的 TIMESTAMP；写进源端时再按各源的习惯转成北京时间、毫秒、字符串。
-- 数据源代号：pos = MySQL 门店收银，mall = Postgres 自营商城与小程序，tmall = S3 Parquet 天猫导出，douyin = S3 CSV 抖店导出，
-- oms = MongoDB 订单中台（天猫订单的第二份拷贝），loyalty = Postgres 会员中心，wecom = S3 上的 DuckDB 文件（企业微信），
-- events = S3 埋点，activity = S3 CSV 线下活动报名表。
-- 探针是 pid ≥ 99000001 的人（archetype = 'probe'），不参与随机生成的订单、行为与积分，由各节末尾的「探针」显式写入。
SET TimeZone = 'UTC';
CREATE OR REPLACE MACRO u(k, salt) AS (hash(CAST(k AS VARCHAR) || ':' || salt) % 1000000)::DOUBLE / 1000000;
CREATE OR REPLACE MACRO data_end() AS TIMESTAMP '${END} 00:00:00';
CREATE OR REPLACE MACRO ago(days) AS TIMESTAMP '${END} 00:00:00' - to_days(CAST(days AS INTEGER));

-- ---------- 人 ----------
CREATE OR REPLACE TABLE person AS
WITH b AS (
  SELECT range + 1 AS pid, (hash((range + 1)::VARCHAR || ':a') % 100)::INT AS a,
    u(range + 1, 'mall') < 0.55 AS m, u(range + 1, 'pos') < 0.35 AS p, u(range + 1, 'tmall') < 0.25 AS t, u(range + 1, 'dy') < 0.12 AS d
  FROM range(${N})
), r AS (
  SELECT pid,
    CASE WHEN a < 10 THEN 'champion' WHEN a < 25 THEN 'loyal' WHEN a < 40 THEN 'new' WHEN a < 60 THEN 'at_risk'
         WHEN a < 80 THEN 'occasional' WHEN a < 90 THEN 'one_time_old' WHEN a < 95 THEN 'big_ticket' ELSE 'browser' END AS archetype,
    m OR NOT (p OR t OR d) AS in_mall, p AS in_pos, t AS in_tmall, d AS in_douyin,
    (m OR NOT (p OR t OR d) OR p) AND u(pid, 'wecom') < 0.25 AS in_wecom,
    (m OR NOT (p OR t OR d) OR p) AND u(pid, 'loy') < 0.70 AS in_loyalty,
    u(pid, 'act') < 0.03 AS in_activity
  FROM b
), probe(pid, in_mall, in_pos, in_tmall, in_douyin, in_wecom, in_loyalty, in_activity, note) AS (VALUES
  (99000001, true,  true,  true,  false, true,  true,  false, 'P01 全渠道'),
  (99000002, true,  false, false, false, false, false, false, 'P02 换号 A'),
  (99000003, false, true,  false, false, false, false, false, 'P02 换号 B（邮箱同 A，手机不同）'),
  (99000004, true,  false, false, false, false, false, false, 'P03 家人 A'),
  (99000005, false, false, false, false, false, true,  false, 'P03 家人 B（邮箱同 A，手机不同）'),
  (99000006, false, false, true,  false, false, false, false, 'P04 天猫无身份'),
  (99000007, true,  true,  false, false, false, false, true,  'P05 手机格式'),
  (99000008, true,  false, false, false, false, false, false, 'P06 匿名后登录'),
  (99000009, true,  false, false, false, false, false, false, 'P07 共享设备 A'),
  (99000010, true,  false, false, false, false, false, false, 'P07 共享设备 B'),
  (99000011, true,  true,  false, false, false, false, false, 'P08 后来才连上'),
  (99000012, false, false, false, true,  false, false, false, 'P09 抖音未授权'),
  (99000013, true,  false, false, true,  false, false, false, 'P10 抖音授权'),
  (99000014, true,  false, false, false, false, false, true,  'P11 活动错号'),
  (99000015, false, false, true,  false, true,  false, false, 'P12 企微导购'),
  (99000016, true,  false, false, false, false, true,  false, 'L2 退款冲回'),
  (99000017, false, false, false, false, false, true,  false, 'L3 余额不一致'),
  (99000018, true,  false, false, false, false, false, false, 'E1 浏览未购'),
  (99000019, false, true,  false, false, false, false, false, 'E2 时区边界'),
  (99000020, true,  false, false, false, false, false, true,  'E3 活动到场'),
  (99000021, false, false, false, false, false, true,  false, 'C1 券'),
  (99000031, false, true,  false, false, false, false, false, 'S1 状态 pos'),
  (99000032, true,  false, false, false, false, false, false, 'S1 状态 mall'),
  (99000033, false, false, true,  false, false, false, false, 'S1 状态 tmall'),
  (99000034, false, false, false, true,  false, false, false, 'S1 状态 douyin'))
SELECT pid, archetype, in_mall, in_pos, in_tmall, in_douyin, in_wecom, in_loyalty, in_activity, NULL::VARCHAR AS note FROM r
UNION ALL
SELECT pid, 'probe', in_mall, in_pos, in_tmall, in_douyin, in_wecom, in_loyalty, in_activity, note FROM probe;

ALTER TABLE person ADD COLUMN phone VARCHAR;
ALTER TABLE person ADD COLUMN email VARCHAR;
ALTER TABLE person ADD COLUMN unionid VARCHAR;
ALTER TABLE person ADD COLUMN openid VARCHAR;
ALTER TABLE person ADD COLUMN name VARCHAR;
ALTER TABLE person ADD COLUMN city VARCHAR;
ALTER TABLE person ADD COLUMN gender VARCHAR;
ALTER TABLE person ADD COLUMN birthday DATE;
UPDATE person SET
  phone = '139' || lpad((pid % 100000000)::VARCHAR, 8, '0'),
  email = 'u' || pid || '@jianyi.test',
  unionid = 'UN' || substr(md5(pid::VARCHAR), 1, 20),
  openid = 'dy_' || substr(md5('dy' || pid), 1, 16),
  name = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴'][1 + (pid % 10)::INT] || ['一', '二', '三', '四', '五', '六', '七', '八', '九'][1 + ((pid // 10) % 9)::INT] || (pid % 1000),
  city = ['上海', '北京', '杭州', '广州', '深圳', '成都', '南京', '武汉', '西安', '重庆'][1 + floor(u(pid, 'city') * 10)::INT],
  gender = CASE WHEN u(pid, 'g') < 0.7 THEN 'female' WHEN u(pid, 'g') < 0.97 THEN 'male' ELSE 'unknown' END,
  birthday = DATE '1965-01-01' + floor(u(pid, 'bd') * 14000)::INT;
-- 探针：P02 两人邮箱相同、P03 一家人共用邮箱
UPDATE person SET email = 'u99000002@jianyi.test' WHERE pid = 99000003;
UPDATE person SET email = 'u99000004@jianyi.test' WHERE pid = 99000005;
UPDATE person SET city = '上海' WHERE pid = 99000001;

-- ---------- 门店、大区、导购、商品（主数据） ----------
CREATE OR REPLACE TABLE region AS
SELECT * FROM (VALUES ('R1', '华东'), ('R2', '华北'), ('R3', '华南'), ('R4', '华中'), ('R5', '西南'), ('R6', '西北'), ('R7', '东北'), ('R9', '测试')) v(region_id, name);
CREATE OR REPLACE TABLE store AS
SELECT 'S' || lpad((range + 1)::VARCHAR, 3, '0') AS store_id, ['上海', '北京', '杭州', '广州', '深圳', '成都', '南京', '武汉', '西安', '重庆'][1 + (range % 10)::INT] || '门店' || (range + 1) AS name,
  ['R1', 'R2', 'R1', 'R3', 'R3', 'R5', 'R1', 'R4', 'R6', 'R5'][1 + (range % 10)::INT] AS region_id
FROM range(200)
UNION ALL SELECT 'T999', '测试门店', 'R9';
CREATE OR REPLACE TABLE guide AS
SELECT 'G' || lpad((range + 1)::VARCHAR, 4, '0') AS guide_id, '导购' || (range + 1) AS name, 'S' || lpad((range % 200 + 1)::VARCHAR, 3, '0') AS store_id FROM range(600);
CREATE OR REPLACE TABLE product AS
SELECT 'SKU' || lpad((range + 1)::VARCHAR, 5, '0') AS product_id,
  ['上装', '下装', '连衣裙', '外套', '鞋', '包', '护肤', '彩妆', '香氛', '配饰'][1 + (range % 10)::INT] AS category,
  ['简衣', '简衣 Lab', '简衣 Kids'][1 + floor(u(range, 'br') * 3)::INT] AS brand,
  round(29 + u(range, 'pr') * 1500, 0)::DECIMAL(12, 2) AS price
FROM range(2000);
ALTER TABLE product ADD COLUMN name VARCHAR;
UPDATE product SET name = category || ' ' || product_id;

-- ---------- 每个数据源里的消费者记录 ----------
-- rid = 数据源:customer_id（标准层的 (_source, customer_id)）。has_* 表示这条记录露出了这个人的哪些身份字段（原文在 *_raw，格式各源不同）；
-- 同一个人的记录之间只露出他自己的值，不同的人不会撞上，所以期望的统一消费者 = 同一个人里按共同字段连起来的分量（见末尾 expected_identity）
CREATE OR REPLACE TABLE rec AS
WITH mall AS (
  SELECT 'mall' AS src, pid, row_number() OVER (ORDER BY pid)::VARCHAR AS customer_id,
    u(pid, 'mph') < 0.85 AS has_phone, true AS has_email, u(pid, 'mun') < 0.70 AS has_unionid
  FROM person WHERE in_mall
), pos AS (
  SELECT 'pos', pid, row_number() OVER (ORDER BY pid)::VARCHAR, true, u(pid, 'pem') < 0.5, false FROM person WHERE in_pos
), tmall AS (
  SELECT 'tmall', pid, 'tb_' || substr(md5('tb' || pid), 1, 12), u(pid, 'tph') < 0.3, false, u(pid, 'tun') < 0.6 FROM person WHERE in_tmall
), douyin AS (
  SELECT 'douyin', pid, openid, u(pid, 'dph') < 0.4, false, false FROM person WHERE in_douyin
), wecom AS (
  SELECT 'wecom', pid, 'wm' || substr(md5('wm' || pid), 1, 18), u(pid, 'wph') < 0.2, false, true FROM person WHERE in_wecom
), loyalty AS (
  SELECT 'loyalty', pid, 'L' || lpad(row_number() OVER (ORDER BY pid)::VARCHAR, 9, '0'), true, u(pid, 'lem') < 0.6, u(pid, 'lun') < 0.5 FROM person WHERE in_loyalty
)
SELECT * FROM mall UNION ALL SELECT * FROM pos UNION ALL SELECT * FROM tmall UNION ALL SELECT * FROM douyin UNION ALL SELECT * FROM wecom UNION ALL SELECT * FROM loyalty;
-- 探针的身份字段：默认只露手机号，再按用例改
UPDATE rec SET has_phone = true, has_email = false, has_unionid = false WHERE pid >= 99000000;
UPDATE rec SET has_email = true, has_unionid = true WHERE pid = 99000001 AND src = 'mall';
UPDATE rec SET has_phone = false, has_unionid = true WHERE pid IN (99000001, 99000015) AND src IN ('tmall', 'wecom');
UPDATE rec SET has_email = true WHERE (pid = 99000002 AND src = 'mall') OR (pid = 99000003 AND src = 'pos')
  OR (pid = 99000004 AND src = 'mall') OR (pid = 99000005 AND src = 'loyalty');
UPDATE rec SET has_phone = false WHERE (pid = 99000006 AND src = 'tmall') OR (pid = 99000012 AND src = 'douyin');
UPDATE rec SET has_phone = false, has_email = true WHERE pid = 99000011 AND src = 'mall';

-- ---------- 线下活动报名（每一行报名是一条消费者记录 + 一个报名事件，到场的再加一个到场事件） ----------
CREATE OR REPLACE TABLE activity AS
SELECT 'ACT' || lpad((range + 1)::VARCHAR, 2, '0') AS activity_id,
  ['春季新品发布会', '会员沙龙', '美妆课堂', '亲子日', '周年庆', '穿搭讲座', '香氛体验', '夏日市集', '秋冬预览', '年终答谢'][range + 1] AS name,
  ago(330 - range * 30) AS held_at
FROM range(10);
CREATE OR REPLACE TABLE signup AS
WITH k AS (
  SELECT pid, unnest(range(1 + floor(u(pid, 'nact') * 3)::INT)) AS k FROM person WHERE in_activity AND pid < 99000000
), s AS (
  SELECT pid, 'ACT' || lpad((1 + floor(u(pid || '-' || k, 'which') * 10))::INT::VARCHAR, 2, '0') AS activity_id,
    u(pid || '-' || k, 'att') < 0.6 AS attended, u(pid, 'typo') < 0.02 AS typo, floor(u(pid, 'fmt') * 4)::INT AS fmt
  FROM k
  UNION ALL SELECT * FROM (VALUES (99000007, 'ACT09', true, false, 2), (99000014, 'ACT09', true, true, 0),
    (99000020, 'ACT08', true, false, 0), (99000020, 'ACT09', false, false, 0)) v(pid, activity_id, attended, typo, fmt)
)
SELECT DISTINCT ON (pid, activity_id) s.*, a.held_at - to_days(3 + floor(u(pid || s.activity_id, 'sd') * 20)::INT) + to_seconds(floor(u(pid || s.activity_id, 'st') * 86400)::BIGINT) AS signup_utc
FROM s JOIN activity a USING (activity_id);
ALTER TABLE signup ADD COLUMN signup_id VARCHAR;
UPDATE signup SET signup_id = x.id FROM (SELECT pid, activity_id, 'SU' || lpad(row_number() OVER (ORDER BY signup_utc, pid)::VARCHAR, 8, '0') AS id FROM signup) x
WHERE signup.pid = x.pid AND signup.activity_id = x.activity_id;
INSERT INTO rec SELECT 'activity', pid, signup_id, NOT typo, false, false FROM signup;

-- 身份字段在源端的原文（格式各源不同，平台规范化后再哈希）；抖音另有掩码手机（不是身份字段，映射成 phone 会把不同的人连起来）
ALTER TABLE rec ADD COLUMN phone_raw VARCHAR;
ALTER TABLE rec ADD COLUMN email_raw VARCHAR;
ALTER TABLE rec ADD COLUMN unionid_raw VARCHAR;
ALTER TABLE rec ADD COLUMN phone_mask VARCHAR;
UPDATE rec SET
  phone_raw = CASE WHEN has_phone THEN CASE src
      WHEN 'pos' THEN '+86 ' || substr(p.phone, 1, 3) || '-' || substr(p.phone, 4, 4) || '-' || substr(p.phone, 8, 4)
      ELSE p.phone END END,
  email_raw = CASE WHEN has_email THEN CASE src WHEN 'pos' THEN '  ' || upper(p.email) || ' ' ELSE p.email END END,
  unionid_raw = CASE WHEN has_unionid THEN p.unionid END,
  phone_mask = CASE WHEN src = 'douyin' THEN substr(p.phone, 1, 3) || '****' || substr(p.phone, 8, 4) END
FROM person p WHERE p.pid = rec.pid;
UPDATE rec SET phone_raw = CASE WHEN s.typo THEN '13' || substr(p.phone, 4) ELSE CASE s.fmt
    WHEN 0 THEN p.phone WHEN 1 THEN '+86' || p.phone
    WHEN 2 THEN substr(p.phone, 1, 3) || ' ' || substr(p.phone, 4, 4) || ' ' || substr(p.phone, 8, 4)
    ELSE substr(p.phone, 1, 3) || '-' || substr(p.phone, 4, 4) || '-' || substr(p.phone, 8, 4) END END
FROM signup s, person p WHERE rec.src = 'activity' AND s.signup_id = rec.customer_id AND p.pid = rec.pid;
-- 同一个人在 POS 的城市有 3% 与商城不同（K8：多源属性不一致）；P01 在 POS 是杭州
ALTER TABLE rec ADD COLUMN city VARCHAR;
UPDATE rec SET city = CASE WHEN src = 'pos' AND (u(rec.pid, 'pcity') < 0.03 OR rec.pid = 99000001)
  THEN CASE WHEN p.city = '杭州' THEN '南京' ELSE '杭州' END ELSE p.city END
FROM person p WHERE p.pid = rec.pid;

-- ---------- 订单 ----------
-- 每个人按画像定单数、日期分布与客单价，订单随机落在他有记录的下单渠道里（pos、mall、tmall、douyin），近两年
CREATE OR REPLACE TABLE ord_raw AS
WITH p AS (
  SELECT *,
    CASE archetype
      WHEN 'champion' THEN 10 + floor(u(pid, 'n') * 21) WHEN 'loyal' THEN 5 + floor(u(pid, 'n') * 8)
      WHEN 'new' THEN 1 + floor(u(pid, 'n') * 2) WHEN 'at_risk' THEN 4 + floor(u(pid, 'n') * 9)
      WHEN 'occasional' THEN 2 + floor(u(pid, 'n') * 4) WHEN 'one_time_old' THEN 1
      WHEN 'big_ticket' THEN 1 + floor(u(pid, 'n') * 2) ELSE 0 END::INT AS n,
    list_filter([CASE WHEN in_pos THEN 'pos' END, CASE WHEN in_mall THEN 'mall' END, CASE WHEN in_tmall THEN 'tmall' END,
                 CASE WHEN in_douyin THEN 'douyin' END], lambda x: x IS NOT NULL) AS srcs
  FROM person WHERE archetype <> 'probe'
), k AS (
  SELECT p.*, unnest(range(n)) AS k FROM p WHERE n > 0
), d AS (
  SELECT pid, archetype, srcs, pid || '-' || k AS key,
    CASE archetype
      WHEN 'champion' THEN CASE WHEN k = 0 THEN floor(u(pid || '-' || k, 'd') * 30) ELSE floor(u(pid || '-' || k, 'd') * 730) END
      WHEN 'loyal' THEN CASE WHEN k = 0 THEN floor(u(pid || '-' || k, 'd') * 90) ELSE floor(u(pid || '-' || k, 'd') * 730) END
      WHEN 'new' THEN floor(u(pid || '-' || k, 'd') * 60)
      WHEN 'at_risk' THEN 200 + floor(u(pid || '-' || k, 'd') * 530)
      WHEN 'occasional' THEN floor(u(pid || '-' || k, 'd') * 730)
      WHEN 'one_time_old' THEN 365 + floor(u(pid || '-' || k, 'd') * 365)
      ELSE floor(u(pid || '-' || k, 'd') * 400) END::INT AS offset_days,
    CASE archetype
      WHEN 'champion' THEN [300, 1500] WHEN 'loyal' THEN [100, 400] WHEN 'new' THEN [50, 800] WHEN 'at_risk' THEN [80, 500]
      WHEN 'occasional' THEN [30, 300] WHEN 'one_time_old' THEN [20, 200] ELSE [2000, 8000] END AS aov
  FROM k
)
SELECT pid, key,
  srcs[1 + floor(u(key, 'src') * len(srcs))::INT] AS src,
  data_end() - to_days(offset_days + 1) + to_seconds(floor(u(key, 't') * 86400)::BIGINT) AS created_utc,
  round(aov[1] + u(key, 'amt') * (aov[2] - aov[1]), 0)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(key, 'st') < 0.55 THEN 'paid' WHEN u(key, 'st') < 0.75 THEN 'completed' WHEN u(key, 'st') < 0.83 THEN 'shipped'
       WHEN u(key, 'st') < 0.90 THEN 'refunded' WHEN u(key, 'st') < 0.96 THEN 'cancelled' ELSE 'created' END AS status,
  floor(u(key, 'pay') * 3600)::BIGINT AS pay_delay
FROM d;
-- 探针的订单（金额、状态、时间都是定值）
INSERT INTO ord_raw SELECT pid, key, src, created_utc, amount, status, 600 FROM (VALUES
  (99000001, 'p01-pos',  'pos',   ago(20) + INTERVAL 10 HOUR, 300.00, 'completed'),
  (99000001, 'p01-mini', 'mall',  ago(15) + INTERVAL 10 HOUR, 200.00, 'paid'),
  (99000001, 'p01-web',  'mall',  ago(12) + INTERVAL 10 HOUR, 100.00, 'shipped'),
  (99000001, 'p01-tm',   'tmall', ago(10) + INTERVAL 10 HOUR, 150.00, 'completed'),
  (99000016, 'l2-mall',  'mall',  ago(30) + INTERVAL 10 HOUR,  80.00, 'refunded'),
  (99000012, 'p09-dy',   'douyin', ago(8) + INTERVAL 10 HOUR,  99.00, 'completed'),
  (99000013, 'p10-dy',   'douyin', ago(8) + INTERVAL 11 HOUR, 120.00, 'completed'),
  -- E2：北京时间第二天 07:30 = UTC 前一天 23:30（标准层的 created_at 应是 UTC 的前一天）
  (99000019, 'e2-pos',   'pos',   ago(5) + INTERVAL 23 HOUR + INTERVAL 30 MINUTE, 88.00, 'completed'),
  (99000031, 's1-pos-1', 'pos',   ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000031, 's1-pos-2', 'pos',   ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000031, 's1-pos-3', 'pos',   ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000031, 's1-pos-4', 'pos',   ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000031, 's1-pos-5', 'pos',   ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000031, 's1-pos-6', 'pos',  ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000032, 's1-mall-1', 'mall', ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000032, 's1-mall-2', 'mall', ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000032, 's1-mall-3', 'mall', ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000032, 's1-mall-4', 'mall', ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000032, 's1-mall-5', 'mall', ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000032, 's1-mall-6', 'mall', ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000033, 's1-tm-1', 'tmall',  ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000033, 's1-tm-2', 'tmall',  ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000033, 's1-tm-3', 'tmall',  ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000033, 's1-tm-4', 'tmall',  ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000033, 's1-tm-5', 'tmall',  ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000033, 's1-tm-6', 'tmall', ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000034, 's1-dy-1', 'douyin', ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000034, 's1-dy-2', 'douyin', ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000034, 's1-dy-3', 'douyin', ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000034, 's1-dy-4', 'douyin', ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000034, 's1-dy-5', 'douyin', ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000034, 's1-dy-6', 'douyin', ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded')
) v(pid, key, src, created_utc, amount, status);

-- 打通不到消费者的订单：POS 散客单（约每 100 人 1 单，member_id 为空）与测试门店 T999 的 37 笔（K7，映射的 where 应把它们去掉）
CREATE OR REPLACE TABLE ord_unlinked AS
SELECT NULL::BIGINT AS pid, 'walkin-' || range AS key, 'pos' AS src,
  data_end() - to_days(1 + floor(u(range, 'wd') * 730)::INT) + to_seconds(floor(u(range, 'wt') * 86400)::BIGINT) AS created_utc,
  round(20 + u(range, 'wa') * 480, 0)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(range, 'ws') < 0.8 THEN 'completed' ELSE 'refunded' END AS status, 300::BIGINT AS pay_delay, false AS test_store
FROM range(greatest(${N} // 100, 10))
UNION ALL
SELECT NULL, 'test-' || range, 'pos', ago(1 + range) + INTERVAL 3 HOUR, 1.00, 'completed', 60, true FROM range(37);

-- 订单真值：标准层的 customer_id、渠道、门店、UTC 下单与支付时间、源端订单号。pos 与 mall 的订单号都从 1 开始（K1：同号不同单，要声明键空间）
CREATE OR REPLACE TABLE ord AS
WITH x AS (
  SELECT o.pid, o.key, o.src, r.customer_id, o.status, o.amount, o.created_utc, o.pay_delay, false AS test_store
  FROM ord_raw o JOIN rec r ON r.src = o.src AND r.pid = o.pid
  UNION ALL
  SELECT pid, key, src, NULL, status, amount, created_utc, pay_delay, test_store FROM ord_unlinked
), y AS (
  SELECT *,
    CASE WHEN status IN ('paid', 'shipped', 'completed', 'refunded') THEN created_utc + to_seconds(pay_delay) END AS paid_utc,
    CASE src WHEN 'pos' THEN 'store' WHEN 'mall' THEN CASE WHEN key = 'p01-web' OR (key <> 'p01-mini' AND u(key, 'ch') < 0.4) THEN 'web' ELSE 'miniapp' END
      ELSE src END AS channel,
    CASE WHEN test_store THEN 'T999' WHEN src = 'pos' THEN CASE WHEN key = 'p01-pos' THEN 'S001' ELSE 'S' || lpad((1 + floor(u(key, 'store') * 200))::INT::VARCHAR, 3, '0') END END AS store_id,
    row_number() OVER (PARTITION BY src ORDER BY created_utc, key) AS rn
  FROM x
)
SELECT pid, key, src, customer_id, status, amount, created_utc, paid_utc, channel, store_id, test_store,
  CASE src WHEN 'pos' THEN rn::VARCHAR WHEN 'mall' THEN rn::VARCHAR WHEN 'tmall' THEN (3000000000000 + rn)::VARCHAR
    ELSE '69' || lpad(rn::VARCHAR, 17, '0') END AS order_id
FROM y;

-- 抖店导出里只有下过单的买家：没有抖音订单的抖音记录不存在
DELETE FROM rec WHERE src = 'douyin' AND customer_id NOT IN (SELECT customer_id FROM ord WHERE src = 'douyin');

-- 期望的身份打通在 identity.sql（第二轮变更后要重算）

-- ---------- 订单明细（pos 与 mall；明细号也各自从 1 开始） ----------
-- 每单 1–3 行，金额均分、最后一行补齐差额，所以明细金额之和 = 订单金额；商品只在商城维护（K3：POS 明细跨源引用商城的 SKU）
CREATE OR REPLACE TABLE item AS
WITH k AS (
  SELECT src, order_id, key, amount, unnest(range(1 + floor(u(key, 'ni') * 3)::INT)) AS i, 1 + floor(u(key, 'ni') * 3)::INT AS n
  FROM ord WHERE src IN ('pos', 'mall') AND NOT test_store
), v AS (
  SELECT src, order_id, i, n,
    'SKU' || lpad((1 + floor(u(key || i, 'sku') * 2000))::INT::VARCHAR, 5, '0') AS product_id,
    CASE WHEN u(key || i, 'q') < 0.8 THEN 1 ELSE 2 END AS quantity,
    CAST(CASE WHEN i < n - 1 THEN round(amount / n, 2) ELSE amount - round(amount / n, 2) * (n - 1) END AS DECIMAL(12, 2)) AS amount
  FROM k
)
SELECT src, order_id, product_id, quantity, amount, CAST(round(amount / quantity, 2) AS DECIMAL(12, 2)) AS unit_price,
  row_number() OVER (PARTITION BY src ORDER BY order_id::BIGINT, i)::VARCHAR AS item_id
FROM v;

-- ---------- 会员中心：会员、积分流水 ----------
CREATE OR REPLACE TABLE membership AS
SELECT r.pid, r.customer_id, 'VIP' || lpad(row_number() OVER (ORDER BY r.pid)::VARCHAR, 9, '0') AS membership_id,
  ago(30 + floor(u(r.pid, 'join') * 1500)::INT) AS joined_utc,
  CASE WHEN u(r.pid, 'mst') < 0.95 THEN 'active' WHEN u(r.pid, 'mst') < 0.98 THEN 'frozen' ELSE 'cancelled' END AS status
FROM rec r WHERE r.src = 'loyalty';

-- 积分：会员在 pos、mall 的每笔已支付订单获得 floor(金额) 分；退款的 7 天后 adjust 冲回；没退款的按比例产生
-- spend（30 天后抵扣 30%）、redeem（45 天后兑换 50%，获得 ≥ 200 时）、expire（365 天后过期 10%）；1% 客服补偿 +5。
-- 每笔扣减都不超过对应的获得，所以余额不为负。只记 data_end() 之前发生的
CREATE OR REPLACE TABLE ledger_raw AS
WITH earn AS (
  SELECT m.membership_id, m.customer_id, o.src AS order_src, o.order_id, o.key, floor(o.amount)::BIGINT AS pts, o.paid_utc, o.status
  FROM ord o JOIN membership m ON m.pid = o.pid
  WHERE o.src IN ('pos', 'mall') AND o.paid_utc IS NOT NULL AND m.pid < 99000000 AND floor(o.amount) > 0
)
SELECT membership_id, customer_id, 'earn' AS change_type, pts AS points_change, order_src, order_id, paid_utc AS occurred_utc, paid_utc + INTERVAL 365 DAY AS expires_utc FROM earn
UNION ALL SELECT membership_id, customer_id, 'adjust', -pts, order_src, order_id, paid_utc + INTERVAL 7 DAY, NULL FROM earn WHERE status = 'refunded'
UNION ALL SELECT membership_id, customer_id, 'spend', -floor(pts * 0.3)::BIGINT, NULL, NULL, paid_utc + INTERVAL 30 DAY, NULL FROM earn WHERE status <> 'refunded' AND u(key, 'spend') < 0.15
UNION ALL SELECT membership_id, customer_id, 'redeem', -floor(pts * 0.5)::BIGINT, NULL, NULL, paid_utc + INTERVAL 45 DAY, NULL FROM earn WHERE status <> 'refunded' AND pts >= 200 AND u(key, 'redeem') < 0.05
UNION ALL SELECT membership_id, customer_id, 'expire', -floor(pts * 0.1)::BIGINT, NULL, NULL, paid_utc + INTERVAL 365 DAY, NULL FROM earn WHERE status <> 'refunded' AND u(key, 'exp') < 0.3
UNION ALL SELECT membership_id, customer_id, 'adjust', 5, NULL, NULL, paid_utc + INTERVAL 3 DAY, NULL FROM earn WHERE u(key, 'comp') < 0.01;
-- 探针：L1（P01 全生命周期，余额 15）、L2（退款冲回，净 0）、L3（流水求和 200，会员表余额写成 999）
INSERT INTO ledger_raw SELECT m.membership_id, m.customer_id, v.change_type, v.points_change, v.order_src,
    CASE WHEN v.order_key IS NOT NULL THEN (SELECT order_id FROM ord WHERE key = v.order_key) END, v.occurred_utc, v.expires_utc
FROM (VALUES
  (99000001, 'earn',    100, 'mall', 'p01-mini', ago(15) + INTERVAL 11 HOUR, ago(15) + INTERVAL 365 DAY),
  (99000001, 'spend',   -30, NULL, NULL, ago(14), NULL),
  (99000001, 'redeem',  -50, NULL, NULL, ago(13), NULL),
  (99000001, 'expire',  -10, NULL, NULL, ago(12), NULL),
  (99000001, 'adjust',    5, NULL, NULL, ago(11), NULL),
  (99000016, 'earn',     80, 'mall', 'l2-mall', ago(30) + INTERVAL 11 HOUR, ago(30) + INTERVAL 365 DAY),
  (99000016, 'adjust',  -80, 'mall', 'l2-mall', ago(23), NULL),
  (99000017, 'earn',    200, NULL, NULL, ago(40), ago(40) + INTERVAL 365 DAY)
) v(pid, change_type, points_change, order_src, order_key, occurred_utc, expires_utc)
JOIN membership m ON m.pid = v.pid;
DELETE FROM ledger_raw WHERE occurred_utc >= data_end();
CREATE OR REPLACE TABLE ledger AS
SELECT *, 'PT' || lpad(row_number() OVER (ORDER BY occurred_utc, membership_id, change_type, order_id)::VARCHAR, 11, '0') AS ledger_id,
  sum(points_change) OVER (PARTITION BY membership_id ORDER BY occurred_utc, change_type, order_id ROWS UNBOUNDED PRECEDING) AS balance_after
FROM ledger_raw;
-- 会员表上的当前余额 = 流水求和；L3 故意写错（G6 / #148）
ALTER TABLE membership ADD COLUMN points BIGINT;
UPDATE membership SET points = coalesce((SELECT sum(points_change) FROM ledger l WHERE l.membership_id = membership.membership_id), 0);
UPDATE membership SET points = 999 WHERE pid = 99000017;
ALTER TABLE membership ADD COLUMN level VARCHAR;
UPDATE membership SET level = CASE WHEN points >= 5000 THEN 'gold' WHEN points >= 1000 THEN 'silver' ELSE 'normal' END;

-- ---------- 券模板与券 ----------
CREATE OR REPLACE TABLE coupon_template AS
SELECT 'CT' || lpad((range + 1)::VARCHAR, 3, '0') AS coupon_template_id,
  ['cash', 'cash', 'discount', 'gift', 'shipping'][1 + (range % 5)::INT] AS coupon_type,
  CASE range % 5 WHEN 0 THEN 20 WHEN 1 THEN 50 END::DECIMAL(12, 2) AS face_value,
  CASE WHEN range % 5 = 2 THEN 85 END::DECIMAL(12, 2) AS pay_percent,
  CASE range % 5 WHEN 0 THEN 199 WHEN 1 THEN 399 END::DECIMAL(12, 2) AS min_spend,
  'CAMP' || lpad((range % 6 + 1)::VARCHAR, 2, '0') AS campaign_id
FROM range(30);
ALTER TABLE coupon_template ADD COLUMN name VARCHAR;
UPDATE coupon_template SET name = CASE coupon_type WHEN 'cash' THEN '满' || min_spend::INT || '减' || face_value::INT WHEN 'discount' THEN '85 折券'
  WHEN 'gift' THEN '赠品兑换券' ELSE '免运费券' END || '（' || coupon_template_id || '）';
CREATE OR REPLACE TABLE coupon AS
WITH k AS (
  SELECT pid, customer_id, unnest(range(floor(u(pid, 'nc') * 5)::INT)) AS k FROM membership WHERE pid < 99000000
  UNION ALL SELECT pid, customer_id, unnest(range(3)) FROM membership WHERE pid = 99000021
), c AS (
  SELECT pid, customer_id, k, pid || '-' || k AS ck,
    CASE WHEN pid = 99000021 THEN 'CT001' ELSE 'CT' || lpad((1 + floor(u(pid || '-' || k, 'ct') * 30))::INT::VARCHAR, 3, '0') END AS coupon_template_id,
    CASE WHEN pid = 99000021 THEN ago(20) ELSE ago(1 + floor(u(pid || '-' || k, 'ci') * 400)::INT) END AS issued_utc
  FROM k
)
SELECT c.pid, c.customer_id, c.coupon_template_id, t.campaign_id, c.issued_utc,
  CASE WHEN c.pid = 99000021 THEN ['redeemed', 'expired', 'issued'][c.k + 1]
       WHEN u(c.ck, 'cs') < 0.05 THEN 'voided' WHEN u(c.ck, 'cs') < 0.40 THEN 'redeemed'
       WHEN c.issued_utc + INTERVAL 30 DAY < data_end() THEN 'expired' ELSE 'issued' END AS status,
  CASE WHEN c.pid = 99000021 AND c.k = 1 THEN ago(5) WHEN c.pid = 99000021 THEN ago(-10) ELSE c.issued_utc + INTERVAL 30 DAY END AS expires_utc,
  coalesce(t.face_value, 10)::DECIMAL(12, 2) AS face,
  'CP' || lpad(row_number() OVER (ORDER BY c.issued_utc, c.ck)::VARCHAR, 10, '0') AS coupon_id, c.ck
FROM c JOIN coupon_template t USING (coupon_template_id);
ALTER TABLE coupon ADD COLUMN redeemed_utc TIMESTAMP;
UPDATE coupon SET redeemed_utc = least(issued_utc + to_days(1 + floor(u(ck, 'rd') * 20)::INT), data_end() - INTERVAL 1 HOUR) WHERE status = 'redeemed';

-- ---------- 营销同意与偏好 ----------
-- 会员中心按渠道记同意；POS 会员表另有一个短信订阅开关（K5：同一个人两个源的同意可能矛盾，P01 会员中心同意、POS 后来撤回）
CREATE OR REPLACE TABLE consent AS
WITH c AS (SELECT pid, customer_id, unnest(['sms', 'email', 'wechat']) AS channel FROM membership)
SELECT 'loyalty' AS src, pid, customer_id, channel,
  CASE WHEN pid = 99000001 THEN 'granted' WHEN u(pid || channel, 'cg') < 0.8 THEN 'granted' ELSE 'revoked' END AS status,
  CASE WHEN pid = 99000001 THEN ago(200) ELSE ago(100 + floor(u(pid || channel, 'cgt') * 900)::INT) END AS granted_utc
FROM c WHERE pid = 99000001 OR u(pid || channel, 'cp') < 0.6
UNION ALL
SELECT 'pos', r.pid, r.customer_id, 'sms', CASE WHEN r.pid = 99000001 OR u(r.pid, 'pso') >= 0.6 THEN 'revoked' ELSE 'granted' END,
  ago(400 + floor(u(r.pid, 'psg') * 300)::INT)
FROM rec r WHERE r.src = 'pos';
ALTER TABLE consent ADD COLUMN revoked_utc TIMESTAMP;
UPDATE consent SET revoked_utc = CASE WHEN pid = 99000001 AND src = 'pos' THEN ago(30) ELSE granted_utc + to_days(1 + floor(u(pid || channel || src, 'rv') * 90)::INT) END
WHERE status = 'revoked';
CREATE OR REPLACE TABLE preference AS
SELECT DISTINCT pid, customer_id, 'category' AS preference_type,
  ['上装', '下装', '连衣裙', '外套', '鞋', '包', '护肤', '彩妆', '香氛', '配饰'][1 + floor(u(pid || k, 'pc') * 10)::INT] AS preference_value,
  ago(floor(u(pid, 'pu') * 300)::INT) AS updated_utc
FROM (SELECT pid, customer_id, unnest(range(1 + floor(u(pid, 'np') * 2)::INT)) AS k FROM membership);

-- ---------- 埋点行为事件（App / 小程序 / 网站） ----------
-- 商城用户每人 1–2 台设备；按画像定会话数，每次会话 3–8 个事件：一半会话已登录（先一个 login，事件带商城的 customer_id），
-- 一半匿名（只有 device_id，平台经设备归属对应到人）。另有从未登录过的匿名设备（每 20 人一台），归属不到任何人
CREATE OR REPLACE TABLE device AS
SELECT pid, k, 'D' || substr(md5(pid || '-' || k), 1, 14) AS device_id
FROM (SELECT pid, unnest(range(CASE WHEN u(pid, 'nd') < 0.8 THEN 1 ELSE 2 END)) AS k FROM person WHERE in_mall AND pid < 99000000);
CREATE OR REPLACE TABLE session AS
WITH p AS (
  SELECT p.pid, r.customer_id,
    CASE p.archetype WHEN 'champion' THEN 20 WHEN 'loyal' THEN 12 WHEN 'new' THEN 6 WHEN 'at_risk' THEN 3 WHEN 'occasional' THEN 5
      WHEN 'one_time_old' THEN 1 WHEN 'big_ticket' THEN 3 ELSE 8 END AS n
  FROM person p JOIN rec r ON r.pid = p.pid AND r.src = 'mall' WHERE p.pid < 99000000
)
SELECT p.pid, p.customer_id, p.pid || '-' || p.k AS sk, u(p.pid || '-' || p.k, 'login') < 0.5 AS logged_in,
  d.device_id AS device_id0, d1.device_id AS device_id1,
  data_end() - to_days(1 + floor(u(p.pid || '-' || p.k, 'sd') * 365)::INT) + to_seconds(floor(u(p.pid || '-' || p.k, 'stt') * 86000)::BIGINT) AS start_utc
FROM (SELECT p.*, unnest(range(n)) AS k FROM p) p JOIN device d ON d.pid = p.pid AND d.k = 0
LEFT JOIN device d1 ON d1.pid = p.pid AND d1.k = 1;
CREATE OR REPLACE TABLE event_raw AS
WITH e AS (
  SELECT s.pid, s.customer_id, s.logged_in, s.sk, s.start_utc, CASE WHEN s.device_id1 IS NOT NULL AND u(s.sk, 'dev2') < 0.3 THEN s.device_id1 ELSE s.device_id0 END AS device_id,
    unnest(range(3 + floor(u(s.sk, 'ne') * 6)::INT)) AS i
  FROM session s
)
SELECT pid, CASE WHEN logged_in THEN customer_id END AS customer_id, device_id,
  CASE WHEN logged_in AND i = 0 THEN 'login' WHEN u(sk || i, 'et') < 0.15 THEN 'add_to_cart' ELSE 'view' END AS event_type,
  start_utc + to_seconds(i * 40) AS occurred_utc,
  '/p/SKU' || lpad((1 + floor(u(sk || i, 'pg') * 2000))::INT::VARCHAR, 5, '0') AS page
FROM e
UNION ALL
SELECT NULL, NULL, 'A' || substr(md5('anon' || range), 1, 14), 'view',
  data_end() - to_days(1 + floor(u(range, 'ad') * 365)::INT) + to_seconds(floor(u(range, 'at') * 86000)::BIGINT), '/'
FROM range(greatest(${N} // 20, 10));
-- 探针：P06 设备 D6 匿名浏览 12 次后登录；P07 设备 D7 先被 A、后被 B 登录，中间的 5 次匿名浏览归 B；E1（P15）近 7 天浏览 10、加购 2、从未下单
INSERT INTO event_raw SELECT v.pid, CASE WHEN v.logged_in THEN r.customer_id END, v.device_id, v.event_type, v.occurred_utc, '/p/SKU00007'
FROM (
  SELECT 99000008 AS pid, false AS logged_in, 'DPROBE06' AS device_id, 'view' AS event_type, ago(4) + to_seconds(range * 60) AS occurred_utc FROM range(12)
  UNION ALL SELECT 99000008, true, 'DPROBE06', 'login', ago(3)
  UNION ALL SELECT 99000009, true, 'DPROBE07', 'login', ago(20)
  UNION ALL SELECT NULL, false, 'DPROBE07', 'view', ago(10) + to_seconds(range * 60) FROM range(5)
  UNION ALL SELECT 99000010, true, 'DPROBE07', 'login', ago(5)
  UNION ALL SELECT 99000018, true, 'DPROBE15', 'login', ago(6)
  UNION ALL SELECT 99000018, true, 'DPROBE15', 'view', ago(6) + to_seconds(60 + range * 60) FROM range(10)
  UNION ALL SELECT 99000018, true, 'DPROBE15', 'add_to_cart', ago(5) + to_seconds(range * 60) FROM range(2)
) v LEFT JOIN rec r ON r.pid = v.pid AND r.src = 'mall';
-- 匿名浏览在真值里记到设备的真实主人（P07 那 5 次记到最后登录的 B）
UPDATE event_raw SET pid = 99000010 WHERE device_id = 'DPROBE07' AND pid IS NULL;
CREATE OR REPLACE TABLE event AS
SELECT *, 'EV' || lpad(row_number() OVER (ORDER BY occurred_utc, device_id, event_type)::VARCHAR, 12, '0') AS event_id FROM event_raw;
DROP TABLE event_raw;

-- ---------- 企业微信（导购添加的外部联系人、聊天、群发） ----------
CREATE OR REPLACE TABLE wecom_contact AS
SELECT r.pid, r.customer_id AS external_userid,
  CASE WHEN r.pid = 99000015 THEN 'G0001' ELSE 'G' || lpad((1 + floor(u(r.pid, 'guide') * 600))::INT::VARCHAR, 4, '0') END AS guide_id,
  ago(10 + floor(u(r.pid, 'wadd') * 700)::INT) AS added_utc,
  CASE WHEN r.pid < 99000000 AND u(r.pid, 'wdel') < 0.05 THEN ago(1 + floor(u(r.pid, 'wdd') * 9)::INT) END AS deleted_utc
FROM rec r WHERE r.src = 'wecom';
CREATE OR REPLACE TABLE wecom_chat AS
SELECT c.pid, c.external_userid, c.guide_id, 'CH' || lpad(row_number() OVER (ORDER BY c.external_userid, k)::VARCHAR, 11, '0') AS chat_id,
  CASE WHEN c.pid = 99000015 THEN ago(2 + k * 5) ELSE c.added_utc + to_days(floor(u(c.external_userid || k, 'cd') * 300)::INT) END AS chat_utc,
  1 + floor(u(c.external_userid || k, 'mc') * 20)::INT AS msg_count
FROM (SELECT c.*, unnest(range(CASE WHEN c.pid = 99000015 THEN 4 ELSE floor(u(c.pid, 'nchat') * 10)::INT END)) AS k FROM wecom_contact c) c;
DELETE FROM wecom_chat WHERE chat_utc >= data_end();
CREATE OR REPLACE TABLE wecom_send AS
SELECT c.pid, c.external_userid, 'CAMP' || lpad((k + 1)::VARCHAR, 2, '0') AS campaign_id, ago(300 - k * 50) AS sent_utc,
  CASE WHEN u(c.external_userid || k, 'ss') < 0.05 THEN 'failed' WHEN u(c.external_userid || k, 'ss') < 0.55 THEN 'delivered'
       WHEN u(c.external_userid || k, 'ss') < 0.85 THEN 'opened' ELSE 'clicked' END AS status,
  'MS' || lpad(row_number() OVER (ORDER BY k, c.external_userid)::VARCHAR, 11, '0') AS send_id
FROM (SELECT *, unnest(range(6)) AS k FROM wecom_contact) c
WHERE u(c.external_userid || k, 'sendto') < 0.5 AND c.added_utc < ago(300 - k * 50);

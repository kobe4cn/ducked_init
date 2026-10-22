-- scripts/fmcg-seed/truth.sql —— fmcglab 快消（乳品）多渠道 CRM 测试的真值（确定性造数：同样的人数与终点日得到同样的数据）。
-- 由 seed.ts 在本机 truth.duckdb 里执行：${N} 换成人数，${END} 换成数据终点日（默认造数当天，UTC）。各数据源的表都由这里派生，
-- verify.ts 也只读这里算期望。所有时间都是 UTC 的 TIMESTAMP；写进源端时再按各源的习惯转成北京时间、毫秒、字符串。
-- 来源代号：member = PG 会员中心（小程序会员、积分、券、同意），mall = PG 小程序商城（订单、周期购），scan = MySQL 一物一码平台，
-- station = MySQL 奶站订奶系统，erp = MySQL ERP（商品、大区），oms = MongoDB 订单中台（三个电商平台订单的第二份拷贝 + B2B 团购单），
-- tmall = S3 Parquet 天猫，jd = S3 CSV 京东，douyin = S3 CSV 抖店，events = S3 JSON 小程序埋点，wecom = S3 上的 DuckDB 文件（企业微信社群），
-- activity = S3 CSV 地推试饮报名表，sellout = S3 CSV 经销商回传的商超门店周销量。
-- 探针是 pid ≥ 99000001 的人（archetype = 'probe'），不参与随机生成的订单、扫码与积分，由各节末尾的「探针」显式写入。
SET TimeZone = 'UTC';
CREATE OR REPLACE MACRO u(k, salt) AS (hash(CAST(k AS VARCHAR) || ':' || salt) % 1000000)::DOUBLE / 1000000;
CREATE OR REPLACE MACRO data_end() AS TIMESTAMP '${END} 00:00:00';
CREATE OR REPLACE MACRO ago(days) AS TIMESTAMP '${END} 00:00:00' - to_days(CAST(days AS INTEGER));

-- ---------- 主数据：大区、城市、商品 ----------
CREATE OR REPLACE TABLE region AS
SELECT * FROM (VALUES ('R1', '华东'), ('R2', '华北'), ('R3', '华南'), ('R4', '华中'), ('R5', '西南'), ('R6', '西北'), ('R7', '东北')) v(region_id, name);
CREATE OR REPLACE TABLE city AS
SELECT * FROM (VALUES (1, '上海', 'R1'), (2, '杭州', 'R1'), (3, '苏州', 'R1'), (4, '南京', 'R1'), (5, '北京', 'R2'), (6, '天津', 'R2'), (7, '广州', 'R3'),
  (8, '深圳', 'R3'), (9, '武汉', 'R4'), (10, '长沙', 'R4'), (11, '成都', 'R5'), (12, '重庆', 'R5'), (13, '西安', 'R6'), (14, '沈阳', 'R7')) v(ci, city, region_id);
-- 60 个在售 SKU 在 ERP 里（HC0053–HC0060 的品牌 ERP 没填），HC0061–HC0063 是新品，只在扫码平台登记了（K3：商品由两个系统各维护一部分）
CREATE OR REPLACE TABLE product AS
WITH p AS (SELECT range + 1 AS i FROM range(63))
SELECT 'HC' || lpad(i::VARCHAR, 4, '0') AS product_id, i,
  ['低温鲜奶', '常温纯奶', '酸奶', '儿童奶', '奶粉', '奶酪', '植物蛋白'][1 + ((i - 1) % 7)::INT] AS category,
  CASE WHEN (i - 1) % 7 = 3 THEN '小禾' WHEN i % 3 = 0 THEN '禾川有机' ELSE '禾川' END AS brand,
  round(CASE (i - 1) % 7 WHEN 0 THEN 12 + u(i, 'pr') * 18 WHEN 1 THEN 50 + u(i, 'pr') * 30 WHEN 2 THEN 15 + u(i, 'pr') * 25
    WHEN 3 THEN 40 + u(i, 'pr') * 30 WHEN 4 THEN 200 + u(i, 'pr') * 200 WHEN 5 THEN 30 + u(i, 'pr') * 30 ELSE 40 + u(i, 'pr') * 30 END, 1)::DECIMAL(12, 2) AS price,
  5 + floor(u(i, 'pts') * 4)::INT * 5 AS scan_points,
  i <= 60 AS in_erp, i > 52 AS erp_brand_missing
FROM p;
ALTER TABLE product ADD COLUMN name VARCHAR;
UPDATE product SET name = brand || category || ' ' || ['250ml', '200ml×12', '100g×8', '125ml×16', '800g', '18g×20', '250ml×10'][1 + ((i - 1) % 7)::INT] || '（' || product_id || '）';
UPDATE product SET scan_points = 10 WHERE product_id = 'HC0001';

-- ---------- 人 ----------
-- 画像：family 家庭常购、regular 普通复购、baby 母婴奶粉、new 新客、lapsed 流失、scanner 只在商超买（只扫码）、light 偶尔买；
-- walkin 地推现场的路人（只在活动表里出现一次，手机号由导购代填）、qa 扫码平台的测试账号
CREATE OR REPLACE TABLE person AS
WITH b AS (
  SELECT range + 1 AS pid, (hash((range + 1)::VARCHAR || ':a') % 100)::INT AS a FROM range(${N})
), r AS (
  SELECT pid,
    CASE WHEN a < 20 THEN 'family' WHEN a < 40 THEN 'regular' WHEN a < 48 THEN 'baby' WHEN a < 60 THEN 'new'
         WHEN a < 75 THEN 'lapsed' WHEN a < 90 THEN 'scanner' ELSE 'light' END AS archetype
  FROM b
), c AS (
  SELECT pid, archetype, archetype = 'scanner' AS sc,
    u(pid, 'mem') < 0.45 AS m0, archetype = 'scanner' OR u(pid, 'scan') < 0.35 AS in_scan,
    archetype <> 'scanner' AND u(pid, 'stn') < 0.06 AS in_station,
    archetype <> 'scanner' AND u(pid, 'tm') < 0.25 AS in_tmall, archetype <> 'scanner' AND u(pid, 'jd') < 0.18 AS in_jd,
    archetype <> 'scanner' AND u(pid, 'dy') < 0.12 AS in_douyin
  FROM r
), d AS (
  -- 线上一个渠道都没有、也不订奶的买家，让他在小程序商城买
  SELECT *, NOT sc AND NOT (in_station OR in_tmall OR in_jd OR in_douyin) AS mall_only FROM c
), e AS (
  SELECT pid, archetype, m0 OR mall_only AS in_member, (m0 AND NOT sc AND u(pid, 'mall') < 0.6) OR mall_only AS in_mall,
    in_scan, in_station, in_tmall, in_jd, in_douyin
  FROM d
), probe(pid, in_member, in_mall, in_scan, in_station, in_tmall, in_jd, in_douyin, in_wecom, in_activity, note) AS (VALUES
  (99000001, true,  true,  true,  true,  true,  true,  true,  true,  false, 'P01 全渠道'),
  (99000002, false, false, true,  false, false, false, false, false, false, 'P02 扫码无身份'),
  (99000003, true,  false, true,  false, false, false, false, false, false, 'P03 扫码后绑手机（第二轮）'),
  (99000004, true,  false, false, true,  false, false, false, false, false, 'P04 奶站占位手机 A（另有会员）'),
  (99000005, false, false, false, true,  false, false, false, false, false, 'P04 奶站占位手机 B'),
  (99000007, true,  false, false, false, false, false, false, false, false, 'P06 匿名浏览后登录'),
  (99000008, true,  false, false, false, true,  false, false, false, false, 'P07 天猫入会'),
  (99000009, true,  false, false, false, true,  false, false, false, false, 'P07 天猫未入会'),
  (99000010, false, false, false, false, true,  false, false, false, false, 'K2a 订单中台退款更晚'),
  (99000011, false, false, false, false, false, true,  false, false, false, 'K2b 京东确认收货更晚'),
  (99000012, false, false, true,  false, false, false, false, false, false, 'K10 先扫码'),
  (99000013, false, false, true,  false, false, false, false, false, false, 'K10 重复扫码'),
  (99000014, true,  false, true,  true,  false, false, false, false, false, 'K8 城市冲突'),
  (99000015, true,  false, false, true,  false, false, false, false, false, 'K5 同意冲突'),
  (99000016, true,  true,  true,  false, false, false, false, false, false, 'L1 积分全周期'),
  (99000017, true,  true,  false, false, false, false, false, false, false, 'L2 退款冲回'),
  (99000018, true,  false, false, false, false, false, false, false, false, 'L3 余额不一致'),
  (99000019, false, false, true,  false, false, false, false, false, false, 'E1 扫码未购'),
  (99000020, false, false, false, true,  false, false, false, false, false, 'E2 时区边界'),
  (99000021, true,  false, false, false, false, false, false, false, false, 'C1 券'),
  (99000022, true,  true,  false, false, false, false, false, false, false, 'SUB 周期购'),
  (99000023, true,  false, false, false, false, false, false, true,  false, 'W1 社群'),
  (99000024, false, false, false, false, true,  false, false, false, false, 'K4 天猫商家编码缺失'),
  (99000025, false, false, false, false, false, false, false, false, true,  'T1 试饮'),
  (99000031, true,  true,  false, false, false, false, false, false, false, 'S1 状态 mall'),
  (99000032, false, false, false, true,  false, false, false, false, false, 'S1 状态 station'),
  (99000033, false, false, false, false, true,  false, false, false, false, 'S1 状态 tmall'),
  (99000034, false, false, false, false, false, true,  false, false, false, 'S1 状态 jd'),
  (99000035, false, false, false, false, false, false, true,  false, false, 'S1 状态 douyin'),
  -- 地推导购：本人是会员，现场替没带手机的路人填了自己的手机号（P05）
  (99000060, true, false, false, false, false, false, false, false, false, 'P05 地推导购 1'),
  (99000061, true, false, false, false, false, false, false, false, false, 'P05 地推导购 2'),
  (99000062, true, false, false, false, false, false, false, false, false, 'P05 地推导购 3'),
  (99000063, true, false, false, false, false, false, false, false, false, 'P05 地推导购 4'))
SELECT pid, archetype, in_member, in_mall, in_scan, in_station, in_tmall, in_jd, in_douyin,
  in_member AND u(pid, 'wc') < 0.25 AS in_wecom, u(pid, 'act') < 0.03 AS in_activity, NULL::VARCHAR AS note FROM e
UNION ALL
SELECT pid, 'probe', in_member, in_mall, in_scan, in_station, in_tmall, in_jd, in_douyin, in_wecom, in_activity, note FROM probe
UNION ALL  -- 路人：每位导购代填 greatest(N / 5000, 5) 个
SELECT 98000000 + range + 1, 'walkin', false, false, false, false, false, false, false, false, true, NULL FROM range(4 * greatest(${N} // 5000, 5))
UNION ALL
SELECT 98100000 + range + 1, 'qa', false, false, true, false, false, false, false, false, false, NULL FROM range(2);

ALTER TABLE person ADD COLUMN phone VARCHAR;
ALTER TABLE person ADD COLUMN unionid VARCHAR;
ALTER TABLE person ADD COLUMN name VARCHAR;
ALTER TABLE person ADD COLUMN city VARCHAR;
ALTER TABLE person ADD COLUMN gender VARCHAR;
ALTER TABLE person ADD COLUMN birthday DATE;
UPDATE person SET
  phone = '13' || lpad((pid % 1000000000)::VARCHAR, 9, '0'),
  unionid = 'oU' || substr(md5(pid::VARCHAR), 1, 24),
  name = ['张', '王', '李', '赵', '陈', '刘', '杨', '黄', '周', '吴'][1 + (pid % 10)::INT] || ['一', '二', '三', '四', '五', '六', '七', '八', '九'][1 + ((pid // 10) % 9)::INT] || (pid % 1000),
  city = (SELECT city FROM city WHERE ci = 1 + floor(u(pid, 'city') * 14)::INT),
  gender = CASE WHEN u(pid, 'g') < 0.72 THEN 'female' WHEN u(pid, 'g') < 0.97 THEN 'male' ELSE 'unknown' END,
  birthday = DATE '1960-01-01' + floor(u(pid, 'bd') * 15000)::INT;
UPDATE person SET city = '上海' WHERE pid IN (99000001, 99000014);
-- 导购与路人在同一个城市
UPDATE person SET city = '杭州' WHERE pid BETWEEN 99000060 AND 99000063 OR archetype = 'walkin';

-- ---------- 每个数据源里的消费者记录 ----------
-- rid = 数据源:customer_id（标准层的 (_source, customer_id)）。has_* 表示这条记录露出了这个人的哪些身份字段（原文在 *_raw）；
-- 同一个人的记录之间只露出他自己的值，不同的人不会撞上（导购代填、奶站占位手机号除外：它们在真值里不算身份字段，见 identity.sql）
CREATE OR REPLACE TABLE rec AS
WITH member AS (
  SELECT 'member' AS src, pid, 'M' || lpad(row_number() OVER (ORDER BY pid)::VARCHAR, 9, '0') AS customer_id, true AS has_phone, u(pid, 'mun') < 0.8 AS has_unionid
  FROM person WHERE in_member
), scan AS (
  SELECT 'scan', pid, 'oHC' || substr(md5('scan' || pid), 1, 20), u(pid, 'sph') < 0.15, CASE WHEN in_member THEN u(pid, 'sun') < 0.7 ELSE u(pid, 'sun') < 0.5 END
  FROM person WHERE in_scan
), station AS (
  SELECT 'station', pid, row_number() OVER (ORDER BY pid)::VARCHAR, u(pid, 'sph0') >= 0.1, false FROM person WHERE in_station
), tmall AS (
  SELECT 'tmall', pid, 'AAH' || substr(md5('tm' || pid), 1, 16), u(pid, 'tph') < 0.3, false FROM person WHERE in_tmall
), jd AS (
  SELECT 'jd', pid, 'jd_' || substr(md5('jd' || pid), 1, 14), u(pid, 'jph') < 0.15, false FROM person WHERE in_jd
), douyin AS (
  SELECT 'douyin', pid, 'dy_' || substr(md5('dy' || pid), 1, 16), u(pid, 'dph') < 0.4, false FROM person WHERE in_douyin
), wecom AS (
  SELECT 'wecom', pid, 'wm' || substr(md5('wm' || pid), 1, 18), u(pid, 'wph') < 0.2, true FROM person WHERE in_wecom
)
SELECT * FROM member UNION ALL SELECT * FROM scan UNION ALL SELECT * FROM station UNION ALL SELECT * FROM tmall
UNION ALL SELECT * FROM jd UNION ALL SELECT * FROM douyin UNION ALL SELECT * FROM wecom;
-- 扫码平台的测试账号什么身份字段都没有
UPDATE rec SET has_phone = false, has_unionid = false WHERE pid > 98100000 AND pid < 99000000;
-- 探针：默认只露手机号，再按用例改
UPDATE rec SET has_phone = true, has_unionid = false WHERE pid >= 99000000;
UPDATE rec SET has_unionid = true WHERE src = 'member' AND pid IN (99000001, 99000016, 99000023);
UPDATE rec SET has_phone = false, has_unionid = true WHERE (pid = 99000001 AND src IN ('scan', 'wecom')) OR (pid = 99000016 AND src = 'scan')
  OR (pid = 99000019 AND src = 'scan') OR (pid = 99000023 AND src = 'wecom');
UPDATE rec SET has_phone = false WHERE (src = 'scan' AND pid IN (99000002, 99000003, 99000012, 99000013))
  OR (src = 'station' AND pid IN (99000004, 99000005)) OR (src = 'tmall' AND pid = 99000009);

-- ---------- 地推试饮报名（每一行报名是一条消费者记录 + 一个报名事件） ----------
CREATE OR REPLACE TABLE activity AS
SELECT 'ACT' || lpad((range + 1)::VARCHAR, 2, '0') AS activity_id,
  ['春季鲜奶试饮', '社区亲子日', '有机奶品鉴', '儿童奶开学季', '夏日酸奶节', '奶粉妈妈课堂', '中秋团购会', '国庆试饮', '冬季热饮', '年货节'][range + 1] AS name,
  ago(320 - range * 30) AS held_at
FROM range(10);
CREATE OR REPLACE TABLE signup AS
WITH k AS (
  SELECT pid, unnest(range(1 + floor(u(pid, 'nact') * 2)::INT)) AS k FROM person WHERE in_activity AND archetype NOT IN ('probe', 'walkin')
), s AS (
  SELECT pid, 'ACT' || lpad((1 + floor(u(pid || '-' || k, 'which') * 10))::INT::VARCHAR, 2, '0') AS activity_id,
    u(pid || '-' || k, 'rcv') < 0.7 AS received, u(pid, 'typo') < 0.02 AS typo, floor(u(pid, 'fmt') * 4)::INT AS fmt, NULL::BIGINT AS proxy_pid
  FROM k
  UNION ALL  -- 路人：活动 ACT09，导购 99000060 + (序号 % 4) 代填手机号
  SELECT pid, 'ACT09', true, false, 0, 99000060 + (pid - 98000001) % 4 FROM person WHERE archetype = 'walkin'
  UNION ALL SELECT * FROM (VALUES (99000025, 'ACT08', true, false, 2, NULL::BIGINT), (99000025, 'ACT09', false, false, 1, NULL::BIGINT)) v
)
SELECT DISTINCT ON (pid, activity_id) s.*, a.held_at - to_days(2 + floor(u(pid || s.activity_id, 'sd') * 10)::INT) + to_seconds(floor(u(pid || s.activity_id, 'st') * 86400)::BIGINT) AS signup_utc
FROM s JOIN activity a USING (activity_id);
ALTER TABLE signup ADD COLUMN signup_id VARCHAR;
UPDATE signup SET signup_id = x.id FROM (SELECT pid, activity_id, 'SU' || lpad(row_number() OVER (ORDER BY signup_utc, pid)::VARCHAR, 8, '0') AS id FROM signup) x
WHERE signup.pid = x.pid AND signup.activity_id = x.activity_id;
INSERT INTO rec SELECT 'activity', pid, signup_id, NOT typo AND proxy_pid IS NULL, false FROM signup;

-- 身份字段在源端的原文（格式各源不同，平台规范化后再哈希）
ALTER TABLE rec ADD COLUMN phone_raw VARCHAR;
ALTER TABLE rec ADD COLUMN unionid_raw VARCHAR;
ALTER TABLE rec ADD COLUMN phone_mask VARCHAR;
UPDATE rec SET
  phone_raw = CASE WHEN has_phone THEN CASE src
      WHEN 'station' THEN substr(p.phone, 1, 3) || ' ' || substr(p.phone, 4, 4) || ' ' || substr(p.phone, 8, 4)
      WHEN 'jd' THEN '86-' || p.phone
      ELSE p.phone END
    WHEN src = 'station' THEN '13800000000' END,  -- 奶站：老人没有手机，录入员填了占位号（P04）
  unionid_raw = CASE WHEN has_unionid THEN p.unionid END,
  phone_mask = CASE WHEN src IN ('douyin', 'jd', 'tmall') THEN substr(p.phone, 1, 3) || '****' || substr(p.phone, 8, 4) END
FROM person p WHERE p.pid = rec.pid;
UPDATE rec SET phone_raw = CASE WHEN s.proxy_pid IS NOT NULL THEN (SELECT phone FROM person WHERE pid = s.proxy_pid)
    WHEN s.typo THEN '13' || substr(p.phone, 4) ELSE CASE s.fmt
    WHEN 0 THEN p.phone WHEN 1 THEN '+86' || p.phone
    WHEN 2 THEN substr(p.phone, 1, 3) || ' ' || substr(p.phone, 4, 4) || ' ' || substr(p.phone, 8, 4)
    ELSE substr(p.phone, 1, 3) || '-' || substr(p.phone, 4, 4) || '-' || substr(p.phone, 8, 4) END END
FROM signup s, person p WHERE rec.src = 'activity' AND s.signup_id = rec.customer_id AND p.pid = rec.pid;
-- 城市与更新时间（统一消费者的属性取舍，ADR-0027）：会员中心、扫码平台（微信资料）、奶站（送奶地址）、抖音（收货城市）有城市；
-- 扫码平台 5%、奶站 3% 与会员中心不同。会员中心的映射配了 survivorship 优先级 1，其余按 updated_at 取最新
ALTER TABLE rec ADD COLUMN city VARCHAR;
ALTER TABLE rec ADD COLUMN updated_utc TIMESTAMP;
UPDATE rec SET
  city = CASE WHEN src IN ('member', 'scan', 'station', 'douyin') THEN
      CASE WHEN (src = 'scan' AND u(rec.pid, 'scity') < 0.05) OR (src = 'station' AND u(rec.pid, 'stcity') < 0.03)
        THEN CASE WHEN p.city = '苏州' THEN '无锡' ELSE '苏州' END ELSE p.city END END,
  updated_utc = ago(20 + floor(u(rec.pid || src, 'ud') * 600)::INT) + to_seconds(floor(u(rec.pid || src, 'us') * 86400)::BIGINT)
FROM person p WHERE p.pid = rec.pid;
-- K8：P 99000014 会员中心上海（300 天前），奶站苏州（10 天前），扫码平台杭州（5 天前）：有优先级时取上海，按时间是杭州
UPDATE rec SET city = CASE src WHEN 'member' THEN '上海' WHEN 'station' THEN '苏州' ELSE '杭州' END,
  updated_utc = CASE src WHEN 'member' THEN ago(300) WHEN 'station' THEN ago(10) ELSE ago(5) END
WHERE pid = 99000014;

-- ---------- 线上订单（商城、天猫、京东、抖音） ----------
CREATE OR REPLACE TABLE ord_raw AS
WITH p AS (
  SELECT *,
    CASE archetype
      WHEN 'family' THEN 12 + floor(u(pid, 'n') * 29) WHEN 'regular' THEN 5 + floor(u(pid, 'n') * 8) WHEN 'baby' THEN 6 + floor(u(pid, 'n') * 10)
      WHEN 'new' THEN 1 + floor(u(pid, 'n') * 2) WHEN 'lapsed' THEN 3 + floor(u(pid, 'n') * 6) WHEN 'light' THEN 1 + floor(u(pid, 'n') * 3) ELSE 0 END::INT AS n,
    list_filter([CASE WHEN in_mall THEN 'mall' END, CASE WHEN in_tmall THEN 'tmall' END, CASE WHEN in_jd THEN 'jd' END,
                 CASE WHEN in_douyin THEN 'douyin' END], lambda x: x IS NOT NULL) AS srcs
  FROM person WHERE archetype IN ('family', 'regular', 'baby', 'new', 'lapsed', 'light')
), k AS (
  SELECT p.*, unnest(range(n)) AS k FROM p WHERE n > 0 AND len(srcs) > 0
), d AS (
  SELECT pid, archetype, srcs, pid || '-' || k AS key,
    CASE archetype WHEN 'new' THEN floor(u(pid || '-' || k, 'd') * 60) WHEN 'lapsed' THEN 150 + floor(u(pid || '-' || k, 'd') * 580)
      ELSE floor(u(pid || '-' || k, 'd') * 730) END::INT AS offset_days,
    CASE archetype WHEN 'family' THEN [50, 200] WHEN 'baby' THEN [250, 700] WHEN 'light' THEN [30, 120] ELSE [40, 150] END AS aov
  FROM k
)
SELECT pid, key, srcs[1 + floor(u(key, 'src') * len(srcs))::INT] AS src,
  data_end() - to_days(offset_days + 1) + to_seconds(floor(u(key, 't') * 86400)::BIGINT) AS created_utc,
  round(aov[1] + u(key, 'amt') * (aov[2] - aov[1]), 0)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(key, 'st') < 0.70 THEN 'completed' WHEN u(key, 'st') < 0.75 THEN 'shipped' WHEN u(key, 'st') < 0.80 THEN 'paid'
       WHEN u(key, 'st') < 0.88 THEN 'refunded' WHEN u(key, 'st') < 0.95 THEN 'cancelled' ELSE 'created' END AS status,
  floor(u(key, 'pay') * 1800)::BIGINT AS pay_delay, archetype = 'baby' AS baby
FROM d;
-- 周期购：商城会员约 12% 买了一张鲜奶周期卡（月卡 30 期 / 季卡 90 期 / 年卡 360 期），每张卡是一笔商城订单
CREATE OR REPLACE TABLE subscription AS
WITH s AS (
  SELECT pid, k, pid || '-sub' || k AS key, ['月卡', '季卡', '年卡'][1 + floor(u(pid || k, 'plan') * 3)::INT] AS plan,
    ago(5 + floor(u(pid || k, 'sst') * 500)::INT) + INTERVAL 9 HOUR AS start_utc
  FROM (SELECT pid, unnest(range(CASE WHEN u(pid, 'sub2') < 0.03 THEN 2 ELSE 1 END)) AS k FROM person
        WHERE in_mall AND archetype NOT IN ('probe', 'scanner') AND u(pid, 'sub') < 0.12)
)
SELECT pid, key, plan, start_utc, CASE plan WHEN '月卡' THEN 30 WHEN '季卡' THEN 90 ELSE 360 END AS periods,
  CASE plan WHEN '月卡' THEN 360 WHEN '季卡' THEN 990 ELSE 3600 END::DECIMAL(12, 2) AS amount,
  'HC' || lpad((1 + 7 * floor(u(key, 'ssku') * 8))::INT::VARCHAR, 4, '0') AS product_id,
  CASE WHEN u(key, 'sstat') < 0.08 THEN 'paused' WHEN u(key, 'sstat') < 0.13 THEN 'cancelled' END AS forced
FROM s;
INSERT INTO subscription VALUES
  (99000022, 'sub-a', '季卡', ago(20) + INTERVAL 9 HOUR, 90, 990.00, 'HC0001', NULL),
  (99000022, 'sub-b', '月卡', ago(15) + INTERVAL 9 HOUR, 30, 360.00, 'HC0008', 'paused');
ALTER TABLE subscription ADD COLUMN status VARCHAR;
ALTER TABLE subscription ADD COLUMN delivered INTEGER;
UPDATE subscription SET status = coalesce(forced, CASE WHEN start_utc + to_days(periods) <= data_end() THEN 'finished' ELSE 'active' END),
  delivered = least(periods, datediff('day', start_utc, data_end()) - CASE WHEN forced IS NOT NULL THEN floor(u(key, 'stop') * 3)::INT ELSE 0 END);
UPDATE subscription SET delivered = greatest(delivered, 0);
ALTER TABLE subscription ADD COLUMN sub_id VARCHAR;
UPDATE subscription SET sub_id = x.id FROM (SELECT key, 'SUB' || lpad(row_number() OVER (ORDER BY start_utc, key)::VARCHAR, 8, '0') AS id FROM subscription) x
WHERE subscription.key = x.key;
INSERT INTO ord_raw SELECT pid, key, 'mall', start_utc - INTERVAL 1 HOUR, amount, 'completed', 120, false FROM subscription;
-- 探针的订单（金额、状态、时间都是定值）
INSERT INTO ord_raw SELECT pid, key, src, created_utc, amount, status, 600, false FROM (VALUES
  (99000001, 'p01-mall',  'mall',   ago(20) + INTERVAL 2 HOUR, 200.00, 'completed'),
  (99000001, 'p01-tm',    'tmall',  ago(18) + INTERVAL 3 HOUR, 120.00, 'completed'),
  (99000001, 'p01-jd',    'jd',     ago(16) + INTERVAL 4 HOUR, 100.00, 'completed'),
  (99000001, 'p01-dy',    'douyin', ago(14) + INTERVAL 5 HOUR,  80.00, 'completed'),
  (99000008, 'p07-tm',    'tmall',  ago(30) + INTERVAL 2 HOUR,  60.00, 'completed'),
  (99000009, 'p07b-tm',   'tmall',  ago(31) + INTERVAL 2 HOUR,  70.00, 'completed'),
  (99000010, 'k2a-tm',    'tmall',  ago(40) + INTERVAL 2 HOUR, 300.00, 'refunded'),
  (99000011, 'k2b-jd',    'jd',     ago(40) + INTERVAL 3 HOUR,  90.00, 'completed'),
  (99000016, 'l1-mall',   'mall',   ago(25) + INTERVAL 2 HOUR, 120.00, 'completed'),
  (99000017, 'l2-mall',   'mall',   ago(30) + INTERVAL 2 HOUR,  80.00, 'refunded'),
  (99000024, 'k4-tm',     'tmall',  ago(12) + INTERVAL 2 HOUR, 150.00, 'completed'),
  (99000031, 's1-mall-1', 'mall',   ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000031, 's1-mall-2', 'mall',   ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000031, 's1-mall-3', 'mall',   ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000031, 's1-mall-4', 'mall',   ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000031, 's1-mall-5', 'mall',   ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000031, 's1-mall-6', 'mall',  ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000033, 's1-tm-1',   'tmall',  ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000033, 's1-tm-2',   'tmall',  ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000033, 's1-tm-3',   'tmall',  ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000033, 's1-tm-4',   'tmall',  ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000033, 's1-tm-5',   'tmall',  ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000033, 's1-tm-6',  'tmall',  ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000034, 's1-jd-1',   'jd',     ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000034, 's1-jd-2',   'jd',     ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000034, 's1-jd-3',   'jd',     ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000034, 's1-jd-4',   'jd',     ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000034, 's1-jd-5',   'jd',     ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000034, 's1-jd-6',  'jd',     ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded'),
  (99000035, 's1-dy-1',   'douyin', ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000035, 's1-dy-2',   'douyin', ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000035, 's1-dy-3',   'douyin', ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000035, 's1-dy-4',   'douyin', ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000035, 's1-dy-5',   'douyin', ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000035, 's1-dy-6',  'douyin', ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded')
) v(pid, key, src, created_utc, amount, status);

-- ---------- 奶站月账单（station 的订单） ----------
-- 订奶户每月 1 日北京时间 07:30 出一张账单（UTC 前一天 23:30），金额 = 当月天数 × 每日单价；20% 中途退订
CREATE OR REPLACE TABLE station AS
SELECT 'ST' || lpad((c.ci * 10 + k)::VARCHAR, 3, '0') AS station_id, c.city || ['东', '西'][k] || '奶站' AS name, c.city, c.region_id
FROM city c, (SELECT unnest([1, 2]) AS k) k;
INSERT INTO station VALUES ('ST999', '测试奶站', '上海', 'R1');
CREATE OR REPLACE TABLE ord_station AS
WITH m AS (
  SELECT p.pid, ago(30 + floor(u(p.pid, 'sstart') * 700)::INT) AS start_utc, u(p.pid, 'sday') * 4 + 2 AS daily,
    CASE WHEN u(p.pid, 'squit') < 0.2 THEN ago(floor(u(p.pid, 'sq') * 25)::INT) END AS quit_utc
  FROM person p WHERE p.in_station AND p.archetype <> 'probe'
), b AS (
  SELECT m.pid, m.daily, unnest(generate_series(date_trunc('month', m.start_utc) + INTERVAL 1 MONTH, date_trunc('month', coalesce(m.quit_utc, data_end() - INTERVAL 1 DAY)), INTERVAL 1 MONTH)) AS month_utc
  FROM m
)
SELECT pid, pid || '-bill-' || strftime(month_utc, '%Y%m') AS key, 'station' AS src, month_utc - INTERVAL 30 MINUTE AS created_utc,
  round(daily * datediff('day', month_utc, month_utc + INTERVAL 1 MONTH), 0)::DECIMAL(12, 2) AS amount,
  CASE WHEN u(pid || month_utc, 'bs') < 0.92 THEN 'completed' WHEN u(pid || month_utc, 'bs') < 0.96 THEN 'created'
       WHEN u(pid || month_utc, 'bs') < 0.98 THEN 'refunded' ELSE 'cancelled' END AS status,
  86400::BIGINT AS pay_delay, false AS baby
FROM b WHERE month_utc - INTERVAL 30 MINUTE < data_end();
-- 探针的账单：P01 150、K8 / K5 各一张、E2（北京时间第 5 天前 07:30 = UTC 前一天 23:30）、S1 六种状态
INSERT INTO ord_station SELECT pid, key, 'station', created_utc, amount, status, 3600, false FROM (VALUES
  (99000001, 'p01-st', ago(10) - INTERVAL 30 MINUTE, 150.00, 'completed'),
  (99000004, 'p04-st', ago(40) - INTERVAL 30 MINUTE, 93.00, 'completed'),
  (99000005, 'p04b-st', ago(40) - INTERVAL 30 MINUTE, 93.00, 'completed'),
  (99000014, 'k8-st', ago(10) - INTERVAL 30 MINUTE, 120.00, 'completed'),
  (99000015, 'k5-st', ago(10) - INTERVAL 30 MINUTE, 120.00, 'completed'),
  (99000020, 'e2-st', ago(5) - INTERVAL 30 MINUTE, 88.00, 'completed'),
  (99000032, 's1-st-1', ago(9) + INTERVAL 1 HOUR, 1.00, 'created'),   (99000032, 's1-st-2', ago(9) + INTERVAL 2 HOUR, 2.00, 'paid'),
  (99000032, 's1-st-3', ago(9) + INTERVAL 3 HOUR, 4.00, 'shipped'),   (99000032, 's1-st-4', ago(9) + INTERVAL 4 HOUR, 8.00, 'completed'),
  (99000032, 's1-st-5', ago(9) + INTERVAL 5 HOUR, 16.00, 'cancelled'), (99000032, 's1-st-6', ago(9) + INTERVAL 6 HOUR, 32.00, 'refunded')
) v(pid, key, created_utc, amount, status);
-- 测试奶站 ST999 的 12 张账单（K7：映射的 where 去掉）；它的订奶户就是 S1 station 探针
INSERT INTO ord_station SELECT 99000032, 'test-st-' || range, 'station', ago(2 + range) + INTERVAL 1 HOUR, 1.00, 'completed', 60, false FROM range(12);

-- 订单真值：标准层的 customer_id、渠道、门店（奶站）、UTC 下单与支付时间、源端订单号。
-- mall 与 station 的订单号都从 1 开始（K1：同号不同单，要声明键空间）；天猫 19 位、京东 12 位、抖音 69 开头 19 位
CREATE OR REPLACE TABLE ord AS
WITH x AS (
  SELECT o.pid, o.key, o.src, r.customer_id, o.status, o.amount, o.created_utc, o.pay_delay, o.baby
  -- 商城订单的下单人是会员中心的会员号（商城没有自己的用户表，映射里 customer_source: member_pg）
  FROM (SELECT * FROM ord_raw UNION ALL SELECT * FROM ord_station) o JOIN rec r ON r.src = CASE o.src WHEN 'mall' THEN 'member' ELSE o.src END AND r.pid = o.pid
), y AS (
  SELECT *,
    CASE WHEN status IN ('paid', 'shipped', 'completed', 'refunded') THEN created_utc + to_seconds(pay_delay) END AS paid_utc,
    CASE src WHEN 'mall' THEN 'miniapp' ELSE src END AS channel,
    CASE WHEN key LIKE 'test-st-%' THEN 'ST999' WHEN src = 'station' THEN
      'ST' || lpad(((SELECT ci FROM city c JOIN person p ON p.city = c.city WHERE p.pid = x.pid) * 10 + 1 + floor(u(pid, 'stn2') * 2))::INT::VARCHAR, 3, '0') END AS store_id,
    row_number() OVER (PARTITION BY src ORDER BY created_utc, key) AS rn
  FROM x
)
SELECT pid, key, src, customer_id, status, amount, created_utc, paid_utc, coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR AS touched_utc,
  channel, store_id, key LIKE 'test-st-%' AS test_store, baby,
  CASE src WHEN 'mall' THEN rn::VARCHAR WHEN 'station' THEN rn::VARCHAR WHEN 'tmall' THEN (4000000000000000000 + rn)::VARCHAR
    WHEN 'jd' THEN (300000000000 + rn)::VARCHAR ELSE (6900000000000000000 + rn)::VARCHAR END AS order_id
FROM y;
DROP TABLE ord_raw;
DROP TABLE ord_station;

-- 天猫、京东、抖音的买家只出现在订单导出里：没有订单的记录不存在
DELETE FROM rec WHERE src IN ('tmall', 'jd', 'douyin') AND customer_id NOT IN (SELECT customer_id FROM ord WHERE src = rec.src);

-- ---------- 订单中台（三个电商平台订单的第二份拷贝） ----------
-- 中台 400 天前上线，之后的电商订单都有一份拷贝，物流信息只在中台。两边各有更新时间，合并组按「取最新（updated_at）」整行取较新的一边（K2）：
--   same        状态相同，中台晚 30 分钟（中台胜出，带物流）
--   plat_newer  已完成的单 15%：中台停在已发货，平台 3 天后确认收货（平台胜出，没有物流字段）
--   oms_refund  已退款的单一半：平台导出还是已完成（售后退款不改交易状态），中台 5 天后记退款（中台胜出）
-- ord.status 是真实的当前状态；plat_status / oms_status 是两边各自写的状态
ALTER TABLE ord ADD COLUMN variant VARCHAR;
ALTER TABLE ord ADD COLUMN plat_status VARCHAR;
ALTER TABLE ord ADD COLUMN plat_updated_utc TIMESTAMP;
ALTER TABLE ord ADD COLUMN oms_status VARCHAR;
ALTER TABLE ord ADD COLUMN oms_updated_utc TIMESTAMP;
UPDATE ord SET variant = CASE
    WHEN src NOT IN ('tmall', 'jd', 'douyin') OR created_utc < ago(400) THEN NULL
    WHEN key = 'k2a-tm' THEN 'oms_refund' WHEN key = 'k2b-jd' THEN 'plat_newer' WHEN pid >= 99000000 THEN 'same'
    WHEN status = 'completed' AND created_utc < ago(10) AND u(key, 'omsv') < 0.15 THEN 'plat_newer'
    WHEN status = 'refunded' AND created_utc < ago(10) AND u(key, 'omsv') < 0.5 THEN 'oms_refund'
    ELSE 'same' END;
UPDATE ord SET
  plat_status = CASE WHEN variant = 'oms_refund' THEN 'completed' ELSE status END,
  plat_updated_utc = CASE WHEN variant = 'plat_newer' THEN touched_utc + INTERVAL 3 DAY ELSE touched_utc END,
  oms_status = CASE WHEN variant = 'plat_newer' THEN 'shipped' WHEN variant IS NOT NULL THEN status END,
  oms_updated_utc = CASE WHEN variant = 'oms_refund' THEN touched_utc + INTERVAL 5 DAY WHEN variant IS NOT NULL THEN touched_utc + INTERVAL 30 MINUTE END
WHERE src IN ('tmall', 'jd', 'douyin');
-- 合并组里胜出的一边：标准层这一行的 _source
ALTER TABLE ord ADD COLUMN winner VARCHAR;
UPDATE ord SET winner = CASE WHEN oms_updated_utc > plat_updated_utc THEN 'oms' ELSE src END;
-- 中台的物流公司（只在中台有，中台胜出时进标准层）
ALTER TABLE ord ADD COLUMN logistics VARCHAR;
UPDATE ord SET logistics = CASE WHEN oms_status IN ('shipped', 'completed', 'refunded') THEN ['顺丰', '中通', '京东物流', '圆通'][1 + (hash(order_id) % 4)::INT] END
WHERE variant IS NOT NULL;
-- 抖音买家的更新时间是他最近一笔订单在抖店导出里的更新时间（源视图从订单里拆出买家，按它取最新）
UPDATE rec SET updated_utc = o.t FROM (SELECT customer_id, max(plat_updated_utc) AS t FROM ord WHERE src = 'douyin' GROUP BY 1) o
WHERE rec.src = 'douyin' AND rec.customer_id = o.customer_id;
-- B2B 团购单（企业福利采购）只在中台：没有消费者，映射只取三个电商平台的单（K7）
CREATE OR REPLACE TABLE oms_b2b AS
SELECT 'B2B' || lpad((range + 1)::VARCHAR, 7, '0') AS so_id, '企业客户' || (range % 50 + 1) AS company,
  round(2000 + u(range, 'b2b') * 30000, 0)::DECIMAL(12, 2) AS amount, ago(1 + floor(u(range, 'b2bd') * 390)::INT) + INTERVAL 3 HOUR AS created_utc
FROM range(greatest(${N} // 1000, 10));

-- ---------- 订单明细（商城、天猫、京东、抖音；奶站账单没有明细） ----------
-- 每单 1–3 行（抖音 1 行），金额均分、最后一行补齐差额；母婴画像一半买奶粉。天猫 5% 的明细没填商家编码（K4：品类「未关联」）。
-- 周期购订单 1 行：鲜奶 × 期数
CREATE OR REPLACE TABLE item AS
WITH k AS (
  SELECT src, order_id, key, amount, baby, CASE WHEN src = 'douyin' OR key LIKE '%-sub%' OR key LIKE 'sub-%' THEN 1 ELSE 1 + floor(u(key, 'ni') * 3)::INT END AS n
  FROM ord WHERE src IN ('mall', 'tmall', 'jd', 'douyin')
), l AS (SELECT k.*, unnest(range(n)) AS i FROM k
), v AS (
  SELECT l.src, l.order_id, l.key, l.i, l.n,
    coalesce(s.product_id, 'HC' || lpad((CASE WHEN l.baby AND u(l.key || l.i, 'bb') < 0.5 THEN 5 + 7 * floor(u(l.key || l.i, 'sku') * 8)
      ELSE 1 + floor(u(l.key || l.i, 'sku') * 60) END)::INT::VARCHAR, 4, '0')) AS product_id,
    coalesce(s.periods, CASE WHEN u(l.key || l.i, 'q') < 0.7 THEN 1 ELSE 2 END) AS quantity,
    CAST(CASE WHEN l.i < l.n - 1 THEN round(l.amount / l.n, 2) ELSE l.amount - round(l.amount / l.n, 2) * (l.n - 1) END AS DECIMAL(12, 2)) AS amount
  FROM l LEFT JOIN subscription s ON s.key = l.key
)
-- 京东同一单里不出现两行同一个 SKU（京东导出没有明细号，明细按 订单号 + 京东 SKU 区分）
SELECT DISTINCT ON (src, order_id, CASE WHEN src = 'jd' THEN product_id ELSE i::VARCHAR END)
  src, order_id, key, i, product_id, quantity, amount, CAST(round(amount / quantity, 2) AS DECIMAL(12, 2)) AS unit_price
FROM v ORDER BY src, order_id, CASE WHEN src = 'jd' THEN product_id ELSE i::VARCHAR END, i;
-- 京东去掉重复 SKU 后补齐金额：把被去掉的行的金额并进同一单的第一行
UPDATE item SET amount = item.amount + d.diff, unit_price = CAST(round((item.amount + d.diff) / item.quantity, 2) AS DECIMAL(12, 2))
FROM (SELECT o.order_id, o.amount - sum(i.amount) AS diff, min(i.i) AS first_i FROM ord o JOIN item i ON i.src = o.src AND i.order_id = o.order_id
      WHERE o.src = 'jd' GROUP BY o.order_id, o.amount HAVING o.amount <> sum(i.amount)) d
WHERE item.src = 'jd' AND item.order_id = d.order_id AND item.i = d.first_i;
-- K4 探针：天猫一单两行（100 + 50），第二行没填商家编码
DELETE FROM item WHERE key = 'k4-tm';
INSERT INTO item SELECT 'tmall', order_id, key, v.i, v.product_id, 1, v.amount, v.amount FROM ord, (VALUES (0, 'HC0002', 100.00), (1, NULL, 50.00)) v(i, product_id, amount) WHERE key = 'k4-tm';
UPDATE item SET product_id = NULL WHERE src = 'tmall' AND key <> 'k4-tm' AND u(order_id || '-' || i, 'noiid') < 0.05;
ALTER TABLE item ADD COLUMN item_id VARCHAR;
UPDATE item SET item_id = x.id FROM (
  SELECT src, order_id, i, CASE src WHEN 'mall' THEN row_number() OVER (PARTITION BY src ORDER BY order_id::BIGINT, i)::VARCHAR
    WHEN 'tmall' THEN (5000000000000000000 + row_number() OVER (PARTITION BY src ORDER BY order_id::BIGINT, i))::VARCHAR
    WHEN 'douyin' THEN (7000000000000000000 + row_number() OVER (PARTITION BY src ORDER BY order_id::BIGINT, i))::VARCHAR
    ELSE order_id || '-JD' || (100000 + substr(product_id, 3)::INT) END AS id FROM item) x
WHERE item.src = x.src AND item.order_id = x.order_id AND item.i = x.i;

-- ---------- 一物一码扫码 ----------
-- 每次扫码一行：成功（第一次扫这个码）、重复扫码（别人已经扫过）、无效码（假码）。成功的码进码表，带销售大区（5% 与扫码地不一致：窜货）。
-- 会员中心绑定了的扫码用户（同一人既是会员、扫码记录又有 unionid）成功扫码得积分，其余得小额红包
CREATE OR REPLACE TABLE scan_raw AS
WITH p AS (
  SELECT p.pid, p.archetype, r.customer_id AS openid, c.region_id,
    CASE p.archetype WHEN 'family' THEN 8 + floor(u(p.pid, 'ns') * 23) WHEN 'regular' THEN 4 + floor(u(p.pid, 'ns') * 12) WHEN 'baby' THEN 2 + floor(u(p.pid, 'ns') * 7)
      WHEN 'new' THEN 1 + floor(u(p.pid, 'ns') * 4) WHEN 'lapsed' THEN floor(u(p.pid, 'ns') * 4) WHEN 'scanner' THEN 15 + floor(u(p.pid, 'ns') * 36)
      ELSE floor(u(p.pid, 'ns') * 6) END::INT AS n
  FROM person p JOIN rec r ON r.pid = p.pid AND r.src = 'scan' JOIN city c ON c.city = p.city
  WHERE p.archetype NOT IN ('probe', 'qa')
), k AS (SELECT p.*, unnest(range(n)) AS k FROM p WHERE n > 0)
SELECT pid, openid, region_id AS scan_region, pid || '-s' || k AS sk,
  CASE WHEN archetype = 'lapsed' THEN ago(150 + floor(u(pid || '-s' || k, 'sd') * 500)::INT) ELSE ago(1 + floor(u(pid || '-s' || k, 'sd') * 365)::INT) END
    + to_seconds(floor(u(pid || '-s' || k, 'stt') * 86400)::BIGINT) AS scan_utc,
  CASE WHEN u(pid || '-s' || k, 'inv') < 0.01 THEN '无效码' ELSE '成功' END AS result,
  'HC' || lpad((CASE WHEN archetype = 'baby' AND u(pid || '-s' || k, 'bb') < 0.5 THEN 5 + 7 * floor(u(pid || '-s' || k, 'ssku') * 8)
    ELSE 1 + floor(u(pid || '-s' || k, 'ssku') * 60) END)::INT::VARCHAR, 4, '0') AS product_id,
  false AS test
FROM k;
-- 探针：P01 近 30 天 2 次；L1 3 次 HC0001（每次 10 分）；E1 近 30 天 5 次、从未下单；K10 两人扫同一个码（后扫的是重复扫码）；P03 2 次
INSERT INTO scan_raw SELECT v.pid, r.customer_id, 'R1', v.sk, v.scan_utc, v.result, v.product_id, false
FROM (VALUES
  (99000001, 'p01-s1', ago(12) + INTERVAL 3 HOUR, '成功', 'HC0002'), (99000001, 'p01-s2', ago(6) + INTERVAL 3 HOUR, '成功', 'HC0003'),
  (99000016, 'l1-s1', ago(40) + INTERVAL 3 HOUR, '成功', 'HC0001'), (99000016, 'l1-s2', ago(30) + INTERVAL 3 HOUR, '成功', 'HC0001'),
  (99000016, 'l1-s3', ago(20) + INTERVAL 3 HOUR, '成功', 'HC0001'),
  (99000019, 'e1-s1', ago(25) + INTERVAL 3 HOUR, '成功', 'HC0004'), (99000019, 'e1-s2', ago(20) + INTERVAL 3 HOUR, '成功', 'HC0004'),
  (99000019, 'e1-s3', ago(15) + INTERVAL 3 HOUR, '成功', 'HC0004'), (99000019, 'e1-s4', ago(10) + INTERVAL 3 HOUR, '成功', 'HC0004'),
  (99000019, 'e1-s5', ago(5) + INTERVAL 3 HOUR, '成功', 'HC0004'),
  (99000012, 'k10-s1', ago(8) + INTERVAL 3 HOUR, '成功', 'HC0006'),
  (99000003, 'p03-s1', ago(50) + INTERVAL 3 HOUR, '成功', 'HC0005'), (99000003, 'p03-s2', ago(45) + INTERVAL 3 HOUR, '成功', 'HC0005'),
  (99000014, 'k8-s1', ago(7) + INTERVAL 3 HOUR, '成功', 'HC0007')
) v(pid, sk, scan_utc, result, product_id) JOIN rec r ON r.pid = v.pid AND r.src = 'scan';
-- 测试码：两个 QA 账号各扫 20 个 TEST 批次的码（K7：映射的 where 去掉）
INSERT INTO scan_raw SELECT p.pid, r.customer_id, 'R1', p.pid || '-t' || range, ago(1 + range) + INTERVAL 2 HOUR, '成功', 'HC0001', true
FROM person p JOIN rec r ON r.pid = p.pid AND r.src = 'scan', range(20) WHERE p.archetype = 'qa';
-- 码：每次成功扫码一个新码；无效码是码表里没有的假码
CREATE OR REPLACE TABLE code AS
SELECT sk, CASE WHEN test THEN 'TEST' || upper(substr(md5(sk), 1, 12)) ELSE 'HC' || upper(substr(md5(sk), 1, 14)) END AS code, product_id,
  CASE WHEN test THEN 'TEST' ELSE 'B' || strftime(scan_utc - to_days(10 + floor(u(sk, 'age') * 50)::INT), '%Y%m') END AS batch_no,
  scan_utc - to_days(10 + floor(u(sk, 'age') * 50)::INT) AS produced_utc,
  CASE WHEN NOT test AND u(sk, 'cross') < 0.05 THEN 'R' || (1 + (substr(scan_region, 2)::INT + floor(u(sk, 'cr') * 6)::INT) % 7) ELSE scan_region END AS sales_region
FROM scan_raw WHERE result = '成功';
-- 重复扫码：4% 的成功码几天后被另一个扫码用户再扫一次（按 pid 排序取下一个人）；K10 的第二个人扫 K10 第一个人的码
CREATE OR REPLACE TABLE scan_dup AS
WITH s AS (
  SELECT s.*, c.code FROM scan_raw s JOIN code c USING (sk) WHERE NOT s.test AND s.pid < 99000000 AND u(s.sk, 'dup') < 0.04
), users AS (SELECT r.pid, r.customer_id AS openid, c.region_id, row_number() OVER (ORDER BY r.pid) AS rn, count(*) OVER () AS total
  FROM rec r JOIN person p USING (pid) JOIN city c ON c.city = p.city WHERE r.src = 'scan' AND p.archetype NOT IN ('probe', 'qa'))
SELECT u2.pid, u2.openid, u2.region_id AS scan_region, s.sk || '-dup' AS sk, s.scan_utc + to_days(1 + floor(u(s.sk, 'dd') * 10)::INT) AS scan_utc,
  '重复扫码' AS result, s.product_id, false AS test, s.code
FROM s JOIN users u1 ON u1.pid = s.pid JOIN users u2 ON u2.rn = u1.rn % u1.total + 1
WHERE s.scan_utc + to_days(1 + floor(u(s.sk, 'dd') * 10)::INT) < data_end();
INSERT INTO scan_dup SELECT 99000013, r.customer_id, 'R1', 'k10-s1-dup', ago(3) + INTERVAL 3 HOUR, '重复扫码', 'HC0006', false, c.code
FROM rec r, code c WHERE r.pid = 99000013 AND r.src = 'scan' AND c.sk = 'k10-s1';
CREATE OR REPLACE TABLE scan AS
WITH a AS (
  SELECT s.pid, s.openid, s.scan_region, s.sk, s.scan_utc, s.result, s.product_id, s.test,
    CASE WHEN s.result = '无效码' THEN 'FAKE' || upper(substr(md5(s.sk), 1, 12)) ELSE c.code END AS code
  FROM scan_raw s LEFT JOIN code c USING (sk)
  UNION ALL SELECT pid, openid, scan_region, sk, scan_utc, result, product_id, test, code FROM scan_dup
)
SELECT a.*, row_number() OVER (ORDER BY scan_utc, sk) AS scan_id,
  -- 绑定了会员（会员中心有这个人、扫码记录露出 unionid）的成功扫码得积分，其余成功扫码得红包
  CASE WHEN a.result <> '成功' THEN '无' WHEN b.pid IS NOT NULL THEN '积分' ELSE '红包' END AS reward_type,
  CASE WHEN a.result <> '成功' THEN 0 WHEN b.pid IS NOT NULL THEN p.scan_points ELSE round(0.3 + u(a.sk, 'hb') * 1.7, 2) END::DECIMAL(8, 2) AS reward_value
FROM a JOIN product p USING (product_id)
LEFT JOIN (SELECT r.pid FROM rec r JOIN person pp USING (pid) WHERE r.src = 'scan' AND r.has_unionid AND pp.in_member) b ON b.pid = a.pid;
DROP TABLE scan_raw;
DROP TABLE scan_dup;

-- ---------- 小程序埋点 ----------
-- 会员每人 1–2 台设备；会话中一半已登录（先一个 login，事件带会员号），一半匿名（只有 device_id）；登录会话 30% 先签到（每次 1 积分）。
-- 另有从未登录过的匿名设备（每 20 人一台）
CREATE OR REPLACE TABLE device AS
SELECT pid, k, 'D' || substr(md5(pid || '-' || k), 1, 14) AS device_id
FROM (SELECT pid, unnest(range(CASE WHEN u(pid, 'nd') < 0.8 THEN 1 ELSE 2 END)) AS k FROM person WHERE in_member AND archetype NOT IN ('probe') AND u(pid, 'app') < 0.8);
CREATE OR REPLACE TABLE session AS
WITH p AS (
  SELECT p.pid, r.customer_id,
    CASE p.archetype WHEN 'family' THEN 20 WHEN 'regular' THEN 10 WHEN 'baby' THEN 12 WHEN 'new' THEN 5 WHEN 'lapsed' THEN 2 WHEN 'scanner' THEN 3 ELSE 4 END AS n
  FROM person p JOIN rec r ON r.pid = p.pid AND r.src = 'member' WHERE p.pid IN (SELECT pid FROM device)
)
SELECT p.pid, p.customer_id, p.pid || '-' || p.k AS sk, u(p.pid || '-' || p.k, 'login') < 0.5 AS logged_in,
  d.device_id AS device_id0, d1.device_id AS device_id1,
  data_end() - to_days(1 + floor(u(p.pid || '-' || p.k, 'sd') * 365)::INT) + to_seconds(floor(u(p.pid || '-' || p.k, 'stt') * 86000)::BIGINT) AS start_utc
FROM (SELECT p.*, unnest(range(n)) AS k FROM p) p JOIN device d ON d.pid = p.pid AND d.k = 0
LEFT JOIN device d1 ON d1.pid = p.pid AND d1.k = 1;
CREATE OR REPLACE TABLE event_raw AS
WITH e AS (
  SELECT s.pid, s.customer_id, s.logged_in, s.sk, s.start_utc, CASE WHEN s.device_id1 IS NOT NULL AND u(s.sk, 'dev2') < 0.3 THEN s.device_id1 ELSE s.device_id0 END AS device_id,
    unnest(range(3 + floor(u(s.sk, 'ne') * 5)::INT)) AS i
  FROM session s
)
SELECT pid, CASE WHEN logged_in THEN customer_id END AS customer_id, device_id,
  CASE WHEN logged_in AND i = 0 THEN 'login' WHEN logged_in AND i = 1 AND u(sk, 'sign') < 0.3 THEN 'sign_in'
       WHEN u(sk || i, 'et') < 0.12 THEN 'add_cart' WHEN u(sk || i, 'et') < 0.15 THEN 'share' ELSE 'view_product' END AS event_type,
  start_utc + to_seconds(i * 40) AS occurred_utc,
  '/pages/goods?sku=HC' || lpad((1 + floor(u(sk || i, 'pg') * 60))::INT::VARCHAR, 4, '0') AS page
FROM e
UNION ALL
SELECT NULL, NULL, 'A' || substr(md5('anon' || range), 1, 14), 'view_product',
  data_end() - to_days(1 + floor(u(range, 'ad') * 365)::INT) + to_seconds(floor(u(range, 'at') * 86000)::BIGINT), '/pages/index'
FROM range(greatest(${N} // 20, 10));
-- 探针：P06 设备匿名浏览 12 次后登录；L1 签到 5 次
INSERT INTO event_raw SELECT v.pid, CASE WHEN v.logged_in THEN r.customer_id END, v.device_id, v.event_type, v.occurred_utc, '/pages/goods?sku=HC0001'
FROM (
  SELECT 99000007 AS pid, false AS logged_in, 'DPROBE06' AS device_id, 'view_product' AS event_type, ago(4) + to_seconds(range * 60) AS occurred_utc FROM range(12)
  UNION ALL SELECT 99000007, true, 'DPROBE06', 'login', ago(3)
  UNION ALL SELECT 99000016, true, 'DPROBEL1', 'login', ago(10 - range) + INTERVAL 8 HOUR FROM range(5)
  UNION ALL SELECT 99000016, true, 'DPROBEL1', 'sign_in', ago(10 - range) + INTERVAL 8 HOUR + INTERVAL 1 MINUTE FROM range(5)
) v LEFT JOIN rec r ON r.pid = v.pid AND r.src = 'member';
-- 匿名浏览在真值里记到设备的真实主人
UPDATE event_raw SET pid = 99000007 WHERE device_id = 'DPROBE06';
CREATE OR REPLACE TABLE event AS
SELECT *, 'EV' || lpad(row_number() OVER (ORDER BY occurred_utc, device_id, event_type)::VARCHAR, 12, '0') AS event_id FROM event_raw;
DROP TABLE event_raw;

-- ---------- 会员中心：会员卡、积分商城兑换、积分流水 ----------
CREATE OR REPLACE TABLE membership AS
SELECT r.pid, r.customer_id, 'VIP' || lpad(row_number() OVER (ORDER BY r.pid)::VARCHAR, 9, '0') AS membership_id,
  ago(30 + floor(u(r.pid, 'join') * 1200)::INT) AS joined_utc,
  CASE WHEN u(r.pid, 'mst') < 0.97 THEN 'active' ELSE 'frozen' END AS status
FROM rec r WHERE r.src = 'member';
-- 获得：商城已支付订单 floor(金额)（退款 7 天后 adjust 冲回）、绑定会员的成功扫码（按 SKU 的扫码积分）、签到 1 分、1% 客服补偿 +5；
-- 过期：30% 的获得 365 天后过期 10%
CREATE OR REPLACE TABLE ledger_raw AS
WITH earn AS (
  SELECT m.membership_id, m.customer_id, 'EARN_ORDER' AS reason, floor(o.amount)::BIGINT AS pts, o.paid_utc AS t, o.order_id AS ref, o.key, o.status
  FROM ord o JOIN membership m ON m.pid = o.pid WHERE o.src = 'mall' AND o.paid_utc IS NOT NULL AND o.pid < 99000000 AND floor(o.amount) > 0
  UNION ALL
  SELECT m.membership_id, m.customer_id, 'EARN_SCAN', s.reward_value::BIGINT, s.scan_utc + INTERVAL 1 MINUTE, s.code, s.sk, 'completed'
  FROM scan s JOIN membership m ON m.pid = s.pid WHERE s.reward_type = '积分'
  UNION ALL
  SELECT m.membership_id, m.customer_id, 'SIGN_IN', 1, e.occurred_utc, e.event_id, e.event_id, 'completed'
  FROM event e JOIN membership m ON m.pid = e.pid WHERE e.event_type = 'sign_in'
)
SELECT membership_id, customer_id, reason, pts AS points_change, ref, t AS occurred_utc, t + INTERVAL 365 DAY AS expires_utc, key FROM earn
UNION ALL SELECT membership_id, customer_id, 'ADJUST', -pts, ref, t + INTERVAL 7 DAY, NULL, key || '-rf' FROM earn WHERE status = 'refunded'
UNION ALL SELECT membership_id, customer_id, 'EXPIRE', -floor(pts * 0.1)::BIGINT, NULL, t + INTERVAL 365 DAY, NULL, key || '-ex' FROM earn
  WHERE status <> 'refunded' AND pts >= 10 AND u(key, 'exp') < 0.3 AND customer_id NOT IN (SELECT customer_id FROM rec WHERE pid >= 99000000)
UNION ALL SELECT membership_id, customer_id, 'ADJUST', 5, NULL, t + INTERVAL 3 DAY, NULL, key || '-cp' FROM earn
  WHERE u(key, 'comp') < 0.01 AND customer_id NOT IN (SELECT customer_id FROM rec WHERE pid >= 99000000);
DELETE FROM ledger_raw WHERE occurred_utc >= data_end();
-- 积分商城兑换：净获得 ≥ 300 的会员约 30% 在最近 60 天里兑换一次，花费不超过兑换时净积分的一半；10% 的兑换单被取消（不扣分）
CREATE OR REPLACE TABLE redemption AS
WITH c AS (
  SELECT m.pid, m.membership_id, m.customer_id, ago(10 + floor(u(m.pid, 'rdt') * 50)::INT) + INTERVAL 12 HOUR AS t FROM membership m
  WHERE m.pid < 99000000 AND u(m.pid, 'rd') < 0.3
), b AS (
  SELECT c.*, (SELECT coalesce(sum(points_change), 0) FROM ledger_raw l WHERE l.membership_id = c.membership_id AND l.occurred_utc < c.t) AS net FROM c
)
SELECT pid, membership_id, customer_id, t AS created_utc,
  CASE WHEN net >= 600 THEN 300 WHEN net >= 400 THEN 200 ELSE 100 END AS points_cost,
  CASE WHEN net >= 600 THEN '禾川定制保温杯' WHEN net >= 400 THEN '有机纯奶 1 箱' ELSE '5 元无门槛券' END AS gift,
  CASE WHEN u(pid, 'rdc') < 0.1 THEN '已取消' ELSE '已兑换' END AS status
FROM b WHERE net >= 300;
INSERT INTO redemption SELECT pid, membership_id, customer_id, ago(8) + INTERVAL 12 HOUR, 100, '5 元无门槛券', '已兑换' FROM membership WHERE pid = 99000016;
ALTER TABLE redemption ADD COLUMN redeem_id VARCHAR;
UPDATE redemption SET redeem_id = x.id FROM (SELECT membership_id, created_utc, 'RD' || lpad(row_number() OVER (ORDER BY created_utc, membership_id)::VARCHAR, 9, '0') AS id FROM redemption) x
WHERE redemption.membership_id = x.membership_id AND redemption.created_utc = x.created_utc;
INSERT INTO ledger_raw SELECT membership_id, customer_id, 'REDEEM', -points_cost, redeem_id, created_utc, NULL, redeem_id FROM redemption WHERE status = '已兑换';
-- 探针：L1（商城单 120 + 扫码 3×10 + 签到 5 − 兑换 100 + 补偿 5 = 60，已由上面写入订单、扫码、签到与兑换；这里补上订单获得与补偿），
-- L2（退款冲回，净 0），L3（流水求和 200，会员卡余额写成 999）
INSERT INTO ledger_raw SELECT m.membership_id, m.customer_id, v.reason, v.points_change, v.ref, v.occurred_utc, v.expires_utc, v.k
FROM (VALUES
  (99000016, 'EARN_ORDER', 120, 'l1-mall', ago(25) + INTERVAL 3 HOUR, ago(25) + INTERVAL 365 DAY, 'l1-earn'),
  (99000016, 'ADJUST',       5, NULL,      ago(9), NULL, 'l1-comp'),
  (99000017, 'EARN_ORDER',  80, 'l2-mall', ago(30) + INTERVAL 3 HOUR, ago(30) + INTERVAL 365 DAY, 'l2-earn'),
  (99000017, 'ADJUST',     -80, 'l2-mall', ago(23), NULL, 'l2-rf'),
  (99000018, 'EARN_ORDER', 200, NULL,      ago(40), ago(40) + INTERVAL 365 DAY, 'l3-earn')
) v(pid, reason, points_change, ref, occurred_utc, expires_utc, k)
JOIN membership m ON m.pid = v.pid;
UPDATE ledger_raw SET ref = (SELECT order_id FROM ord WHERE key = ledger_raw.ref) WHERE ref IN ('l1-mall', 'l2-mall');
CREATE OR REPLACE TABLE ledger AS
SELECT membership_id, customer_id, reason, CASE WHEN reason LIKE 'EARN_%' OR reason = 'SIGN_IN' THEN 'earn' ELSE lower(reason) END AS change_type,
  points_change, ref, occurred_utc, expires_utc,
  'PT' || lpad(row_number() OVER (ORDER BY occurred_utc, membership_id, key)::VARCHAR, 11, '0') AS ledger_id,
  sum(points_change) OVER (PARTITION BY membership_id ORDER BY occurred_utc, key ROWS UNBOUNDED PRECEDING) AS balance_after
FROM ledger_raw;
DROP TABLE ledger_raw;
ALTER TABLE membership ADD COLUMN points BIGINT;
UPDATE membership SET points = coalesce((SELECT sum(points_change) FROM ledger l WHERE l.membership_id = membership.membership_id), 0);
UPDATE membership SET points = 999 WHERE pid = 99000018;
ALTER TABLE membership ADD COLUMN level VARCHAR;
UPDATE membership SET level = CASE WHEN points >= 2000 THEN 'gold' WHEN points >= 500 THEN 'silver' ELSE 'normal' END;

-- ---------- 券模板与券 ----------
CREATE OR REPLACE TABLE coupon_template AS
SELECT 'CT' || lpad((range + 1)::VARCHAR, 3, '0') AS coupon_template_id,
  ['cash', 'cash', 'discount', 'gift', 'shipping'][1 + (range % 5)::INT] AS coupon_type,
  CASE range % 5 WHEN 0 THEN 5 WHEN 1 THEN 30 END::DECIMAL(12, 2) AS face_value,
  CASE WHEN range % 5 = 2 THEN 90 END::DECIMAL(12, 2) AS pay_percent,
  CASE range % 5 WHEN 0 THEN 0 WHEN 1 THEN 300 END::DECIMAL(12, 2) AS min_spend,
  'CAMP' || lpad((range % 6 + 1)::VARCHAR, 2, '0') AS campaign_id
FROM range(20);
ALTER TABLE coupon_template ADD COLUMN name VARCHAR;
UPDATE coupon_template SET name = CASE coupon_type WHEN 'cash' THEN CASE WHEN min_spend = 0 THEN '新人无门槛 5 元' ELSE '奶粉满 300 减 30' END
  WHEN 'discount' THEN '周期购 9 折' WHEN 'gift' THEN '试饮装兑换券' ELSE '免运费券' END || '（' || coupon_template_id || '）';
CREATE OR REPLACE TABLE coupon AS
WITH k AS (
  SELECT pid, customer_id, unnest(range(floor(u(pid, 'nc') * 4)::INT)) AS k FROM membership WHERE pid < 99000000
  UNION ALL SELECT pid, customer_id, unnest(range(3)) FROM membership WHERE pid = 99000021
), c AS (
  SELECT pid, customer_id, k, pid || '-' || k AS ck,
    CASE WHEN pid = 99000021 THEN 'CT001' ELSE 'CT' || lpad((1 + floor(u(pid || '-' || k, 'ct') * 20))::INT::VARCHAR, 3, '0') END AS coupon_template_id,
    CASE WHEN pid = 99000021 THEN ago(20) ELSE ago(1 + floor(u(pid || '-' || k, 'ci') * 400)::INT) END AS issued_utc
  FROM k
)
SELECT c.pid, c.customer_id, c.coupon_template_id, t.campaign_id, c.issued_utc,
  CASE WHEN c.pid = 99000021 THEN ['redeemed', 'expired', 'issued'][c.k + 1]
       WHEN u(c.ck, 'cs') < 0.05 THEN 'voided' WHEN u(c.ck, 'cs') < 0.35 THEN 'redeemed'
       WHEN c.issued_utc + INTERVAL 30 DAY < data_end() THEN 'expired' ELSE 'issued' END AS status,
  CASE WHEN c.pid = 99000021 AND c.k = 1 THEN ago(5) WHEN c.pid = 99000021 THEN ago(-10) ELSE c.issued_utc + INTERVAL 30 DAY END AS expires_utc,
  coalesce(t.face_value, 5)::DECIMAL(12, 2) AS face,
  'CP' || lpad(row_number() OVER (ORDER BY c.issued_utc, c.ck)::VARCHAR, 10, '0') AS coupon_id, c.ck
FROM c JOIN coupon_template t USING (coupon_template_id);
ALTER TABLE coupon ADD COLUMN redeemed_utc TIMESTAMP;
UPDATE coupon SET redeemed_utc = least(issued_utc + to_days(1 + floor(u(ck, 'rd') * 20)::INT), data_end() - INTERVAL 1 HOUR) WHERE status = 'redeemed';

-- ---------- 营销同意与偏好 ----------
-- 会员中心按渠道（短信、微信订阅消息）记同意；奶站会员表另有一个短信通知开关（K5：99000015 会员中心同意、奶站后来撤回）
CREATE OR REPLACE TABLE consent AS
WITH c AS (SELECT pid, customer_id, unnest(['sms', 'wechat']) AS channel FROM membership)
SELECT 'member' AS src, pid, customer_id, channel,
  CASE WHEN pid IN (99000001, 99000015) THEN 'granted' WHEN u(pid || channel, 'cg') < 0.8 THEN 'granted' ELSE 'revoked' END AS status,
  CASE WHEN pid IN (99000001, 99000015) THEN ago(200) ELSE ago(100 + floor(u(pid || channel, 'cgt') * 900)::INT) END AS granted_utc
FROM c WHERE pid IN (99000001, 99000015) OR u(pid || channel, 'cp') < 0.6
UNION ALL
SELECT 'station', r.pid, r.customer_id, 'sms', CASE WHEN r.pid = 99000015 OR u(r.pid, 'pso') >= 0.6 THEN 'revoked' ELSE 'granted' END,
  ago(400 + floor(u(r.pid, 'psg') * 300)::INT)
FROM rec r WHERE r.src = 'station';
ALTER TABLE consent ADD COLUMN revoked_utc TIMESTAMP;
UPDATE consent SET revoked_utc = CASE WHEN pid = 99000015 AND src = 'station' THEN ago(30) ELSE granted_utc + to_days(1 + floor(u(pid || channel || src, 'rv') * 90)::INT) END
WHERE status = 'revoked';
-- 奶站会员表的短信开关与资料在同一行：这一行的修改时间不早于开关的修改时间
UPDATE rec SET updated_utc = greatest(rec.updated_utc, coalesce(c.revoked_utc, c.granted_utc)) FROM consent c
WHERE rec.src = 'station' AND c.src = 'station' AND c.customer_id = rec.customer_id;
-- 偏好：母婴画像记宝宝阶段，其余 30% 记口味
CREATE OR REPLACE TABLE preference AS
SELECT m.pid, m.customer_id, CASE WHEN p.archetype = 'baby' THEN 'life_stage' ELSE 'taste' END AS preference_type,
  CASE WHEN p.archetype = 'baby' THEN ['孕期', '0-1 岁', '1-3 岁', '3-6 岁'][1 + floor(u(m.pid, 'ls') * 4)::INT]
    ELSE ['低糖', '全脂', '零乳糖', '高蛋白'][1 + floor(u(m.pid, 'ts') * 4)::INT] END AS preference_value,
  ago(floor(u(m.pid, 'pu') * 300)::INT) AS updated_utc
FROM membership m JOIN person p USING (pid) WHERE p.archetype = 'baby' OR u(m.pid, 'tp') < 0.3;

-- ---------- 企业微信社群 ----------
-- 社群运营（G01–G50）添加的外部联系人；每人进 1–2 个福利群，10% 之后退群；群发 → 营销触达
CREATE OR REPLACE TABLE wecom_contact AS
SELECT r.pid, r.customer_id AS external_userid, 'G' || lpad((1 + floor(u(r.pid, 'owner') * 50))::INT::VARCHAR, 2, '0') AS owner_id,
  ago(10 + floor(u(r.pid, 'wadd') * 600)::INT) AS added_utc,
  CASE WHEN r.pid < 99000000 AND u(r.pid, 'wdel') < 0.05 THEN ago(1 + floor(u(r.pid, 'wdd') * 9)::INT) END AS deleted_utc
FROM rec r WHERE r.src = 'wecom';
CREATE OR REPLACE TABLE wecom_group AS
SELECT 'GRP' || lpad((range + 1)::VARCHAR, 2, '0') AS group_id, c.city || '鲜奶福利群 ' || (range // 14 + 1) AS name, c.region_id
FROM range(42) JOIN city c ON c.ci = range % 14 + 1;
CREATE OR REPLACE TABLE wecom_member AS
WITH k AS (SELECT c.*, unnest(range(1 + floor(u(c.pid, 'ng') * 2)::INT)) AS k FROM wecom_contact c WHERE c.pid <> 99000023)
SELECT DISTINCT ON (group_id, external_userid) pid, external_userid, 'GRP' || lpad((1 + floor(u(pid || '-' || k, 'grp') * 42))::INT::VARCHAR, 2, '0') AS group_id,
  added_utc + to_days(1 + floor(u(pid || '-' || k, 'gj') * 5)::INT) AS joined_utc,
  CASE WHEN u(pid || '-' || k, 'gq') < 0.1 THEN added_utc + to_days(6 + floor(u(pid || '-' || k, 'gqd') * 3)::INT) END AS quit_utc
FROM k;
-- W1：进两个群、退一个
INSERT INTO wecom_member SELECT pid, external_userid, v.g, v.j, v.q FROM wecom_contact, (VALUES ('GRP01', ago(30), NULL::TIMESTAMP), ('GRP15', ago(25), ago(5))) v(g, j, q)
WHERE pid = 99000023;
DELETE FROM wecom_member WHERE joined_utc >= data_end();
UPDATE wecom_member SET quit_utc = NULL WHERE quit_utc >= data_end();
CREATE OR REPLACE TABLE wecom_send AS
SELECT c.pid, c.external_userid, 'CAMP' || lpad((k + 1)::VARCHAR, 2, '0') AS campaign_id, ago(300 - k * 50) AS sent_utc,
  CASE WHEN u(c.external_userid || k, 'ss') < 0.05 THEN 'failed' WHEN u(c.external_userid || k, 'ss') < 0.55 THEN 'delivered'
       WHEN u(c.external_userid || k, 'ss') < 0.85 THEN 'opened' ELSE 'clicked' END AS status,
  'MS' || lpad(row_number() OVER (ORDER BY k, c.external_userid)::VARCHAR, 11, '0') AS send_id
FROM (SELECT *, unnest(range(6)) AS k FROM wecom_contact) c
WHERE u(c.external_userid || k, 'sendto') < 0.5 AND c.added_utc < ago(300 - k * 50);

-- ---------- 商超门店周销量（经销商回传，没有消费者） ----------
CREATE OR REPLACE TABLE ka_store AS
SELECT 'KA' || lpad((row_number() OVER (ORDER BY c.ci, s.k, n.n))::VARCHAR, 4, '0') AS store_code, s.chain || c.city || '店' || n.n AS name, s.chain, c.city, c.region_id
FROM city c, (SELECT unnest(['大润发', '永辉', '华润万家']) AS chain, unnest([1, 2, 3]) AS k) s, (SELECT unnest([1, 2, 3]) AS n) n;
-- 最近 26 周，每店每周 20 个不同的 ERP SKU（按门店与周轮换），销售额按标价 92 折
CREATE OR REPLACE TABLE sellout AS
WITH w AS (SELECT unnest(generate_series(date_trunc('week', data_end()) - INTERVAL 26 WEEK, date_trunc('week', data_end()) - INTERVAL 1 WEEK, INTERVAL 1 WEEK)) AS week_start)
SELECT s.store_code, w.week_start::DATE AS week_start, strftime(w.week_start, '%G-W%V') AS week, p.product_id,
  (5 + floor(u(s.store_code || w.week_start || p.product_id, 'q') * 196))::INT AS qty,
  round((5 + floor(u(s.store_code || w.week_start || p.product_id, 'q') * 196)) * p.price * 0.92, 2)::DECIMAL(14, 2) AS amount
FROM ka_store s CROSS JOIN w CROSS JOIN (SELECT unnest(range(20)) AS j) j CROSS JOIN product p
WHERE p.i = 1 + ((hash(s.store_code) % 60)::BIGINT + j.j * 3 + epoch(w.week_start)::BIGINT // 604800) % 60;

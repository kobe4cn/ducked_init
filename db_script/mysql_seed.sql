-- db_script/mysql_seed.sql —— 开发用的 MySQL 数据源：一个小电商库 crm_source（确定性造数，可重复执行，会先删库重建）
-- 与只读账号 crm_reader / reader-secret（在平台登记数据源时用它；写类权限会被拒绝）。
-- 测试用的 crm_source_test 由测试自己重建，不要放在这里。
--   container exec -i mysql mysql -uroot -pcrm --default-character-set=utf8mb4 < db_script/mysql_seed.sql
-- 刻意保留了映射要处理的源端特点：
--   - customers：自增主键 + updated_at（水位线），性别是中文、手机号带空格，约 1/5 没有邮箱
--   - products：字符串主键（SKU），价格以分为单位（映射里 / 100）
--   - orders：自增主键 + updated_at，状态是中文（值字典），下单时间是不带时区的北京时间（from_timezone）
--   - order_items：复合主键 (order_id, line_no)
--   - events：没有主键与更新时间（整行比对），发生时间是 Unix 毫秒（from_epoch_millis），含少量完全重复的行
--   - members：会员等级是中文，开卡时间为 DATE
--   - point_logs：自增主键，变动类型是中文（值字典），积分带正负，会员号列叫 member_no，只有获得与消费有关联订单、只有获得有到期时间
--   - consents：复合主键 (customer_id, channel)，渠道是中文、同意状态是 Y / N（值字典），一开始就拒绝的没有同意时间，没撤回过的没有撤回时间
--   - preferences：自增主键与兴趣偏好的主键对不上（草稿按 消费者 + 偏好类型 + 偏好值 去重），同一消费者同一类型下有多个值
DROP DATABASE IF EXISTS crm_source;
CREATE DATABASE crm_source DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE crm_source;
SET SESSION cte_max_recursion_depth = 100000;

CREATE TABLE customers (
  customer_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  gender VARCHAR(8),
  mobile VARCHAR(32),
  email VARCHAR(128),
  city VARCHAR(32),
  registered_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
INSERT INTO customers (name, gender, mobile, email, city, registered_at, updated_at)
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1000)
SELECT CONCAT(ELT(1 + i % 8, '王', '李', '张', '刘', '陈', '杨', '赵', '黄'), ELT(1 + (i DIV 8) % 6, '伟', '芳', '娜', '敏', '静', '磊'), i),
       ELT(1 + i % 3, '男', '女', '未知'),
       CONCAT('138 ', LPAD(i, 4, '0'), ' ', LPAD(i * 7 % 10000, 4, '0')),
       IF(i % 5 = 0, NULL, CONCAT('user', i, '@example.com')),
       ELT(1 + i % 6, '北京', '上海', '广州', '深圳', '杭州', '成都'),
       TIMESTAMP '2023-01-01 09:00:00' + INTERVAL i * 13 HOUR,
       TIMESTAMP '2024-06-01 00:00:00' + INTERVAL i * 37 MINUTE
FROM s;

CREATE TABLE products (
  sku VARCHAR(32) PRIMARY KEY,
  title VARCHAR(128) NOT NULL,
  category VARCHAR(32) NOT NULL,
  price_cents INT NOT NULL,
  on_sale TINYINT(1) NOT NULL,
  updated_at DATETIME NOT NULL
);
INSERT INTO products
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 200)
SELECT CONCAT('SKU-', LPAD(i, 5, '0')),
       CONCAT(ELT(1 + i % 5, '保湿面霜', '运动鞋', '蓝牙耳机', '咖啡豆', '双肩包'), ' ', i, ' 号'),
       ELT(1 + i % 5, '美妆', '鞋服', '数码', '食品', '箱包'),
       990 + (i * 1373) % 49000,
       i % 10 <> 0,
       TIMESTAMP '2024-05-01 00:00:00' + INTERVAL i HOUR
FROM s;

CREATE TABLE orders (
  order_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL,
  pay_amount DECIMAL(12, 2) NOT NULL,
  ordered_at DATETIME NOT NULL COMMENT '北京时间',
  updated_at DATETIME NOT NULL
);
INSERT INTO orders (order_no, customer_id, status, pay_amount, ordered_at, updated_at)
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 5000)
SELECT CONCAT('NO', 20240000000 + i),
       1 + (i * 7919) % 1000,
       ELT(1 + i % 10, '已支付', '已支付', '已发货', '已完成', '已完成', '已完成', '待支付', '已取消', '已退款', '已完成'),
       0,
       TIMESTAMP '2024-01-01 08:00:00' + INTERVAL i * 97 MINUTE,
       TIMESTAMP '2024-01-01 08:00:00' + INTERVAL i * 97 + 60 * (i % 3) MINUTE
FROM s;

CREATE TABLE order_items (
  order_id BIGINT NOT NULL,
  line_no INT NOT NULL,
  sku VARCHAR(32) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
INSERT INTO order_items
WITH RECURSIVE o(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM o WHERE i < 5000),
     l(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM l WHERE n < 3)
SELECT o.i, l.n, p.sku, 1 + (o.i + l.n) % 3, p.price_cents / 100
FROM o JOIN l ON l.n <= 1 + o.i % 3
JOIN products p ON p.sku = CONCAT('SKU-', LPAD(1 + (o.i * 31 + l.n * 17) % 200, 5, '0'));
UPDATE orders o JOIN (SELECT order_id, SUM(quantity * unit_price) AS total FROM order_items GROUP BY order_id) t USING (order_id)
SET o.pay_amount = t.total;

CREATE TABLE events (
  customer_id BIGINT,
  event_type VARCHAR(32) NOT NULL,
  sku VARCHAR(32),
  occurred_ms BIGINT NOT NULL COMMENT 'Unix 毫秒',
  channel VARCHAR(16)
);
INSERT INTO events
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 20000)
SELECT IF(i % 9 = 0, NULL, 1 + (i * 104729) % 1000),
       ELT(1 + i % 6, '浏览', '浏览', '浏览', '加购', '收藏', '搜索'),
       IF(i % 6 = 5, NULL, CONCAT('SKU-', LPAD(1 + i % 200, 5, '0'))),
       1704067200000 + i * 131000,
       ELT(1 + i % 3, 'app', 'mini', 'web')
FROM s;
-- 源端埋点重复上报：完全相同的行
INSERT INTO events SELECT * FROM events WHERE (occurred_ms - 1704067200000) DIV 131000 % 50 = 0;

CREATE TABLE members (
  member_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL UNIQUE,
  level VARCHAR(16) NOT NULL,
  points INT NOT NULL,
  joined_on DATE NOT NULL,
  updated_at DATETIME NOT NULL
);
INSERT INTO members (customer_id, level, points, joined_on, updated_at)
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1000)
SELECT i, ELT(1 + i % 4, '普通', '银卡', '金卡', '钻石'), (i * 37) % 5000, DATE '2023-03-01' + INTERVAL i DAY,
       TIMESTAMP '2024-06-01 00:00:00' + INTERVAL i MINUTE
FROM s WHERE i % 3 <> 0;

CREATE TABLE point_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  member_no BIGINT NOT NULL,
  change_type VARCHAR(8) NOT NULL,
  points INT NOT NULL COMMENT '增加为正，减少为负',
  balance INT NOT NULL,
  order_no VARCHAR(32),
  created_at DATETIME NOT NULL COMMENT '北京时间',
  expire_time DATETIME,
  remark VARCHAR(32)
);
-- 每位会员 20 笔，按「获得、消费、获得、兑换、调整、过期」轮转；余额是按时间累计的变动，不会为负
INSERT INTO point_logs (customer_id, member_no, change_type, points, balance, order_no, created_at, expire_time, remark)
WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i < 5999),
t AS (
  SELECT i, 1 + i % 300 AS c, i DIV 300 AS k, 1 + (i DIV 300) % 6 AS kind,
         CASE (i DIV 300) % 6 WHEN 0 THEN 200 + i % 400 WHEN 1 THEN -(20 + i % 50) WHEN 2 THEN 200 + i * 7 % 400
           WHEN 3 THEN -(50 + i % 100) WHEN 4 THEN IF(i % 2 = 0, 20, -20) ELSE -(10 + i % 30) END AS points
  FROM s
)
SELECT t.c, m.member_id, ELT(t.kind, '获得', '消费', '获得', '兑换', '调整', '过期'), t.points,
       SUM(t.points) OVER (PARTITION BY t.c ORDER BY t.k),
       IF(t.kind IN (1, 2, 3), CONCAT('NO', 20240000000 + 1 + t.i * 13 % 5000), NULL),
       TIMESTAMP '2024-01-01 09:00:00' + INTERVAL t.k * 14 DAY + INTERVAL t.c * 3 MINUTE,
       IF(t.kind IN (1, 3), TIMESTAMP '2025-01-01 09:00:00' + INTERVAL t.k * 14 DAY + INTERVAL t.c * 3 MINUTE, NULL),
       ELT(t.kind, '购物返积分', '下单抵扣', '购物返积分', '兑换礼品', '客服调整', '到期清零')
FROM t JOIN members m ON m.customer_id = t.c
ORDER BY t.k, t.c;

CREATE TABLE consents (
  customer_id BIGINT NOT NULL,
  channel VARCHAR(8) NOT NULL,
  opt_in CHAR(1) NOT NULL COMMENT 'Y 同意，N 撤回或拒绝',
  agree_time DATETIME COMMENT '北京时间',
  revoke_time DATETIME,
  update_time DATETIME NOT NULL,
  PRIMARY KEY (customer_id, channel)
);
-- 每位消费者在三个渠道上有记录；1/5 撤回，其中 2/3 是一开始就拒绝（没有同意时间）
INSERT INTO consents
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1000),
ch(k) AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4),
t AS (
  SELECT i, ELT(k, '短信', '邮件', 'APP推送', '微信') AS name, (i * 7 + k * 3) % 10 AS r,
         TIMESTAMP '2023-01-02 09:00:00' + INTERVAL i * 12 HOUR + INTERVAL k HOUR AS agreed,
         TIMESTAMP '2024-02-01 10:00:00' + INTERVAL i * 5 HOUR + INTERVAL k HOUR AS revoked
  FROM s JOIN ch ON (i + k) % 4 <> 0
)
SELECT i, name, IF(r < 8, 'Y', 'N'), IF(r = 9, NULL, agreed), IF(r < 8, NULL, revoked), IF(r < 8, agreed, revoked)
FROM t;

CREATE TABLE preferences (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  pref_type VARCHAR(16) NOT NULL,
  pref_value VARCHAR(32) NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY (customer_id, pref_type, pref_value)
);
-- 每位消费者两条：同一类型下两个值，类型按「品类、品牌、口味」轮转
INSERT INTO preferences (customer_id, pref_type, pref_value, updated_at)
WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 1000),
n(j) AS (SELECT 0 UNION ALL SELECT 1)
SELECT i, ELT(1 + i % 3, 'category', 'brand', 'flavor'),
       CASE i % 3
         WHEN 0 THEN ELT(1 + (i + j) % 6, '护肤', '彩妆', '香水', '个护', '母婴', '食品')
         WHEN 1 THEN ELT(1 + (i + j) % 4, '自有品牌', '兰蔻', '雅诗兰黛', '资生堂')
         ELSE ELT(1 + (i + j) % 4, '清淡', '甜', '辣', '酸') END,
       TIMESTAMP '2024-03-01 08:00:00' + INTERVAL i HOUR
FROM s, n
ORDER BY i, j;

DROP USER IF EXISTS 'crm_reader'@'%';
CREATE USER 'crm_reader'@'%' IDENTIFIED BY 'reader-secret';
GRANT SELECT ON crm_source.* TO 'crm_reader'@'%';

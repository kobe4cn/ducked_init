-- scripts/crm-seed/round2.sql —— 第二轮变更（plan T6）在真值上的补丁：seed.ts --round 2 先在真值库上执行它与 identity.sql，再把同样的变更就地写进各数据源
-- （新增行、更新行带新的修改时间，删除的从文件里拿掉），让平台按水位线增量、全量比对与软删除各自发现。r2_* 表记下每项变更，seed.ts 照它们改源端。
-- 宏 u()、ago()、data_end() 在 truth.sql 里建好、存在真值库里
-- 1. 新增约 1% 的订单（商城与 POS，数据终点前一天内，已支付），每单 1 行明细
CREATE OR REPLACE TABLE r2_orders AS
WITH p AS (
  SELECT r.pid, r.src, r.customer_id, row_number() OVER (PARTITION BY r.src ORDER BY hash(r.pid || 'r2')) AS rn
  FROM rec r WHERE r.src IN ('mall', 'pos') AND r.pid < 99000000 AND u(r.pid, 'r2pick') < 0.02
), base AS (SELECT src, max(order_id::BIGINT) AS top FROM ord WHERE src IN ('mall', 'pos') GROUP BY src)
SELECT p.pid, 'r2-' || p.src || '-' || p.rn AS key, p.src, p.customer_id, 'paid' AS status,
  round(100 + u(p.pid, 'r2amt') * 400, 0)::DECIMAL(12, 2) AS amount,
  data_end() - INTERVAL 1 DAY + to_seconds(floor(u(p.pid, 'r2t') * 80000)::BIGINT) AS created_utc,
  CASE WHEN p.src = 'pos' THEN 'store' WHEN u(p.pid, 'r2ch') < 0.4 THEN 'web' ELSE 'miniapp' END AS channel,
  CASE WHEN p.src = 'pos' THEN 'S' || lpad((1 + floor(u(p.pid, 'r2s') * 200))::INT::VARCHAR, 3, '0') END AS store_id,
  (b.top + p.rn)::VARCHAR AS order_id
FROM p JOIN base b USING (src)
WHERE p.rn <= greatest((SELECT persons FROM meta) // 200, 5);
INSERT INTO ord SELECT pid, key, src, customer_id, status, amount, created_utc, created_utc + INTERVAL 10 MINUTE, channel, store_id, false, order_id FROM r2_orders;
CREATE OR REPLACE TABLE r2_items AS
SELECT o.src, o.order_id, 'SKU' || lpad((1 + floor(u(o.key, 'r2sku') * 2000))::INT::VARCHAR, 5, '0') AS product_id, 1 AS quantity,
  o.amount, o.amount AS unit_price, (b.top + row_number() OVER (PARTITION BY o.src ORDER BY o.order_id::BIGINT))::VARCHAR AS item_id
FROM r2_orders o JOIN (SELECT src, max(item_id::BIGINT) AS top FROM item GROUP BY src) b USING (src);
INSERT INTO item SELECT src, order_id, product_id, quantity, amount, unit_price, item_id FROM r2_items;

-- 2. P08（99000011）在商城补了手机号，与 POS 那条记录连上（#147：统一消费者 ID 可能变）
CREATE OR REPLACE TABLE r2_phone AS SELECT r.src, r.customer_id, p.phone FROM rec r JOIN person p USING (pid) WHERE r.pid = 99000011 AND r.src = 'mall';
UPDATE rec SET has_phone = true, phone_raw = p.phone FROM person p WHERE p.pid = rec.pid AND rec.pid = 99000011 AND rec.src = 'mall';

-- 3. P01 的商城网页订单（100.00，已发货）退款
CREATE OR REPLACE TABLE r2_refund AS SELECT src, order_id FROM ord WHERE key = 'p01-web';
UPDATE ord SET status = 'refunded' WHERE key = 'p01-web';

-- 4. 天猫导出文件里少了 5 笔订单（源端删除，全量比对应发现）
CREATE OR REPLACE TABLE r2_deleted AS SELECT src, order_id FROM ord WHERE src = 'tmall' AND pid < 99000000 ORDER BY hash(order_id || 'r2del') LIMIT 5;
DELETE FROM ord WHERE src = 'tmall' AND order_id IN (SELECT order_id FROM r2_deleted);

-- 5. POS 作废 3 笔（is_void = 1，软删除；映射的 where 也会挡住）。明细不动
CREATE OR REPLACE TABLE r2_voided AS SELECT src, order_id FROM ord WHERE src = 'pos' AND pid < 99000000 AND NOT test_store ORDER BY hash(order_id || 'r2void') LIMIT 3;
DELETE FROM ord WHERE src = 'pos' AND order_id IN (SELECT order_id FROM r2_voided);

-- 6. 一个商品改品类
CREATE OR REPLACE TABLE r2_product AS SELECT product_id, CASE WHEN category = '配饰' THEN '包' ELSE '配饰' END AS category FROM product WHERE product_id = 'SKU00001';
UPDATE product SET category = r.category FROM r2_product r WHERE r.product_id = product.product_id;

-- 7. P11（99000014）重新报名，这次手机号填对了：与他的商城记录连上
CREATE OR REPLACE TABLE r2_signup AS
SELECT 99000014::BIGINT AS pid, 'ACT10' AS activity_id, false AS attended, false AS typo, 0 AS fmt, data_end() - INTERVAL 1 DAY + INTERVAL 9 HOUR AS signup_utc,
  'SU' || lpad(((SELECT max(substr(signup_id, 3)::BIGINT) FROM signup) + 1)::VARCHAR, 8, '0') AS signup_id;
INSERT INTO signup SELECT * FROM r2_signup;
INSERT INTO rec (src, pid, customer_id, has_phone, has_email, has_unionid, phone_raw, city)
SELECT 'activity', s.pid, s.signup_id, true, false, false, p.phone, p.city FROM r2_signup s JOIN person p USING (pid);

UPDATE meta SET round = 2;

-- scripts/fmcg-seed/round2.sql —— 第二轮变更（plan T7）在真值上的补丁：seed.ts --round 2 先在真值库上执行它与 identity.sql，再把同样的变更就地写进各数据源
-- （新增行、更新行带新的修改时间，删除的从文件里拿掉），让平台按水位线增量、全量比对与合并组的存活规则各自发现。r2_* 表记下每项变更，seed.ts 照它们改源端。
-- 宏 u()、ago()、data_end() 在 truth.sql 里建好、存在真值库里；${NOW} 换成执行时刻（UTC），所有「刚改过」的修改时间都是它
-- 1. 小程序商城：约 1% 的会员新下一单（数据终点前一天，已支付，1 行明细），会员中心随之记一笔订单积分。
--    第二轮的积分流水都记在执行时刻（晚于已有的每一笔），balance_after 接着已有余额，积分流水断档的断言才不会误报
CREATE OR REPLACE TABLE r2_orders AS
WITH p AS (
  SELECT r.pid, r.customer_id, row_number() OVER (ORDER BY hash(r.pid || 'r2')) AS rn
  FROM rec r JOIN person p USING (pid) WHERE r.src = 'member' AND p.in_mall AND r.pid < 99000000 AND u(r.pid, 'r2pick') < 0.03
)
SELECT p.pid, 'r2-mall-' || p.rn AS key, p.customer_id, round(40 + u(p.pid, 'r2amt') * 160, 0)::DECIMAL(12, 2) AS amount,
  data_end() - INTERVAL 1 DAY + to_seconds(floor(u(p.pid, 'r2t') * 80000)::BIGINT) AS created_utc,
  ((SELECT max(order_id::BIGINT) FROM ord WHERE src = 'mall') + p.rn)::VARCHAR AS order_id,
  'HC' || lpad((1 + floor(u(p.pid, 'r2sku') * 60))::INT::VARCHAR, 4, '0') AS product_id
FROM p WHERE p.rn <= greatest((SELECT persons FROM meta) // 100, 5);
INSERT INTO ord (pid, key, src, customer_id, status, amount, created_utc, paid_utc, touched_utc, channel, store_id, test_store, baby, order_id, winner)
SELECT pid, key, 'mall', customer_id, 'paid', amount, created_utc, created_utc + INTERVAL 10 MINUTE, ${NOW}, 'miniapp', NULL, false, false, order_id, 'mall' FROM r2_orders;
CREATE OR REPLACE TABLE r2_items AS
SELECT o.order_id, o.key, o.product_id, o.amount, ((SELECT max(item_id::BIGINT) FROM item WHERE src = 'mall') + row_number() OVER (ORDER BY o.order_id::BIGINT))::VARCHAR AS item_id
FROM r2_orders o;
INSERT INTO item (src, order_id, key, i, product_id, quantity, amount, unit_price, item_id) SELECT 'mall', order_id, key, 0, product_id, 1, amount, amount, item_id FROM r2_items;
CREATE OR REPLACE TABLE r2_ledger AS
SELECT m.membership_id, m.customer_id, 'EARN_ORDER' AS reason, 'earn' AS change_type, floor(o.amount)::BIGINT AS points_change, o.order_id AS ref,
  ${NOW} AS occurred_utc, ${NOW} + INTERVAL 365 DAY AS expires_utc,
  'PT' || lpad(((SELECT max(substr(ledger_id, 3)::BIGINT) FROM ledger) + row_number() OVER (ORDER BY o.order_id::BIGINT))::VARCHAR, 11, '0') AS ledger_id
FROM r2_orders o JOIN membership m USING (pid);

-- 2. 订单中台：5 笔天猫订单售后退款，中台刚记下（天猫导出不变，仍是已完成）。合并组按 updated_at 取较新的中台：营收里去掉这 5 笔（「覆盖」）
CREATE OR REPLACE TABLE r2_oms_refund AS
SELECT order_id FROM ord WHERE src = 'tmall' AND variant = 'same' AND status = 'completed' AND pid < 99000000 AND created_utc > ago(300)
ORDER BY hash(order_id || 'r2rf') LIMIT 5;
UPDATE ord SET status = 'refunded', oms_status = 'refunded', oms_updated_utc = ${NOW}, winner = 'oms' WHERE src = 'tmall' AND order_id IN (SELECT order_id FROM r2_oms_refund);

-- 3. 天猫导出里少了 3 笔订单（连同明细；源端删除，全量比对发现）。中台里还在：合并组改由中台那一行给出，订单数不变
CREATE OR REPLACE TABLE r2_tmall_deleted AS
SELECT order_id FROM ord WHERE src = 'tmall' AND variant = 'same' AND status = 'completed' AND pid < 99000000
  AND order_id NOT IN (SELECT order_id FROM r2_oms_refund) ORDER BY hash(order_id || 'r2del') LIMIT 3;
UPDATE ord SET plat_status = NULL, plat_updated_utc = NULL WHERE src = 'tmall' AND order_id IN (SELECT order_id FROM r2_tmall_deleted);
DELETE FROM item WHERE src = 'tmall' AND order_id IN (SELECT order_id FROM r2_tmall_deleted);

-- 4. P03（99000003）领红包时绑定了手机号：扫码用户与会员连上（ADR-0029：两组合并，留分配较早的统一消费者 ID）
CREATE OR REPLACE TABLE r2_bind AS SELECT r.customer_id, p.phone FROM rec r JOIN person p USING (pid) WHERE r.pid = 99000003 AND r.src = 'scan';
UPDATE rec SET has_phone = true, phone_raw = p.phone, updated_utc = ${NOW} FROM person p WHERE p.pid = rec.pid AND rec.pid = 99000003 AND rec.src = 'scan';

-- 5. P01 在会员中心把城市改成北京：会员中心的映射优先级最高，统一消费者的城市跟着变
CREATE OR REPLACE TABLE r2_city AS SELECT customer_id, '北京' AS city FROM rec WHERE pid = 99000001 AND src = 'member';
UPDATE rec SET city = '北京', updated_utc = ${NOW} WHERE pid = 99000001 AND src = 'member';

-- 6. ERP 给 HC0053 补了品牌（之前由扫码平台补齐）、新品 HC0061 建档（之前只有扫码平台有，没有品类）
CREATE OR REPLACE TABLE r2_product AS SELECT product_id, '禾川臻选' AS brand FROM product WHERE product_id = 'HC0053';
UPDATE product SET brand = '禾川臻选', erp_brand_missing = false WHERE product_id = 'HC0053';
UPDATE product SET in_erp = true, erp_brand_missing = false WHERE product_id = 'HC0061';

-- 7. 扫码平台：约 2% 的扫码用户今天又扫了一个新码（绑定了会员的得积分，会员中心记一笔扫码积分）；P01 再扫 2 次
CREATE OR REPLACE TABLE r2_scans AS
WITH p AS (
  SELECT r.pid, r.customer_id AS openid, c.region_id AS scan_region, 'r2-s-' || r.pid AS sk FROM rec r JOIN person pp USING (pid) JOIN city c ON c.city = pp.city
  WHERE r.src = 'scan' AND pp.archetype NOT IN ('probe', 'qa') AND u(r.pid, 'r2scan') < 0.02
  UNION ALL SELECT 99000001, customer_id, 'R1', 'r2-p01-s' || k FROM rec, (SELECT unnest([1, 2]) AS k) WHERE pid = 99000001 AND src = 'scan'
)
SELECT p.*, data_end() - INTERVAL 1 DAY + to_seconds(floor(u(p.sk, 'r2st') * 80000)::BIGINT) AS scan_utc, '成功' AS result,
  'HC' || lpad((1 + floor(u(p.sk, 'r2sku') * 60))::INT::VARCHAR, 4, '0') AS product_id, false AS test,
  'HC' || upper(substr(md5(p.sk), 1, 14)) AS code, (SELECT max(scan_id) FROM scan) + row_number() OVER (ORDER BY p.sk) AS scan_id
FROM p;
INSERT INTO code SELECT sk, code, product_id, 'B' || strftime(scan_utc - INTERVAL 20 DAY, '%Y%m'), scan_utc - INTERVAL 20 DAY, scan_region FROM r2_scans;
INSERT INTO scan
SELECT s.pid, s.openid, s.scan_region, s.sk, s.scan_utc, s.result, s.product_id, s.test, s.code, s.scan_id,
  CASE WHEN b.pid IS NOT NULL THEN '积分' ELSE '红包' END, CASE WHEN b.pid IS NOT NULL THEN p.scan_points ELSE round(0.3 + u(s.sk, 'hb') * 1.7, 2) END::DECIMAL(8, 2)
FROM r2_scans s JOIN product p USING (product_id)
LEFT JOIN (SELECT r.pid FROM rec r JOIN person pp USING (pid) WHERE r.src = 'scan' AND r.has_unionid AND pp.in_member) b ON b.pid = s.pid;
INSERT INTO r2_ledger
SELECT m.membership_id, m.customer_id, 'EARN_SCAN', 'earn', s.reward_value::BIGINT, s.code, ${NOW} + INTERVAL 1 SECOND, ${NOW} + INTERVAL 1 SECOND + INTERVAL 365 DAY,
  'PT' || lpad((coalesce((SELECT max(substr(ledger_id, 3)::BIGINT) FROM r2_ledger), (SELECT max(substr(ledger_id, 3)::BIGINT) FROM ledger))
    + row_number() OVER (ORDER BY s.scan_id))::VARCHAR, 11, '0')
FROM scan s JOIN membership m USING (pid) WHERE s.sk IN (SELECT sk FROM r2_scans) AND s.reward_type = '积分';
-- 新流水的 balance_after 接着各会员卡已有的余额（L3 的卡上余额是故意写错的，流水仍按流水求和）
INSERT INTO ledger
SELECT n.membership_id, n.customer_id, n.reason, n.change_type, n.points_change, n.ref, n.occurred_utc, n.expires_utc, n.ledger_id,
  coalesce((SELECT sum(points_change) FROM ledger l WHERE l.membership_id = n.membership_id), 0)
    + sum(n.points_change) OVER (PARTITION BY n.membership_id ORDER BY n.occurred_utc, n.ledger_id ROWS UNBOUNDED PRECEDING)
FROM r2_ledger n;
UPDATE membership SET points = coalesce((SELECT sum(points_change) FROM ledger l WHERE l.membership_id = membership.membership_id), 0)
WHERE membership_id IN (SELECT membership_id FROM r2_ledger) AND pid <> 99000018;

-- 8. P01 在会员中心退订了微信订阅消息
CREATE OR REPLACE TABLE r2_consent AS SELECT customer_id, 'wechat' AS channel FROM consent WHERE pid = 99000001 AND src = 'member' AND channel = 'wechat';
UPDATE consent SET status = 'revoked', revoked_utc = ${NOW} WHERE pid = 99000001 AND src = 'member' AND channel = 'wechat';

-- 9. SUB 探针的季卡暂停配送：在订周期购从 1 张变成 0 张
CREATE OR REPLACE TABLE r2_sub AS SELECT key FROM subscription WHERE key = 'sub-a';
UPDATE subscription SET status = 'paused' WHERE key = 'sub-a';

UPDATE meta SET round = 2;

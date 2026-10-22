-- oms_mongo 的源视图 oms_tmall：订单中台里天猫平台的单。中台一张表混着三个平台和 B2B 团购单，而映射的跨源引用（customer_source）
-- 对整列只能指一个数据源：按平台拆成三个视图，各自指向自己平台的买家（K2）。B2B 团购单没有消费者，三个视图都不取（K7）。
-- 嵌套字段已由平台按下划线展开（buyer.id → buyer_id、pay.total → pay_total）；_id 是文档 ID，映射以它为记录标识（view_key）
SELECT _id AS doc_id, so_id, buyer_id, status, pay_total, pay_paid_at, logistics_company, created, modified, _op, _batch, _commit_ts
FROM orders
WHERE platform = 'TMALL'

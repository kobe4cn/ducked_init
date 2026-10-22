-- oms_mongo 的源视图 oms_douyin：订单中台里抖音平台的单（同 oms_tmall，买家指向 douyin_s3）
SELECT _id AS doc_id, so_id, buyer_id, status, pay_total, pay_paid_at, logistics_company, created, modified, _op, _batch, _commit_ts
FROM orders
WHERE platform = 'DOUYIN'

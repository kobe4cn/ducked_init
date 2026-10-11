-- douyin_s3 的源视图 douyin_buyers：抖店订单里内嵌的买家信息。每一行订单都是这个买家的一个版本，
-- 映射用 view_key: [openid] 并按更新时间去重，取最新的一行。平台列 _op、_batch、_commit_ts 照原始层输出
SELECT "买家openid" AS openid, "买家手机号" AS mobile, "买家手机号（脱敏）" AS mobile_mask, "收货城市" AS city, "更新时间" AS updated_at,
  _op, _batch, _commit_ts
FROM dy_orders

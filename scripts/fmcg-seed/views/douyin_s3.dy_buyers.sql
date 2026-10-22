-- douyin_s3 的源视图 dy_buyers：抖店订单里内嵌的买家信息。每一行订单都是这个买家的一个版本，映射按整行区分记录、按 openid 去重取更新时间最新的一行。
-- openid 只在抖音内有意义，不当外部 ID；约 40% 授权了明文手机号（CSV 读成整数）；「买家手机号（脱敏）」不是身份字段，不取
SELECT "买家openid" AS openid, "买家手机号" AS mobile, "收货城市" AS city, "更新时间" AS updated_at, _op, _batch, _commit_ts
FROM dy_orders

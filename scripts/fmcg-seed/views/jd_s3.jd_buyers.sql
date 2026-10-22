-- jd_s3 的源视图 jd_buyers：京东订单导出里内嵌的买家。每一行订单都是这个买家的一个版本，映射按整行区分记录、按 PIN 去重取更新时间最新的一行。
-- 只有入会的买家有手机号（带 86- 前缀，平台规范化时去掉）；「手机号（脱敏）」不是身份字段，不取
SELECT "用户PIN" AS pin, "入会手机" AS mobile, "更新时间" AS updated_at, _op, _batch, _commit_ts
FROM jd_orders

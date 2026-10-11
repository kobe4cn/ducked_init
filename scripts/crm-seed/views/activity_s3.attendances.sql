-- activity_s3 的源视图 attendances：到场的报名。同一张源表到同一个实体只能有一个映射，「报名」用 signups 映射成事件，
-- 「到场」要从这个视图映射（E3）。平台列照原始层输出
SELECT "报名编号", "活动编号", "活动日期", _op, _batch, _commit_ts
FROM signups
WHERE "是否到场" = '是'

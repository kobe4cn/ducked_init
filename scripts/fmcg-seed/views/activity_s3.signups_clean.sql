-- activity_s3 的源视图 signups_clean：去掉导购代填的手机号（P05）。地推现场没带手机的路人，导购填了自己的手机号：
-- 同一个手机号出现在 3 个以上不同姓名的报名里，就不是本人的号，置空（不参与身份打通）；本人报几场活动都是同一个姓名，不受影响。
-- 平台的身份打通没有「一个值连了太多人」的保护，只能在接入时这样清洗（见 plan 的缺口）
SELECT "报名编号", "姓名",
  CASE WHEN count(DISTINCT "姓名") OVER (PARTITION BY "手机") > 3 THEN NULL ELSE "手机" END AS "手机",
  "城市", "报名时间", _op, _batch, _commit_ts
FROM signups

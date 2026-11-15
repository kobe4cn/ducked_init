-- 验收计划 SK 阶段：奶站账单的 MySQL 表注释与列注释（MODIFY 要带完整列定义，与 seed.ts 的建表保持一致）。
-- 每次造数后重跑：
--   container exec -i mysql mysql -uroot -pcrm --default-character-set=utf8mb4 < scripts/fmcg-seed/knowledge/source-comments-mysql.sql
-- 期望：bills.amount、bills.status 的列注释提成提案（station_mysql.bills → order 已发布后）；表注释不提。
ALTER TABLE fmcg_station.bills COMMENT = '奶站月度账单（北京时间）';
ALTER TABLE fmcg_station.bills MODIFY COLUMN amount DECIMAL(12,2) NOT NULL COMMENT '账单金额，单位元，含税；退订时整单记已退订，金额不改';
ALTER TABLE fmcg_station.bills MODIFY COLUMN status VARCHAR(8) NOT NULL COMMENT '账单状态：未缴费、已缴费、配送中、已完成、已取消、已退订';

-- wecom_duckdb 的源视图 group_quits：退群。同一张源表到同一个实体只能有一个映射，「进群」用 group_members 映射成事件，「退群」从这个视图映射（W1）
SELECT group_id, external_userid, quit_time, _op, _batch, _commit_ts
FROM group_members
WHERE quit_time IS NOT NULL

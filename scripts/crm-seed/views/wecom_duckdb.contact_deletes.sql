-- wecom_duckdb 的源视图 contact_deletes：被删除的好友。「添加好友」用 contacts 映射成事件，「删除好友」从这个视图映射
SELECT external_userid, guide_id, del_time, _op, _batch, _commit_ts
FROM contacts
WHERE del_time IS NOT NULL

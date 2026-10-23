# 人群导出：按标签条件异步导出 consumer_id 文件

外部系统要把「满足这几个标签的人」整批拿走（投放、短信、客服外呼），点查接口（ADR-0033）一次一个人，不够用（#264，父 issue #15）。

**接口。** `POST /api/v1/exports`（Bearer API Key）请求体 `{ conditions: [{ tag, value }], snapshots?: { <标签>: <快照 ID> }, format?: 'parquet' | 'csv' }`：1–5 个条件、标签键同 `DSL_KEY_PATTERN`、不重复，`value` 是 1–200 字符的字符串，`snapshots` 只能给条件里的标签，`format` 默认 `parquet`。合法时 202 `{ id, status: 'queued', snapshots }`，记审计 `export.requested`（system 操作者，明细 `{ keyPrefix, conditions, snapshots, format }`）；不合法时 400 `{ error }`、不入队。`GET /api/v1/exports/:id` 返回 `{ id, status, format, snapshots, rowCount }`，失败时多带 `error`。

**导出 ID 就是任务 ID。** 不另建表：状态、错误、行数都在 `platform.tasks` 里，任务类型 `export.tags`（「人群导出」）也就出现在成员的 `/tasks` 列表里。别的租户的任务、不是 `export.tags` 的任务一律 404。

**按标签分别给快照，入队时定下。** 一张标签快照只装一个标签（template `tag:<键>`，表 `gold."tag__<任务 ID>"`，列 `consumer_id, tag_key, tag_value`），所以 `snapshots` 按标签给。没指定时取这个标签最新一张未过期的（`expired_at IS NULL AND expires_at > now()`，按 `created_at desc, id desc`），不要求定义仍有已发布版本。指定的快照必须是本租户、这个标签、未过期的；别的租户的与不存在的报同样的错，不泄露它存在。工作进程不读平台库（ADR-0002），所以快照表名在入队时查好，放进任务参数 `{ format, conditions: [{ tag, value, table }], snapshots }`。这样「先不指定导一次，再用响应里的 `snapshots` 原样导一次」得到相同的文件，即使中间产出了更新的快照。

**只导出 `consumer_id`，不做同意过滤。** 同意数据只有当前状态、不进快照，按它过滤会让同一组快照导出不同的结果。要按同意过滤的由调用方自己做。

**写文件。** 工作进程只读挂载数据湖，先查 `information_schema.tables` 确认快照表都在（排队期间 `gold.expire` 可能已删掉），不在时失败，错误为「快照已过期，请重新发起导出」，不写文件；再用 `COPY (SELECT t0.consumer_id FROM … JOIN … USING (consumer_id) WHERE … ORDER BY 1) TO '<存储前缀>_exports/<任务 ID>.<parquet|csv>'`，取值一律 `lit`，CSV 带表头。工作进程的 DuckDB 用 `allowed_directories` 锁在存储前缀下（ADR-0008），目标只能在 `dataPath` 下面；本地湖先建 `_exports/`，COPY 失败时删掉残留文件。结果 `{ rows, path, format }`，`path` 相对存储前缀，状态接口不暴露。

**导出文件是短期的明文。** `_exports/` 下的文件不经 DuckLake、不加密，也不在删除请求的擦除范围内（ADR-0020），所以只短期保留：下载链接有效期 15 分钟，文件在任务结束 24 小时后删除（#265）。湖迁移不复制 `_exports/`（同 `_serving/`）。

**下载链接（#265）。** 任务成功且还在保留期内时，每次 `GET /api/v1/exports/:id` 签发一个新链接 `download: { url, expiresAt }`（`export_links` 只存令牌的 SHA-256，新链接不让旧的失效）；过了保留期（按 `finished_at` 判断，不探测文件）状态返回 `expired`、不再签发。`/download?token=` 只认令牌：令牌不存在或属于别的导出 404，令牌到期、过了保留期或文件不在 410，每次下载记审计 `export.downloaded`（不记令牌）。调度器删掉过了保留期的文件（从任务结果里去掉 `path`，下一轮不再处理）；这些导出的链接等到期后才删，所以清理之后的 15 分钟内下载仍是 410 而不是 404。

## 已接受的取舍

- 只支持标签条件的 AND，每个条件一个取值；要 OR 或指标阈值的以后再加。
- 快照在入队时定下，排队期间它过期了任务就失败，要重新发起，不自动换成更新的快照。

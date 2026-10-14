# 服务库：从快照合成的只读 DuckDB 文件，放在租户存储前缀的 `_serving/` 下，指针切换

接口要按 `consumer_id` 点查标签、指标与 RFM（#14）。每次请求都挂载 DuckLake、查结果层的快照表太慢，也让 API 节点要拿 catalog 的连接；ADR-0002 已允许「面向接口的服务库是从结果层派生的只读副本，可随时重建」。2026-10-14 与产品确认了下面这些取舍。

**内容。** 只放租户每个已发布定义（RFM、各指标、各标签）最新、未过期的快照，不放标准层或原始层的任何表。表都按 `consumer_id` 排序写入（点查时 DuckDB 的 zone map 能跳过大部分行组）：

- `tags(consumer_id, tag, tag_value)`：`tag` 是标签的键
- `metrics(consumer_id, metric, dims JSON, value DOUBLE)`：维度列名各指标不同，按快照表的实际列（除 `consumer_id`、`value`）拼成 `dims`，无维度时是 `{}`；`value` 统一成 `DOUBLE`
- `rfm(consumer_id, segment, r, f, m, recency_days, frequency, monetary)`
- `consumer_aliases(retired_id, consumer_id)`：来自 `silver._consumer_id_changes` 里 `merge` 的行（ADR-0029；`split` 的原 ID 不退役），沿着合并链走到现在的 ID；表不在时为空
- `meta(version, built_at)`

快照表里没有明文（ADR-0005），服务库因此也没有。数据不完整的快照（`snapshots.incomplete` 非空）照常放入，对外标 `incomplete: true`。指定旧快照 ID 的请求不进服务库，直接只读查湖（#206）。

**生成。** 任务种类 `serving.build`（#201），参数 `{ version, target, snapshots: [{ id, template, table, ... }] }`：工作进程不连平台库（ADR-0001），读哪些快照只能由调用方查好放进参数。工作进程只读挂载数据湖，在锁定配置之前另挂一个本机库 `serving`（会话临时目录里，`openTenantLake` 的 `servingFile`），`CREATE TABLE … AS SELECT … ORDER BY consumer_id` 写完、`CHECKPOINT` 并 `DETACH` 后用 Node 上传：对象存储用本租户的账号 `putObject`，本地湖复制到旁边再改名。`target` 必须正好是 `<dataPath>_serving/v<version>.duckdb`；表名不合规（`gold.<种类>__<任务 ID>`，种类与模板 `rfm` / `metric:<键>` / `tag:<键>` 一致，同一模板只能有一个）或表不在时任务失败、不上传。结果是 `{ version, path, rows }`，`rows` 是各表行数。

**存放。** 正本在租户存储前缀内的 `<dataPath>_serving/v<版本>.duckdb`（`dataPath` 以 `/` 结尾，即 `tenants/<租户 ID>/_serving/`；租户的对象存储账号只对这个前缀有权限，ADR-0008），本地湖时同样在本地路径。不放在任何节点的本机磁盘：API 节点可以随时增减。对象存储上保留最近 2 版（#202）。`_serving/` 不是 DuckLake 登记的文件，`ducklake_cleanup_old_files` 不会碰它；迁移数据湖时不复制、不计入文件数（指针记的是旧前缀的完整路径，迁移后重建），重置数据湖时一并删掉，都可以重建。

**指针（#202）。** 平台库新表 `serving_stores(tenant_id pk, version int, path, snapshots jsonb, built_at)`，`snapshots` 是 `[{ id, template, definitionVersion, createdAt, incomplete }]`。文件上传完成、任务成功后才更新这一行，切换是原子的：上传到一半的文件没有指针指向它。

**读（#206）。** API 节点每次请求查指针；版本变了时先把新文件下载到容器本地临时目录（只是缓存）再切换，下载完之前用旧版；没有任何版本时返回 503。多节点切换的几秒内不同节点可能答不同版本，但每个请求只看到一个完整版本，响应带版本号。

**加密（#203）。** 用 DuckDB 数据库加密，密钥按租户派生。

**删除请求。** 不在这一批：以后实现删除请求时接上。服务库每次重建都从快照派生，快照里删掉的消费者重建后自然没有。

## 取舍

- **没有放进 DuckLake。** 服务库要整份下载到 API 节点、用普通 DuckDB 打开，DuckLake 表要 catalog 连接才能读。
- **`rfm.monetary` 统一成 `DECIMAL(38, 2)`。** 金额字段是 `DECIMAL(18, 2)`，求和就是这个类型，不丢精度；写明了类型，没有 RFM 快照时空表也是同样的列。
- **`metrics.value` 统一成 `DOUBLE`。** 各指标的值类型不同（计数是整数、金额求和是 DECIMAL、平均是浮点），一张表里只能取一种；点查接口用 JSON 返回，精度足够。
- **`target` 由调用方给但工作进程核对。** 指针表在平台库，版本号由调度器分配；工作进程只认本租户前缀下这一版的位置，参数被篡改也写不到别处（`openTenantLake` 的上传函数同样只认 `_serving/` 之下）。

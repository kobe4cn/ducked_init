# 服务库：从快照合成的只读 DuckDB 文件，放在租户存储前缀的 `_serving/` 下，指针切换

接口要按 `consumer_id` 点查标签、指标与 RFM（#14）。每次请求都挂载 DuckLake、查结果层的快照表太慢，也让 API 节点要拿 catalog 的连接；ADR-0002 已允许「面向接口的服务库是从结果层派生的只读副本，可随时重建」。2026-10-14 与产品确认了下面这些取舍。

**内容。** 只放租户每个已发布定义（RFM、各指标、各标签）最新、未过期的快照，不放标准层或原始层的任何表。表都按 `consumer_id` 排序写入（点查时 DuckDB 的 zone map 能跳过大部分行组）：

- `tags(consumer_id, tag, tag_value)`：`tag` 是标签的键
- `metrics(consumer_id, metric, dims JSON, value DOUBLE)`：维度列名各指标不同，按快照表的实际列（除 `consumer_id`、`value`）拼成 `dims`，无维度时是 `{}`；`value` 统一成 `DOUBLE`
- `rfm(consumer_id, segment, r, f, m, recency_days, frequency, monetary)`
- `consumer_aliases(retired_id, consumer_id)`：来自 `silver._consumer_id_changes` 里 `merge` 的行（ADR-0029；`split` 的原 ID 不退役），沿着合并链走到现在的 ID；表不在时为空
- `meta(version, built_at)`

快照表里没有明文（ADR-0005），服务库因此也没有。数据不完整的快照（`snapshots.incomplete` 非空）照常放入，对外标 `incomplete: true`。指定旧快照 ID 的请求不进服务库，直接只读查湖（#206）。

**生成。** 任务种类 `serving.build`（#201），参数 `{ version, target, snapshots: [{ id, template, table, ... }] }`：工作进程不连平台库（ADR-0001），读哪些快照只能由调用方查好放进参数。工作进程只读挂载数据湖，在锁定配置之前另挂一个本机库 `serving`（会话临时目录里，`openTenantLake` 的 `servingKey`，任务种类上的标志是 `servingFile`），`CREATE TABLE … AS SELECT … ORDER BY consumer_id` 写完、`CHECKPOINT` 并 `DETACH` 后用 Node 上传：对象存储用本租户的账号 `putObject`，本地湖复制到旁边再改名。`target` 必须正好是 `<dataPath>_serving/v<version>.duckdb`；表名不合规（`gold.<种类>__<任务 ID>`，种类与模板 `rfm` / `metric:<键>` / `tag:<键>` 一致，同一模板只能有一个）或表不在时任务失败、不上传。结果是 `{ version, path, rows }`，`rows` 是各表行数。

**存放。** 正本在租户存储前缀内的 `<dataPath>_serving/v<版本>.duckdb`（`dataPath` 以 `/` 结尾，即 `tenants/<租户 ID>/_serving/`；租户的对象存储账号只对这个前缀有权限，ADR-0008），本地湖时同样在本地路径。不放在任何节点的本机磁盘：API 节点可以随时增减。对象存储上保留最近 2 版（#202）。`_serving/` 不是 DuckLake 登记的文件，`ducklake_cleanup_old_files` 不会碰它；迁移数据湖时不复制、不计入文件数（指针记的是旧前缀的完整路径，迁移后重建），重置数据湖时一并删掉，都可以重建。

**指针（#202）。** 平台库新表 `serving_stores(tenant_id pk, version int, path, snapshots jsonb, built_at)`，`snapshots` 是 `[{ id, template, definitionVersion, createdAt, incomplete }]`。文件上传完成、任务成功后才更新这一行，切换是原子的：上传到一半的文件没有指针指向它。

**自动重建（#202，`serving-store.ts`）。** 调度器在 `gold.rfm` / `gold.dsl` 成功登记快照、`gold.expire` 成功标记过期之后调 `enqueueServingBuild`：锁租户行，已有排队中的 `serving.build` 就不另入队，改用现在的快照改写它的参数（`snapshots` 写死在参数里，不改的话入队后登记的快照会漏掉、入队后过期的表会让它失败）；运行中的不算，另入队一个；参数里放每个模板最新、未过期（`expired_at` 为空且 `expires_at` 未到）的快照，指标、标签只取定义仍有已发布版本的，RFM 总是取。断言失败的任务也带 `result`，以有没有 `error` 判断成功，没登记快照就不重建。`serving.build` 成功后 `activateServingStore` 锁租户行（第一版之前指针行还不存在，锁不住），只接受比当前指针大的版本，再删掉 `_serving/` 下比新版旧、又不是上一版的文件（平台账号；正在生成的更新版本不碰）。

**读（#206）。** API 节点每次请求查指针；版本变了时先把新文件下载到容器本地临时目录（只是缓存）再切换，下载完之前用旧版；没有任何版本时返回 503。多节点切换的几秒内不同节点可能答不同版本，但每个请求只看到一个完整版本，响应带版本号。

**加密（#203）。** 用 DuckDB 数据库加密（`ATTACH … (ENCRYPTION_KEY …)`）：不带密钥挂不上，换成别的租户的密钥也读不了。密钥 `tenantServingKey` 和敏感信息盐（ADR-0005）一样由租户数据密钥（ADR-0009）以 HMAC 派生、不另存；调度器领取 `serving.build` 时派生，经 `WorkerInput.servingKey` 交给工作进程，不写进任务参数（平台库明文存储），报错时与盐一样被抹掉。工作进程没拿到密钥时直接报错，不会写出未加密的文件。读服务库（#206）用同一个 `tenantServingKey`。

**删除请求。** 不在这一批：以后实现删除请求时接上。服务库每次重建都从快照派生，快照里删掉的消费者重建后自然没有。

## 取舍

- **没有放进 DuckLake。** 服务库要整份下载到 API 节点、用普通 DuckDB 打开，DuckLake 表要 catalog 连接才能读。
- **`rfm.monetary` 统一成 `DECIMAL(38, 2)`。** 金额字段是 `DECIMAL(18, 2)`，求和就是这个类型，不丢精度；写明了类型，没有 RFM 快照时空表也是同样的列。
- **`metrics.value` 统一成 `DOUBLE`。** 各指标的值类型不同（计数是整数、金额求和是 DECIMAL、平均是浮点），一张表里只能取一种；点查接口用 JSON 返回，精度足够。
- **版本号取指针与本租户所有 `serving.build` 用过的版本号的最大值加一，不只看指针。** 一个在运行、一个刚入队时指针还没动，只看指针会让两个任务写同一个文件，后完成的覆盖先切换的那份；按用过的版本号分配则每个任务一个文件，先完成的新版本之后完成的旧版本不再生效（它的文件下次切换时删掉）。
- **服务库密钥由租户数据密钥派生，不单独存、不进参数。** 和敏感信息盐同一做法：不多一张密钥表，轮换租户数据密钥时随之变化（重建即可）；任务参数在平台库明文存储，放进去就等于没加密。
- **`target` 由调用方给但工作进程核对。** 指针表在平台库，版本号由调度器分配；工作进程只认本租户前缀下这一版的位置，参数被篡改也写不到别处（`openTenantLake` 的上传函数同样只认 `_serving/` 之下）。

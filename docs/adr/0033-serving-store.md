# 服务库：从快照合成的只读 DuckDB 文件，放在租户存储前缀的 `_serving/` 下，指针切换

接口要按 `consumer_id` 点查标签、指标与 RFM（#14）。每次请求都挂载 DuckLake、查结果层的快照表太慢，也让 API 节点要拿 catalog 的连接；ADR-0002 已允许「面向接口的服务库是从结果层派生的只读副本，可随时重建」。2026-10-14 与产品确认了下面这些取舍。

**内容。** 只放租户每个已发布定义（RFM、各指标、各标签）最新、未过期的快照与两张 ID 对照表，不放标准层或原始层的任何表，也不放成员的沙箱表（不论是否分享，ADR-0036）。除 `consumer_sources` 外，表都按 `consumer_id` 排序写入（点查时 DuckDB 的 zone map 能跳过大部分行组）：

- `tags(consumer_id, tag, tag_value)`：`tag` 是标签的键
- `metrics(consumer_id, metric, dims JSON, value DOUBLE)`：维度列名各指标不同，按快照表的实际列（除 `consumer_id`、`value`）拼成 `dims`，无维度时是 `{}`；`value` 统一成 `DOUBLE`
- `rfm(consumer_id, segment, r, f, m, recency_days, frequency, monetary)`
- `consumer_aliases(retired_id, consumer_id)`：退役 ID 只来自 `silver._consumer_id_changes` 里 `merge` 的行（ADR-0029；`split` 的原 ID 不退役，`retire` 退役的没有继承人、没有别名）。在 `silver._consumer_id_members` 有成员记录的，指向现在拥有它过半成员的统一消费者，没有就不给别名（先合后拆，#252）；没有成员记录的沿着合并链走到现在的 ID，途中走到有成员记录的 ID 就停、改用它的结果（#259）；变更表不在时为空
- `consumer_sources(source_id, customer_id, consumer_id)`：数据源 + 源端消费者 ID → 统一消费者 ID，构建时读当前的 `silver._identities`（与 `consumer_aliases` 同一时点），按 `(source_id, customer_id)` 排序写入；`_identities` 不在时为空表、构建不失败（#256）。只存 `source_id`，数据源名查询时到平台库换
- `meta(version, built_at)`

快照表里没有明文（ADR-0005），服务库里的分值与 ID 因此也没有。**已知缺口：** `consumer_sources.customer_id` 照 `_identities` 原样存源端 ID，源端 ID 本身是敏感值时（如直接把手机号映射成 `customer_id`）明文会进服务库（已加密、只有本租户的 Key 可查），与标准层现状相同，这次不处理。数据不完整的快照（`snapshots.incomplete` 非空）照常放入，对外标 `incomplete: true`。指定旧快照 ID 的请求不进服务库，直接只读查湖（#206）。

**生成。** 任务种类 `serving.build`（#201），参数 `{ version, target, snapshots: [{ id, template, table, ... }] }`：工作进程不连平台库（ADR-0001），读哪些快照只能由调用方查好放进参数。工作进程只读挂载数据湖，在锁定配置之前另挂一个本机库 `serving`（会话临时目录里，`openTenantLake` 的 `servingKey`，任务种类上的标志是 `servingFile`），`CREATE TABLE … AS SELECT … ORDER BY consumer_id` 写完、`CHECKPOINT` 并 `DETACH` 后用 Node 上传：对象存储用本租户的账号 `putObject`，本地湖复制到旁边再改名。`target` 必须正好是 `<dataPath>_serving/v<version>.duckdb`；表名不合规（`gold.<种类>__<任务 ID>`，种类与模板 `rfm` / `metric:<键>` / `tag:<键>` 一致，同一模板只能有一个）或表不在时任务失败、不上传。结果是 `{ version, path, rows }`，`rows` 是各表行数（含 `consumer_sources`）。

**存放。** 正本在租户存储前缀内的 `<dataPath>_serving/v<版本>.duckdb`（`dataPath` 以 `/` 结尾，即 `tenants/<租户 ID>/_serving/`；租户的对象存储账号只对这个前缀有权限，ADR-0008），本地湖时同样在本地路径。不放在任何节点的本机磁盘：API 节点可以随时增减。对象存储上保留最近 2 版（#202）。`_serving/` 不是 DuckLake 登记的文件，`ducklake_cleanup_old_files` 不会碰它；迁移数据湖时不复制、不计入文件数（指针记的是旧前缀的完整路径，迁移后重建），重置数据湖时一并删掉，都可以重建。

**指针（#202）。** 平台库新表 `serving_stores(tenant_id pk, version int, path, snapshots jsonb, built_at)`，`snapshots` 是 `[{ id, template, definitionVersion, createdAt, incomplete }]`。文件上传完成、任务成功后才更新这一行，切换是原子的：上传到一半的文件没有指针指向它。

**自动重建（#202，`serving-store.ts`）。** 调度器在 `gold.rfm` / `gold.dsl` 成功登记快照、`gold.expire` 成功标记过期之后调 `enqueueServingBuild`：锁租户行，已有排队中的 `serving.build` 就不另入队，改用现在的快照改写它的参数（`snapshots` 写死在参数里，不改的话入队后登记的快照会漏掉、入队后过期的表会让它失败）；运行中的不算，另入队一个；参数里放每个模板最新、未过期（`expired_at` 为空且 `expires_at` 未到）的快照，指标、标签只取定义仍有已发布版本的，RFM 总是取。断言失败的任务也带 `result`，以有没有 `error` 判断成功，没登记快照就不重建。`serving.build` 成功后 `activateServingStore` 锁租户行（第一版之前指针行还不存在，锁不住），只接受比当前指针大的版本，再删掉 `_serving/` 下比新版旧、又不是上一版的文件（平台账号；正在生成的更新版本不碰）。

**读（#206，`serving-reader.ts`）。** 接口 `GET /api/v1/consumers/:consumerId`（Bearer API Key）。API 节点每次请求查指针；进程内按租户缓存一个只读挂载服务库的 DuckDB 实例（`memory_limit` 64MiB、1 线程，挂上后锁住配置）。版本变了时先把新文件下载到本机临时目录 `crm-serving/<租户>/v<版本>.duckdb`（只是缓存，对象存储用本租户账号，同一版本只下载一次），挂上并核对 `meta.version` 后再替换缓存；下载完之前的请求用旧版，旧实例等进行中的请求结束后关闭、删本地文件；本节点还没有任何缓存时等下载完；指针都没有时返回 503。每个请求从头到尾占用一个实例，多节点切换的几秒内不同节点可能答不同版本，但每个请求只看到一个完整版本，响应带 `serving_version`。点查先查 `consumer_aliases` 把退役 ID 换成现在的 ID，再取 `tags` / `metrics` / `rfm`，三样都没有时 404；响应里的 `snapshots` 取自指针（与挂载的版本一致）。`?snapshot=<快照 ID>` 时不碰服务库：快照须属于本租户、未过期（`expired_at` 为空且 `expires_at` 未到），否则 404，然后照分析页的做法只读挂载数据湖、只查那一张快照表，`serving_version` 为 `null`，ID 照快照表里记的查、不换成现在的 ID。

按源点查（#256）：`GET /api/v1/consumers/by-source/:source/:customerId`，源端 ID 由调用方 URL 编码。`:source` 是数据源登记名，每次请求按「本租户 + 名字」（区分大小写，按原样比较）到平台库换成 `source_id`，改名后旧名立刻 404、新名立刻可用，不用重建；再在 `consumer_sources` 里换成统一消费者 ID，之后与按 ID 点查相同、共用同一个构造函数（`consumer_id` 是现在的 ID，`requested_id` 是调用方传入的源端 ID）。数据源名不存在、该数据源下没有这个源端 ID、查到人但三样都没有各自 404、提示不同；带 `?snapshot=` 时 400（旧快照记的是当时的 ID，与现在的映射对不上，需要时先按源查出 `consumer_id` 再带 snapshot 走原接口）。不另加「合并后触发重建」：新会员要等下一次快照后的重建才查得到，在那之前快照里也没有它的结果。本机 10 万消费者的基准见 `reports/serving-bench.md`（`scripts/bench-serving.ts`）。

**加密（#203）。** 用 DuckDB 数据库加密（`ATTACH … (ENCRYPTION_KEY …)`）：不带密钥挂不上，换成别的租户的密钥也读不了。密钥 `tenantServingKey` 和敏感信息盐（ADR-0005）一样由租户数据密钥（ADR-0009）以 HMAC 派生、不另存；调度器领取 `serving.build` 时派生，经 `WorkerInput.servingKey` 交给工作进程，不写进任务参数（平台库明文存储），报错时与盐一样被抹掉。工作进程没拿到密钥时直接报错，不会写出未加密的文件。读服务库（#206）用同一个 `tenantServingKey`。

**删除请求。** 不在这一批：以后实现删除请求时接上（#24），届时要一并擦掉 `consumer_sources` 里这个人的源端 ID。服务库每次重建都从快照与当前的 `_identities` 派生，快照与 `_identities` 里删掉的消费者重建后自然没有。

## 取舍

- **没有放进 DuckLake。** 服务库要整份下载到 API 节点、用普通 DuckDB 打开，DuckLake 表要 catalog 连接才能读。
- **`rfm.monetary` 统一成 `DECIMAL(38, 2)`。** 金额字段是 `DECIMAL(18, 2)`，求和就是这个类型，不丢精度；写明了类型，没有 RFM 快照时空表也是同样的列。
- **`metrics.value` 统一成 `DOUBLE`。** 各指标的值类型不同（计数是整数、金额求和是 DECIMAL、平均是浮点），一张表里只能取一种；点查接口用 JSON 返回，精度足够。
- **版本号取指针与本租户所有 `serving.build` 用过的版本号的最大值加一，不只看指针。** 一个在运行、一个刚入队时指针还没动，只看指针会让两个任务写同一个文件，后完成的覆盖先切换的那份；按用过的版本号分配则每个任务一个文件，先完成的新版本之后完成的旧版本不再生效（它的文件下次切换时删掉）。
- **服务库密钥由租户数据密钥派生，不单独存、不进参数。** 和敏感信息盐同一做法：不多一张密钥表，轮换租户数据密钥时随之变化（重建即可）；任务参数在平台库明文存储，放进去就等于没加密。
- **服务库下载到本机再挂载，不直接挂对象存储上的文件。** 点查要低延迟，远程读每次都有往返；文件按 `consumer_id` 排序、体积小，整份下载一次即可。本机目录只是缓存，节点重启或新加节点时重新下载。
- **指定快照时不换退役 ID。** 旧快照记的是当时的 ID，换成现在的 ID 反而查不到；要现在的 ID 就不带 `snapshot`。
- **`target` 由调用方给但工作进程核对。** 指针表在平台库，版本号由调度器分配；工作进程只认本租户前缀下这一版的位置，参数被篡改也写不到别处（`openTenantLake` 的上传函数同样只认 `_serving/` 之下）。

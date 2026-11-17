# 向量存储：存储接口 + 系统自带实现，首个外部实现 pgvector

混合检索的向量一路（ADR-0047、0049）把向量缓存在平台库 `platform.catalog_embeddings`。租户可能想把向量放进自己的 PostgreSQL（合规、规模、已有 pgvector 设施），决定把读写收进一个存储接口，先落系统自带实现，外部实现由后续子票接入（#847 实现 pgvector、#848 模型服务页配置、#849 补算与检索切换）。

**存储接口。** `app/.server/catalog/vector-store.ts` 导出 `VectorStore`（一个实例绑定一个租户：`upsert` / `hashes` / `read` / `deleteOtherModels` / `deleteMissing` / `topN` / `clear`），`embeddings.ts` 的读写全部经这个接口，不再直接查表。系统自带实现 `platformStore(tenantId)` 就是现在那张表的 SQL；首个外部实现是租户自带 PostgreSQL 上的 pgvector。`topN` 只在调用方传入的哈希（当前可见类的行）里取相似度前 N，restricted 条目不会被取到、也不会挤占前 N 名；展开成条目由调用方做（一个哈希可对应多条投影行）。外部存储的写没法和平台库事务放在一起，所以各方法独立生效，`ensureEmbeddings` 的补算只能靠任务去重（判断 fresh 只是提示，不构成一致性保证）。

**不把 pgvector 装进平台库。** 设计稿（`docs/semantic-retrieval-design.md:101、131`）把 pgvector 当作「平台 PG 可用」的基础设施；这里不这么做：平台库是所有租户共用的托管元数据库（ADR-0002），装扩展、按租户建向量索引会把向量的规模与运维都压在平台上，也和「向量随租户走」的诉求相反。外部库连接串用租户数据密钥按租户信封加密（context `vector_store`，同 ADR-0009 的模型服务 Key），页面不回显。保存时先测连通并顺带建好扩展与表，失败不保存——设置与实际可用保持一致；外连租户指定主机的 SSRF 取舍沿用 ADR-0009 / 0035（不做端点白名单）。

**只存哈希与向量，不存文本。** 外部库的表与平台表同构：`(tenant_id, model_id, text_hash)` 主键，另存 `dimension`，向量列不带维度——不受 pgvector 2000 维上限约束、换模型不用改表；按 `text_hash = ANY(…)` 精确扫描，不建索引（topN 只在传入哈希里算，规模与现在相同，要加索引另开票）。这样外部库里没有检索文本，泄漏面只有向量。**修订 ADR-0049「不需要新的外发政策」的论证**：发给 embedding 的文本仍只是可见性投影文本，但 `full` 可见类的**向量**现在会存进租户自己的外部库——向量是这些文本的派生表示，会离开平台；restricted 类的向量不外发。

**租户隔离与生命周期。** 外部库每条 SQL 都带 `tenant_id`（ADR-0001、0008 的隔离原则延伸到租户自带的外部库）；但外部库里的行不在平台库的删除级联里——租户退出（整体删除数据）时平台不会去外部库删行，那是租户自己的库。

**切换存储与换模型。** 切到外部库时删掉平台表里本租户的行（平台库不再存这个租户的向量）；切回系统自带时保留外部库里的行（不替租户删它自己库里的数据）；新存储一律从零补算。换模型时在当前生效的存储里删掉旧模型的行、按新模型重算（同 ADR-0049）。

**不可达时降级。** 外部库连不上时向量一路降级关闭，同 embedding 失败（ADR-0049 :16）：只去掉这一路，关键词与别名检索照常。`rankedSearch` 的返回带 `vectorFallback` 原因（`off` / `embed_failed` / `store_unreachable`），`catalog_search` 输出一行 `vector_fallback`；上次连通检查的时间与错误记在 `model_providers`。

## Consequences

- 本票（#846）只是重构：行为不变，外部库还不接，`platformStore` 的 SQL 从 `embeddings.ts` 原样搬来；`ensureEmbeddings` 读哈希改经 store、不在平台事务里，读到的哈希偏旧至多多排一个任务。
- 测试 PG 是 `postgres:17`、没有 pgvector：契约用例对系统自带实现一直跑，对 pgvector 只在设置了 `TEST_PGVECTOR_URL` 的环境跑（`describe.skipIf`）；在那之前 pgvector 的 SQL 只在这种环境里真跑过。换镜像见 #850。
- 外部表结构与索引（如 HNSW）以后有实测规模再开票。

# ADR 索引

先看这张表，只打开与本次改动相关的 ADR，不要通读全部。新增 ADR 时在表里补一行。

| ADR | 决定 | 改到这些地方时要读 |
|---|---|---|
| [0001](0001-tenant-physical-isolation.md) | 租户在存储层物理隔离：独立存储前缀与 DuckLake catalog，每个计算任务独立 DuckDB 进程 | 任何跨租户、任务进程、数据湖挂载 |
| [0002](0002-ducklake-single-landing-zone.md) | 业务数据只落 DuckLake；DuckDB 只做用完即弃的计算；平台 PG 只存元数据 | 决定数据存哪里、新增持久化 |
| [0003](0003-llm-design-time-only.md) | 大语言模型只在设计时产出声明式草稿，经 Schema 校验与确定性编译后发布，运行时不调用 | 映射 / 指标 / 标签草稿、LLM 相关功能 |
| [0004](0004-own-dsl-and-templates-not-dbt.md) | 指标与标签用平台自有 YAML DSL 与分析模板编译成 SQL，不用 dbt | 指标、标签、分析模板、模板定义、`src/` 与 `dbt/` |
| [0005](0005-pii-hashed-from-silver.md) | 敏感信息从标准层起只存加盐哈希，明文仅加密留在原始层 | 标准层字段、身份打通、敏感字段、解密审计 |
| [0006](0006-bronze-as-change-batch-log.md) | 原始层统一存为变更批次（`_op`/`_commit_ts`/`_batch`），标准层只通过 MERGE 消费 | 原始层表格式、任何同步方式、标准层合并 |
| [0007](0007-operator-console-separate-identity.md) | 运营后台用独立的运营者身份（`operators`、`/ops/login`、Magic Link + TOTP），只管租户元数据 | `/ops` 路由、运营者认证、租户开通 / 配额 |
| [0008](0008-tenant-lake-db-role-and-locked-engine.md) | 租户数据湖隔离靠独占的 PG 角色、存储服务上的租户账号与锁定配置的 DuckDB | 工作进程里的 DuckDB 配置、租户开通、湖迁移 |
| [0009](0009-source-credentials-and-read-only-probe.md) | 数据源凭据按租户信封加密（AES-256-GCM + `PLATFORM_MASTER_KEY`），登记时探测只读权限 | 数据源登记、凭据、权限探测、模型服务密钥 |
| [0010](0010-full-compare-against-lake-mirror.md) | 没有水位线的表一律全量比对，上一版作为当前镜像（整行哈希）存在租户数据湖 | 全量比对、`_mirror`、大表同步频率 |
| [0011](0011-mongodb-via-community-extension.md) | MongoDB 经 DuckDB 社区扩展 `mongo` 只读挂载，权限另用官方驱动查询 | MongoDB 数据源 |
| [0012](0012-watermark-sync-change-batches.md) | 水位线增量同步：源与湖挂在同一个 DuckDB，原始层按数据源分 schema，批次日志随批次写入 | 增量同步、水位线、回看窗口、`bronze_<数据源 ID>`、`_batches` |
| [0013](0013-explicit-sync-scope.md) | 成员逐张选定同步范围，只采集与同步范围内的表 | 同步范围、选表、采集 |
| [0014](0014-read-only-lake-verification.md) | 湖中数据核对（`source.verify`）只读挂载、只出报告，修复只走同步 | 核对任务、覆盖情况报告 |
| [0015](0015-mapping-publish-and-silver-merge.md) | 映射是平台解析的 YAML（白名单表达式、值字典与兜底值、去重键），双人发布后按变更批次合并进标准层 | 映射、标准模型、标准层合并、`silver.merge` |
| [0016](0016-low-cardinality-text-top-values.md) | 列统计只为低基数（≤50）、列名与格式都不像敏感信息的文本列保存常见取值与行数，`min`/`max` 仍不写文本 | 列统计、`ColumnProfile.top`、值字典对照、敏感字段识别 |
| [0017](0017-mapping-form-editor-over-yaml.md) | 映射以表单为主要编辑方式（规则生成草稿、常用转换、值对照、自定义表达式兜底），YAML 仍是唯一的数据与存档格式；起草权限不变 | 映射编辑页、映射表单、草稿生成、映射 YAML 的读写 |
| [0018](0018-points-consent-coupon-canonical-entities.md) | 积分流水、营销同意、兴趣偏好、优惠券、券模板升格为标准实体（字段、主键、枚举见正文）；同一大版本内新增实体、字段、枚举取值算兼容，小版本随每次新增加一；用自定义实体承载过这些数据的租户新建映射迁移 | 标准模型、新增标准实体或字段、`MODEL_VERSION`、积分 / 同意 / 偏好 / 优惠券的映射 |
| [0019](0019-custom-entity-registration-and-relations.md) | 标准模型只收平台模板要用的实体，其余登记为自定义实体；实体间用通用关系（终点为主键、跨映射唯一）连接，指标、标签与模板用维度路径在计算时关联，不读原始层 | 自定义实体、实体登记、关系、维度路径、指标 / 标签 / 模板的维度、是否新增标准实体、身份打通与 `silver._identities`、设备归属 `silver._device_owner` |
| [0020](0020-ducklake-whole-lake-encryption.md) | 租户数据湖建 catalog 时开启 DuckLake 整湖加密（一个文件一个密钥，密钥存在租户 catalog，防对象存储泄露）；已有的未加密湖不迁移；删除请求按 DELETE → 重写数据文件 → 过期快照 → 清理旧文件擦除；结果快照过期删表后同样过期 DuckLake 快照并清理旧文件（清空整湖时间旅行） | 数据湖挂载与初始化、直接读湖里的 parquet 文件、核对文件、删除请求、结果快照过期、依赖 DuckLake 时间旅行或旧版本、湖迁移 |
| [0021](0021-template-definitions.md) | 模板参数存成租户的模板定义（每个租户每个模板一份，第一次保存草稿时建立，没有已发布版本时用注册表默认参数），按映射的规则双人发布；起草和丢弃用 `definitions:draft`；定义不含运行参数（`asOf`），发布后以 UTC 当天为 `asOf` 入队一次模板任务，快照记下定义版本；发布只锁定义行；有发布权限的成员可按生效版本重新计算（选填不晚于今天的 `asOf`，同模板有任务排队或运行时拒绝，没有已发布版本时不能重新计算） | 模板定义、模板参数、`template_definitions` / `template_versions`、模板任务入队、快照的 `definition_version`、`publish-rules.ts`、`definitions:draft` 权限、重新计算 |
| [0022](0022-source-views.md) | 源视图是一个数据源下只读原始层的一条 SELECT：只读挂载挡写入，`json_serialize_sql` 解析树限定引用的表（只能是本源 `bronze_<数据源 ID>` 的表或作用域内的 CTE，不能带 catalog，表函数、SHOW 与读配置的函数拒绝），必须输出 `_op`/`_batch`/`_commit_ts`；保存时校验并预览列与样本，样本在 `stage` 里敏感列已哈希的同名视图上执行；按映射的规则双人发布，只能由人在页面上发布 | 源视图、`source_views` / `source_view_versions`、`source-view-engine.ts`、在数据湖上执行成员写的 SQL、映射读源视图（#96） |
| [0023](0023-mappings-over-source-views.md) | 映射可用 `view:` 读已发布的源视图（`view_key` 声明记录标识，不写时按整行区分）；视图的批次号来自不同的表不能比较，所以不增量：视图版本或它引用的各表最新批次变了就由全部批次重建，否则不动；引用的任一张表同步写入变更、或视图发布新版本时入队合并；视图版本存下输出列与引用的表；视图映射不能按源表主键解密 | 映射读源视图、`mappings.source_view_id`、`source_view_versions.columns` / `tables`、合并日志的 `source_keys`、`mappingInput`、同步后合并的判断 |
| [0024](0024-cross-mapping-keys.md) | 主键跨映射默认独占（全部实体，`customer` 不查，主键含 `customer` 引用的实体按数据源内唯一）；编号各自独立时映射声明键空间（主键写成 `<键空间>:<原值>`，引用字段显式写同一键空间，发布时检查一致）；同一批对象的多路接入将来以显式的合并与存活规则处理；只读的冲突体检给出建议；映射可用 `where` 过滤行 | 标准层合并、跨映射的主键冲突、键空间、`key_space` / `_key_space`、映射的 `where`、冲突体检、`uniqueKeys` |

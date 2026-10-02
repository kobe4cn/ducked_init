# ADR 索引

先看这张表，只打开与本次改动相关的 ADR，不要通读全部。新增 ADR 时在表里补一行。

| ADR | 决定 | 改到这些地方时要读 |
|---|---|---|
| [0001](0001-tenant-physical-isolation.md) | 租户在存储层物理隔离：独立存储前缀与 DuckLake catalog，每个计算任务独立 DuckDB 进程 | 任何跨租户、任务进程、数据湖挂载 |
| [0002](0002-ducklake-single-landing-zone.md) | 业务数据只落 DuckLake；DuckDB 只做用完即弃的计算；平台 PG 只存元数据 | 决定数据存哪里、新增持久化 |
| [0003](0003-llm-design-time-only.md) | 大语言模型只在设计时产出声明式草稿，经 Schema 校验与确定性编译后发布，运行时不调用 | 映射 / 指标 / 标签草稿、LLM 相关功能 |
| [0004](0004-own-dsl-and-templates-not-dbt.md) | 指标与标签用平台自有 YAML DSL 与分析模板编译成 SQL，不用 dbt | 指标、标签、分析模板、`src/` 与 `dbt/` |
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

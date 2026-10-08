# 指标与标签：一张通用定义表、按消费者聚合的 YAML DSL、稳定键与按需计算的依赖

ADR-0004 决定指标与标签用平台自有的 YAML DSL 编译成 SQL；ADR-0019 规定了维度路径。#17 要把它们做出来。模板定义（ADR-0021）是「一个租户一个模板一份」，指标、标签是租户自己起名、数量不定的定义，不能塞进 `template_definitions`。

**一张通用定义表。** 指标与标签都存在 `dsl_definitions`（`id, tenant_id, kind metric|tag, key, created_at`，`(tenant_id, kind, key)` 唯一），版本存在 `dsl_versions`（`definition_id, version, status draft|published, yaml, authors, last_editor, published_by_email, published_at, updated_at`，每个定义只能有一份草稿）。YAML 原文是唯一的存档格式，保存时校验、发布时再校验一次。按种类分派的校验与编译放在注册表 `app/.server/pipeline/dsl/index.ts`（`DSL_KINDS[kind]`），页面、发布、预览、任务都与种类无关。起草、丢弃用 `definitions:draft`，删除用 `definitions:write`，发布用 `publish` 且按 `publishBlocker` 双人发布（ADR-0015、0021）。

**键稳定。** `key` 在新建定义时填写（`^[a-z][a-z0-9_]{0,62}$`），存在定义行上，之后不能改；发布新版本只加版本行，键不变。标签快照的每一行带上 `tag_key`，下游（分群、导出）只认键，不认定义 ID 和版本。

**指标 DSL。** 每个统一消费者一行（或每个消费者 × 维度取值一行）：

- `base`：基础实体，必须有引用 `customer.customer_id` 的 `customer_id` 字段（或就是 `customer`）。通过 `silver._identities`（`_source, customer_id`）关联到 `consumer_id`，关联不到的行不计入。
- `measure`：`{ agg: count|count_distinct|sum|avg|min|max, field? }`，只有 `count` 可以不写 `field`；`sum`/`avg` 只能用整数、小数字段。
- `filter`：可选，`[{ field, op, value? }]`，全部用 AND 连接；字段只能是基础实体的字段，`op` 为 `eq|ne|in|not_in|gt|gte|lt|lte|is_null|not_null`，取值按字段类型校验后用 `lit` 写入，不接受表达式。
- `window`：可选，`{ field, days }`，`field` 是基础实体的时间或日期字段，取 `(asOf - days, asOf]`。没写时只取 `field <= asOf` 的限制也不加。
- `dimensions`：可选，最多 3 个，`[{ name, path, as_of? }]`。`path` 写成 `order.store_id -> custom_store.region_id -> custom_region.name`：第一段的实体是 `base`；相邻两段之间，前一段的字段必须有一条关系（内置 `ref` 或已发布登记上的关系）指向后一段实体的单列主键；最多 3 跳；不成环（沿用 `allRelations` 的全部关系判断）；终点不能是敏感字段。编译成链式 `LEFT JOIN`，结果转成 `VARCHAR`，关联不到或为空记为「未关联」，不丢行。`as_of` 是给「按时间点关联」预留的位置，只接受 `current`（默认），其他值报「暂不支持按时间点关联」。
- 能引用的只有标准实体、已发布登记的自定义实体（推断出的、未确认的登记不算）和已发布映射里的 `x_` 字段；不读原始层。度量、过滤、窗口用到的字段都不能是敏感字段（`isSensitiveField`）。

**标签 DSL。** `metric: <指标键>`、`rules: [{ value, when: { gte?, gt?, lte?, lt?, eq? } }]`（按顺序第一条命中）、`default: <取值>`。引用的指标必须已发布且没有维度（每个消费者一行）。标签结果覆盖指标结果里的每个消费者，列为 `consumer_id, tag_key, tag_value`。标签的 SQL 把它引用的指标当前已发布版本的 SQL 内联成 CTE，不读指标快照，所以标签任务与指标任务之间没有先后顺序。

**计算与快照。** 一个任务种类 `gold.dsl`：入队时在服务端用当时的登记与映射编译好 SQL（带上 `asOf`），参数为 `kind, key, definitionId, definitionVersion, asOf, sql, entities`；handler 建 `gold."<kind>__<taskId>"`。快照登记进 `snapshots`，`template` 写 `metric:<key>` 或 `tag:<key>`，`definition_version` 照旧。

**依赖按需计算，不建依赖表。** 一份已发布版本的依赖（引用的指标键、实体、字段、关系）由它的 YAML 解析得出（`dependenciesOf`）。只有已发布版本算依赖，草稿不算。被已发布标签引用的指标不能删；被已发布指标引用的自定义实体不能删（加进 `publishedReferrers`）；映射发布后若某个被已发布指标引用的 `x_` 字段在该实体的已发布映射里不再存在，拒绝发布。关系本来就只能加不能删（`checkAdditive`）。

**新版本只影响最新快照。** 发布一版指标，以当天为 `asOf` 入队这个指标和引用它的每个已发布标签；发布标签只入队它自己。已有的快照不动，仍标着旧的定义版本。手动回刷：对这个定义所有未过期、定义版本早于当前生效版本的快照，按各自的 `asOf` 以当前版本各入队一次（指标连同下游标签），产出新的快照；旧快照保留到正常过期。已过期的快照没有表，不能回刷。

**影响预览。** 定义有草稿且有已发布版本时，在只读挂载的湖上以当天为 `asOf` 分别按已发布版本和草稿计算，按 `consumer_id` 对比，只给计数：指标给取值变化的消费者数；受影响的每个标签（草稿本身是标签时就是它自己）给换了取值的消费者数、新增、移出，以及按「原取值 → 新取值」分组的人数。不出消费者 ID 与明文。

## 已接受的取舍

- 每次标签计算都重算一遍它引用的指标，多算一次换来没有任务顺序。
- 回刷后同一个 `asOf` 会有新旧两份快照，旧的保留到过期，列表上靠定义版本区分。
- 维度取当前值；「按时间点关联」只留了语法位置。
- 过滤只能用基础实体的字段，按维度过滤要等以后再加。

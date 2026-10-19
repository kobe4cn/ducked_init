# 指标与标签：一张通用定义表、按消费者聚合的 YAML DSL、稳定键与按需计算的依赖

ADR-0004 决定指标与标签用平台自有的 YAML DSL 编译成 SQL；ADR-0019 规定了维度路径。#17 要把它们做出来。模板定义（ADR-0021）是「一个租户一个模板一份」，指标、标签是租户自己起名、数量不定的定义，不能塞进 `template_definitions`。

**一张通用定义表。** 指标与标签都存在 `dsl_definitions`（`id, tenant_id, kind metric|tag, key, created_at`，`(tenant_id, kind, key)` 唯一），版本存在 `dsl_versions`（`definition_id, version, status draft|published, yaml, authors, last_editor, published_by_email, published_at, updated_at`，每个定义只能有一份草稿）。YAML 原文是唯一的存档格式，保存时校验、发布时再校验一次。按种类分派的校验与编译放在注册表 `app/.server/pipeline/dsl/index.ts`（`DSL_KINDS[kind]`），页面、发布、预览、任务都与种类无关。起草、丢弃用 `definitions:draft`，删除用 `definitions:write`，发布用 `publish` 且按 `publishBlocker` 双人发布（ADR-0015、0021）。

**键稳定。** `key` 在新建定义时填写（`^[a-z][a-z0-9_]{0,62}$`），存在定义行上，之后不能改；发布新版本只加版本行，键不变。标签快照的每一行带上 `tag_key`，下游（分群、导出）只认键，不认定义 ID 和版本。

**指标 DSL。** 每个统一消费者一行（或每个消费者 × 维度取值一行）：

- `base`：基础实体，必须有引用 `customer.customer_id` 的 `customer_id` 字段（或就是 `customer`）。通过 `silver._identities`（`_source, customer_id`）关联到 `consumer_id`，关联不到的行不计入；基础实体按 `customer_id` 的数据源列 `_customer_source` 对 `_source`（跨源引用，ADR-0030），`customer` 自己按 `_source`。
- `measure`：`{ agg: count|count_distinct|sum|avg|min|max, field? }`，只有 `count` 可以不写 `field`；`sum`/`avg` 只能用整数、小数字段。另有三类写法（#224），结果都是数字，可被标签引用：
  - `ratio`：`{ agg: ratio, numerator: { agg, field?, filter? }, denominator: { agg, field?, filter? } }`，不写 `field`。分子、分母的 `agg` 只能是 `count|count_distinct|sum`（字段规则同上），各自的 `filter` 写法同顶层，并与顶层 `filter`、`window` 叠加（AND）。编译成 `CAST(COALESCE(<分子> FILTER (WHERE …), 0) AS DOUBLE) / NULLIF(<分母> FILTER (WHERE …), 0)`：分母为 0 或为空时取值为空，分子的 `sum` 没有行时按 0 算。
  - `latest` / `earliest`：`{ agg, field, by }`，按 `by`（时间或日期字段）取最新 / 最早一行的 `field`，编译成 `arg_max` / `arg_min`。`field` 只能是整数、小数字段：`serving.metrics.value` 是 DOUBLE，文本取值不在这一版。`by` 相同的多行取哪一行不确定。
  - `days_since`：`{ agg: days_since, field }`，`field` 是时间或日期字段，取值 = `DATE asOf - max(field 的 UTC 日期)`（整数天）。用编译时的 `asOf` 而不是 `current_date`，同一定义同一 `asOf` 编译出同样的 SQL。
  - `by`、分子分母的字段与过滤字段同样不能是敏感字段，并计入定义依赖。
- `filter`：可选，`[{ field, op, value? }]`，全部用 AND 连接；字段只能是基础实体的字段，`op` 为 `eq|ne|in|not_in|gt|gte|lt|lte|is_null|not_null`，取值按字段类型校验后用 `lit` 写入，不接受表达式。
- `window`：可选，`{ field, days }`，`field` 是基础实体的时间或日期字段，取 `(asOf - days, asOf]`。没写时不加时间限制。
- `dimensions`：可选，最多 3 个，`[{ name, path, as_of? }]`。`path` 写成 `order.store_id -> custom_store.region_id -> custom_region.name`：第一段的实体是 `base`；相邻两段之间，前一段的字段必须有一条关系（内置 `ref` 或已发布登记上的关系）指向后一段实体的单列主键；最多 3 跳；不成环（沿用 `allRelations` 的全部关系判断）；终点不能是敏感字段。编译成链式 `LEFT JOIN`，结果转成 `VARCHAR`，关联不到或为空记为「未关联」，不丢行。`as_of` 是给「按时间点关联」预留的位置，只接受 `current`（默认），其他值报「暂不支持按时间点关联」。
- `device_attribution`：可选布尔，只有 `base: event` 能写，缺省为 `true`。为真时匿名事件（`customer_id` 为空）经 `device_id` 查 `silver._device_owner`（ADR-0019）计入设备主人；写 `false` 时只经 `_identities`，编译出的 SQL 与加这个字段之前逐字节一致。
- `description`：可选字符串，最多 500 字，给人看的说明，不参与编译（#205）。
- 能引用的只有标准实体、已发布登记的自定义实体（推断出的、未确认的登记不算）和已发布映射里的 `x_` 字段；不读原始层。度量、过滤、窗口用到的字段都不能是敏感字段（`isSensitiveField`）。

**标签 DSL。** `metric: <指标键>`、`rules: [{ value, when: { gte?, gt?, lte?, lt?, eq? } }]`（按顺序第一条命中）、`default: <取值>`，可选 `description`（同指标，#205）。引用的指标必须已发布且没有维度（每个消费者一行）、取值是数字。标签的 SQL 把它引用的指标当前已发布版本的 SQL 内联成 CTE，不读指标快照，所以标签任务与指标任务之间没有先后顺序。

- 多指标写法（#225，与上面的单指标写法二选一）：不写顶层 `metric`，每条规则的 `when` 是 `{ all: [...] }`（全部满足）或 `{ any: [...] }`（任一满足），只一层、不嵌套，每项为 `{ metric: <指标键>, gte?|gt?|lte?|lt?|eq?: 数字 }`，至少一个比较。写了 `metric` 的按单指标写法校验（`when` 不认 `all` / `any`），没写的按多指标写法校验（`when` 不认比较）。模型生成标签草稿（ADR-0035）仍只出单指标写法（`SINGLE_TAG_SCHEMA`）。
- 人群：全部统一消费者（`SELECT DISTINCT consumer_id FROM silver._identities`），每人一行，列为 `consumer_id, tag_key, tag_value`。每个引用指标的 CTE 左连接进来。不用 `silver._consumer`：老湖可能没有这张表。
- 缺失取值：消费者不在某指标结果里（或取值为空）时，可选顶层 `missing: { <指标键>: 数字 | null }` 写了按写的（键必须是规则里引用到的指标）；没写时该指标的 `agg` 为 `count|count_distinct|sum` 记 0，其余记空（比较为假，落到后面的规则或 `default`）。编译成 `COALESCE(m<i>.value, <缺省>)`，两种写法都适用。
- 依赖：`tagDependencies(spec).metrics` 返回全部引用的指标（去重排序），删除指标的拒绝、发布指标的下游重算、影响预览、刷新都经过它，多指标标签自动覆盖。依赖收到的是未经 Schema 的已发布 YAML，两种写法结构不全时只取认得出的指标键。
- 口径变化：在这之前标签只覆盖指标结果里的消费者。老标签的已发布版本不改 YAML，下次发布、刷新或回刷时人群变成全部统一消费者，多出取 `default`（或按 0 命中规则）的人，各取值的人数会跳变；已有快照不变。

**计算与快照。** 一个任务种类 `gold.dsl`：入队时在服务端用当时的登记与映射编译好 SQL（带上 `asOf`），参数为 `kind, key, definitionId, definitionVersion, asOf, sql, entities`；handler 建 `gold."<kind>__<taskId>"`。快照登记进 `snapshots`，`template` 写 `metric:<key>` 或 `tag:<key>`，`definition_version` 照旧。

**依赖按需计算，不建依赖表。** 一份已发布版本的依赖（引用的指标键、实体、字段、关系）由它的 YAML 解析得出（`dependenciesOf`）。只有已发布版本算依赖，草稿不算。被已发布标签引用的指标不能删；被已发布指标引用的自定义实体不能删（加进 `publishedReferrers`）；映射发布后若某个被已发布指标引用的 `x_` 字段在该实体的已发布映射里不再存在，拒绝发布。关系本来就只能加不能删（`checkAdditive`）。

**新版本只影响最新快照。** 发布一版指标，以当天为 `asOf` 入队这个指标和引用它的每个已发布标签；发布标签只入队它自己。已有的快照不动，仍标着旧的定义版本。手动回刷：对这个定义所有未过期、定义版本早于当前生效版本的快照，按各自的 `asOf` 以当前版本各入队一次（指标连同下游标签），产出新的快照；旧快照保留到正常过期。已过期的快照没有表，不能回刷。发布时锁定义行后对照当前的登记与映射再校验一次，并在同一事务里编译、入队，SQL 进任务参数，任务不再访问平台库。补充（#139）：上面的反查落地后，发布定义、删除定义、删除自定义实体与发布映射都先锁租户行，按租户串行，依赖检查读到的是对方提交后的结果；自定义实体登记的发布只增不减，不拿这把锁。补充（#154）：event 指标改为缺省按设备归属。`customer_id` 有值时只经 `_identities` 解析，解析不到也不退回设备；只有 `customer_id` 为空才经 `device_id` 查 `_device_owner`，两边都查不到的不计入（`LEFT JOIN` 两张表，`COALESCE` 出 `consumer_id`）。已有快照是实体表 `gold."<kind>__<taskId>"`，SQL 在入队时编进任务参数，所以老快照不变，新口径在发布新版本或回刷后出现；代价是 `dsl_versions` 只存 YAML，老版本在预览、下游标签内联、影响预览、回刷时重编都用新口径，要老口径就在 YAML 里写 `device_attribution: false`。`gold.dsl` 与预览在 SQL 用到 `_device_owner` 时检查这张表在不在（老湖可能只有 `_identities`），不在时提示重新合并；`_device_owner` 不进 `entities` 与依赖。维度路径里 `event.customer_id -> customer` 这一跳不按设备补，匿名事件仍记「未关联」。补充（#178）：依赖的实体有新合并后，调度器每天以当天为 `asOf` 按生效版本重算指标与下游标签，快照记来源，见 ADR-0028。

**说明（#205）。** 指标与标签的 YAML 可写 `description`（字符串，最多 500 字，JSON Schema 校验，超长报「不能超过 500 字」）。说明是 YAML 的一部分，跟版本走，不另加列：目录接口 `GET /api/v1/catalog` 取当前（最新已发布）版本 YAML 里的 `description`，没写为 `null`，草稿里改了说明要发布后才对外可见。字段可选，加之前发布的 YAML 照常通过校验；编译不读它，SQL 不变。

**影响预览。** 定义有草稿且有已发布版本时，在只读挂载的湖上以当天为 `asOf` 分别按已发布版本和草稿计算，按 `consumer_id` 对比，只给计数：指标给取值变化的消费者数；受影响的每个标签（草稿本身是标签时就是它自己）给换了取值的消费者数、新增、移出，以及按「原取值 → 新取值」分组的人数。不出消费者 ID 与明文。分析模板的升级预览（ADR-0021，#234）复用同样的两条差异 SQL（`compileTagDiff` / `compileMetricDiff`）。

## 已接受的取舍

- 每次标签计算都重算一遍它引用的指标，多算一次换来没有任务顺序。
- 回刷后同一个 `asOf` 会有新旧两份快照，旧的保留到过期，列表上靠定义版本区分。
- 维度取当前值；「按时间点关联」只留了语法位置。
- 过滤只能用基础实体的字段，按维度过滤要等以后再加。
- 按统一消费者的属性做维度（`consumer.<字段>`，一个人只有一个取值）见 ADR-0027。

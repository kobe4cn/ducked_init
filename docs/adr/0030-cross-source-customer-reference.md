# 跨源引用：指向 customer 的字段可声明 ID 属于哪个数据源，标准层落 `_customer_source`

ADR-0019、ADR-0024 把消费者记录的身份定为 `(_source, customer_id)`，事件、订单、同意等实体上的 `customer_id` 只在本数据源内解析。行为、触达这类数据常常和消费者主档不在同一个系统（埋点里的 `user_id` 是商城的用户 ID），单独登记时全部归不到人，登录也给不了设备主人（#150）。

**写法与计划。** 映射里指向 `customer` 的字段（内置 ref 或已登记关系，标准字段与 `extensions` 都可以）可写 `customer_source: <数据源名>`，YAML 写名字，便于人读；草稿检查按名字找同租户的数据源，解析成 ID 存进计划的列上（`customerSource`），之后数据源改名不影响已发布的映射。目标源不存在、它没有已发布的 `customer` 映射、写在不指向 customer 的字段上时报错并指出行列；写的就是本源时只提示可以省略。计划里所有指向 customer 的引用列带 `customerRef`：工作进程不连平台库，只能靠它认出这样的列（#183）。

**发布期的键空间一致。** 跨源引用对照的是目标源的消费者主键，键空间（ADR-0024）也要对上目标源：发布带 `customer_source` 的映射时，字段的 `key_space` 要是目标源各已发布 `customer` 映射声明的键空间之一（有几个时任一个即可），报错给出目标源与它的键空间。与同源规则不同，目标源一定已有已发布的 `customer` 映射，所以它都没声明键空间时引用不能写键空间，而不是放过。反过来，重发某个数据源的 `customer` 映射改了或去掉键空间、使别的数据源的跨源引用对不上时拒绝发布，列出这些引用映射（数据源 + 映射名与字段），先改引用再改目标；同源引用只提示一起改（`keySpaceFollowers`），跨源引用分散在别的数据源、改的人未必看得到，所以拦。引用方由 `crossSourceReferrers(sourceId)` 查出：`customer_source` 指向该源的已发布映射（#187）。

**标准层恒写数据源列。** 每个指向 customer 的引用列旁边落一列 `customerSourceColumn(字段)`：`customer_id` → `_customer_source`，其他 → `_<字段>_source`（`app/lib/customer-source.ts`，前后端共用）。值是声明的目标数据源 ID，没声明时就是行自己的 `_source`。恒写而不是「没声明时为空、读时 `coalesce`」，读的地方只认一列，不会漏写 `coalesce`。名为 `customer_id` 的列不论计划里有没有 `customerRef` 都落（`customer` 自己的主键也记，早于 `customerRef` 的老计划也能认出）。列名不固定，不进 `SILVER_SYSTEM_COLUMNS`；合并的写法 `SCHEME` 不变，不触发全量重建。

**老湖补列。** 标准层里有 `customer_id` 却没有 `_customer_source` 的表（`_` 开头的系统表除外），在 `ensureLakeSchemas`（建湖与 `pnpm lake:ensure`）和每次合并开头补上这一列并按 `_source` 回填，同一个事务里，不整表重建。没有每次启动都跑的 schema 检查，所以合并开头也要补；结果层任务开头的补列随指标 / RFM 改用它时加。

**哪些地方改用它。** 关联 `silver._identities` 找统一消费者的地方按引用列的数据源列：设备归属（登录事件）、统一消费者的同意，以及指标、RFM、订单关联断言（#185）。主键冲突体检按 `_customer_source` 分组（#186）。

**哪些仍用 `_source`。** 行从哪里来、在哪里唯一不变：`customer` 关联 `_identities`、写 `_identities` 本身；行主键的唯一性（`assertions.ts` 的 `uniqueKey`）与跨映射独占（`merge-engine.ts` 的 `assertUniqueAcrossMappings`，主键含 customer 引用的实体按数据源内唯一）。设备仍按 `device_id` 跨源归属，不分数据源。

## 已接受的取舍

- 目标源里找不到这个 ID 时事件归不到人，不报错；之后目标源同步进来这条记录，下一次身份重算就归上。
- 没有撤下映射的路径，所以不处理「目标源的 customer 映射被撤下」；被引用的数据源删除前的提示由依赖查询 `crossSourceReferrers` 承担（#187）。
- 重发 `customer` 映射而键空间没变时不查跨源引用：失效只可能来自键空间的变化，没变时引用方发布时已经对照过。
- 只能指向 `customer`；指向别的实体的跨源引用用键空间（ADR-0024）。

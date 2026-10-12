# 统一消费者属性：合并时写出 silver._consumer，默认按 updated_at 取最新的非空值并记来源

身份打通（ADR-0019）只给出 `(_source, customer_id) → consumer_id`，customer 的属性仍按源记录各存一份。指标按 `order.customer_id -> customer.city` 做维度时，同一个人在两个源里城市不同就拆成两行（crmlab 的 K8）。#145 要让一个人在属性维度上只有一个取值。

**一张表。** 合并时身份打通之后、在写 `_identities`、`_device_owner` 的同一个事务里整表重写 `silver._consumer`：每个统一消费者一行，列是 `consumer_id`，加上 `silver.customer` 里每个属性列与它的来源列 `<列>__source`（取值那条源记录的 `_source`）。属性列是 customer 表里除系统列（`_mapping, _source, _version, _merged_at, _key_space`）与 `customer_id` 以外的全部列，随表结构变化，所以整表 `CREATE OR REPLACE`。实现在 `app/.server/pipeline/identity-engine.ts` 的 `resolveIdentities`。

**存活规则。** 每个属性单独取值：只看非空值，按 `updated_at` 新的在前（为空的排最后），再按 `(_source, customer_id)` 定序，取第一条。同样的输入总得到同样的结果。不同属性可以来自不同的源记录。`resolveIdentities` 另收数据源优先级（映射 ID → 名次，越小越优先，没配的排最后），名次排在 `updated_at` 前面；从映射配置传入留给后续的票，见下。

**不收敏感字段。** 标准模型的敏感字段（`name, phone, email, external_id`）与映射里标成敏感的 `x_` 字段不进 `_consumer`（ADR-0005；后者入队合并时由全部已发布的 customer 映射汇总进任务参数 `consumerSensitive`，与匹配规则一样不只看这次合并的映射）：它们在标准层只有哈希，做维度没有意义，也不该多一份副本。

**只算最新快照。** `_consumer` 由当前的 `silver.customer` 算出，不留历史；指标按 `consumer.<字段>` 做维度时取的是合并当时的值，与 ADR-0025「维度取当前值」一致。

**指标里的写法。** 维度路径写 `consumer.<字段>`（如 `consumer.city`）：只有一段，不从基础实体出发，字段是 customer 的非敏感字段（`customer_id` 除外）；基础实体要有 `customer_id`（或是 customer、event）。编译成按 `consumer_id` 左连接 `silver._consumer`（event 指标用设备归属后的 `consumer_id`，ADR-0025 补充 #154），一个人只有一个取值，取值为空记「未关联」；打通不到消费者的记录照 ADR-0025 不计入，不会出现在「未关联」里。`consumer` 不是标准层实体：不进任务的 `entities`（否则缺表检查与断言会找 `silver.consumer`），依赖里记作 `customer` 的字段。`gold.dsl` 与预览在 SQL 用到 `_consumer` 时检查这张表在不在，老湖没有时提示重新合并一次映射。

## 已接受的取舍

- 每次身份打通都整表重写 `_consumer`，customer 很大时与 `_identities` 一样是全量计算。
- 老湖在下次合并改到 customer 或 event 之前没有 `_consumer`，用了 `consumer.*` 的指标会被拦下；自动补算留给后续的票。
- `updated_at` 是源端给的，各源的时钟与含义不一定可比；需要指定「哪个源说了算」时用数据源优先级。
- 新加的 `x_` 字段在下次身份打通之前不在 `_consumer` 里，引用它的指标会在任务里报 SQL 错。

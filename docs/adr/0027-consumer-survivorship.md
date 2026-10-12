# 统一消费者属性：合并时写出 silver._consumer，默认按 updated_at 取最新的非空值并记来源

身份打通（ADR-0019）只给出 `(_source, customer_id) → consumer_id`，customer 的属性仍按源记录各存一份。指标按 `order.customer_id -> customer.city` 做维度时，同一个人在两个源里城市不同就拆成两行（crmlab 的 K8）。#145 要让一个人在属性维度上只有一个取值。

**一张表。** 合并时身份打通之后、在写 `_identities`、`_device_owner` 的同一个事务里整表重写 `silver._consumer`：每个统一消费者一行，列是 `consumer_id`，加上 `silver.customer` 里每个属性列与它的来源列 `<列>__source`（取值那条源记录的 `_source`）。属性列是 customer 表里除系统列（`_mapping, _source, _version, _merged_at, _key_space`）与 `customer_id` 以外的全部列，随表结构变化，所以整表 `CREATE OR REPLACE`。实现在 `app/.server/pipeline/identity-engine.ts` 的 `resolveIdentities`。

**存活规则。** 每个属性单独取值：只看非空值，按 `updated_at` 新的在前（为空的排最后），再按 `(_source, customer_id)` 定序，取第一条。同样的输入总得到同样的结果。不同属性可以来自不同的源记录。`resolveIdentities` 另收数据源优先级（映射 ID → 名次，越小越优先，没配的排最后），名次排在 `updated_at` 前面，配置方式见下。

**数据源优先级（#176）。** customer 映射可以写 `survivorship: { priority: <正整数> }`，数字越小越优先；只有 customer 映射能写，`priority` 不是正整数时映射校验报在这个键上。排序键是 `priority ASC NULLS LAST, updated_at DESC NULLS LAST, _source, customer_id`：先按名次取非空值，名次相同或都没配再按 `updated_at`。名次按 silver 的 `_mapping`（映射 ID）对，不按数据源（同一数据源可以有几个 customer 映射），任务参数里也只放映射 ID（映射可以改名）。入队合并时由全部已发布的 customer 映射汇总成 `survivorship`（映射 ID → 名次）放进任务参数，与匹配规则一样不只看这次合并的映射；名次与上次真正打通时不同就带 `identityForce` 强制重算，否则只改名次的发布因为 customer 数据没变会跳过打通。名次只作用于 `_consumer` 的属性，不作用于同意（见下）。这是成员显式声明的取舍，即 ADR-0024 所说「存活规则由成员显式声明」在统一消费者上的落地。

**不收敏感字段。** 标准模型的敏感字段（`name, phone, email, external_id`）与映射里标成敏感的 `x_` 字段不进 `_consumer`（ADR-0005；后者入队合并时由全部已发布的 customer 映射汇总进任务参数 `consumerSensitive`，与匹配规则一样不只看这次合并的映射）：它们在标准层只有哈希，做维度没有意义，也不该多一份副本。

**只算最新快照。** `_consumer` 由当前的 `silver.customer` 算出，不留历史；指标按 `consumer.<字段>` 做维度时取的是合并当时的值，与 ADR-0025「维度取当前值」一致。

**同意（#175）。** 同一个事务里紧接 `_consumer` 之后整表重写 `silver._consumer_consent(consumer_id, channel, status, updated_at, _source)`：`silver.consent` 按 `(_source, customer_id)` 关联 `_identities`，每个统一消费者每个渠道一行。同意只按时间，不用数据源优先级：`updated_at` 新的在前（为空的排最后），同一时刻撤回（`revoked`）优先于同意，再按 `(_source, customer_id)` 定序，取第一条，`_source` 记下取值那条源记录的数据源。不看 `granted_at`、`revoked_at`：有的映射只给了状态与 `updated_at`（如 crmlab 的 POS 同意）。`silver.consent` 不存在时建一张空表。打通的输入因此包括 consent：只合并了 consent 映射时也会重算。

**指标里的写法。** 维度路径写 `consumer.<字段>`（如 `consumer.city`）：只有一段，不从基础实体出发，字段是 customer 的非敏感字段（`customer_id` 除外）；基础实体要有 `customer_id`（或是 customer、event）。编译成按 `consumer_id` 左连接 `silver._consumer`（event 指标用设备归属后的 `consumer_id`，ADR-0025 补充 #154），一个人只有一个取值，取值为空记「未关联」；打通不到消费者的记录照 ADR-0025 不计入，不会出现在「未关联」里。`consumer` 不是标准层实体：不进任务的 `entities`（否则缺表检查与断言会找 `silver.consumer`），依赖里记作 `customer` 的字段。`gold.dsl` 与预览在 SQL 用到 `_consumer` 时检查这张表在不在，老湖没有时提示重新合并一次映射。

## 已接受的取舍

- 每次身份打通都整表重写 `_consumer`，customer 很大时与 `_identities` 一样是全量计算。
- `_consumer` 或 `_consumer_consent` 不在时（老湖、被删掉），下次合并即使数据没变也会重算打通把它们补回；在那之前用了 `consumer.*` 的指标会被拦下。
- `updated_at` 是源端给的，各源的时钟与含义不一定可比；需要指定「哪个源说了算」时用数据源优先级。
- 新加的 `x_` 字段在下次身份打通之前不在 `_consumer` 里，引用它的指标会在任务里报 SQL 错。

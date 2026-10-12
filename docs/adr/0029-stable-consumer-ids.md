# 统一消费者 ID 分配后固定：重算时沿用旧 ID，合并与拆开记入变更表

ADR-0019 补充（#76）里，统一消费者 ID 是组内最小源记录 `(_source, customer_id)` 的哈希。组的成员一变（新记录把两个人连起来、改规则把一个人拆开、最小的那条源记录被删），ID 就跟着变，结果层的快照、下游系统按旧 ID 存的数据都对不上。#147 定下 ID 分配后固定，#181 落地。

**两张表，都在湖里。** `silver._consumer_ids(consumer_id, assigned_at, retired_at)` 是分配表（包括已退役的 ID），`silver._consumer_id_changes(old_id, new_id, reason, changed_at)` 是变更表，`reason` 取 `merge` 或 `split`，只追加。「源记录 → ID」仍只存在 `silver._identities`。不放平台 PG：ADR-0002 规定业务数据只落湖，工作进程也不连平台库。两张表由 `resolveIdentities` 用 `CREATE TABLE IF NOT EXISTS` 建，与 `_identities` 在同一个 lake 事务里写入，不进 `lake-schemas.ts`（ADR-0020：不预建打通表）。合并时分配表不在也会触发重算，同 `_identities`。

**怎么选 ID。** 标签传播算出新的组之后、写入事务之前，在 `stage` 里对照上一版 `_identities`：
1. 新组按 `(_source, customer_id)` 等值连接旧 `_identities`，按（新组，旧 ID）数重叠的源记录数。
2. 每个旧 ID 只留给一个新组：重叠最多的那组，平局取含字典序最小源记录的组。「最多」数的是新组里原来属于这个 ID 的记录，不是新组的总人数；源记录上没有可靠的首次出现时间（`silver.customer._merged_at` 每次合并都覆盖），所以平局按 `(_source, customer_id)` 字典序。
3. 一个新组继承了多个旧 ID 时，留 `assigned_at` 最早的，平局取字典序较小的 ID；其余的各记一条 `merge`（旧 → 存活的 ID），并设上 `retired_at`。
4. 没分到旧 ID、但含有旧 ID 记录的新组，取新 ID，从它含有的每个旧 ID 各记一条 `split`（原 ID → 新 ID）。旧 ID 本身不退役，留给另一组。
5. 全是新记录的组取新 ID，不记变更。

只做一次哈希连接加两次聚合，不做二分图最大匹配。一个旧 ID 可能同时记 `merge`（它的大部分记录并入了另一个存活的 ID）和 `split`（其余记录拆成了新组）。

对照在写入事务之外读上一版 `_identities` 与分配表，依赖同一租户同时只有一个合并（`mappings.ts` 入队时在租户锁里保证），不会有两次打通交错。

**新 ID 仍是组内最小源记录的哈希**，新租户、新的组 ID 与以前一样；但可能撞上分配表里已有的 ID（包括已退役的，比如拆出来的组恰好以原组的最小记录为最小记录），撞了就在哈希输入后面加盐（`chr(31)` 加序号）重算，直到不撞。

**老湖播种。** 有 `_identities`、没有分配表时，先用 `_identities` 里现有的 ID 播种（`assigned_at` 取当前时间），原 ID 全部保留，不记变更。

摘要 `IdentitySummary` 加上本次记下的 `merged`、`split` 条数，随合并任务结果保存。

## 已接受的取舍

- 贪心对照，不求全局最优的匹配：极端的交叉拆合下，某组可能没分到本可以分到的旧 ID，记成 `split`。
- 记录全部消失的旧 ID 不退役、不记变更，仍留在分配表里（新 ID 不会再撞上它）。
- `_identities` 被删而分配表还在时，对照不到旧 ID，所有组都取新 ID（撞上的加盐），不记变更。
- 用旧 ID 点查（返回新消费者并带上「已合并到」，#14）、删除请求覆盖历史 ID（#24）、在数据地图显示合并与拆开数，都不在这里，见 #147。

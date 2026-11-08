# 标准层合并编排由 `merges.ts` 负责，读计划的模块只依赖「已发布映射计划」

`mappings.ts` 后四分之一（约 340 行）是标准层合并的编排：组装合并参数、入队或补进排队中的合并、同步后触发、定时补漏、强制重算打通的判断，成员手动触发的合并与重建，以及读回合并结果（身份打通摘要、关系统计、各映射最近一次合并）。合并组、源视图、自定义实体、调度器都为此 import `mappings.ts`，跟映射无关的改动也落到这个文件里。同时 `publishedPlans` 返回的是合并任务的参数类型 `MergeMappingParam`，目录、血缘、知识层、指标、lake-inspect 都依赖它；合并专属的字段（`rebuild`、`uniqueKey`、`uniqueBySource`、`group`）随之传给每个读计划的模块，`knowledge/basis.ts` 的 `planHash` 要先把它们剔掉才能算摘要。

决定：

- **合并编排由 `app/.server/merges.ts` 负责**：`mergePlans`（在已发布映射计划上补合并组与实体主键，给定映射时带上同组组员）、入队与补进排队中的合并、`mergeAfterSync`、`enqueueDueMerges`、`mergeNow` / `mergeMapping` / `rebuildEntity`（报 `MergeError`，400），以及读合并结果的函数。把新映射并进排队中的合并是纯函数 `mergeQueued`，经 `updateQueuedParams`（ADR-0052）写回。`mappings.ts` 只管映射的定义生命周期。
- **「已发布映射计划」`PublishedPlan`**（`MergePlan` 加 `mapping`、`version`、`sourceId`、`sourceView?`）定义在 `pipeline/mapping-spec.ts`。`mappings.ts` 的 `publishedPlans` 只读最新已发布版本与源视图，返回它；读计划的模块只依赖它。合并参数（契约里的 `silver.merge`）是 `PublishedPlan` 加合并专属字段，只出现在 `merges.ts`、合并引擎和 key-check。`isSensitiveField` 也移到 `mapping-spec.ts`，参数是 `PublishedPlan[]`。
- **`lockTenant` 单放在 `app/.server/tenant-lock.ts`**：它锁的是租户行，让入队合并、发布映射与定义、删除定义按租户串行，合并只是用它的一处。头注释写明加锁顺序：先拿它，记目录版本的锁最后拿（ADR-0047）。
- **DuckDB 小工具**（`rows`、`tableExists`、`keyList`、`joinOn`、`columnExists`、`silverTable`）移到 `pipeline/duck-sql.ts`；`ident` / `lit` 直接从 `lib/mapping-expr.ts` import，合并引擎不再转手导出。

没有把 `PublishedPlan` 和合并参数合成一个类型：给合并任务加字段不该波及目录与血缘，读计划的模块也不该看到入队时才补上的合并组。

## Consequences

- 两个类型、两个函数（`publishedPlans` / `mergePlans`）是有意的；需要合并组或实体主键的读方（目前只有 key-check）调 `mergePlans`。
- `mappings.ts` 不再 import `merge-groups` 与自定义实体的唯一键，`custom-entities` ↔ `mappings` 的循环 import 断开。
- `syncWroteMappingTable`、`dueMappings` 里用 jsonb 路径读同步与合并结果的 SQL 原样搬进 `merges.ts`（ADR-0052 不改 SQL 里的 jsonb 读取），注释指向契约里对应的结果类型。
- 合并参数的「补进排队中的合并」有纯函数测试；其余合并行为仍由真跑调度器的测试覆盖。

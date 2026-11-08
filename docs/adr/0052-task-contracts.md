# 每种任务一份契约，运行与完成后钩子各一张登记表

一种任务的契约原来散在四处：业务模块入队时拼 `Record<string, unknown>` 参数，`pipeline/handlers.ts` 的 `run` 手写校验参数，调度器钩子把 `tasks.result` 读回来各自 `as` 强转，完成后要做什么写在 `dispatcher.ts` 的一条 if 链里。参数两端（例如 `enqueueMerge` 与合并引擎的解析器）没有共享类型；`handlers.ts` 头注释说「新增任务类型只改这里」，实际还要改 if 链和 `claimNextTask` 里按 kind 写死的凭据准备。

决定：**每种任务在 `app/.server/pipeline/task-contracts.ts` 有一份契约：kind、label、参数 schema、结果类型、挂载标志（`attachSource` / `readOnlyLake` / `servingFile`），以及领取时要准备什么（`needs`：源连接、`piiSalt`、`servingKey`）。工作进程一侧的 `HANDLERS` 按契约实现 `run`，调度器一侧的 `task-hooks.ts` 按契约登记完成后钩子，两张表都用 `satisfies Record<TaskKind, …>` 让编译器查漏。** 契约文件不依赖任何平台模块。

没有把一种任务的 `run` 和钩子写进同一个文件：钩子都要用平台 PG（`db/client`、mailer、llm），工作进程 import 它们就会把平台库带进去，违背 ADR-0008（工作进程只拿租户凭据），还会和 `tasks.ts` 形成循环依赖。放在一处的是契约，`run` 和钩子分别实现它。

- 参数 schema 只要求 `{ parse(raw: unknown): T }`：新写的用 zod（中文错误信息），模板任务沿用各模板的 `parse`。参数类型以契约为准（`z.infer`），引擎从契约 import。schema 接受的参数与改写前的手写校验一致，队列里的旧任务不用迁移。
- 入队 `insertTask<K>(tx, tenantId, kind: K, params: ParamsOf<K>)`：编译时按 kind 检查，入队时再 `parse` 一次，参数不合法在用户请求里就报错。改写已排队任务的参数只走 `updateQueuedParams`，先按契约读出、改完校验再写回。
- 模板任务的契约由 `TEMPLATES` 与 `TASK_KINDS` 生成（ADR-0004 不变）：公共部分（`asOf`、`definitionVersion`、`trigger`、`templateVersion`）一个 schema，模板部分按 `templateAt(id, 版本).parse`。
- 钩子是每种任务一个有序数组，同一钩子可挂在多种任务上；每个钩子声明在成功、失败还是「有结果」（含部分失败）时运行；调度器逐个执行、各自捕获错误并记日志，一个失败不影响后面的；数组顺序就是执行顺序。
- 结果只有类型，不做运行时校验（结果由本仓库的工作进程写出）。读结果统一用 `readResult(kind, row)`。

## Consequences

- 新增一种任务改三处：契约、`HANDLERS`、`task-hooks.ts`（没有钩子就登记空数组）。
- `claimNextTask` 不再按 kind 或参数名判断，照契约的 `needs` 准备凭据；`source.drop` 的参数不必再刻意避开 `sourceId` 这个名字。
- `createDispatcher` 接受 `hooks` 选项，测试可以传假钩子验证执行顺序、触发条件和错误隔离；任务本身的测试仍然真跑调度器与工作进程。
- SQL 里按 kind 字符串查询的地方不收进常量；用 `jsonb` 路径读结果的 SQL 不改。

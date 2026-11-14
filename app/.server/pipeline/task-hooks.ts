// app/.server/pipeline/task-hooks.ts —— 各类任务结束后的钩子表（ADR-0052）：任务在 finishTask 之后按本表逐个执行钩子，
// 数组顺序就是执行顺序，每个钩子声明在成功、失败还是「有结果」（含部分失败）时运行。这里只写「任务结束后要做什么」，
// 领取与结束任务在 dispatcher.ts 与 tasks.ts。本文件引平台 PG（db/client、mailer 等），工作进程及其引入链不能 import 它（ADR-0008）
import { ensureEmbeddings, fillEmbeddings } from '../catalog/embeddings';
import { rebuildProjection } from '../catalog/projection';
import { recordCatalogVersionIfChanged } from '../catalog/versions';
import { registerDslSnapshot } from '../dsl-definitions';
import { alertNewFallback } from '../fallback-alerts';
import { mergeAfterSync } from '../merges';
import { alertAssertionFailure } from '../quality';
import { markSandboxExpired } from '../sandbox';
import { alertSchemaBreak } from '../schema-alerts';
import { draftSchemaRepairs } from '../schema-repair-drafts';
import { activateServingStore, enqueueServingBuild } from '../serving-store';
import { markExpired, registerSnapshot } from '../snapshots';
import { applyKeyCheck } from '../source-key-check';
import { enableDefaultTemplates } from '../templates';
import type { ClaimedTask } from '../tasks';
import { isTaskKind, type ParamsOf, type ResultOf, type TaskKind } from './task-contracts';
import { TASK_KINDS, type TemplateId } from './templates';
import type { WorkerOutcome } from './worker';

/** 钩子声明的运行时机：成功（没有 error）、失败（有 error）、有结果（含部分失败、断言失败带 result 的任务） */
export type HookWhen = 'succeeded' | 'failed' | 'result';

/** 一个钩子：成功或有结果时收到 params 与 result，失败时另有 error。params、result 的类型从契约断言而来（ADR-0052：
 * 入队时已按契约校验参数，结果由本仓库的工作进程写出，不做运行时校验），所以在 runHooks 里执行而非这里 parse */
export type TaskHook<K extends TaskKind> =
  | { name: string; when: 'succeeded' | 'result'; run(ctx: { task: ClaimedTask; params: ParamsOf<K>; result: ResultOf<K> }): Promise<unknown> }
  | { name: string; when: 'failed'; run(ctx: { task: ClaimedTask; params: ParamsOf<K>; error: string; result: ResultOf<K> | undefined }): Promise<unknown> };

/** 全部任务的钩子表：每种任务一个有序数组，没有钩子的 kind 登记空数组 */
export type TaskHookTable = { [K in TaskKind]: readonly TaskHook<K>[] };

/** 一个模板任务的钩子：登记快照、断言失败告警；RFM 另在成功后入队重建服务库（ADR-0033，在登记快照之后） */
const templateHooks = (id: TemplateId): readonly TaskHook<(typeof TASK_KINDS)[TemplateId]>[] => [
  // 分析模板任务写好了结果层的快照表：登记到平台元数据，分析页据此列出（断言失败的任务也带 result，靠库里的 status 挡住）
  { name: 'registerSnapshot', when: 'result', run: ({ task }) => registerSnapshot(task.tenantId, task.id, id) },
  // 结果层任务因 error 级断言失败（没有登记快照）：告警租户管理员并记审计
  { name: 'alertAssertionFailure', when: 'failed', run: ({ task, result }) => alertAssertionFailure(task.tenantId, task, result) },
  // 有了新快照：重建服务库（ADR-0033），只收 RFM 与指标、标签，其他模板的快照不触发；生成成功后才切换指针
  ...(id === 'rfm' ? [{ name: 'enqueueServingBuild', when: 'succeeded' as const, run: ({ task }: { task: ClaimedTask }) => enqueueServingBuild(task.tenantId) }] : []),
];

/** 模板任务（gold.rfm 等）的钩子：由注册表（TEMPLATES 与 TASK_KINDS）生成，写法照 handlers.ts 的 TEMPLATE_HANDLERS */
const TEMPLATE_HOOKS = Object.fromEntries((Object.keys(TASK_KINDS) as TemplateId[]).map(id => [TASK_KINDS[id], templateHooks(id)])) as
  { [K in TemplateId as (typeof TASK_KINDS)[K]]: readonly TaskHook<(typeof TASK_KINDS)[K]>[] };

/** 正式钩子表。新增任务先在 task-contracts.ts 登记契约，没有钩子也在这里登记空数组（编译器按 TaskHookTable 查漏） */
export const TASK_HOOKS = {
  'source.sync': [
    // 同步给已发布映射的源表写入了变更批次（部分失败时也可能有）：随即把它们合并进标准层
    { name: 'mergeAfterSync', when: 'result', run: ({ task }) => mergeAfterSync(task.tenantId, task.id) },
    // 同步发现源表删了列或破坏性改了类型、且已发布映射引用了它们：通知能改映射的成员并记审计（ADR-0034）
    { name: 'alertSchemaBreak', when: 'result', run: ({ task, result }) => alertSchemaBreak(task.tenantId, task, result) },
    // 同步成功：源表的列可能变了，和最新一版目录比较，有差异记一版（ADR-0041）；只改了统计不记
    { name: 'recordCatalogVersionIfChanged', when: 'succeeded', run: ({ task }) => recordCatalogVersionIfChanged(task.tenantId, 'source.synced') },
  ],
  'source.profile': [
    // 告警时入队的重新采集（带 repairFor）成功：按规则猜测源列改名，起草修复草稿并发带链接的邮件（ADR-0034）。成功必有 result
    { name: 'draftSchemaRepairs', when: 'succeeded', run: async ({ task, params }) => { if (params.repairFor) await draftSchemaRepairs(task.tenantId, task); } },
    // 采集成功：源表的列可能变了，和最新一版目录比较，有差异记一版（ADR-0041）；只改了统计不记
    { name: 'recordCatalogVersionIfChanged', when: 'succeeded', run: ({ task }) => recordCatalogVersionIfChanged(task.tenantId, 'source.profiled') },
  ],
  'silver.merge': [
    // 合并里值字典没写到的新取值落入了兜底值（以前没通知过）：通知能改映射的成员并记审计（ADR-0015）。部分映射失败时也看成功的那些
    { name: 'alertNewFallback', when: 'result', run: ({ task, result }) => alertNewFallback(task.tenantId, task, result) },
    // 合并成功：以默认参数自动启用依赖已齐、本租户还没有定义的模板，产出第一版快照（ADR-0021）
    { name: 'enableDefaultTemplates', when: 'succeeded', run: ({ task }) => enableDefaultTemplates(task.tenantId) },
  ],
  // 业务主键的全表检查通过：写回声明并记审计（工作进程里没有平台库）
  'source.keycheck': [{ name: 'applyKeyCheck', when: 'result', run: ({ task }) => applyKeyCheck(task.tenantId, task.id) }],
  'gold.dsl': [
    // 自定义定义写好了结果层的快照表：登记到平台元数据（断言失败的任务也带 result，靠库里的 status 挡住）
    { name: 'registerDslSnapshot', when: 'result', run: ({ task }) => registerDslSnapshot(task.tenantId, task.id) },
    // 结果层任务因 error 级断言失败（没有登记快照）：告警租户管理员并记审计
    { name: 'alertAssertionFailure', when: 'failed', run: ({ task, result }) => alertAssertionFailure(task.tenantId, task, result) },
    // 有了新快照：重建服务库（ADR-0033），生成成功后才切换指针
    { name: 'enqueueServingBuild', when: 'succeeded', run: ({ task }) => enqueueServingBuild(task.tenantId) },
  ],
  'gold.expire': [
    // 到期快照的表已删、旧文件已清理：标记为已过期，分析页不再打开它们
    { name: 'markExpired', when: 'result', run: ({ task }) => markExpired(task.tenantId, task.id) },
    // 快照过期腾出了数据：重建服务库（ADR-0033），生成成功后才切换指针
    { name: 'enqueueServingBuild', when: 'succeeded', run: ({ task }) => enqueueServingBuild(task.tenantId) },
  ],
  // 到期沙箱表已删、旧文件已清理：标记为已过期，工作台不再列出（沙箱表不进服务库，不重建）
  'sandbox.expire': [{ name: 'markSandboxExpired', when: 'result', run: ({ task }) => markSandboxExpired(task.tenantId, task.id) }],
  'catalog.projection': [
    // 检索投影差异太大、交给了任务（ADR-0047）：在这里按当前目录从零重建
    { name: 'rebuildProjection', when: 'succeeded', run: ({ task }) => rebuildProjection(task.tenantId) },
    // 重建后投影文字可能变了：顺带入队补算缺的向量（ADR-0049）。重建失败不再挡住补算入队
    { name: 'ensureEmbeddings', when: 'succeeded', run: ({ task }) => ensureEmbeddings(task.tenantId) },
  ],
  // 检索向量补算（ADR-0047、0049）：工作进程只占位（没有平台库），在这里补齐当前模型缺的向量并清掉旧模型的行
  'catalog.embed': [{ name: 'fillEmbeddings', when: 'succeeded', run: ({ task }) => fillEmbeddings(task.tenantId) }],
  // 服务库生成成功：把服务库指针切到新版本（ADR-0033）
  'serving.build': [{ name: 'activateServingStore', when: 'succeeded', run: ({ task }) => activateServingStore(task.tenantId, task.id) }],
  // 没有结束钩子的任务：湖清点与演示造数、核对与巡检、源表删除、指标与标签的重建、人群导出
  'lake.inventory': [],
  'demo.seed': [],
  'source.verify': [],
  'lake.inspect': [],
  'silver.keycheck': [],
  'source.drop': [],
  'export.tags': [],
  ...TEMPLATE_HOOKS,
} satisfies TaskHookTable;

/**
 * runHooks 执行时手里的钩子：ctx 的 params、result 直接用运行时数据，不逐 kind 泛型化——
 * 入队时已按契约校验参数、结果由本仓库的工作进程写出（ADR-0052 不做运行时校验），调用处（TASK_HOOKS）已按 kind 定型
 */
interface HookCall { name: string; when: HookWhen; run(ctx: { task: ClaimedTask; params: unknown; error?: string; result?: unknown }): Promise<unknown> }

/**
 * 按表执行一个任务结束后的钩子：满足 when 的逐个 await，每个各自捕获错误并记日志，一个失败不影响后面的。
 * hooks 传了就整张替换（缺的 kind 视为没有钩子），测试传假钩子时不会连带跑真钩子
 */
export async function runHooks(hooks: Partial<TaskHookTable>, task: ClaimedTask, outcome: WorkerOutcome): Promise<void> {
  // 队列里可能还有已下线的旧 kind：契约表里没有，视为没有钩子
  if (!isTaskKind(task.kind)) return;
  const failed = 'error' in outcome;
  for (const hook of (hooks[task.kind] ?? []) as readonly HookCall[]) {
    // 触发条件：succeeded 是成功（没有 error）、failed 是失败（有 error）、result 是有结果（含部分失败、断言失败带 result 的任务）
    if (hook.when === 'succeeded' && failed) continue;
    if (hook.when === 'failed' && !failed) continue;
    if (hook.when === 'result' && !outcome.result) continue;
    try {
      if (failed) await hook.run({ task, params: task.params, error: outcome.error, result: outcome.result });
      else await hook.run({ task, params: task.params, result: outcome.result });
    } catch (e) {
      console.warn(`[调度器] 任务 ${task.id}（${task.kind}）的钩子 ${hook.name} 出错`, e);
    }
  }
}

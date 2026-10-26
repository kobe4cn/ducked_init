// app/.server/pipeline/dispatcher.ts —— 调度器：从平台 PG 的队列领取任务，每个任务启动一个独立的工作进程（ADR-0001）。
// 本机同时运行的工作进程不超过 maxWorkers；各租户的并发上限与公平调度由 claimNextTask 保证，可以部署多个调度器。
// 数据湖迁移存储也由调度器执行（在本进程内，要用平台账号读旧前缀、写新前缀），同样占一个名额，先于任务领取。
// 常驻运行时还定期为到期的数据源入队同步与湖中数据核对，为有新变化的租户入队标准层合并；同步给已发布映射的源表写入变更后随即入队一次合并，
// 分析模板与指标、标签任务成功后登记结果快照，因断言失败时告警；还定期为有到期快照的租户入队快照过期、有到期沙箱表的入队沙箱表过期，成功后标记快照、沙箱表已过期。
// 登记了新快照或标记了过期后入队重建服务库，生成成功后把服务库指针切到新版本
// 源表采集与同步成功后和最新一版语义目录比较，源表的列变了记一版目录版本
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordCatalogVersionIfChanged } from '../catalog/versions';
import { registerDslSnapshot } from '../dsl-definitions';
import { cleanupExpiredExports } from '../exports';
import { alertNewFallback } from '../fallback-alerts';
import { claimLakeMigration, heartbeatLakeMigrations, runLakeMigration } from '../lake-migration';
import { enqueueDueMerges, mergeAfterSync } from '../mappings';
import { alertAssertionFailure } from '../quality';
import { enqueueDueRefreshes } from '../refresh';
import { enqueueDueSandboxExpiries, markSandboxExpired } from '../sandbox';
import { alertSchemaBreak } from '../schema-alerts';
import { draftSchemaRepairs } from '../schema-repair-drafts';
import { activateServingStore, enqueueServingBuild } from '../serving-store';
import { enqueueDueExpiries, markExpired, registerSnapshot } from '../snapshots';
import { applyKeyCheck } from '../source-key-check';
import { enqueueDueSyncs } from '../source-sync';
import { enqueueDueVerifies } from '../source-verify';
import { claimNextTask, failStaleTasks, finishTask, heartbeatTasks, setWorkerPid, type ClaimedTask } from '../tasks';
import { enableDefaultTemplates } from '../templates';
import { templateOfKind } from './templates';
import type { WorkerInput, WorkerOutcome } from './worker';

const WORKER_ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url));

export interface DispatcherOptions {
  /** 本机同时运行的工作进程上限 */
  maxWorkers: number;
  /** 轮询队列、为运行中的任务续期的间隔 */
  pollMs?: number;
  /** 任务超过这个时间没有续期，就认为派发它的调度器已失联 */
  staleAfterMs?: number;
  /** 单个任务的运行时限，超时终止工作进程 */
  timeoutMs?: number;
  /** 常驻运行时检查哪些数据源到了同步或核对周期的间隔 */
  syncCheckMs?: number;
}

// 工作进程只继承运行所需的环境变量（平台 PG 连接串等不在其中）；本租户数据湖的凭据经 IPC 单独传入
const WORKER_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'NODE_ENV', 'SystemRoot',
  'SOURCE_SYNC_LOOKBACK_MINUTES', 'SOURCE_SYNC_LOOKBACK_IDS', 'SOURCE_RECONCILE_HOURS',
  // 只给测试用的模板版本开关（templates/test-versions.ts）
  'TEMPLATE_TEST_VERSIONS',
];
const workerEnv = () => Object.fromEntries(WORKER_ENV_KEYS.flatMap(k => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

interface RunningTask { child: ChildProcess; done: Promise<void>; abort(reason: string): void }

export function createDispatcher({
  maxWorkers, pollMs = 1000, staleAfterMs = 60_000, timeoutMs = 2 * 60 * 60_000, syncCheckMs = 60_000,
}: DispatcherOptions) {
  const running = new Map<string, RunningTask>();
  /** 本调度器执行中的数据湖迁移，按领取凭据（claim）索引；abort 让它就此放弃（已被其他调度器接手） */
  const migrations = new Map<string, { done: Promise<void>; abort: AbortController }>();
  const busy = () => running.size + migrations.size;
  let stopped = false;
  let wake: (() => void) | undefined;
  let lastHeartbeat = Date.now();

  /** 在独立进程中执行一个任务；进程异常退出、超时或被终止都折算成错误 */
  function start(task: ClaimedTask) {
    const child = fork(WORKER_ENTRY, [], { execArgv: ['--import', 'tsx'], env: workerEnv(), stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let outcome: WorkerOutcome | undefined;
    const abort = (reason: string) => {
      outcome ??= { error: reason };
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => abort(`任务超过运行时限（${Math.round(timeoutMs / 60_000)} 分钟），已终止`), timeoutMs);
    if (child.pid) setWorkerPid(task.id, child.pid).catch(e => console.error('[调度器] 记录工作进程失败', e));
    child.on('message', m => { outcome ??= m as WorkerOutcome; });
    child.on('error', e => { outcome ??= { error: `无法启动工作进程：${e.message}` }; });
    const exited = new Promise<void>(resolve => child.on('exit', (code, signal) => {
      clearTimeout(timer);
      outcome ??= { error: `工作进程异常退出（${signal ?? `退出码 ${code}`}）` };
      resolve();
    }));
    const input: WorkerInput = { taskId: task.id, kind: task.kind, params: task.params, lake: task.lake, limits: task.limits, source: task.source, piiSalt: task.piiSalt, servingKey: task.servingKey };
    child.send(input);
    const done = exited
      .then(async () => {
        // 错误已由工作进程抹掉凭据；记进调度器日志，便于在后台排查
        if ('error' in outcome!) console.warn(`[调度器] 任务 ${task.id}（${task.kind}）失败：${outcome.error}`);
        await finishTask(task.id, outcome!);
        const succeeded = !('error' in outcome!);
        // 同步给已发布映射的源表写入了变更批次（部分失败时也可能有）：随即把它们合并进标准层
        if (task.kind === 'source.sync' && outcome!.result) await mergeAfterSync(task.tenantId, task.id);
        // 同步发现源表删了列或破坏性改了类型、且已发布映射引用了它们：通知能改映射的成员并记审计（ADR-0034）
        if (task.kind === 'source.sync' && outcome!.result) await alertSchemaBreak(task.tenantId, task, outcome!.result);
        // 告警时入队的重新采集（带 repairFor）成功：按规则猜测源列改名，起草修复草稿并发带链接的邮件（ADR-0034）
        if (task.kind === 'source.profile' && outcome!.result && succeeded && task.params.repairFor) await draftSchemaRepairs(task.tenantId, task);
        // 采集或同步成功：源表的列可能变了，和最新一版目录比较，有差异记一版（ADR-0041）；只改了统计不记。失败不影响任务状态
        if ((task.kind === 'source.profile' || task.kind === 'source.sync') && succeeded) {
          await recordCatalogVersionIfChanged(task.tenantId, task.kind === 'source.profile' ? 'source.profiled' : 'source.synced')
            .catch(e => console.warn(`[调度器] 任务 ${task.id} 之后记目录版本失败`, e));
        }
        // 合并里值字典没写到的新取值落入了兜底值（以前没通知过）：通知能改映射的成员并记审计（ADR-0015）。部分映射失败时也看成功的那些
        if (task.kind === 'silver.merge' && outcome!.result) await alertNewFallback(task.tenantId, task, outcome!.result);
        // 合并成功：以默认参数自动启用依赖已齐、本租户还没有定义的模板，产出第一版快照（ADR-0021）
        if (task.kind === 'silver.merge' && outcome!.result && !('error' in outcome!)) await enableDefaultTemplates(task.tenantId);
        // 业务主键的全表检查通过：写回声明并记审计（工作进程里没有平台库）
        if (task.kind === 'source.keycheck' && outcome!.result) await applyKeyCheck(task.tenantId, task.id);
        // 分析模板任务写好了结果层的快照表：登记到平台元数据，分析页据此列出
        const template = templateOfKind(task.kind);
        if (template && outcome!.result) await registerSnapshot(task.tenantId, task.id, template);
        if (task.kind === 'gold.dsl' && outcome!.result) await registerDslSnapshot(task.tenantId, task.id);
        // 结果层任务因 error 级断言失败（没有登记快照）：告警租户管理员并记审计
        if ((template || task.kind === 'gold.dsl') && 'error' in outcome!) await alertAssertionFailure(task.tenantId, task, outcome.result);
        // 到期快照的表已删、旧文件已清理：标记为已过期，分析页不再打开它们
        if (task.kind === 'gold.expire' && outcome!.result) await markExpired(task.tenantId, task.id);
        // 到期沙箱表已删、旧文件已清理：标记为已过期，工作台不再列出（沙箱表不进服务库，不重建）
        if (task.kind === 'sandbox.expire' && outcome!.result) await markSandboxExpired(task.tenantId, task.id);
        // 有了新快照或快照过期：重建服务库（ADR-0033），服务库只收 RFM 与指标、标签，其他模板的快照不触发；断言失败的任务也带 result，要看有没有 error。生成成功后才切换指针
        if ((task.kind === 'gold.rfm' || task.kind === 'gold.dsl' || task.kind === 'gold.expire') && succeeded) await enqueueServingBuild(task.tenantId);
        if (task.kind === 'serving.build' && succeeded) await activateServingStore(task.tenantId, task.id);
      })
      .catch(e => console.error(`[调度器] 任务 ${task.id} 结束时出错`, e))
      .finally(() => { running.delete(task.id); wake?.(); });
    running.set(task.id, { child, done, abort });
  }

  // 领取任务串行进行：进程结束与定时轮询可能同时触发补位
  let filling = Promise.resolve();
  const fill = () => (filling = filling.then(async () => {
    while (!stopped && busy() < maxWorkers) {
      const migration = await claimLakeMigration(staleAfterMs);
      if (!migration) break;
      const abort = new AbortController();
      const done = runLakeMigration(migration, abort.signal)
        .catch(e => console.error(`[调度器] 数据湖迁移 ${migration.id} 出错`, e))
        .finally(() => { migrations.delete(migration.claim); wake?.(); });
      migrations.set(migration.claim, { done, abort });
    }
    while (!stopped && busy() < maxWorkers) {
      const task = await claimNextTask();
      if (!task) break;
      start(task);
    }
  }));

  /**
   * 续期并终止不该再运行的任务（租户已停用、已被判为失联）。
   * 与平台 PG 失联过久时，其他调度器已把这些任务判为失败：终止全部工作进程，免得超出租户的并发上限
   */
  async function heartbeat() {
    try {
      for (const id of await heartbeatTasks([...running.keys()])) running.get(id)?.abort('任务已终止');
      for (const claim of await heartbeatLakeMigrations([...migrations.keys()])) migrations.get(claim)?.abort.abort();
      lastHeartbeat = Date.now();
    } catch (e) {
      if (Date.now() - lastHeartbeat > staleAfterMs) {
        for (const t of running.values()) t.abort('调度器失联，任务中断');
        for (const m of migrations.values()) m.abort.abort();
      }
      throw e;
    }
  }

  async function tick() {
    await heartbeat();
    await failStaleTasks(staleAfterMs);
    await fill();
  }

  let lastSyncCheck = 0;
  /**
   * 为到期的数据源入队同步，再入队核对（有同步在排队时等下一次检查），然后为有新变化的租户入队合并，为有到期快照的租户入队快照过期、有到期沙箱表的入队沙箱表过期，
   * 再为依赖的实体有新合并的已发布指标、标签与模板入队当天的刷新，最后删掉过了保留期的人群导出文件与到期的下载链接：
   * 每 syncCheckMs 一次，多个调度器同时检查也不会重复入队
   */
  async function scheduleSyncs() {
    if (Date.now() - lastSyncCheck < syncCheckMs) return;
    lastSyncCheck = Date.now();
    await enqueueDueSyncs();
    await enqueueDueVerifies();
    await enqueueDueMerges();
    await enqueueDueExpiries();
    await enqueueDueSandboxExpiries();
    await enqueueDueRefreshes();
    await cleanupExpiredExports();
  }

  /** 每隔 pollMs 或有工作进程结束时醒来 */
  const nap = () => new Promise<void>(resolve => {
    wake = resolve;
    setTimeout(resolve, pollMs);
  });

  return {
    /** 派发到队列里没有可派发的任务、且本调度器派发的任务全部结束为止（测试与一次性运行时使用） */
    async runUntilIdle() {
      await tick();
      while (busy()) {
        await nap();
        await tick();
      }
    },
    /** 持续运行，直到 stop()；之后等运行中的任务结束再返回 */
    async run() {
      while (!stopped) {
        await scheduleSyncs().catch(e => console.error('[调度器] 入队到期的同步、核对、合并、快照过期、结果层刷新或清理人群导出出错', e));
        await tick().catch(e => console.error('[调度器] 轮询出错', e));
        await nap();
      }
      await Promise.all([...[...running.values()].map(t => t.done), ...[...migrations.values()].map(m => m.done)]);
    },
    /** 不再领取新任务 */
    stop() {
      stopped = true;
      wake?.();
    },
  };
}

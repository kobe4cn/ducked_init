// app/.server/pipeline/dispatcher.ts —— 调度器：从平台 PG 的队列领取任务，每个任务启动一个独立的工作进程（ADR-0001）。
// 本机同时运行的工作进程不超过 maxWorkers；各租户的并发上限与公平调度由 claimNextTask 保证，可以部署多个调度器。
// 数据湖迁移存储也由调度器执行（在本进程内，要用平台账号读旧前缀、写新前缀），同样占一个名额，先于任务领取。
// 常驻运行时还定期为到期的数据源入队同步与湖中数据核对，为有新变化的租户入队标准层合并；同步给已发布映射的源表写入变更后随即入队一次合并
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimLakeMigration, heartbeatLakeMigrations, runLakeMigration } from '../lake-migration';
import { enqueueDueMerges, mergeAfterSync } from '../mappings';
import { enqueueDueSyncs } from '../source-sync';
import { enqueueDueVerifies } from '../source-verify';
import { claimNextTask, failStaleTasks, finishTask, heartbeatTasks, setWorkerPid, type ClaimedTask } from '../tasks';
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
    const input: WorkerInput = { kind: task.kind, params: task.params, lake: task.lake, limits: task.limits, source: task.source, piiSalt: task.piiSalt };
    child.send(input);
    const done = exited
      .then(async () => {
        // 错误已由工作进程抹掉凭据；记进调度器日志，便于在后台排查
        if ('error' in outcome!) console.warn(`[调度器] 任务 ${task.id}（${task.kind}）失败：${outcome.error}`);
        await finishTask(task.id, outcome!);
        // 同步给已发布映射的源表写入了变更批次（部分失败时也可能有）：随即把它们合并进标准层
        if (task.kind === 'source.sync' && outcome!.result) await mergeAfterSync(task.tenantId, task.id);
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
   * 为到期的数据源入队同步，再入队核对（有同步在排队时等下一次检查），最后为有新变化的租户入队合并：
   * 每 syncCheckMs 一次，多个调度器同时检查也不会重复入队
   */
  async function scheduleSyncs() {
    if (Date.now() - lastSyncCheck < syncCheckMs) return;
    lastSyncCheck = Date.now();
    await enqueueDueSyncs();
    await enqueueDueVerifies();
    await enqueueDueMerges();
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
        await scheduleSyncs().catch(e => console.error('[调度器] 入队到期的同步、核对或合并出错', e));
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

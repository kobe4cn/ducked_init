// app/.server/tasks.ts —— 平台 PG 上的任务队列：入队、按租户公平地领取、结束，以及成员查看本租户的任务。
// 执行由调度器（pipeline/dispatcher.ts）派发给独立的工作进程
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { TASK_STATUSES, tasks, tenantLakes, tenants, type TaskStatus } from './db/schema';
import { lakeSpecOf } from './lake';
import { tenantPiiSalt } from './secrets';
import { loadSourceSpec, SourceError } from './source-config';
import { HANDLERS, isTaskKind, type TaskKind } from './pipeline/handlers';
import type { WorkerInput, WorkerOutcome } from './pipeline/worker';

export type { TaskKind } from './pipeline/handlers';

export const TASK_STATUS_LABELS = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败' } as const;
export const TASK_PAGE_SIZE = 200;

export class TaskError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 入队一个任务。停用中的租户不能提交任务；共享锁与停用互斥，不会在停用的同时插进新任务 */
export async function enqueueTask(tenantId: string, kind: string, params: Record<string, unknown> = {}) {
  return getDb().transaction(tx => insertTask(tx, tenantId, kind, params));
}

/** 在调用方的事务里入队（调用方要在同一事务里先做检查时使用），规则同 enqueueTask */
export async function insertTask(tx: Tx, tenantId: string, kind: string, params: Record<string, unknown> = {}) {
  if (!isTaskKind(kind)) throw new TaskError(`未知的任务类型：${kind}`);
  const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId)).for('share');
  if (!tenant) throw new TaskError('租户不存在', 404);
  if (tenant.suspendedAt) throw new TaskError('租户已停用，不能提交任务');
  const [task] = await tx.insert(tasks).values({ tenantId, kind, params }).returning();
  return task;
}

export async function getTask(taskId: string) {
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new TaskError('任务不存在', 404);
  return task;
}

/** 本租户最近的任务（按提交时间倒序），带可展示的类型名称 */
export async function listTasks(tenantId: string) {
  const rows = await getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(TASK_PAGE_SIZE);
  return rows.map(t => ({ ...t, kindLabel: HANDLERS[t.kind as TaskKind]?.label ?? t.kind }));
}

/** 本租户各状态的任务数（不限于最近 TASK_PAGE_SIZE 个），没有任务的状态为 0 */
export async function countTasksByStatus(tenantId: string): Promise<Record<TaskStatus, number>> {
  const rows = await getDb()
    .select({ status: tasks.status, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId))
    .groupBy(tasks.status);
  const counts = Object.fromEntries(TASK_STATUSES.map(s => [s, 0])) as Record<TaskStatus, number>;
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export interface ClaimedTask extends WorkerInput { id: string; tenantId: string }

// 领取任务时持有的事务级咨询锁：多个调度器串行领取，按租户的并发上限不会被同时突破
const CLAIM_LOCK = 0x7461736b;

/** 在事务内取得领取锁。领取数据湖迁移也持有它：迁移开始时该租户没有运行中的任务，此后也不会再派发 */
export async function lockClaims(tx: Tx) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLAIM_LOCK})`);
}

/**
 * 领取下一个任务并标为运行中；参数带 sourceId 的任务同时解密该数据源的凭据交给工作进程，合并到标准层的任务同时派生
 * 租户的敏感信息盐（都不写进任务记录）。数据源已不存在或凭据、盐无法取得时，该任务直接记为失败，接着领取下一个。
 */
export async function claimNextTask(): Promise<ClaimedTask | null> {
  for (;;) {
    const task = await claimQueuedTask();
    if (!task) return null;
    let reading = '数据源的凭据';
    try {
      const { sourceId } = task.params;
      if (typeof sourceId === 'string') task.source = await loadSourceSpec(task.tenantId, sourceId);
      reading = '敏感信息盐';
      if (task.kind === 'silver.merge') task.piiSalt = await tenantPiiSalt(task.tenantId);
      return task;
    } catch (e) {
      const error = e instanceof SourceError ? e.message : `无法读取${reading}：${(e as Error).message}`;
      console.warn(`[调度器] 任务 ${task.id}（${task.kind}）失败：${error}`);
      await finishTask(task.id, { error });
    }
  }
}

/**
 * 领取下一个任务并标为运行中；没有可派发的任务时返回 null。
 * 跳过已停用、数据湖未初始化（含对象存储上还没有本租户账号）、数据湖迁移中、以及运行中任务已达并发上限的租户。
 * 公平调度：先挑运行中任务最少的租户，再挑最久没被派发过的租户，同一租户内先进先出——
 * 排队再多的大租户每次也只占一个名额，小租户不会被饿死
 */
async function claimQueuedTask(): Promise<ClaimedTask | null> {
  return getDb().transaction(async tx => {
    await lockClaims(tx);
    // 只看有排队任务的租户；各项统计都走按租户的索引，不随历史任务增多而变慢
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT q.id
      FROM (SELECT DISTINCT tenant_id FROM platform.tasks WHERE status = 'queued') c
      JOIN platform.tenants tn ON tn.id = c.tenant_id AND tn.suspended_at IS NULL
      JOIN platform.tenant_lakes l ON l.tenant_id = c.tenant_id AND l.catalog_initialized_at IS NOT NULL
        AND (l.data_path NOT LIKE 's3://%' OR l.s3_access_key IS NOT NULL)
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n FROM platform.tasks WHERE tenant_id = c.tenant_id AND status = 'running'
      ) r
      CROSS JOIN LATERAL (
        SELECT max(started_at) AS last_started FROM platform.tasks WHERE tenant_id = c.tenant_id
      ) s
      CROSS JOIN LATERAL (
        SELECT id, created_at FROM platform.tasks
        WHERE tenant_id = c.tenant_id AND status = 'queued' ORDER BY created_at, id LIMIT 1
      ) q
      WHERE r.n < tn.max_concurrent_tasks
        AND NOT EXISTS (
          SELECT 1 FROM platform.lake_migrations m WHERE m.tenant_id = c.tenant_id AND m.status IN ('pending', 'running')
        )
      ORDER BY r.n, s.last_started NULLS FIRST, q.created_at, q.id
      LIMIT 1`);
    if (!rows.length) return null;

    // 用数据库时钟（微秒精度）记录派发时间：公平调度按它排序，毫秒精度下连续领取可能相同
    const [task] = await tx
      .update(tasks)
      .set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` })
      .where(eq(tasks.id, rows[0].id))
      .returning();
    const [{ tenant, lake }] = await tx
      .select({ tenant: tenants, lake: tenantLakes })
      .from(tenants)
      .innerJoin(tenantLakes, eq(tenantLakes.tenantId, tenants.id))
      .where(eq(tenants.id, task.tenantId));
    return {
      id: task.id,
      tenantId: task.tenantId,
      kind: task.kind as TaskKind,
      params: task.params,
      lake: lakeSpecOf(lake),
      limits: { memoryLimitMb: tenant.memoryLimitMb, threads: tenant.threads },
    };
  });
}

export async function setWorkerPid(taskId: string, pid: number) {
  await getDb().update(tasks).set({ workerPid: pid }).where(eq(tasks.id, taskId));
}

/** 记录任务结果。已被判为中断的任务不再改写 */
export async function finishTask(taskId: string, outcome: WorkerOutcome) {
  await getDb()
    .update(tasks)
    .set({
      status: 'error' in outcome ? 'failed' : 'succeeded',
      result: outcome.result ?? null,
      error: 'error' in outcome ? outcome.error : null,
      finishedAt: sql`now()`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'running')));
}

/**
 * 调度器定期为自己派发的任务续期，返回应当终止的任务：租户已停用的（随即记为失败），
 * 以及已不在运行中的（例如被判为失联）。调度器负责终止它们的工作进程
 */
export async function heartbeatTasks(taskIds: string[]): Promise<string[]> {
  if (!taskIds.length) return [];
  const mine = and(inArray(tasks.id, taskIds), eq(tasks.status, 'running'));
  const suspended = await getDb()
    .update(tasks)
    .set({ status: 'failed', error: '租户已停用，任务终止', finishedAt: sql`now()` })
    .where(and(mine, inArray(tasks.tenantId, getDb().select({ id: tenants.id }).from(tenants).where(isNotNull(tenants.suspendedAt)))))
    .returning({ id: tasks.id });
  await getDb().update(tasks).set({ heartbeatAt: sql`now()` }).where(mine);
  const gone = await getDb().select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, taskIds), ne(tasks.status, 'running')));
  return [...new Set([...suspended, ...gone].map(t => t.id))];
}

/** 派发它的调度器失联（超过 staleAfterMs 没有续期）的任务判为失败，释放该租户的并发名额。按数据库时钟判断 */
export async function failStaleTasks(staleAfterMs: number) {
  await getDb()
    .update(tasks)
    .set({ status: 'failed', error: '调度器失联，任务中断', finishedAt: sql`now()` })
    .where(and(eq(tasks.status, 'running'), sql`${tasks.heartbeatAt} < now() - make_interval(secs => ${staleAfterMs / 1000})`));
}

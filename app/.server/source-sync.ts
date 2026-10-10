// app/.server/source-sync.ts —— 数据源的同步（有水位线的表增量同步，没有的全量比对）：成员手动触发、调度器按周期入队（source.sync 任务），
// 核对发现差异后成员触发一次主键比对，以及查看每张表的同步历史。同一数据源的同步与核对（source.verify）互斥。
// 同步本身在工作进程里进行（pipeline/sync-engine.ts）；每张表每次同步的变更批次、行数、耗时与水位线记在任务结果里
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import type { Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { sources, tasks, tenants, type TaskStatus } from './db/schema';
import type { TaskKind } from './pipeline/handlers';
import type { SyncRecord } from './pipeline/sync-engine';
import { requireSource, SourceError } from './source-config';
import { largeTableSyncHours, syncIntervalMinutes, syncTables } from './sources';
import { insertTask } from './tasks';

/** 同步历史取最近多少次同步任务 */
const HISTORY_TASKS = 50;

/** 同一数据源上互斥的任务：同步写原始层，核对读原始层与源端，同时只能有一个在排队或运行 */
type SourceTaskKind = Extract<TaskKind, 'source.sync' | 'source.verify'>;
const SOURCE_TASK_KINDS: SourceTaskKind[] = ['source.sync', 'source.verify'];
const SOURCE_TASK_LABELS: Record<SourceTaskKind, string> = { 'source.sync': '同步', 'source.verify': '核对' };

export const ofSource = (tenantId: string, sourceId: string, kinds: TaskKind[] = ['source.sync']) =>
  and(eq(tasks.tenantId, tenantId), inArray(tasks.kind, kinds), sql`${tasks.params}->>'sourceId' = ${sourceId}`);

/**
 * 锁住数据源行后检查并入队：同一数据源同时只有一个同步或核对在排队或运行（两次同步写同一批原始层表会互相冲突，
 * 核对与同步同时进行时读到的是写了一半的结果）。dueBefore 给出时，只有最近一次同类任务早于这个时间才入队（按周期）。
 * 不入队时返回 null 与原因
 */
export async function enqueueSourceTask(
  tx: Tx, tenantId: string, sourceId: string, kind: SourceTaskKind, params: Record<string, unknown>, dueBefore?: Date,
) {
  await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, sourceId)).for('update');
  const [pending] = await tx.select({ kind: tasks.kind }).from(tasks)
    .where(and(ofSource(tenantId, sourceId, SOURCE_TASK_KINDS), inArray(tasks.status, ['queued', 'running']))).limit(1);
  if (pending) return { task: null, reason: `已有一次${SOURCE_TASK_LABELS[pending.kind as SourceTaskKind]}在排队或运行中` };
  const [latest] = await tx.select({ createdAt: tasks.createdAt }).from(tasks)
    .where(ofSource(tenantId, sourceId, [kind])).orderBy(desc(tasks.createdAt)).limit(1);
  if (dueBefore && latest && latest.createdAt > dueBefore) return { task: null, reason: `本周期已经${SOURCE_TASK_LABELS[kind]}过` };
  return { task: await insertTask(tx, tenantId, kind, { sourceId, ...params }), reason: null };
}

/**
 * 成员手动触发一次同步（修复后不用等下一个周期）：同步所有要同步的表，全量比对的大表也在内。
 * reconcile 为真时（核对发现差异后的「立即主键比对」）不等比对周期，有水位线的表增量之后都比对一次主键全集（没有主键时整行比对）
 */
export async function syncSource(actor: CurrentMember, sourceId: string, { reconcile = false }: { reconcile?: boolean } = {}) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId);
  const tables = (await syncTables(actor.tenant.id, sourceId)).map(t => t.param);
  if (!tables.length) throw new SourceError('没有可同步的表：请先选定同步范围，并为待确认水位线的表确认水位线字段');
  const { task, reason } = await getDb().transaction(tx =>
    enqueueSourceTask(tx, actor.tenant.id, sourceId, 'source.sync', { tables, ...(reconcile && { reconcile: true }) }));
  if (!task) throw new SourceError(reason!);
  return task;
}

/** 数据源各表在 since 之后最近一次同步（成功或失败）的开始时间，取自这段时间内的全部同步任务 */
async function lastAttempts(tenantId: string, sourceId: string, since: Date) {
  const runs = await getDb().select({ result: tasks.result }).from(tasks)
    .where(and(ofSource(tenantId, sourceId), gt(tasks.createdAt, since)));
  const last = new Map<string, Date>();
  for (const { result } of runs) {
    for (const record of (result?.tables ?? []) as SyncRecord[]) {
      const at = new Date(record.startedAt);
      const seen = last.get(record.table);
      if (!seen || seen < at) last.set(record.table, at);
    }
  }
  return last;
}

/**
 * 为到期的数据源入队同步（调度器定期调用，可以部署多个调度器）：有要同步的表、租户未停用、
 * 最近一次同步早于一个周期之前且没有同步在排队或运行。全量比对的大表距上次同步满 SOURCE_LARGE_TABLE_SYNC_HOURS
 * （默认一天）才带上，失败了也等下一天，免得每小时整表重读。返回入队的数据源
 */
export async function enqueueDueSyncs(now = new Date()) {
  const dueBefore = new Date(now.getTime() - syncIntervalMinutes() * 60_000);
  const largeDueBefore = new Date(now.getTime() - largeTableSyncHours() * 3_600_000);
  const candidates = await getDb()
    .select({ id: sources.id, tenantId: sources.tenantId })
    .from(sources)
    .innerJoin(tenants, and(eq(tenants.id, sources.tenantId), isNull(tenants.suspendedAt)))
    .orderBy(sources.id);
  const enqueued: string[] = [];
  for (const { id, tenantId } of candidates) {
    const plan = await syncTables(tenantId, id);
    const recent = plan.some(t => t.large) ? await lastAttempts(tenantId, id, largeDueBefore) : new Map<string, Date>();
    const tables = plan.filter(t => !t.large || !recent.has(t.param.name)).map(t => t.param);
    if (!tables.length) continue;
    try {
      const { task } = await getDb().transaction(tx => enqueueSourceTask(tx, tenantId, id, 'source.sync', { tables }, dueBefore));
      if (task) enqueued.push(id);
    } catch (e) {
      console.error(`[调度器] 数据源 ${id} 的同步入队失败`, e);
    }
  }
  return enqueued;
}

/** 一张表的一次同步，带所属任务 */
export type SyncHistoryEntry = SyncRecord & { taskId: string };

/**
 * 数据源的同步状态：最近一次同步任务（任何状态）与每张表的同步历史（新的在前）。
 * 任务整体失败（如连不上数据源）时没有各表的记录，只有 error
 */
export async function getSyncStatus(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  await requireSource(actor.tenant.id, sourceId);
  return syncStatus(actor.tenant.id, sourceId);
}

/** 同 getSyncStatus，不检查权限（平台内部使用，如核对时判断未进湖的原因） */
export async function syncStatus(tenantId: string, sourceId: string) {
  const runs = await getDb().select().from(tasks).where(ofSource(tenantId, sourceId))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(HISTORY_TASKS);
  const history: Record<string, SyncHistoryEntry[]> = {};
  for (const run of runs) {
    // 一次同步里同一张表可能先后有增量与主键比对两个批次，同样新的在前
    const records = [...((run.result?.tables ?? []) as SyncRecord[])].reverse();
    for (const record of records) (history[record.table] ??= []).push({ ...record, taskId: run.id });
  }
  const [latest] = runs;
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
    history,
  };
}

// app/.server/source-verify.ts —— 湖中数据核对（source.verify 任务）：成员手动触发、调度器每天为有同步表的数据源入队一次，
// 查看最近一次核对的结果，以及数据源列表上标出最近一次核对有差异的数据源。
// 核对在工作进程里进行（pipeline/verify-engine.ts），只读、只出报告；发现差异时由成员触发一次主键比对同步去修复（source-sync.ts）。
// 同一数据源的核对与同步互斥
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { sources, tasks, tenants, type TaskStatus } from './db/schema';
import type { VerifyRecord, VerifyTableParam } from './pipeline/verify-engine';
import { requireSource, SourceError } from './source-config';
import { enqueueSourceTask, ofSource, syncStatus } from './source-sync';
import { confirmedTables, syncTables } from './sources';
import type { LakeCoverage } from '../lib/sources';

/** 调度器多久为每个有同步表的数据源核对一次（SOURCE_VERIFY_INTERVAL_HOURS，默认 24 小时） */
export const verifyIntervalHours = () => Number(process.env.SOURCE_VERIFY_INTERVAL_HOURS ?? 24);

/**
 * 同步范围内的表为什么还没有进湖；同步成功过（写出过变更批次）的表返回 null。
 * 不在范围内、源端已不存在、账号没有读权限、等待采集、待确认水位线、同步失败、等待首次同步
 */
export function notInLakeReason(
  t: { inScope: boolean; gone: boolean; readable: boolean }, profiled: { needsWatermark: boolean } | undefined, history: object[] | undefined,
): Exclude<LakeCoverage, 'in_lake'> | null {
  if (!t.inScope) return 'out_of_scope';
  if (history?.some(e => !('error' in e))) return null;
  // 重新列出表之前，最近一次同步发现源端已没有这张表
  if (t.gone || (history?.[0] && 'gone' in history[0])) return 'gone';
  if (!t.readable) return 'unreadable';
  if (!profiled) return 'pending_profile';
  if (profiled.needsWatermark) return 'needs_watermark';
  return history?.length ? 'sync_failed' : 'pending_sync';
}

/**
 * 核对任务的参数：最近一次列出表得到的每张表（源端已不存在、不在范围内的除外），带是否在同步范围内、平台判断的未进湖原因
 * 与同步设置。账号读不了、源端已删除由工作进程核对时实时判断
 */
async function verifyParams(tenantId: string, sourceId: string): Promise<VerifyTableParam[]> {
  const { listing, tables } = await confirmedTables(tenantId, sourceId);
  const { history } = await syncStatus(tenantId, sourceId);
  const synced = new Map((await syncTables(tenantId, sourceId)).map(t => [t.param.name, t.param]));
  return listing.filter(t => t.inScope || !t.goneAt).map(t => {
    const profiled = tables.find(p => p.table.name === t.tableName);
    const reason = notInLakeReason(
      { inScope: t.inScope, gone: !!t.goneAt, readable: t.readable },
      profiled && { needsWatermark: !profiled.watermark && profiled.table.watermarkCandidates.length > 0 },
      history[t.tableName],
    );
    const param = synced.get(t.tableName);
    return {
      name: t.tableName,
      inScope: t.inScope,
      reason: reason === null || reason === 'gone' || reason === 'unreadable' ? 'pending_sync' : reason,
      ...(t.keyColumns?.length && { key: t.keyColumns }),
      ...(param?.softDelete && { softDelete: param.softDelete }),
      ...(param?.column && { column: param.column, kind: param.kind }),
    };
  });
}

/** 成员手动触发一次核对：同一数据源已有同步或核对在排队或运行时拒绝 */
export async function verifySource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId);
  const tables = await verifyParams(actor.tenant.id, sourceId);
  const { task, reason } = await getDb().transaction(tx => enqueueSourceTask(tx, actor.tenant.id, sourceId, 'source.verify', { tables }));
  if (!task) throw new SourceError(reason!);
  return task;
}

/**
 * 为到期的数据源入队核对（调度器定期调用，可以部署多个调度器）：有要同步的表、租户未停用、最近一次核对早于
 * SOURCE_VERIFY_INTERVAL_HOURS 之前，且没有同步或核对在排队或运行（有时等下一次检查）。返回入队的数据源
 */
export async function enqueueDueVerifies(now = new Date()) {
  const dueBefore = new Date(now.getTime() - verifyIntervalHours() * 3_600_000);
  const candidates = await getDb()
    .select({ id: sources.id, tenantId: sources.tenantId })
    .from(sources)
    .innerJoin(tenants, and(eq(tenants.id, sources.tenantId), isNull(tenants.suspendedAt)))
    .orderBy(sources.id);
  const enqueued: string[] = [];
  for (const { id, tenantId } of candidates) {
    try {
      // 先看是否到期，免得每次检查都为每个数据源组装核对参数
      const [latest] = await getDb().select({ createdAt: tasks.createdAt }).from(tasks)
        .where(ofSource(tenantId, id, ['source.verify'])).orderBy(desc(tasks.createdAt)).limit(1);
      if (latest && latest.createdAt > dueBefore) continue;
      if (!(await syncTables(tenantId, id)).length) continue;
      const tables = await verifyParams(tenantId, id);
      const { task } = await getDb().transaction(tx => enqueueSourceTask(tx, tenantId, id, 'source.verify', { tables }, dueBefore));
      if (task) enqueued.push(id);
    } catch (e) {
      console.error(`[调度器] 数据源 ${id} 的核对入队失败`, e);
    }
  }
  return enqueued;
}

/**
 * 数据源最近一次核对：最近一次核对任务的状态（任何状态），以及最近一次成功核对的结果（每表一行）与有差异的表数。
 * 还没有成功核对过时 tables 为空、verifiedAt 为 null
 */
export async function getVerifyStatus(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  await requireSource(actor.tenant.id, sourceId);
  const verifies = ofSource(actor.tenant.id, sourceId, ['source.verify']);
  const [latest] = await getDb().select().from(tasks).where(verifies).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const [report] = await getDb().select().from(tasks).where(and(verifies, eq(tasks.status, 'succeeded')))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    verifiedAt: report?.finishedAt ?? null,
    differences: Number(report?.result?.differences ?? 0),
    tables: (report?.result?.tables ?? []) as VerifyRecord[],
  };
}

/** 本租户各数据源最近一次成功核对中有差异的表数（数据源 ID → 表数，一致为 0）；没有成功核对记录的数据源不在其中 */
export async function verifyDifferences(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const { rows } = await getDb().execute<{ source_id: string; differences: number }>(sql`
    SELECT DISTINCT ON (t.params->>'sourceId') t.params->>'sourceId' AS source_id, coalesce((t.result->>'differences')::int, 0) AS differences
    FROM ${tasks} t
    WHERE t.tenant_id = ${actor.tenant.id} AND t.kind = 'source.verify' AND t.status = 'succeeded'
    ORDER BY t.params->>'sourceId', t.created_at DESC, t.id DESC`);
  return new Map(rows.map(r => [r.source_id, Number(r.differences)]));
}

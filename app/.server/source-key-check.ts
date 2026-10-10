// app/.server/source-key-check.ts —— 业务主键的全表检查（source.keycheck 任务）：成员声明业务主键时入队（sources.ts 的 confirmKey），
// 工作进程按租户配额在源表全表上分桶检查非空与唯一（pipeline/sync-engine.ts 的 checkKeyColumns），结果写进任务结果。
// 检查通过后由调度器写回 source_tables.key_columns 并记审计；不通过时声明不生效，原有声明不变。
// 这项检查只读源端，不与同一数据源的同步、核对互斥；同一张表同时只有一次检查在排队或运行
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { sources, sourceTables, tasks, type TaskStatus } from './db/schema';
import { requireSource, SourceError } from './source-config';
import { ofSource } from './source-sync';
import { insertTask } from './tasks';

/** 入队参数；memberId 与 email 是声明的成员，写回时据此记审计 */
export interface KeyCheckTaskParams { sourceId: string; tableName: string; keyColumns: string[]; sensitive: boolean; memberId: string; email: string }

/** 任务结果：ok 为假时有空值或重复；主键列像敏感信息时重复键的 key 为 null，只给次数 */
export interface KeyCheckTaskResult {
  tableName: string;
  keyColumns: string[];
  ok: boolean;
  nullRows: number;
  duplicates: { key: string[] | null; count: number }[];
}

const ofTable = (tenantId: string, sourceId: string, tableName: string) =>
  and(ofSource(tenantId, sourceId, ['source.keycheck']), sql`${tasks.params}->>'tableName' = ${tableName}`);

/** 锁住数据源行后检查并入队：同一张表已有一次检查在排队或运行时拒绝 */
export async function enqueueKeyCheck(tx: Tx, tenantId: string, params: KeyCheckTaskParams) {
  await tx.select({ id: sources.id }).from(sources).where(eq(sources.id, params.sourceId)).for('update');
  const [pending] = await tx.select({ id: tasks.id }).from(tasks)
    .where(and(ofTable(tenantId, params.sourceId, params.tableName), inArray(tasks.status, ['queued', 'running']))).limit(1);
  if (pending) throw new SourceError(`${params.tableName} 已有一次业务主键检查在排队或运行中`);
  return insertTask(tx, tenantId, 'source.keycheck', { ...params });
}

/**
 * 检查任务结束后写回（调度器调用）：结果通过、这次检查仍是这张表最近的一次、数据源与表都还在时，写回业务主键并记审计；
 * 否则丢弃。返回是否写回
 */
export async function applyKeyCheck(tenantId: string, taskId: string) {
  return getDb().transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
    const params = task?.params as unknown as KeyCheckTaskParams | undefined;
    if (!task || !params || (task.result as KeyCheckTaskResult | null)?.ok !== true) return false;
    const [source] = await tx.select({ id: sources.id, name: sources.name }).from(sources)
      .where(and(eq(sources.id, params.sourceId), eq(sources.tenantId, tenantId))).for('update');
    if (!source) return false;
    const [latest] = await tx.select({ id: tasks.id }).from(tasks).where(ofTable(tenantId, params.sourceId, params.tableName))
      .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
    if (latest?.id !== taskId) return false;
    const values = { keyColumns: params.keyColumns, keyConfirmedByEmail: params.email };
    const updated = await tx.update(sourceTables).set(values)
      .where(and(eq(sourceTables.sourceId, params.sourceId), eq(sourceTables.tableName, params.tableName), isNull(sourceTables.goneAt)))
      .returning({ tableName: sourceTables.tableName });
    if (!updated.length) return false;
    await recordAudit(tx, {
      tenantId,
      actor: { memberId: params.memberId, email: params.email },
      action: 'source.key_confirmed',
      targetType: 'source',
      targetId: params.sourceId,
      detail: { name: source.name, table: params.tableName, column: params.keyColumns.join('、') },
    });
    return true;
  });
}

/** 数据源每张表最近一次业务主键检查：表名 → 状态、结果与错误 */
export async function getKeyChecks(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  await requireSource(actor.tenant.id, sourceId);
  const checks = await getDb().select().from(tasks).where(ofSource(actor.tenant.id, sourceId, ['source.keycheck']))
    .orderBy(desc(tasks.createdAt), desc(tasks.id));
  const latest = new Map<string, { status: TaskStatus; result: KeyCheckTaskResult | null; error: string | null }>();
  for (const t of checks) {
    const tableName = (t.params as Partial<KeyCheckTaskParams>).tableName;
    if (typeof tableName === 'string' && !latest.has(tableName)) {
      latest.set(tableName, { status: t.status as TaskStatus, result: t.result as KeyCheckTaskResult | null, error: t.error });
    }
  }
  return latest;
}

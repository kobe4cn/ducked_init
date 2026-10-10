// app/.server/snapshots.ts —— 结果快照：分析模板（与指标、标签）任务成功后，调度器把它写进结果层的那张表登记到平台元数据（模板、参数、任务、表名、行数，
// 创建后 90 天过期）；数据仍只在租户数据湖里（ADR-0002）。分析页列出本租户的快照，打开时在请求内只读挂载本租户的数据湖读取，
// 快照表只有 consumer_id 与分值，没有明文（ADR-0005）。登记时模板读到的实体有已发布映射在任务开始前最近一次合并失败的，照常登记，
// 但在快照上记下这些映射（数据不完整），原因只留摘要、不带源端取值。到期后调度器为每个租户入队 gold.expire 删表并清理湖里的旧文件，成功后标记 expiredAt。
// 一律限定在给定租户内
import { and, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { snapshots, tasks, tenants, type IncompleteMapping } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { publishedPlans } from './mappings';
import { openTenantLake } from './pipeline/lake-engine';
import type { MergeRecord } from './pipeline/merge-engine';
import { insertTask } from './tasks';
import { TEMPLATES } from './pipeline/templates';
import type { RfmParams } from './pipeline/templates/rfm';

export type SnapshotTemplate = keyof typeof TEMPLATES;
export type Snapshot = typeof snapshots.$inferSelect;

/** 快照从创建起保留的天数 */
export const SNAPSHOT_RETENTION_DAYS = 90;
export const CONSUMER_PAGE_SIZE = 50;

/** 读一张快照用的计算资源 */
const READ_LIMITS = { memoryLimitMb: 256, threads: 1 };

/** 可以展示给成员的业务错误 */
export class SnapshotError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/**
 * 分析模板任务成功后登记它的快照（任务结果里的 table、rows、params，任务参数里的模板定义版本 definitionVersion），
 * 并记下任务开始前模板读到的实体里最近一次合并失败的映射（incompleteMappings）；任务没有成功（如已被判为中断）或已登记过时什么也不做
 */
export const registerSnapshot = (tenantId: string, taskId: string, template: SnapshotTemplate) =>
  registerTaskSnapshot(tenantId, taskId, () => ({ template, entities: TEMPLATES[template].entities }));

/**
 * 结果层任务成功后登记它的快照：describe 由任务参数给出快照的 template 与读到的实体，其余同 registerSnapshot。
 * 每次只新增这一张，已有的快照不变
 */
export async function registerTaskSnapshot(
  tenantId: string, taskId: string, describe: (params: Record<string, unknown>) => { template: string; entities: readonly string[] },
) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params, result: tasks.result, startedAt: tasks.startedAt }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded' || !task.result) return;
  const { table, rows, params } = task.result as { table: string; rows: number; params: Record<string, unknown> };
  const { definitionVersion } = task.params as { definitionVersion?: unknown };
  const { template, entities } = describe(task.params as Record<string, unknown>);
  const incomplete = await incompleteMappings(tenantId, entities, task.startedAt ?? new Date());
  const createdAt = new Date();
  await db.insert(snapshots).values({
    tenantId, template, taskId, table, params, rowCount: rows, createdAt,
    incomplete: incomplete.length ? incomplete : null,
    definitionVersion: Number.isInteger(definitionVersion) ? definitionVersion as number : null,
    expiresAt: new Date(createdAt.getTime() + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  }).onConflictDoNothing({ target: snapshots.taskId });
}

/**
 * 这些实体的已发布映射里，在 before 之前结束的合并中最近一次（跳过的不算，也不盖掉之前的结果）失败了的映射，
 * 带原因摘要与这个映射最近一次成功合并的任务的结束时间。按每个映射自己的记录判断，不看任务状态；没有 result.mappings 的合并任务不算
 */
export async function incompleteMappings(tenantId: string, entities: readonly string[], before: Date): Promise<IncompleteMapping[]> {
  const ids = (await publishedPlans(getDb(), tenantId)).filter(p => entities.includes(p.entity)).map(p => p.mapping);
  if (!ids.length) return [];
  // 映射 m.id 在 before 之前结束的合并里最近一条满足 recordFilter 的记录（FROM 起的子查询主体）
  const latestRecordWhere = (recordFilter: SQL) => sql`
    FROM ${tasks} t, jsonb_array_elements(t.result->'mappings') rec
    WHERE t.tenant_id = ${tenantId} AND t.kind = 'silver.merge' AND t.finished_at <= ${before.toISOString()}::timestamptz
      AND rec->>'mapping' = m.id::text AND ${recordFilter}
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1`;
  const { rows } = await getDb().execute<{ record: MergeRecord & { error: string }; last_success_at: string | Date | null }>(sql`
    SELECT f.record, s.finished_at AS last_success_at FROM unnest(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::uuid[]) m(id)
    CROSS JOIN LATERAL (SELECT rec AS record ${latestRecordWhere(sql`NOT rec ? 'skipped'`)}) f
    LEFT JOIN LATERAL (SELECT t.finished_at ${latestRecordWhere(sql`rec ? 'rows'`)}) s ON true
    WHERE f.record ? 'error'
    ORDER BY m.id`);
  return rows.map(({ record: { mapping, entity, table, error }, last_success_at }) => ({
    mapping, entity, table, error: summarizeMergeError(error),
    lastSuccessAt: last_success_at === null ? null : new Date(last_success_at).toISOString(),
  }));
}

/**
 * 合并报错的摘要：只留第一个全角冒号之前的部分（冒号后是取值，如主键冲突时没有引号的键值、值字典缺失的取值），
 * 截到 120 字。原文写进任务前已在工作进程里 redact 过，这里再去掉取值
 */
export function summarizeMergeError(message: string) {
  const colon = message.indexOf('：');
  return (colon < 0 ? message : message.slice(0, colon)).slice(0, 120);
}

/**
 * 为有到期快照（expiresAt 已到、还没标记过期）的租户各入队一个 gold.expire，参数是到期快照的表名；
 * 本租户已有排队或运行中的 gold.expire 时跳过（下一次检查再补上），多个调度器同时检查也不会重复入队。返回入队了的租户
 */
export async function enqueueDueExpiries(now = new Date()) {
  const due = (db: Tx | ReturnType<typeof getDb>, tenantId?: string) => db
    .select({ tenantId: snapshots.tenantId, table: snapshots.table }).from(snapshots)
    .innerJoin(tenants, and(eq(tenants.id, snapshots.tenantId), isNull(tenants.suspendedAt)))
    .where(and(lte(snapshots.expiresAt, now), isNull(snapshots.expiredAt), tenantId ? eq(snapshots.tenantId, tenantId) : undefined))
    .orderBy(snapshots.tenantId, snapshots.table);
  const enqueued: string[] = [];
  for (const tenantId of [...new Set((await due(getDb())).map(d => d.tenantId))]) {
    try {
      const task = await getDb().transaction(async tx => {
        // 先锁住租户行再查一次：查询之后可能已有调度器入队过期、甚至已执行完
        await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
        const [pending] = await tx.select({ id: tasks.id }).from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'gold.expire'), inArray(tasks.status, ['queued', 'running']))).limit(1);
        const tables = (await due(tx, tenantId)).map(d => d.table);
        if (pending || !tables.length) return null;
        return insertTask(tx, tenantId, 'gold.expire', { tables });
      });
      if (task) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的快照过期入队失败`, e);
    }
  }
  return enqueued;
}

/** gold.expire 成功后把它删掉的表对应的快照标记为已过期；任务没有成功时什么也不做 */
export async function markExpired(tenantId: string, taskId: string) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded') return;
  const { tables } = task.params as { tables: string[] };
  await db.update(snapshots).set({ expiredAt: new Date() })
    .where(and(eq(snapshots.tenantId, tenantId), inArray(snapshots.table, tables), isNull(snapshots.expiredAt)));
}

/** 本租户的全部快照，最新的在前 */
export async function listSnapshots(tenantId: string) {
  return getDb().select().from(snapshots).where(eq(snapshots.tenantId, tenantId)).orderBy(desc(snapshots.createdAt));
}

/** 本租户的一张快照；不存在或属于其他租户时为 null */
export async function getSnapshot(tenantId: string, id: string): Promise<Snapshot | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await getDb().select().from(snapshots).where(and(eq(snapshots.id, id), eq(snapshots.tenantId, tenantId)));
  return row ?? null;
}

export interface RfmSegmentSummary { name: string; consumers: number; monetary: string }
export interface RfmConsumer { consumer_id: string; segment: string; r: number; f: number; m: number; recency_days: number; frequency: number; monetary: string }

/**
 * 只读挂载本租户的数据湖，读出 RFM 快照：各人群的人数与金额（按定义里的人群顺序，没有消费者的人群为 0），
 * 以及按 consumer_id 排序的第 page 页消费者明细
 */
export async function readRfmSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  if (snapshot.template !== 'rfm') throw new SnapshotError('不是 RFM 快照', 404);
  if (snapshot.expiredAt) throw new SnapshotError('快照已过期', 404);
  const match = /^gold\.(rfm__[0-9a-f-]{36})$/.exec(snapshot.table);
  if (!match) throw new SnapshotError('快照表名不合法', 404);
  const lake = await lakeRow(snapshot.tenantId);
  if (!lake || !lakeReady(lake)) throw new SnapshotError('本租户的数据湖还没有初始化');

  const table = `gold."${match[1]}"`;
  const session = await openTenantLake(lakeSpecOf(lake), READ_LIMITS, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const totals = await read<{ segment: string; consumers: string; monetary: string }>(
      `SELECT segment, count(*) AS consumers, sum(monetary)::VARCHAR AS monetary FROM ${table} GROUP BY segment`);
    const offset = (page - 1) * pageSize;
    const consumers = await read<RfmConsumer>(`
      SELECT consumer_id, segment, r, f, m, recency_days, frequency, monetary::VARCHAR AS monetary
      FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${offset}`);
    const segments: RfmSegmentSummary[] = (snapshot.params as unknown as RfmParams).segments.map(({ name }) => {
      const t = totals.find(x => x.segment === name);
      return { name, consumers: Number(t?.consumers ?? 0), monetary: t?.monetary ?? '0.00' };
    });
    return { segments, consumers: consumers.map(c => ({ ...c, r: Number(c.r), f: Number(c.f), m: Number(c.m), recency_days: Number(c.recency_days), frequency: Number(c.frequency) })) };
  } finally {
    session.close();
  }
}

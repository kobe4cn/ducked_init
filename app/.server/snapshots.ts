// app/.server/snapshots.ts —— 结果快照：分析模板任务成功后，调度器把它写进结果层的那张表登记到平台元数据（模板、参数、任务、表名、行数，
// 创建后 90 天过期）；数据仍只在租户数据湖里（ADR-0002）。分析页列出本租户的快照，打开时在请求内只读挂载本租户的数据湖读取，
// 快照表只有 consumer_id 与分值，没有明文（ADR-0005）。到期后调度器为每个租户入队 gold.expire 删表并清理湖里的旧文件，成功后标记 expiredAt。
// 一律限定在给定租户内
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { snapshots, tasks, tenants } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { openTenantLake } from './pipeline/lake-engine';
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

/** 分析模板任务成功后登记它的快照（任务结果里的 table、rows、params）；任务没有成功（如已被判为中断）或已登记过时什么也不做 */
export async function registerSnapshot(tenantId: string, taskId: string, template: SnapshotTemplate) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, result: tasks.result }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded' || !task.result) return;
  const { table, rows, params } = task.result as { table: string; rows: number; params: Record<string, unknown> };
  const createdAt = new Date();
  await db.insert(snapshots).values({
    tenantId, template, taskId, table, params, rowCount: rows, createdAt,
    expiresAt: new Date(createdAt.getTime() + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  }).onConflictDoNothing({ target: snapshots.taskId });
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

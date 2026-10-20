// app/.server/sandbox.ts —— 沙箱表过期（ADR-0036）：沙箱表保存后 SANDBOX_TTL_DAYS 天到期，调度器为有到期沙箱表的租户入队 sandbox.expire，
// 工作进程删表并清理湖里的旧文件（与快照过期同一套做法，ADR-0020），成功后在平台库标记 expiredAt，工作台不再列出。一律限定在给定租户内
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { sandboxTables, tasks, tenants } from './db/schema';
import { sandboxSchema } from './pipeline/workbench-engine';
import { insertTask } from './tasks';

/** 沙箱表在湖里的全名 sandbox_<成员>.<表名>，即 sandbox.expire 的参数 */
const sandboxLakeName = (t: { memberId: string; name: string }) => `${sandboxSchema(t.memberId)}.${t.name}`;

/**
 * 为有到期沙箱表（expiresAt 已到、还没标记过期）的租户各入队一个 sandbox.expire，参数是到期沙箱表在湖里的全名；
 * 本租户已有排队或运行中的 sandbox.expire 时跳过（下一次检查再补上），多个调度器同时检查也不会重复入队。返回入队了的租户
 */
export async function enqueueDueSandboxExpiries(now = new Date()) {
  const due = (db: Tx | ReturnType<typeof getDb>, tenantId?: string) => db
    .select({ tenantId: sandboxTables.tenantId, memberId: sandboxTables.memberId, name: sandboxTables.name }).from(sandboxTables)
    .innerJoin(tenants, and(eq(tenants.id, sandboxTables.tenantId), isNull(tenants.suspendedAt)))
    .where(and(lte(sandboxTables.expiresAt, now), isNull(sandboxTables.expiredAt), tenantId ? eq(sandboxTables.tenantId, tenantId) : undefined))
    .orderBy(sandboxTables.tenantId, sandboxTables.memberId, sandboxTables.name);
  const enqueued: string[] = [];
  for (const tenantId of [...new Set((await due(getDb())).map(d => d.tenantId))]) {
    try {
      const task = await getDb().transaction(async tx => {
        // 先锁住租户行再查一次：查询之后可能已有调度器入队过期、甚至已执行完
        await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
        const [pending] = await tx.select({ id: tasks.id }).from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'sandbox.expire'), inArray(tasks.status, ['queued', 'running']))).limit(1);
        const tables = (await due(tx, tenantId)).map(sandboxLakeName);
        if (pending || !tables.length) return null;
        return insertTask(tx, tenantId, 'sandbox.expire', { tables });
      });
      if (task) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的沙箱表过期入队失败`, e);
    }
  }
  return enqueued;
}

/**
 * sandbox.expire 成功后把它删掉的沙箱表标记为已过期；任务没有成功时什么也不做。
 * 只标记入队时已到期的登记：入队之后成员又同名保存的（过期时间已重置）不标记
 */
export async function markSandboxExpired(tenantId: string, taskId: string) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params, createdAt: tasks.createdAt }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded') return;
  const tables = new Set((task.params as { tables: string[] }).tables);
  const stillDue = and(eq(sandboxTables.tenantId, tenantId), lte(sandboxTables.expiresAt, task.createdAt), isNull(sandboxTables.expiredAt));
  const due = await db.select({ id: sandboxTables.id, memberId: sandboxTables.memberId, name: sandboxTables.name }).from(sandboxTables).where(stillDue);
  const ids = due.filter(t => tables.has(sandboxLakeName(t))).map(t => t.id);
  // 更新时再带上到期条件：查询之后成员可能又同名保存（同一行，过期时间已重置）
  if (ids.length) await db.update(sandboxTables).set({ expiredAt: new Date() }).where(and(inArray(sandboxTables.id, ids), stillDue));
}

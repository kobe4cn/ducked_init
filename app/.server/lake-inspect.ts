// app/.server/lake-inspect.ts —— 漂移检查（lake.inspect 任务）：成员在数据地图上手动触发，入队时由已发布映射算出标准层各表应有的结构，
// 工作进程只读挂载数据湖对比实际结构（pipeline/inspect-engine.ts），差异写进任务结果。同一租户同时只有一次检查在排队或运行。
// 报告里只有标准层的表名、列名与类型，不含源表名，任何角色都能看最近一次结果
import { and, desc, eq, inArray } from 'drizzle-orm';
import { assertCan } from './access';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { tasks, tenants, type TaskStatus } from './db/schema';
import { publishedPlans } from './mappings';
import type { Drift, InspectParams } from './pipeline/inspect-engine';
import { sensitiveColumns, SILVER_SYSTEM_COLUMNS, type MergeMappingParam } from './pipeline/merge-engine';
import { sqlType } from './pipeline/mapping-spec';
import { insertTask } from './tasks';

export class InspectError extends Error {}

/**
 * 标准层各表应有的结构（与 merge-engine.ts 的 ensureSilverTable 建表一致）：按实体汇总各映射的列（并集），敏感字段存哈希、一律 VARCHAR，
 * 再加上系统列。同名列在不同映射里类型不同时取第一个映射的
 */
export function expectedTables(plans: MergeMappingParam[]): InspectParams['expected'] {
  const expected: InspectParams['expected'] = {};
  for (const plan of plans) {
    const pii = sensitiveColumns(plan);
    const table = (expected[plan.entity] ??= {});
    for (const c of plan.entityColumns) table[c.name] ??= pii.has(c.name) ? 'VARCHAR' : sqlType(c.type);
  }
  for (const table of Object.values(expected)) Object.assign(table, SILVER_SYSTEM_COLUMNS);
  return expected;
}

const ofInspect = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'lake.inspect'));

/** 成员手动触发一次漂移检查；锁住租户行后检查，已有一次在排队或运行时不入队 */
export async function inspectLakeNow(actor: CurrentMember) {
  assertCan(actor, 'sources:write');
  const tenantId = actor.tenant.id;
  return getDb().transaction(async tx => {
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(ofInspect(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (pending) throw new InspectError('已有一次漂移检查在排队或运行中');
    return insertTask(tx, tenantId, 'lake.inspect', { expected: expectedTables(await publishedPlans(tx, tenantId)) });
  });
}

/**
 * 最近一次漂移检查：最近一次检查任务的状态（任何状态），以及最近一次成功检查的时间与差异。
 * 还没有成功检查过时 drifts 为空、inspectedAt 为 null
 */
export async function getInspectStatus(actor: CurrentMember) {
  const inspects = ofInspect(actor.tenant.id);
  const [latest] = await getDb().select().from(tasks).where(inspects).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const [report] = await getDb().select().from(tasks).where(and(inspects, eq(tasks.status, 'succeeded')))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    inspectedAt: report?.finishedAt ?? null,
    drifts: (report?.result?.drifts ?? []) as Drift[],
  };
}

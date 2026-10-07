// app/.server/key-check.ts —— 主键冲突体检（silver.keycheck 任务，ADR-0024「冲突体检」）：成员在映射列表上手动触发，入队时由已发布映射
// 算出各实体的主键、是否按数据源比较与各映射的列，工作进程只读挂载数据湖统计重叠（pipeline/key-check-engine.ts），报告写进任务结果。
// 同一租户同时只有一次体检在排队或运行。customer 不参与；主键含指向 customer 的字段的实体只在同一个数据源内比较
import { and, desc, eq, inArray } from 'drizzle-orm';
import { assertCan } from './access';
import type { CurrentMember } from './auth';
import { publishedCustomEntities, type RegisteredEntity } from './custom-entities';
import { getDb } from './db/client';
import { tasks, tenants, type TaskStatus } from './db/schema';
import { entityOf } from '../lib/canonical-model';
import { publishedPlans } from './mappings';
import type { KeyCheckParams, KeyCheckResult } from './pipeline/key-check-engine';
import type { MergeMappingParam } from './pipeline/merge-engine';
import { insertTask } from './tasks';

export class KeyCheckError extends Error {}

/**
 * 体检参数里的实体：按实体汇总已发布映射，带上实体主键与 bySource（主键里有字段指向 customer：标准实体看字段上内置的 ref，
 * 自定义实体与扩展字段看已发布登记上的关系）。customer 与主键未知的实体不放进去
 */
export function keyCheckEntities(plans: MergeMappingParam[], published: Map<string, RegisteredEntity>): KeyCheckParams['entities'] {
  const relations = [...published.values()].flatMap(e => e.relations ?? []);
  const toCustomer = (entity: string, field: string) =>
    entityOf(entity)?.fields.find(f => f.name === field)?.ref?.entity === 'customer'
    || relations.some(r => r.from.entity === entity && r.from.field === field && r.ref.entity === 'customer');
  const byEntity = new Map<string, MergeMappingParam[]>();
  for (const p of plans) if (p.entity !== 'customer') byEntity.set(p.entity, [...byEntity.get(p.entity) ?? [], p]);
  return [...byEntity].flatMap(([entity, group]) => {
    const key = entityOf(entity)?.key.slice() ?? published.get(entity)?.primaryKey;
    if (!key) return [];
    return [{
      entity, key, bySource: key.some(f => toCustomer(entity, f)),
      mappings: group.map(p => ({ mapping: p.mapping, columns: p.columns.map(c => c.name) })),
    }];
  });
}

const ofKeyCheck = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.keycheck'));

/** 成员手动触发一次体检；锁住租户行后检查，已有一次在排队或运行时不入队 */
export async function checkKeysNow(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const tenantId = actor.tenant.id;
  return getDb().transaction(async tx => {
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(ofKeyCheck(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (pending) throw new KeyCheckError('已有一次主键冲突体检在排队或运行中');
    const entities = keyCheckEntities(await publishedPlans(tx, tenantId), await publishedCustomEntities(tx, tenantId));
    return insertTask(tx, tenantId, 'silver.keycheck', { entities } satisfies KeyCheckParams);
  });
}

/**
 * 最近一次体检：最近一次体检任务的状态（任何状态），以及最近一次成功体检的时间与报告。
 * 还没有成功体检过时 entities 为空、checkedAt 为 null
 */
export async function getKeyCheckStatus(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const checks = ofKeyCheck(actor.tenant.id);
  const [latest] = await getDb().select().from(tasks).where(checks).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const [report] = await getDb().select().from(tasks).where(and(checks, eq(tasks.status, 'succeeded')))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    checkedAt: report?.finishedAt ?? null,
    entities: (report?.result?.entities ?? []) as KeyCheckResult['entities'],
  };
}

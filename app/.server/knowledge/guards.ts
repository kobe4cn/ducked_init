// app/.server/knowledge/guards.ts —— 别名与知识提案共用的骨架：先按两种权限挡掉查看者、按 UUID 校验后锁住本租户的行、别名唯一索引冲突改写成 400
import { and, eq, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { assertCan, can } from '../access';
import type { Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { UUID } from '../tenants';
import { KnowledgeError } from './basis';

/** 两种权限（definitions:draft、sources:write）都没有（查看者）时先 403，不必读行；有其中一种的，读出行后按是不是映射字段再查 */
export function assertCanTouchKnowledge(actor: CurrentMember) {
  if (!can(actor.role, 'definitions:draft') && !can(actor.role, 'sources:write')) assertCan(actor, 'definitions:draft');
}

/** 按 ID 锁住（FOR UPDATE）本租户的一行；ID 不是 UUID、不存在或别的租户的返回 undefined */
export async function lockTenantRow<T extends PgTable & { id: PgColumn; tenantId: PgColumn }>(
  tx: Tx, table: T, id: string, tenantId: string,
): Promise<InferSelectModel<T> | undefined> {
  if (!UUID.test(id)) return undefined;
  const [row] = await tx.select().from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.tenantId, tenantId))).for('update');
  return row as InferSelectModel<T> | undefined;
}

/** 唯一索引冲突（PG 23505；drizzle 可能把它包在 cause 里） */
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === '23505'
  || (e as { cause?: { code?: string } } | null)?.cause?.code === '23505';

/** 并发加了同一个别名时唯一索引兜底：23505 改写成 400，其他错误原样抛出 */
export function rethrowDuplicateAlias(e: unknown): never {
  if (isUniqueViolation(e)) throw new KnowledgeError('已有同样的别名');
  throw e;
}

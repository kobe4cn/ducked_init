// app/.server/tenant-lock.ts —— 锁租户行：入队合并、发布映射与定义、删除定义与自定义实体先拿它，按租户串行，合并只是用它的一处（ADR-0053）。
// 加锁顺序：先拿它，记目录版本的锁最后拿（ADR-0047）；拿了 advisory 锁之后不能再等租户行锁（ADR-0054）
import { eq } from 'drizzle-orm';
import type { Tx } from './audit';
import { tenants } from './db/schema';

export const lockTenant = (tx: Tx, tenantId: string) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');

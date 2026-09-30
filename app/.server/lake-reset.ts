// app/.server/lake-reset.ts —— 开发 / 演示环境清空租户的数据湖重来（pnpm lake:reset）。生产环境清除租户数据走删除请求与租户退出，
// 运营后台不提供这个操作（ADR-0007）。步骤：标为未初始化（调度器不再派发该租户的任务，排队的保留）→ 删除并重建 catalog schema →
// 删除存储前缀下的全部文件 → 重新初始化。租户的数据库角色、密码与对象存储账号不变
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit, type OperatorActor } from './audit';
import { getDb } from './db/client';
import { lakeMigrations, tasks, tenantLakes } from './db/schema';
import { createCatalogSchema, initTenantCatalog, lakeRow } from './lake';
import { ACTIVE_MIGRATION } from './lake-migration';
import { deleteLakeFiles } from './lake-storage';
import { lockClaims } from './tasks';
import { TenantError } from './tenants';

/**
 * 重置租户的数据湖：有运行中的任务或正在迁移存储时拒绝。
 * 中途出错时数据湖停在未初始化（不派发任务），可以重新执行；数据湖未初始化时也可以执行
 */
export async function resetTenantLake(operator: OperatorActor, tenantId: string) {
  // 与领取任务共用一把锁：确认没有运行中的任务后立即标为未初始化，此后不会再派发该租户的任务
  const lake = await getDb().transaction(async tx => {
    await lockClaims(tx);
    const [lake] = await tx.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId)).for('update');
    if (!lake) throw new TenantError('租户还没有数据湖');
    const [{ running }] = await tx.select({ running: count() }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, 'running')));
    if (running) throw new TenantError(`租户有 ${running} 个运行中的任务，等它们结束后再重置`);
    const [migration] = await tx.select({ toPath: lakeMigrations.toPath }).from(lakeMigrations)
      .where(and(eq(lakeMigrations.tenantId, tenantId), inArray(lakeMigrations.status, ACTIVE_MIGRATION)));
    if (migration) throw new TenantError(`数据湖正在迁移到 ${migration.toPath}，迁移结束后再重置`);
    await tx.update(tenantLakes).set({ catalogInitializedAt: null }).where(eq(tenantLakes.tenantId, tenantId));
    return lake;
  });

  // schema 归平台所有，删除时连同租户角色建的元数据表一起删掉；重建后与开通时一样只授予本租户角色
  await getDb().transaction(async tx => {
    await tx.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(lake.catalogSchema)} CASCADE`);
    await createCatalogSchema(tx, lake.catalogSchema, lake.dbRole);
  });
  const files = await deleteLakeFiles(lake.dataPath);
  await initTenantCatalog(tenantId, operator);

  await recordAudit(getDb(), {
    tenantId,
    operator,
    action: 'tenant.lake_reset',
    targetType: 'tenant',
    targetId: tenantId,
    detail: { catalogSchema: lake.catalogSchema, dataPath: lake.dataPath, files },
  });
  return { dataPath: lake.dataPath, files, resetAt: (await lakeRow(tenantId))!.catalogInitializedAt! };
}

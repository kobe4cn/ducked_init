// scripts/rebuild-all.ts —— 用法：node --env-file-if-exists=.env --import tsx scripts/rebuild-all.ts --tenant crmlab-10m
// 为某个租户的全部已发布映射入队一次强制重建的合并（由调度器派发执行）。已有合并在排队或运行中时不入队
import { parseArgs } from 'node:util';
import { closeDb, getDb } from '../app/.server/db/client';
import { enqueueMerge, lockTenant, pendingMerge } from '../app/.server/mappings';
import { tenantIdBySlug } from '../app/.server/tenants';

const { values } = parseArgs({ options: { tenant: { type: 'string' } } });

if (!values.tenant) {
  console.error('用法：node --env-file-if-exists=.env --import tsx scripts/rebuild-all.ts --tenant <租户标识>');
  process.exit(2);
}

try {
  const tenantId = await tenantIdBySlug(values.tenant);
  // 先锁租户行再查排队中的合并，与入队互斥（同 rebuildEntity）；不并进已排队的合并，免得计时混进别的映射
  const task = await getDb().transaction(async tx => {
    await lockTenant(tx, tenantId);
    if (await pendingMerge(tx, tenantId)) return null;
    return enqueueMerge(tx, tenantId, undefined, { rebuild: true });
  });
  if (task) console.log(`已提交强制重建（${(task.params.mappings as unknown[]).length} 个映射，id=${task.id}）`);
  else {
    console.error('没有入队：已有合并在排队或运行中，或者还没有已发布的映射');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`提交失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

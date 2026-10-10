// scripts/ensure-lake-schemas.ts —— 用法：pnpm lake:ensure [--tenant acme]
// 给已初始化的租户数据湖补建名字固定的 schema 与平台表（ensureLakeSchemas）：这些对象改为在初始化数据湖时建、任务里不再建，
// 此前开通的租户上线前要先跑一次，否则任务会因 gold 或平台表缺失而失败。可重复执行；不给 --tenant 时处理全部已初始化的租户。
// 一个租户失败不影响其他租户，有失败时退出码为 1
import { parseArgs } from 'node:util';
import { isNotNull } from 'drizzle-orm';
import { closeDb, getDb } from '../app/.server/db/client';
import { tenantLakes } from '../app/.server/db/schema';
import { ensureTenantLakeSchemas } from '../app/.server/lake';
import { tenantIdBySlug } from '../app/.server/tenants';

const { values } = parseArgs({ options: { tenant: { type: 'string' } } });

try {
  const tenantIds = values.tenant
    ? [await tenantIdBySlug(values.tenant)]
    : (await getDb().select({ tenantId: tenantLakes.tenantId }).from(tenantLakes).where(isNotNull(tenantLakes.catalogInitializedAt))).map(l => l.tenantId);
  for (const tenantId of tenantIds) {
    try {
      await ensureTenantLakeSchemas(tenantId);
      console.log(`${tenantId}：已补建`);
    } catch (e) {
      console.error(`${tenantId}：补建失败：${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`共处理 ${tenantIds.length} 个租户`);
} catch (e) {
  console.error(`补建失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

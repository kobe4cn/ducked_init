// scripts/reset-lake.ts —— 用法：pnpm lake:reset --tenant acme [--yes] [--force]
// 开发 / 演示环境把租户的数据湖清空重来：删除并重建 catalog，删除存储前缀下的全部文件，再重新初始化。
// 该租户有运行中的任务时拒绝；排队的任务保留，重置完成后照常执行。执行前要求再输入一次租户标识确认（--yes 跳过）。
// 生产环境（NODE_ENV=production）须加 --force；生产环境清除租户数据应走删除请求与租户退出
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { getTenantLake } from '../app/.server/lake';
import { resetTenantLake } from '../app/.server/lake-reset';
import { getTenant, tenantIdBySlug } from '../app/.server/tenants';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    yes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

if (!values.tenant) {
  console.error('用法：pnpm lake:reset --tenant <租户标识> [--yes 跳过确认] [--force 生产环境强制执行]');
  process.exit(2);
}

async function confirm(slug: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`此操作不可恢复。请再输入一次租户标识（${slug}）确认：`)).trim() === slug;
  } finally {
    rl.close();
  }
}

try {
  if (process.env.NODE_ENV === 'production' && !values.force) {
    throw new Error('生产环境不能重置数据湖（清除租户数据请走删除请求与租户退出）；确需执行请加 --force');
  }
  const tenantId = await tenantIdBySlug(values.tenant);
  const [tenant, lake] = await Promise.all([getTenant(tenantId), getTenantLake(tenantId)]);
  if (!lake) throw new Error('租户还没有数据湖');
  console.log(`将清空租户「${tenant.name}」（${tenant.slug}）的数据湖：`);
  console.log(`  catalog：${lake.catalogSchema}`);
  console.log(`  存储前缀：${lake.dataPath}（其下全部文件将被删除）`);
  if (!values.yes && !(await confirm(tenant.slug))) throw new Error('输入的租户标识不一致，已取消');

  const { files } = await resetTenantLake(null, tenantId);
  console.log(`已重置：删除 ${files} 个文件，catalog 已重建并重新初始化；排队中的任务将照常执行`);
} catch (e) {
  console.error(`重置失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

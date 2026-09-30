// scripts/migrate-lake.ts —— 用法：pnpm lake:migrate --tenant acme --to s3://crm-lake/platform
//                                 pnpm lake:migrate --all --to s3://crm-lake/platform
// 平台切换存储（本地目录 ⇄ 对象存储、换桶）时，把已开通租户的数据湖搬到新的数据湖根下（<根>/tenants/<租户 ID>/）。
// 这条命令只申请迁移、标记「迁移中」，由调度器（pnpm dispatcher）执行；进度与结果在运营后台的租户页与租户审计日志查看。
// --all 跳过已在目标根下的租户，可以重复执行
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { requestLakeMigration, requestLakeMigrations } from '../app/.server/lake-migration';
import { tenantIdBySlug } from '../app/.server/tenants';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    all: { type: 'boolean', default: false },
    to: { type: 'string' },
  },
});

if (!values.to || !!values.tenant === values.all) {
  console.error('用法：pnpm lake:migrate (--tenant <租户标识> | --all) --to <新的数据湖根，如 s3://bucket/prefix 或本地目录>');
  process.exit(2);
}

try {
  if (values.tenant) {
    const { migration, created } = await requestLakeMigration(null, await tenantIdBySlug(values.tenant), values.to);
    console.log(`${values.tenant}：${created ? '已申请迁移' : '已在迁移中'} ${migration.fromPath} → ${migration.toPath}`);
  } else {
    const { requested, skipped } = await requestLakeMigrations(null, values.to);
    for (const r of requested) console.log(`${r.slug}：已申请迁移 ${r.fromPath} → ${r.toPath}`);
    for (const s of skipped) console.log(`${s.slug}：跳过（${s.reason}）`);
    console.log(`共申请 ${requested.length} 个租户${skipped.length ? `，跳过 ${skipped.length} 个` : ''}；已在目标根下的租户不再列出`);
  }
  console.log('迁移由调度器（pnpm dispatcher）执行，进度与结果见运营后台的租户页；旧位置的文件不会自动删除');
} catch (e) {
  console.error(`申请失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

// scripts/create-tenant.ts —— 用法：npm run tenant:create -- --slug acme --name "示例商贸" --admin-email admin@acme.com
// 运营者开通租户：自动创建默认空间与首个管理员（管理员随后用该邮箱通过 Magic Link 登录）
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { createTenant } from '../app/.server/tenants';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'admin-email': { type: 'string' },
  },
});

if (!values.slug || !values.name || !values['admin-email']) {
  console.error('用法：npm run tenant:create -- --slug <租户标识> --name <租户名称> --admin-email <管理员邮箱>');
  process.exit(2);
}

try {
  const { tenant, space, admin } = await createTenant({ slug: values.slug, name: values.name, adminEmail: values['admin-email'] });
  console.log(`已创建租户 ${tenant.name}（${tenant.slug}，id=${tenant.id}）`);
  console.log(`  默认空间：${space.name}（id=${space.id}）`);
  console.log(`  管理员：${admin.email}`);
} catch (e) {
  const cause = (e as { cause?: { code?: string } }).cause;
  console.error(cause?.code === '23505' ? `租户标识已存在：${values.slug}` : `创建失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

// scripts/browser-lab.ts —— Sandcastle 沙箱里浏览器验收的准备：在 PLATFORM_DATABASE_URL 指向的库（不存在就建）迁移到最新结构，
// 建验收租户 crmlab-smoke 与三个角色的成员 admin@ / eng@ / an@crmlab-smoke.test。可重复跑：库、租户、成员已有就跳过。
// 只建空租户，不造上游数据、不跑同步；Browser check 需要的数据由验收的 agent 在页面上自己建。
// 环境变量由 .sandcastle/main.ts 注入（库名带 _browser_i<n>，与测试库、开发库 crm_platform 都分开）。
// 用法：node --import tsx scripts/browser-lab.ts
import pg from 'pg';
import { closeDb } from '../app/.server/db/client';
import { migratePlatformDb } from '../app/.server/db/migrate';
import { createTenant, tenantIdBySlug } from '../app/.server/tenants';
import { memberOf } from '../test/pipeline/fixtures';

const SLUG = 'crmlab-smoke';
const url = process.env.PLATFORM_DATABASE_URL;
if (!url) {
  console.error('缺少 PLATFORM_DATABASE_URL');
  process.exit(2);
}

const dbName = new URL(url).pathname.slice(1);
const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
await admin.connect();
try {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
} finally {
  await admin.end();
}

try {
  await migratePlatformDb();
  const tenantId = await tenantIdBySlug(SLUG).catch(async () => {
    const { tenant } = await createTenant({ slug: SLUG, name: '验收租户', adminEmail: `admin@${SLUG}.test` });
    return tenant.id;
  });
  await memberOf(tenantId, `eng@${SLUG}.test`, 'data_engineer');
  await memberOf(tenantId, `an@${SLUG}.test`, 'analyst');
  console.log(`验收库 ${dbName} 就绪：租户 ${SLUG}，成员 admin@ / eng@ / an@${SLUG}.test`);
} finally {
  await closeDb();
}

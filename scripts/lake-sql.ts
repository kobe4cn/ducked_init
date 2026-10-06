// scripts/lake-sql.ts —— 测试用：只读挂载某个租户的数据湖执行 SQL，打印结果。
// 用法：node --env-file=.env --import tsx scripts/lake-sql.ts lm "SELECT count(*) FROM silver.\"order\""
import { closeDb } from '../app/.server/db/client';
import { lakeReady, lakeRow, lakeSpecOf } from '../app/.server/lake';
import { openTenantLake } from '../app/.server/pipeline/lake-engine';
import { tenantIdBySlug } from '../app/.server/tenants';

const [slug, ...sqls] = process.argv.slice(2);
const tenantId = await tenantIdBySlug(slug);
if (!tenantId) throw new Error(`没有租户 ${slug}`);
const lake = await lakeRow(tenantId);
if (!lake || !lakeReady(lake)) throw new Error('数据湖没有初始化');
const session = await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 4096, threads: 4 }, undefined, { readOnly: true });
try {
  for (const sql of sqls) {
    console.log(`> ${sql}`);
    console.table((await session.con.runAndReadAll(sql)).getRowObjectsJson());
  }
} finally {
  session.close();
  await closeDb();
}

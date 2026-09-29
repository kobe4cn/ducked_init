// app/.server/db/client.ts —— 平台 PostgreSQL 连接（进程内单例），连接串来自 PLATFORM_DATABASE_URL
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

let db: (NodePgDatabase & { $client: pg.Pool }) | undefined;

export function getDb() {
  if (db) return db;
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) throw new Error('缺少环境变量 PLATFORM_DATABASE_URL（平台 PostgreSQL 连接串）');
  db = drizzle({ client: new pg.Pool({ connectionString: url }) });
  return db;
}

export type Db = ReturnType<typeof getDb>;

export async function closeDb() {
  await db?.$client.end();
  db = undefined;
}

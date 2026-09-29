// app/.server/db/migrate.ts —— 把 drizzle/ 下的迁移应用到平台 PostgreSQL
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client';

export async function migratePlatformDb() {
  await migrate(getDb(), { migrationsFolder: new URL('../../../drizzle', import.meta.url).pathname });
}

// test/global-setup.ts —— 测试用平台 PG：不存在就建库，然后迁移到最新结构
import pg from 'pg';
import { closeDb } from '../app/.server/db/client';
import { migratePlatformDb } from '../app/.server/db/migrate';

export default async function setup() {
  const url = new URL(process.env.PLATFORM_DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await admin.end();
  await migratePlatformDb();
  await closeDb();
}

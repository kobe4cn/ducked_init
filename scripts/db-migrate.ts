// scripts/db-migrate.ts —— 用法：npm run db:migrate —— 升级平台 PostgreSQL 元数据结构
import { closeDb } from '../app/.server/db/client';
import { migratePlatformDb } from '../app/.server/db/migrate';

await migratePlatformDb();
await closeDb();
console.log('平台元数据库已迁移到最新版本');

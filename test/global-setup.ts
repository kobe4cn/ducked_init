// test/global-setup.ts —— 测试用平台 PG：不存在就建库，然后迁移到最新结构；同时只允许一个 vitest 使用测试库
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { closeDb } from '../app/.server/db/client';
import { migratePlatformDb } from '../app/.server/db/migrate';

/** 两个 vitest 同时跑会互相清表、清数据湖目录，报出与代码无关的失败，所以第二个直接退出 */
function lockTestDb(dbName: string) {
  const file = join(tmpdir(), `${dbName}.vitest.pid`);
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) {
      throw new Error(`另一个 vitest（pid ${pid}）正在使用测试库 ${dbName}：等它结束再跑（锁文件 ${file}）`);
    }
    writeFileSync(file, String(process.pid));
  }
  return () => rmSync(file, { force: true });
}

export default async function setup() {
  const url = new URL(process.env.PLATFORM_DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const unlock = lockTestDb(dbName);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
  await admin.end();
  await migratePlatformDb();
  await closeDb();
  return unlock;
}

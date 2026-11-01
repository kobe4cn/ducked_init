// test/global-setup.ts —— 测试用平台 PG：每个 worker 一个库（基准库名加 _w<i>，见 test/setup-env.ts），不存在就建库，
// 然后迁移到最新结构；同时只允许一个 vitest 使用这组测试库。旧库不删：库里租户的 catalog 角色 lake_<id> 是集群级的，删库会留下孤儿角色
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { closeDb } from '../app/.server/db/client';
import { migratePlatformDb } from '../app/.server/db/migrate';
import { dbNameOf, withDbSuffix } from './setup-env';

/** 两个 vitest 同时跑会互相清表、清数据湖目录，报出与代码无关的失败，所以第二个直接退出（锁的是基准库名，即整组库） */
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

export default async function setup(project: TestProject) {
  const baseUrl = process.env.PLATFORM_DATABASE_URL!;
  const unlock = lockTestDb(dbNameOf(baseUrl));
  const admin = new pg.Client({ connectionString: Object.assign(new URL(baseUrl), { pathname: '/postgres' }).toString() });
  await admin.connect();
  try {
    for (let i = 1; i <= project.config.maxWorkers; i++) {
      const url = withDbSuffix(baseUrl, `_w${i}`);
      const dbName = dbNameOf(url);
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (!rowCount) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      // getDb 第一次调用时读 PLATFORM_DATABASE_URL 并缓存连接池：每个库迁移完先关掉
      process.env.PLATFORM_DATABASE_URL = url;
      await migratePlatformDb();
      await closeDb();
    }
  } finally {
    process.env.PLATFORM_DATABASE_URL = baseUrl;
    await admin.end();
  }
  return unlock;
}

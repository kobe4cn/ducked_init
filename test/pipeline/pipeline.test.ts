// 租户流水线接缝：开通租户 → 入队任务 → 调度器派发到独立工作进程 → 读取任务结果。数据用 seed 造数夹具生成
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { getTenantLake } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { claimNextTask, enqueueTask, finishTask, listTasks } from '../../app/.server/tasks';
import { setTenantQuota } from '../../app/.server/tenants';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('开通租户时初始化数据湖', () => {
  it('每个租户有独立的存储前缀与 catalog schema，开通后即初始化完成', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const a = (await getTenantLake(acme))!;
    const b = (await getTenantLake(globex))!;

    expect(a.dataPath).toBe(join(process.env.PLATFORM_LAKE_URI!, 'tenants', acme) + '/');
    expect(existsSync(a.dataPath)).toBe(true);
    expect(a.catalogInitialized).toBe(true);
    expect(b.catalogInitialized).toBe(true);
    expect(a.catalogSchema).not.toBe(b.catalogSchema);
    expect(a.dataPath).not.toBe(b.dataPath);
  });
});

describe('任务在独立进程中按租户配额运行', () => {
  it('工作进程是独立进程，DuckDB 的内存上限与线程数取自租户配额', async () => {
    const acme = await newTenant('acme');
    await setTenantQuota(null, acme, { memoryLimitMb: 300, threads: 1, maxConcurrentTasks: 1 });
    const first = await runTask(acme, 'lake.inventory');
    const second = await runTask(acme, 'lake.inventory');

    expect(first.status).toBe('succeeded');
    expect(first.result).toMatchObject({ engine: { memoryLimit: '300.0 MiB', threads: 1 }, tables: [] });
    expect(first.workerPid).not.toBe(process.pid);
    expect(second.workerPid).not.toBe(first.workerPid);
    expect((await listTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('任务出错时记为失败并保留错误信息', async () => {
    const acme = await newTenant('acme');
    const task = await runTask(acme, 'demo.seed', { customers: -1 });
    expect(task.status).toBe('failed');
    expect(task.error).toContain('customers');
  });
});

describe('租户数据互相隔离', () => {
  it('两个租户存在同名表时，各自只看到自己的数据', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    expect((await runTask(acme, 'demo.seed', { customers: 200 })).status).toBe('succeeded');
    expect((await runTask(globex, 'demo.seed', { customers: 50 })).status).toBe('succeeded');

    const tablesOf = async (tenantId: string) =>
      Object.fromEntries(((await runTask(tenantId, 'lake.inventory')).result!.tables as { name: string; rows: number }[]).map(t => [t.name, t.rows]));
    const a = await tablesOf(acme);
    const b = await tablesOf(globex);
    expect(Object.keys(a).sort()).toEqual(['customers', 'orders']);
    expect(Object.keys(b).sort()).toEqual(['customers', 'orders']);
    expect(a.customers).toBe(200);
    expect(b.customers).toBe(50);
    expect(a.orders).not.toBe(b.orders);
  });

  it('任务进程读不到其他租户的存储前缀、catalog 与平台元数据，也不能解除限制', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const acmeLake = (await getTenantLake(acme))!;

    // 以工作进程的方式打开 globex 的数据湖：领取任务得到的就是工作进程拿到的全部凭据
    const { id } = await enqueueTask(globex, 'lake.inventory');
    const task = (await claimNextTask())!;
    expect(task.id).toBe(id);
    expect(JSON.stringify(task)).not.toContain(acmeLake.catalogSchema);
    const { con, close } = await openTenantLake(task.lake, task.limits);
    try {
      const denied = async (sql: string) => (await con.run(sql).then(() => 'allowed', e => (e as Error).message));
      expect(await denied(`SELECT count(*) FROM read_parquet('${acmeLake.dataPath}**/*.parquet')`)).toMatch(/Permission Error/);
      expect(await denied(`SELECT * FROM postgres_query('__ducklake_metadata_lake', 'SELECT count(*) FROM ${acmeLake.catalogSchema}.ducklake_table')`)).toMatch(/permission denied/);
      expect(await denied(`SELECT * FROM postgres_query('__ducklake_metadata_lake', 'SELECT count(*) FROM platform.sessions')`)).toMatch(/permission denied/);
      expect(await denied(`ATTACH '${acmeLake.dataPath}x.duckdb' AS other`)).toMatch(/Permission Error/);
      expect(await denied(`SET enable_external_access = true`)).toMatch(/locked/);
    } finally {
      close();
      await finishTask(task.id, { result: {} });
    }
  });
});

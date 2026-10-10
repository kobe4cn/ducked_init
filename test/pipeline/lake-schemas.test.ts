// test/pipeline/lake-schemas.test.ts —— 名字固定的 schema 与平台表（ADR-0020）：开通租户 / 重置数据湖 / pnpm lake:ensure → 湖里建好
// gold、silver、silver_records 与三张平台表 → 并发数为 4 的租户在空的结果层上同时跑多个 gold.dsl，提交不冲突、全部成功
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { resetTenantLake } from '../../app/.server/lake-reset';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { enqueueTask, getTask } from '../../app/.server/tasks';
import { setTenantQuota } from '../../app/.server/tenants';
import { resetDb, runCli } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 在本租户数据湖里执行 SQL */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

const schemasOf = async (tenantId: string) => (await onLake<{ name: string }>(tenantId, `
  SELECT schema_name AS name FROM information_schema.schemata WHERE catalog_name = 'lake' ORDER BY ALL`)).map(s => s.name);
const tablesOf = async (tenantId: string) => (await onLake<{ name: string }>(tenantId, `
  SELECT table_schema || '.' || table_name AS name FROM information_schema.tables WHERE table_catalog = 'lake' ORDER BY ALL`)).map(t => t.name);
const mergeColumnsOf = async (tenantId: string) => (await onLake<{ name: string }>(tenantId, `
  SELECT column_name AS name FROM information_schema.columns WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name = '_merges'`)).map(c => c.name);

const PLATFORM_TABLES = ['silver._assertion_runs', 'silver._merges', 'silver._quarantine'];

/**
 * 只建 gold.dsl 读到的标准层表（silver.customer 与身份打通结果），结果层保持空的；
 * 并发数为 4 时一次入队 6 个指标与标签，由调度器跑完，返回各任务与同时运行的最大任务数
 */
async function runDslConcurrently(tenantId: string) {
  await onLake(tenantId, `
    CREATE TABLE silver.customer AS SELECT 'c' || i AS customer_id FROM range(10) t(i);
    CREATE TABLE silver._identities AS SELECT 'c' || i AS consumer_id FROM range(10) t(i)`);
  const queued = [];
  for (let i = 0; i < 6; i++) {
    queued.push(await enqueueTask(tenantId, 'gold.dsl', {
      kind: i % 2 ? 'tag' : 'metric', key: `k${i}`, asOf: '2024-07-01',
      sql: `SELECT consumer_id, ${i} AS value FROM silver._identities`, entities: ['customer'],
    }));
  }
  await createDispatcher({ maxWorkers: 6 }).runUntilIdle();
  const tasks = await Promise.all(queued.map(t => getTask(t.id)));
  const overlap = Math.max(...tasks.map(a => tasks.filter(b => b!.startedAt! < a!.finishedAt! && a!.startedAt! < b!.finishedAt!).length));
  return { tasks, overlap };
}

/** 开通租户并把最多同时运行的任务调到 4 */
async function concurrentTenant() {
  const acme = await newTenant('acme');
  await setTenantQuota(null, acme, { memoryLimitMb: 256, threads: 1, maxConcurrentTasks: 4 });
  return acme;
}

describe('初始化数据湖时建好固定的 schema 与平台表', () => {
  it('新租户的湖里有 gold、silver、silver_records 与三张平台表，_merges 带 scheme 列；身份打通的表不预建', async () => {
    const acme = await newTenant('acme');
    expect(await schemasOf(acme)).toEqual(expect.arrayContaining(['gold', 'silver', 'silver_records']));
    expect(await tablesOf(acme)).toEqual(PLATFORM_TABLES);
    expect(await mergeColumnsOf(acme)).toContain('scheme');
  });

  it('并发数为 4 的租户在空的结果层上同时跑 6 个指标与标签，全部成功', async () => {
    const acme = await concurrentTenant();
    const { tasks, overlap } = await runDslConcurrently(acme);
    expect(tasks.map(t => t!.status)).toEqual(Array(6).fill('succeeded'));
    expect(overlap).toBeGreaterThan(1);
    expect((await tablesOf(acme)).filter(t => t.startsWith('gold.'))).toHaveLength(6);
  });

  it('重置数据湖之后同样全部成功', async () => {
    const acme = await concurrentTenant();
    await runDslConcurrently(acme);
    await resetTenantLake(null, acme);
    expect(await tablesOf(acme)).toEqual(PLATFORM_TABLES);

    const { tasks, overlap } = await runDslConcurrently(acme);
    expect(tasks.map(t => t!.status)).toEqual(Array(6).fill('succeeded'));
    expect(overlap).toBeGreaterThan(1);
  });
});

describe('命令行 pnpm lake:ensure', () => {
  it('给缺少固定 schema、平台表或 scheme 列的已有租户补建，可重复执行；不给 --tenant 时处理全部租户', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const strip = (tenantId: string) => onLake(tenantId, `
      DROP TABLE silver._assertion_runs; DROP TABLE silver._quarantine; ALTER TABLE silver._merges DROP COLUMN scheme; DROP SCHEMA gold`);
    await strip(acme);
    await strip(globex);

    const one = await runCli('scripts/ensure-lake-schemas.ts', ['--tenant', 'acme']);
    expect(one.code).toBe(0);
    expect(await tablesOf(acme)).toEqual(PLATFORM_TABLES);
    expect(await schemasOf(acme)).toContain('gold');
    expect(await mergeColumnsOf(acme)).toContain('scheme');
    expect(await tablesOf(globex)).toEqual(['silver._merges']);

    const all = await runCli('scripts/ensure-lake-schemas.ts', []);
    expect(all).toMatchObject({ code: 0, stdout: expect.stringContaining('共处理 2 个租户') });
    expect(await tablesOf(globex)).toEqual(PLATFORM_TABLES);
    expect(await schemasOf(globex)).toContain('gold');
  });
});

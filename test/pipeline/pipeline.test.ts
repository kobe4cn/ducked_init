// 租户流水线接缝：开通租户 → 入队任务 → 调度器派发到独立工作进程 → 读取任务结果。数据用 seed 造数夹具生成
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { getTenantLake } from '../../app/.server/lake';
import { openTenantLake, type LakeSpec } from '../../app/.server/pipeline/lake-engine';
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

/** 不加限制地列出存储前缀下的文件：确认数据确实落在那里，越权读取被拒才有意义 */
async function filesUnder(lake: LakeSpec, prefix: string) {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    if (lake.s3) {
      const s = lake.s3;
      await con.run(`INSTALL httpfs; LOAD httpfs; CREATE SECRET (TYPE s3, KEY_ID '${s.key}', SECRET '${s.secret}', REGION '${s.region}',
        ENDPOINT '${s.endpoint}', URL_STYLE '${s.urlStyle}', USE_SSL ${s.useSsl})`);
    }
    return (await con.runAndReadAll(`SELECT file FROM glob('${prefix}**')`)).getRowObjectsJson().map(r => r.file as string);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

/** 以工作进程的方式打开租户的数据湖：领取任务得到的就是工作进程拿到的全部凭据 */
async function openAsWorker(tenantId: string) {
  const { id } = await enqueueTask(tenantId, 'lake.inventory');
  const task = (await claimNextTask())!;
  expect(task.id).toBe(id);
  const { con, close } = await openTenantLake(task.lake, task.limits);
  const denied = async (sql: string) => (await con.run(sql).then(() => 'allowed', e => (e as Error).message));
  return {
    task,
    con,
    denied,
    async close() {
      close();
      await finishTask(task.id, { result: {} });
    },
  };
}

// 本地目录总是测；对象存储在设置了 TEST_S3_LAKE_URI 时测（见 vitest.config.ts）
const STORAGES = [
  { storage: '本地目录', lakeUri: process.env.PLATFORM_LAKE_URI! },
  { storage: '对象存储', lakeUri: process.env.TEST_S3_LAKE_URI },
];

for (const { storage, lakeUri } of STORAGES) {
  describe.skipIf(!lakeUri)(`租户数据互相隔离（${storage}）`, () => {
    const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
    beforeAll(() => { process.env.PLATFORM_LAKE_URI = lakeUri; });
    afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

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
      expect(acmeLake.dataPath.startsWith(lakeUri!)).toBe(true);

      const worker = await openAsWorker(globex);
      try {
        const { task, denied } = worker;
        expect(await filesUnder(task.lake, acmeLake.dataPath)).not.toEqual([]);
        expect(JSON.stringify(task)).not.toContain(acmeLake.catalogSchema);
        expect(await denied(`SELECT count(*) FROM read_parquet('${acmeLake.dataPath}**/*.parquet')`)).toMatch(/Permission Error/);
        expect(await denied(`SELECT * FROM glob('${acmeLake.dataPath}*')`)).toMatch(/Permission Error/);
        expect(await denied(`COPY (SELECT 1) TO '${acmeLake.dataPath}evil.parquet'`)).toMatch(/Permission Error/);
        expect(await denied(`SELECT * FROM postgres_query('__ducklake_metadata_lake', 'SELECT count(*) FROM ${acmeLake.catalogSchema}.ducklake_table')`)).toMatch(/permission denied/);
        expect(await denied(`SELECT * FROM postgres_query('__ducklake_metadata_lake', 'SELECT count(*) FROM platform.sessions')`)).toMatch(/permission denied/);
        expect(await denied(`ATTACH '${acmeLake.dataPath}x.duckdb' AS other`)).toMatch(/Permission Error/);
        expect(await denied(`SET enable_external_access = true`)).toMatch(/locked/);
      } finally {
        await worker.close();
      }
    });
  });
}

// 对象存储上工作进程拿到的是平台共用的 S3 密钥（ADR-0008），以下绕路也必须走不通
describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储上的越权访问', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('不能用路径穿越、直连存储服务的地址读写其他租户的数据，也读不出 S3 密钥', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const acmeLake = (await getTenantLake(acme))!;

    const worker = await openAsWorker(globex);
    try {
      const { task, con, denied } = worker;
      const s3 = task.lake.s3!;
      const [acmeFile] = await filesUnder(task.lake, acmeLake.dataPath);
      expect(acmeFile).toBeDefined();

      // 带 .. 的路径能通过 DuckDB 的 allowed_directories 检查，只靠存储服务拒绝（见 ADR-0008）
      const viaTraversal = `${task.lake.dataPath}../${acme}/`;
      expect(await denied(`SELECT count(*) FROM read_parquet('${viaTraversal}${acmeFile.slice(acmeLake.dataPath.length)}')`)).not.toBe('allowed');
      expect(await denied(`COPY (SELECT 1) TO '${viaTraversal}evil.parquet'`)).not.toBe('allowed');
      const viaEndpoint = acmeFile.replace('s3://', `${s3.useSsl ? 'https' : 'http'}://${s3.endpoint}/`);
      expect(await denied(`SELECT count(*) FROM read_parquet('${viaEndpoint}')`)).toMatch(/Permission Error/);
      expect(await filesUnder(task.lake, acmeLake.dataPath)).not.toContain(`${acmeLake.dataPath}evil.parquet`);

      const secrets = (await con.runAndReadAll('SELECT secret_string FROM duckdb_secrets()')).getRowObjectsJson();
      expect(JSON.stringify(secrets)).not.toContain(s3.secret);
    } finally {
      await worker.close();
    }
  });
});

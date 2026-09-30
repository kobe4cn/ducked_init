// 租户流水线接缝：开通租户 → 入队任务 → 调度器派发到独立工作进程 → 读取任务结果。数据用 seed 造数夹具生成
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tenantLakes } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { deleteTenantS3Account } from '../../app/.server/s3-accounts';
import { getTenantLake } from '../../app/.server/lake';
import { openTenantLake, type LakeSpec } from '../../app/.server/pipeline/lake-engine';
import { claimNextTask, enqueueTask, finishTask, getTask, listTasks } from '../../app/.server/tasks';
import { initTenantLake, setTenantQuota } from '../../app/.server/tenants';
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

/** 不加 DuckDB 限制地执行 SQL；给了 S3 凭据时用它访问对象存储。返回执行结果，或被拒绝时的错误信息 */
async function unlocked<T>(s3: LakeSpec['s3'], run: (con: DuckDBConnection) => Promise<T>) {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    if (s3) {
      await con.run(`INSTALL httpfs; LOAD httpfs; CREATE SECRET (TYPE s3, KEY_ID '${s3.key}', SECRET '${s3.secret}', REGION '${s3.region}',
        ENDPOINT '${s3.endpoint}', URL_STYLE '${s3.urlStyle}', USE_SSL ${s3.useSsl})`);
    }
    return await run(con);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

/** 平台账号的 S3 凭据（测试用它确认数据确实落在对象存储上）；本地目录时为 undefined */
const platformS3 = (lake: LakeSpec): LakeSpec['s3'] => lake.s3 && { ...lake.s3, key: process.env.S3_ACCESS_KEY!, secret: process.env.S3_SECRET_KEY! };

/** 用平台账号列出存储前缀下的文件：确认数据确实落在那里，越权读取被拒才有意义 */
const filesUnder = (lake: LakeSpec, prefix: string) =>
  unlocked(platformS3(lake), async con =>
    (await con.runAndReadAll(`SELECT file FROM glob('${prefix}**')`)).getRowObjectsJson().map(r => r.file as string));

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

// 对象存储上的隔离由存储服务执行：工作进程拿到的是本租户的 S3 账号，只能访问本租户的前缀（ADR-0008）
describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储上的越权访问', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('工作进程拿到的是本租户的 S3 凭据，不含平台账号的密钥', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const worker = await openAsWorker(globex);
    try {
      const s3 = worker.task.lake.s3!;
      expect(s3.key).not.toBe(process.env.S3_ACCESS_KEY);
      expect(JSON.stringify(worker.task)).not.toContain(process.env.S3_SECRET_KEY);
      const acmeWorker = await openAsWorker(acme);
      await acmeWorker.close();
      expect(acmeWorker.task.lake.s3!.key).not.toBe(s3.key);
    } finally {
      await worker.close();
    }
  });

  it('即使不锁 DuckDB 配置，租户凭据也读写、列不到其他租户的前缀，路径穿越同样失败', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const acmeLake = (await getTenantLake(acme))!;

    const worker = await openAsWorker(globex);
    await worker.close();
    const { lake } = worker.task;
    const [acmeFile] = await filesUnder(lake, acmeLake.dataPath);
    expect(acmeFile).toBeDefined();
    const bucket = acmeLake.dataPath.split('/').slice(0, 3).join('/');
    const viaTraversal = `${lake.dataPath}../${acme}/`;

    const attempts = await unlocked(lake.s3, async con => {
      const tryRun = (sql: string) => con.run(sql).then(() => 'allowed', e => (e as Error).message);
      return {
        ownWrite: await tryRun(`COPY (SELECT 1 AS x) TO '${lake.dataPath}probe.parquet'`),
        ownRead: await tryRun(`SELECT * FROM read_parquet('${lake.dataPath}probe.parquet')`),
        ownList: await tryRun(`SELECT * FROM glob('${lake.dataPath}*')`),
        read: await tryRun(`SELECT count(*) FROM read_parquet('${acmeFile}')`),
        write: await tryRun(`COPY (SELECT 1 AS x) TO '${acmeLake.dataPath}evil.parquet'`),
        list: await tryRun(`SELECT * FROM glob('${acmeLake.dataPath}*')`),
        listBucket: await tryRun(`SELECT * FROM glob('${bucket}/*')`),
        traversalRead: await tryRun(`SELECT count(*) FROM read_parquet('${viaTraversal}${acmeFile.slice(acmeLake.dataPath.length)}')`),
        traversalWrite: await tryRun(`COPY (SELECT 1 AS x) TO '${viaTraversal}evil2.parquet'`),
      };
    });
    expect(attempts).toMatchObject({ ownWrite: 'allowed', ownRead: 'allowed', ownList: 'allowed' });
    // 由存储服务按租户账号的前缀策略拒绝
    for (const k of ['read', 'write', 'list', 'listBucket'] as const) expect(attempts[k], k).toMatch(/AccessDenied/);
    // 带 .. 的路径：DuckDB 原样发出，存储服务拒绝（SeaweedFS 不接受路径里的 ..，与凭据无关，见 ADR-0008）
    for (const k of ['traversalRead', 'traversalWrite'] as const) expect(attempts[k], k).toMatch(/HTTP 403|HTTP code 403|HTTP 400|HTTP code 400/);
    const acmeFiles = await filesUnder(lake, acmeLake.dataPath);
    expect(acmeFiles).not.toContain(`${acmeLake.dataPath}evil.parquet`);
    expect(acmeFiles).not.toContain(`${acmeLake.dataPath}evil2.parquet`);
  });

  it('本功能上线前开通、还没有对象存储账号的租户不派发任务，运营者补建账号后恢复运行并记入审计', async () => {
    const acme = await newTenant('acme');
    expect((await runTask(acme, 'demo.seed', { customers: 20 })).status).toBe('succeeded');
    // 模拟上线前开通的租户：数据湖已初始化，但存储服务上没有它的账号
    await deleteTenantS3Account(acme);
    await getDb().update(tenantLakes).set({ s3AccessKey: null, s3SecretKey: null }).where(eq(tenantLakes.tenantId, acme));
    expect(await getTenantLake(acme)).toMatchObject({ catalogInitialized: true, ready: false, s3User: { ready: false } });

    const { id } = await enqueueTask(acme, 'lake.inventory');
    await createDispatcher({ maxWorkers: 1 }).runUntilIdle();
    expect((await getTask(id)).status).toBe('queued');

    await initTenantLake(null, acme);
    await initTenantLake(null, acme);
    expect(await getTenantLake(acme)).toMatchObject({ ready: true, s3User: { name: `lake-${acme}`, ready: true } });
    await createDispatcher({ maxWorkers: 1 }).runUntilIdle();
    const task = await getTask(id);
    expect(task.status).toBe('succeeded');
    expect((task.result!.tables as { name: string; rows: number }[]).find(t => t.name === 'customers')?.rows).toBe(20);

    // 开通时建一次，补建一次；重复初始化不再新建
    const audit = await listAuditLogs(acme);
    const created = `lake-${acme}，只能访问 ${(await getTenantLake(acme))!.dataPath}`;
    expect(audit.filter(l => l.action === '建立对象存储账号').map(l => l.summary)).toEqual([created, created]);
    expect(audit.filter(l => l.action === '初始化数据湖')).toHaveLength(2);
  });

  it('锁定配置的工作进程也不能直连存储服务的地址，读不出 S3 密钥', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const acmeLake = (await getTenantLake(acme))!;

    const worker = await openAsWorker(globex);
    try {
      const { task, con, denied } = worker;
      const s3 = task.lake.s3!;
      const [acmeFile] = await filesUnder(task.lake, acmeLake.dataPath);
      const viaEndpoint = acmeFile.replace('s3://', `${s3.useSsl ? 'https' : 'http'}://${s3.endpoint}/`);
      expect(await denied(`SELECT count(*) FROM read_parquet('${viaEndpoint}')`)).toMatch(/Permission Error/);

      const secrets = (await con.runAndReadAll('SELECT secret_string FROM duckdb_secrets()')).getRowObjectsJson();
      expect(JSON.stringify(secrets)).not.toContain(s3.secret);
    } finally {
      await worker.close();
    }
  });
});

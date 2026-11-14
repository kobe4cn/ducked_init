// 租户流水线接缝：开通租户 → 入队任务 → 调度器派发到独立工作进程 → 读取任务结果。数据用 seed 造数夹具生成
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tenantLakes } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { deleteTenantS3Account, issueTenantS3Account } from '../../app/.server/s3-accounts';
import { getTenantLake } from '../../app/.server/lake';
import { openTenantLake, type LakeSpec } from '../../app/.server/pipeline/lake-engine';
import { isS3 } from '../../app/.server/lake-storage';
import { claimNextTask, enqueueTask, finishTask, getTask, listTasks } from '../../app/.server/tasks';
import { initTenantLake, setTenantQuota } from '../../app/.server/tenants';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';

/** 本文件的已知差距（用 it.fails 标预期失败，改好后会变红，提醒从清单删掉；写法照 test/retrieval-golden.test.ts） */
const KNOWN_GAPS = new Map<string, string>([
]);

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
    await setTenantQuota(null, acme, { memoryLimitMb: 300, threads: 1, maxConcurrentTasks: 1, maxUploadMb: 100 });
    const first = await runTask(acme, 'lake.inventory');
    const second = await runTask(acme, 'lake.inventory');

    expect(first.status).toBe('succeeded');
    expect(first.result).toMatchObject({
      engine: { memoryLimit: '300.0 MiB', threads: 1 },
      tables: ['silver._assertion_runs', 'silver._merges', 'silver._quarantine'].map(name => ({ name, rows: 0 })),
    });
    expect(first.workerPid).not.toBe(process.pid);
    expect(second.workerPid).not.toBe(first.workerPid);
    expect((await listTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('入队时参数不合法直接报错，不进队列（文案与工作进程里的一致）', async () => {
    const acme = await newTenant('acme');
    await expect(enqueueTask(acme, 'demo.seed', { customers: -1 })).rejects.toThrow('参数 customers 必须是 1 到 1000000 之间的整数');
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

/** 存储前缀下的数据文件（不含占位对象 .keep） */
const parquetUnder = async (lake: LakeSpec, prefix: string) => (await filesUnder(lake, prefix)).filter(f => f.endsWith('.parquet'));

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
        Object.fromEntries(((await runTask(tenantId, 'lake.inventory')).result!.tables as { name: string; rows: number }[])
          .filter(t => !t.name.startsWith('silver._')).map(t => [t.name, t.rows]));
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
      // 对象存储上是独占的桶（ADR-0008），本地目录是 <根>/tenants/<租户 ID>/
      if (isS3(lakeUri!)) expect(acmeLake.dataPath).toBe(`s3://lake-${acme}/`);
      else expect(acmeLake.dataPath.startsWith(lakeUri!)).toBe(true);

      const worker = await openAsWorker(globex);
      try {
        const { task, denied } = worker;
        expect(await parquetUnder(task.lake, acmeLake.dataPath)).not.toEqual([]);
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

// 对象存储上的隔离由存储服务执行：工作进程拿到的是本租户的 S3 账号，只能访问本租户的桶（ADR-0008）
describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储上的越权访问', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('开通后租户的存储前缀下即有占位对象 .keep，还没有数据时也能在存储服务上看到这个前缀', async () => {
    const acme = await newTenant('acme');
    const worker = await openAsWorker(acme);
    await worker.close();
    expect(await filesUnder(worker.task.lake, worker.task.lake.dataPath)).toEqual([`${worker.task.lake.dataPath}.keep`]);
  });

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

  it('即使不锁 DuckDB 配置，租户凭据也读写、列不到其他租户的桶', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const acmeLake = (await getTenantLake(acme))!;

    const worker = await openAsWorker(globex);
    await worker.close();
    const { lake } = worker.task;
    const [acmeFile] = await parquetUnder(lake, acmeLake.dataPath);
    expect(acmeFile).toBeDefined();

    const attempts = await unlocked(lake.s3, async con => {
      const tryRun = (sql: string) => con.run(sql).then(() => 'allowed', e => (e as Error).message);
      return {
        ownWrite: await tryRun(`COPY (SELECT 1 AS x) TO '${lake.dataPath}probe.parquet'`),
        ownRead: await tryRun(`SELECT * FROM read_parquet('${lake.dataPath}probe.parquet')`),
        ownList: await tryRun(`SELECT * FROM glob('${lake.dataPath}*')`),
        read: await tryRun(`SELECT count(*) FROM read_parquet('${acmeFile}')`),
        write: await tryRun(`COPY (SELECT 1 AS x) TO '${acmeLake.dataPath}evil.parquet'`),
        list: await tryRun(`SELECT * FROM glob('${acmeLake.dataPath}*')`),
      };
    });
    expect(attempts).toMatchObject({ ownWrite: 'allowed', ownRead: 'allowed', ownList: 'allowed' });
    // 由存储服务按租户账号的桶策略拒绝：跨桶读写与列出都是 403（每租户一桶后前缀条件与路径穿越退场，ADR-0008）
    for (const k of ['read', 'write', 'list'] as const) expect(attempts[k], k).toMatch(/AccessDenied/);
    const acmeFiles = await filesUnder(lake, acmeLake.dataPath);
    expect(acmeFiles).not.toContain(`${acmeLake.dataPath}evil.parquet`);
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
      const [acmeFile] = await parquetUnder(task.lake, acmeLake.dataPath);
      const viaEndpoint = acmeFile.replace('s3://', `${s3.useSsl ? 'https' : 'http'}://${s3.endpoint}/`);
      expect(await denied(`SELECT count(*) FROM read_parquet('${viaEndpoint}')`)).toMatch(/Permission Error/);

      const secrets = (await con.runAndReadAll('SELECT secret_string FROM duckdb_secrets()')).getRowObjectsJson();
      expect(JSON.stringify(secrets)).not.toContain(s3.secret);
    } finally {
      await worker.close();
    }
  });

  // #560：完整测试里多个 worker 同时建删租户账号（resetDb / newTenant），每次 IAM 写都让存储服务网关重载整份内存里的
  // IAM 配置，重载窗口内已有租户的 ListBucket 前缀隔离毫秒级失效（list 单个请求被放行，read / write / 列桶根仍被拒，
  // 同一连接立即重试即恢复拒绝——存储里的策略文档在泄露当下读回是完好的，排除丢更新；10/10 次运行复现，全在
  // SeaweedFS 4.47 上）。默认跳过：并发改写打乱的是全局 IAM，会把其他 worker 的 S3 用例一起搞成偶发失败（等于自己
  // 制造 #560）。#569 把本地与 CI 统一到 4.50 后不再复现（含把 IAM 配置臃肿成 #621 之前的状态再压），保留用例继续把关
  const gap = KNOWN_GAPS.get('iam-concurrent');
  const iamStress = it.skipIf(!process.env.CRM_TEST_IAM_STRESS);
  (gap ? iamStress.fails : iamStress)(
    `并发建删账号期间，已有租户的凭据仍读写、列不到其他租户的前缀${gap ? `（已知差距：${gap}）` : ''}`,
    async () => {
      const acme = await newTenant('acme');
      const globex = await newTenant('globex');
      await runTask(acme, 'demo.seed', { customers: 20 });
      const acmeLake = (await getTenantLake(acme))!;

      const worker = await openAsWorker(globex);
      await worker.close();
      const { lake } = worker.task;
      const [acmeFile] = await parquetUnder(lake, acmeLake.dataPath);
      expect(acmeFile).toBeDefined();
      const bucket = acmeLake.dataPath.split('/').slice(0, 3).join('/');

      // 压测：8 路各对一次性账号建删 10 轮（照 sources.test.ts「并发建源端账号不报错」），每轮都是多次整份 IAM 配置
      // 读改写；另加 180 s 墙钟上限——并发下 IAM 延时波动大（同样 8×10 轮实测 340 s 到 480 s+），不设上限本用例
      // 会偶发超时。一次性 tenantId 不进 tenant_lakes，resetDb 删不到，每路 finally 兜底再删一次
      let stressDone = false;
      const stressDeadline = Date.now() + 180_000;
      const stress = Promise.all(Array.from({ length: 8 }, async () => {
        const id = randomUUID();
        const dataPath = `${process.env.PLATFORM_LAKE_URI}/tenants/${id}/`;
        try {
          for (let i = 0; i < 10 && Date.now() < stressDeadline; i++) {
            await issueTenantS3Account(id, dataPath);
            await deleteTenantS3Account(id);
          }
        } finally {
          await deleteTenantS3Account(id).catch(() => {});
        }
      })).finally(() => { stressDone = true; });

      // 探测：压测期间用 globex 的凭据在同一个连接上串行读写、列出 acme 的前缀，每一轮都应仍被前缀策略拒绝
      const cycles = await unlocked(lake.s3, async con => {
        const tryRun = (sql: string) => con.run(sql).then(() => 'allowed', e => (e as Error).message);
        const probed: { i: number; read: string; write: string; list: string; listBucket: string }[] = [];
        for (let i = 0; !stressDone; i++) {
          probed.push({
            i,
            read: await tryRun(`SELECT count(*) FROM read_parquet('${acmeFile}')`),
            write: await tryRun(`COPY (SELECT 1 AS x) TO '${acmeLake.dataPath}evil.parquet'`),
            list: await tryRun(`SELECT * FROM glob('${acmeLake.dataPath}*')`),
            listBucket: await tryRun(`SELECT * FROM glob('${bucket}/*')`),
          });
        }
        return probed;
      });
      await stress;
      expect(cycles.length, '压测期间至少完成一轮探测').toBeGreaterThan(0);
      // 列出被放行的探测（第几轮、哪种操作、返回什么），方便对照时序判断根因
      const leaked = cycles.flatMap(({ i, ...attempts }) =>
        Object.entries(attempts).filter(([, r]) => !/AccessDenied/.test(r)).map(([k, r]) => `第${i}轮 ${k}: ${r}`));
      expect(leaked, '压测期间被放行的探测').toEqual([]);
      expect(await filesUnder(lake, acmeLake.dataPath)).not.toContain(`${acmeLake.dataPath}evil.parquet`);
    },
    // 单独放宽本用例：准备（建租户、造数）加压测（8 路 × 最多 10 轮、180 s 封顶）加收尾，实测最慢 ~8 分钟
    600_000,
  );
});

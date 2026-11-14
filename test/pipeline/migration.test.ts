// 数据湖迁移存储的接缝：运营者申请迁移（领域函数 / pnpm lake:migrate）→ 调度器执行 → 数据湖指向新位置。
// 数据用 seed 造数夹具与直接挂载租户数据湖写入（多个快照、内联数据）
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { lakeMigrations } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf, getTenantLake, tenantDataPath } from '../../app/.server/lake';
import { claimLakeMigration, requestLakeMigration, requestLakeMigrations, runLakeMigration } from '../../app/.server/lake-migration';
import { listLakeFiles } from '../../app/.server/lake-storage';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { setTenantS3Prefixes } from '../../app/.server/s3-accounts';
import { listObjects, type S3Creds } from '../../app/.server/s3-client';
import { claimNextTask, enqueueTask, finishTask, getTask } from '../../app/.server/tasks';
import { resetDb, runCli } from '../http/harness';
import { WORKER_SUFFIX } from '../setup-env';
import { newTenant, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });

// 迁移的目标根：本地目录总是测，对象存储在设置了 TEST_S3_LAKE_URI 时测。按 worker 分开（TEST_S3_LAKE_URI 已带后缀，见 test/setup-env.ts）
const LOCAL_TARGET = join(tmpdir(), `crm_platform_test_lake_moved${WORKER_SUFFIX}`);
const S3_TARGET = process.env.TEST_S3_LAKE_URI && `${process.env.TEST_S3_LAKE_URI}/moved`;

beforeEach(async () => {
  await resetDb();
  await rm(LOCAL_TARGET, { recursive: true, force: true });
});

/** 以本租户的凭据直接挂载其数据湖执行 SQL（与工作进程拿到的凭据相同） */
async function withLake<T>(tenantId: string, run: (sql: (q: string) => Promise<Record<string, unknown>[]>) => Promise<T>) {
  const { con, close } = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return await run(async q => (await con.runAndReadAll(q)).getRowObjectsJson());
  } finally {
    close();
  }
}

const inventoryOf = async (tenantId: string) => {
  const task = await runTask(tenantId, 'lake.inventory');
  expect(task.status).toBe('succeeded');
  return task.result!.tables;
};

/** 调度器把迁移与排队的任务都跑完 */
const runDispatcher = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const auditOf = async (tenantId: string) => (await listAuditLogs(tenantId)).reverse().map(l => `${l.action}：${l.summary}`);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 最近一次迁移存储的整行：`getTenantLake` 的 migration 不含 result，而收回旧前缀失败会写进 result 的 warning */
const lastMigrationOf = async (tenantId: string) =>
  (await getDb().select().from(lakeMigrations).where(eq(lakeMigrations.tenantId, tenantId))
    .orderBy(desc(lakeMigrations.createdAt)).limit(1))[0]!;

/**
 * 等存储服务开始拒绝该账号访问旧前缀。SeaweedFS 的 S3 网关异步加载共享的 IAM 配置，完整测试里多个 worker
 * 又都在改这份配置（resetDb 删租户账号、各用例建 lake-<id> 账号，与 #343 的 untilGrantsApplied 同一机制）：
 * 迁移把租户策略收窄到新前缀后，网关可能仍在用「新旧前缀都放行」的旧策略。每 200 ms 用租户账号列一次旧前缀，
 * 被拒即返回；其他错误直接抛；30 s 仍可访问则抛错（并发写把收窄覆盖掉是丢失更新，属生产问题，不在这里掩盖）
 */
async function untilPrefixDenied(creds: S3Creds, prefixUri: string) {
  const deadline = Date.now() + 30_000;
  let lastCount = 0;
  for (;;) {
    try {
      lastCount = (await listObjects(creds, prefixUri)).length;
    } catch (e) {
      if (/AccessDenied|HTTP 403/.test((e as Error).message)) return;
      throw e;
    }
    if (Date.now() > deadline) throw new Error(`等了 30 s 旧前缀仍可访问：${prefixUri}（最后一次列出 ${lastCount} 个对象）`);
    await sleep(200);
  }
}

/** 造出有数据文件、多个快照、内联数据的数据湖，返回用于时间旅行比对的早期快照号 */
async function seedLake(tenantId: string) {
  expect((await runTask(tenantId, 'demo.seed', { customers: 300 })).status).toBe('succeeded');
  return withLake(tenantId, async sql => {
    const [{ v }] = await sql(`SELECT max(snapshot_id)::INT AS v FROM ducklake_snapshots('lake')`);
    // 几行的小表由 DuckLake 内联在 catalog 里，没有数据文件
    await sql(`CREATE TABLE notes (id INT, body TEXT); INSERT INTO notes VALUES (1, '甲'); INSERT INTO notes VALUES (2, '乙')`);
    await sql(`DELETE FROM customers WHERE customer_id <= 10`);
    // 确认 notes 确实内联在 catalog 里、customers 有数据文件：两种数据都要随迁移搬走
    const files = await sql(`SELECT (SELECT count(*) FROM ducklake_list_files('lake', 'notes'))::INT AS notes,
                                    (SELECT count(*) FROM ducklake_list_files('lake', 'customers'))::INT AS customers`);
    expect(files).toEqual([{ notes: 0, customers: expect.any(Number) }]);
    expect(files[0].customers).toBeGreaterThan(0);
    return v as number;
  });
}

const timeTravel = (tenantId: string, version: number) =>
  withLake(tenantId, sql => sql(`
    SELECT (SELECT count(*) FROM customers AT (VERSION => ${version}))::INT AS then_customers,
           (SELECT count(*) FROM customers)::INT AS now_customers,
           (SELECT string_agg(body, ',' ORDER BY id) FROM notes) AS notes`));

for (const { storage, target } of [
  { storage: '本地目录', target: LOCAL_TARGET },
  { storage: '对象存储', target: S3_TARGET },
]) {
  describe.skipIf(!target)(`本地目录上的数据湖迁移到${storage}`, () => {
    it('表、行数、时间旅行查询与迁移前一致，之后的写入落在新位置，旧位置的文件保留', async () => {
      const acme = await newTenant('acme');
      const version = await seedLake(acme);
      const oldPath = (await getTenantLake(acme))!.dataPath;
      const before = { inventory: await inventoryOf(acme), timeTravel: await timeTravel(acme, version) };
      const oldFiles = await listLakeFiles(oldPath);
      expect(oldFiles.some(f => f.path.endsWith('.parquet'))).toBe(true);

      await requestLakeMigration(null, acme, target!);
      expect(await getTenantLake(acme)).toMatchObject({ dataPath: oldPath, migration: { status: 'pending', toPath: tenantDataPath(target!, acme) } });
      await runDispatcher();

      const lake = (await getTenantLake(acme))!;
      expect(lake.dataPath).toBe(tenantDataPath(target!, acme));
      expect(lake.migration).toMatchObject({ status: 'succeeded', fromPath: oldPath });
      expect(await inventoryOf(acme)).toEqual(before.inventory);
      expect(await timeTravel(acme, version)).toEqual(before.timeTravel);

      // 之后的写入落在新位置，旧位置原样保留
      expect((await runTask(acme, 'demo.seed', { customers: 50 })).status).toBe('succeeded');
      const newFiles = (await listLakeFiles(lake.dataPath)).map(f => f.path);
      expect(newFiles.filter(f => !oldFiles.some(o => o.path === f)).some(f => f.endsWith('.parquet'))).toBe(true);
      expect(await listLakeFiles(oldPath)).toEqual(oldFiles);

      expect(await auditOf(acme)).toEqual(expect.arrayContaining([
        `开始迁移数据湖：${oldPath} → ${lake.dataPath}`,
        expect.stringMatching(new RegExp(`^数据湖迁移完成：${oldPath} → ${lake.dataPath}，复制 \\d+ 个文件.*旧位置的文件未删除`)),
      ]));
    });

    it('迁移后工作进程只能访问新位置：旧位置与其他租户的前缀都被拒绝', async () => {
      const acme = await newTenant('acme');
      const globex = await newTenant('globex');
      await runTask(acme, 'demo.seed', { customers: 50 });
      await runTask(globex, 'demo.seed', { customers: 50 });
      const oldPath = (await getTenantLake(acme))!.dataPath;
      const globexPath = (await getTenantLake(globex))!.dataPath;
      await requestLakeMigration(null, acme, target!);
      await runDispatcher();

      const { id } = await enqueueTask(acme, 'lake.inventory');
      const task = (await claimNextTask())!;
      expect(task.id).toBe(id);
      expect(task.lake.dataPath).toBe(tenantDataPath(target!, acme));
      const { con, close } = await openTenantLake(task.lake, task.limits);
      const tryRun = (q: string) => con.run(q).then(() => 'allowed', e => (e as Error).message);
      try {
        expect(await tryRun(`SELECT count(*) FROM glob('${task.lake.dataPath}**')`)).toBe('allowed');
        expect(await tryRun(`SELECT count(*) FROM customers`)).toBe('allowed');
        expect(await tryRun(`SELECT * FROM glob('${oldPath}**')`)).toMatch(/Permission Error/);
        expect(await tryRun(`SELECT * FROM glob('${globexPath}**')`)).toMatch(/Permission Error/);
      } finally {
        close();
        await finishTask(task.id, { result: {} });
      }
    });
  });
}

// 对象存储之间迁移：租户账号的前缀策略随之改为新前缀，存储服务拒绝它再访问旧前缀
describe.skipIf(!S3_TARGET)('对象存储上的数据湖迁移到另一个前缀', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('数据完整，租户账号只能访问新前缀', async () => {
    const acme = await newTenant('acme');
    const version = await seedLake(acme);
    const oldPath = (await getTenantLake(acme))!.dataPath;
    const before = { inventory: await inventoryOf(acme), timeTravel: await timeTravel(acme, version) };

    await requestLakeMigration(null, acme, S3_TARGET!);
    await runDispatcher();
    const lake = (await lakeRow(acme))!;
    expect(lake.dataPath).toBe(tenantDataPath(S3_TARGET!, acme));
    expect(await inventoryOf(acme)).toEqual(before.inventory);
    expect(await timeTravel(acme, version)).toEqual(before.timeTravel);

    // 收回旧前缀失败会写成迁移结果 result 里的 warning（不影响迁移状态）：先排除它，剩下的失败才是策略生效延迟
    expect((await lastMigrationOf(acme)).result?.warning).toBeUndefined();

    // 不经 DuckDB 的限制，直接用租户账号访问存储服务
    const creds = lakeSpecOf(lake).s3!;
    expect((await listObjects(creds, lake.dataPath)).some(f => f.path === '.keep')).toBe(true);
    await untilPrefixDenied(creds, oldPath);
    await expect(listObjects(creds, oldPath)).rejects.toThrow(/AccessDenied|HTTP 403/);
  });

  it('旧前缀迟迟收不回时迁移仍然成功并记 warning', async () => {
    const acme = await newTenant('acme');
    await seedLake(acme);
    const oldPath = (await getTenantLake(acme))!.dataPath;
    await requestLakeMigration(null, acme, S3_TARGET!);
    // 不经调度器直接执行：注入恒成功的探测（代表网关一直没加载收窄后的新策略），60 s 超时缩成 500 ms
    await runLakeMigration((await claimLakeMigration())!, undefined, {
      revokeTimeoutMs: 500,
      probe: async () => [{ path: '.keep', size: 0 }],
    });
    const migration = await lastMigrationOf(acme);
    expect(migration).toMatchObject({ status: 'succeeded' });
    expect(migration.result?.warning).toContain(oldPath);
  });

  it('并发迁移后租户账号被拒绝访问旧前缀', async () => {
    // 完整测试时多个 worker 同时改共享的 IAM 配置（#541）：6 个租户同时迁移，另外 2 个无关租户的策略在迁移期间被反复重写加压
    const ids: string[] = [];
    for (const slug of ['co1', 'co2', 'co3', 'co4', 'co5', 'co6']) ids.push(await newTenant(slug));
    // 开通租户时 catalog 与 S3 账号就建好了：数据文件直接挂湖用 SQL 造（不经 demo.seed 的 worker，6 个租户快得多），
    // 表足够大才不内联在 catalog 里；这里不比对时间旅行，不用 seedLake
    await Promise.all(ids.map(id =>
      withLake(id, sql => sql(`CREATE TABLE payload AS SELECT i AS id, '数据文件' || i AS body FROM range(1, 2001) t(i)`))));
    const oldPaths = new Map(await Promise.all(ids.map(async id => [id, (await getTenantLake(id))!.dataPath] as const)));
    for (const id of ids) expect((await listLakeFiles(oldPaths.get(id)!)).some(f => f.path.endsWith('.parquet'))).toBe(true);

    const { requested } = await requestLakeMigrations(null, S3_TARGET!);
    expect(requested.map(r => r.tenantId).sort()).toEqual([...ids].sort());

    // 无关租户不迁移：迁移进行时反复重写它们的前缀策略，模拟其他 worker 对共享 IAM 配置的并发写
    const churn: { id: string; path: string }[] = [];
    for (const slug of ['churn1', 'churn2']) {
      const id = await newTenant(slug);
      churn.push({ id, path: (await getTenantLake(id))!.dataPath });
    }

    const drained = { done: false };
    await Promise.all([
      createDispatcher({ maxWorkers: 8 }).runUntilIdle().then(() => { drained.done = true; }),
      ...churn.map(({ id, path }) => (async () => {
        while (!drained.done) {
          await setTenantS3Prefixes(id, [path]).catch(e => console.error('[并发迁移加压] 重写策略失败，继续', e));
          await sleep(100);
        }
      })()),
    ]);

    // 各租户互不依赖，等策略生效与断言并发进行（等待上限 30 s 是合计，不是每租户叠加）
    await Promise.all(ids.map(async id => {
      const migration = await lastMigrationOf(id);
      expect(migration).toMatchObject({ status: 'succeeded' });
      expect(migration.result?.warning).toBeUndefined();
      const creds = lakeSpecOf((await lakeRow(id))!).s3!;
      await untilPrefixDenied(creds, oldPaths.get(id)!);
      await expect(listObjects(creds, oldPaths.get(id)!)).rejects.toThrow(/AccessDenied|HTTP 403/);
    }));
  }, 420_000); // 8 个租户开通（S3 上各 ~10 s）加 6 个并发迁移，单独跑 ~140 s；4 个 worker 并行跑满时约慢一倍，会超过默认 180 s

  it('迁回本地目录后数据完整，之后的写入落在本地', async () => {
    const acme = await newTenant('acme');
    const version = await seedLake(acme);
    const before = { inventory: await inventoryOf(acme), timeTravel: await timeTravel(acme, version) };

    await requestLakeMigration(null, acme, LOCAL_TARGET);
    await runDispatcher();
    expect((await getTenantLake(acme))!.dataPath).toBe(tenantDataPath(LOCAL_TARGET, acme));
    expect(await inventoryOf(acme)).toEqual(before.inventory);
    expect(await timeTravel(acme, version)).toEqual(before.timeTravel);
    expect((await runTask(acme, 'demo.seed', { customers: 30 })).status).toBe('succeeded');
    expect(await inventoryOf(acme)).toContainEqual({ name: 'customers', rows: 30 });
    // 迁离对象存储后收回租户在存储服务上的账号
    expect(await lakeRow(acme)).toMatchObject({ s3AccessKey: null, s3SecretKey: null });
    expect(await getTenantLake(acme)).toMatchObject({ ready: true, s3User: null });
    // 删账号路径也要等网关拒绝旧凭据：InvalidAccessKeyId 漏判会白等到超时并记 warning
    expect((await lastMigrationOf(acme)).result?.warning).toBeUndefined();
  });

  it('删账号后等旧凭据被拒期间失联，接手的执行幂等地完成，不把数据湖指回旧前缀', async () => {
    const acme = await newTenant('acme');
    const version = await seedLake(acme);
    const before = { inventory: await inventoryOf(acme), timeTravel: await timeTravel(acme, version) };
    const oldPath = (await getTenantLake(acme))!.dataPath;
    await requestLakeMigration(null, acme, LOCAL_TARGET);

    // 第一次执行：注入恒成功的探测（旧前缀一直列得动），迁移就停在等待网关拒绝里
    const first = (await claimLakeMigration())!;
    const controller = new AbortController();
    const stuck = runLakeMigration(first, controller.signal, { probe: async () => [{ path: '.keep', size: 0 }] });
    // 等它复制、切换、删完账号（数据湖已指向本地、凭据列已清空）再像失联的调度器一样中止
    const toPath = tenantDataPath(LOCAL_TARGET, acme);
    const accountDropped = async () => {
      const lake = (await lakeRow(acme))!;
      return lake.dataPath === toPath && !lake.s3AccessKey;
    };
    for (let i = 0; i < 150 && !(await accountDropped()); i++) await sleep(200);
    expect(await accountDropped()).toBe(true);
    controller.abort();
    await stuck; // LostClaim：不写完成状态，迁移停在 running，数据湖已指向本地
    expect((await lastMigrationOf(acme)).status).toBe('running');

    // 另一个调度器失联判定后重新领取：接手方取不出旧凭据（账号已删），要能识别这个中间状态并幂等地完成
    const takeover = (await claimLakeMigration(0))!;
    expect(takeover.id).toBe(first.id);
    await runLakeMigration(takeover);

    const migration = await lastMigrationOf(acme);
    expect(migration).toMatchObject({ status: 'succeeded', error: null });
    // 接手时凭据已清空，无法确认网关已开始拒绝旧凭据：不能静默记成功，要写 warning 备查
    expect(migration.result?.warning).toContain('没有等到网关拒绝旧凭据');
    const lake = (await lakeRow(acme))!;
    expect(lake.dataPath).toBe(toPath);
    expect(lake.dataPath).not.toBe(oldPath); // 不得指回已没有账号的旧 s3 前缀
    expect(lake.s3AccessKey).toBeNull();
    expect(await inventoryOf(acme)).toEqual(before.inventory);
    expect(await timeTravel(acme, version)).toEqual(before.timeTravel);
  });

  it('删账号后失联，接手时盘点对不上：记 failed，不把数据湖指回旧前缀', async () => {
    const acme = await newTenant('acme');
    await seedLake(acme);
    const oldPath = (await getTenantLake(acme))!.dataPath;
    await requestLakeMigration(null, acme, LOCAL_TARGET);

    // 第一次执行：注入恒成功的探测（旧前缀一直列得动），迁移就停在等待网关拒绝里
    const first = (await claimLakeMigration())!;
    const controller = new AbortController();
    const stuck = runLakeMigration(first, controller.signal, { probe: async () => [{ path: '.keep', size: 0 }] });
    // 等它复制、切换、删完账号（数据湖已指向本地、凭据列已清空）再像失联的调度器一样中止
    const toPath = tenantDataPath(LOCAL_TARGET, acme);
    const accountDropped = async () => {
      const lake = (await lakeRow(acme))!;
      return lake.dataPath === toPath && !lake.s3AccessKey;
    };
    for (let i = 0; i < 150 && !(await accountDropped()); i++) await sleep(200);
    expect(await accountDropped()).toBe(true);
    controller.abort();
    await stuck; // LostClaim：不写完成状态，迁移停在 running，数据湖已指向本地
    expect((await lastMigrationOf(acme)).status).toBe('running');

    // 接手的调度器领取之前把存的盘点改成对不上的（领取时 m.inventory 从行里读，必须改在领取之前）
    await getDb().update(lakeMigrations).set({ inventory: [{ name: 'no_such_table', rows: 1 }] }).where(eq(lakeMigrations.id, first.id));
    const takeover = (await claimLakeMigration(0))!;
    expect(takeover.id).toBe(first.id);
    await runLakeMigration(takeover);

    // 旧前缀上的账号已删：盘点对不上也不能指回旧前缀、不再改那个账号的策略，只把迁移记为失败，数据湖留在新位置
    const migration = await lastMigrationOf(acme);
    expect(migration.status).toBe('failed');
    expect(migration.error).toContain('盘点与迁移前不一致');
    const lake = (await lakeRow(acme))!;
    expect(lake.dataPath).toBe(toPath);
    expect(lake.dataPath).not.toBe(oldPath);
    expect(lake.s3AccessKey).toBeNull();
    // 失败已落库，不会再被失联判定重新领取、永远出不来
    expect((await claimLakeMigration(0))?.id).not.toBe(first.id);
  });
});

describe('迁移期间的调度', () => {
  it('等运行中的任务结束才开始；迁移中不派发该租户的任务（仍可提交），其他租户不受影响；结束后排队的任务照常执行', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await enqueueTask(acme, 'lake.inventory');
    const running = (await claimNextTask())!;

    await requestLakeMigration(null, acme, LOCAL_TARGET);
    expect((await getTenantLake(acme))!.migration).toMatchObject({ status: 'pending' });
    // 运行中的任务还没结束：迁移不开始
    expect(await claimLakeMigration()).toBeNull();

    const queued = await enqueueTask(acme, 'lake.inventory');
    await enqueueTask(globex, 'lake.inventory');
    expect((await claimNextTask())?.tenantId).toBe(globex);
    expect(await claimNextTask()).toBeNull();

    await finishTask(running.id, { result: {} });
    await runDispatcher();
    const lake = (await getTenantLake(acme))!;
    expect(lake.migration).toMatchObject({ status: 'succeeded' });
    const task = await getTask(queued.id);
    expect(task.status).toBe('succeeded');
    expect(task.startedAt!.getTime()).toBeGreaterThanOrEqual(new Date(lake.migration!.finishedAt!).getTime());
  });
});

describe('迁移失败', () => {
  it('中途出错时数据湖仍指向旧位置、数据完整、任务照常派发并记入审计；修正后可重试，新位置的残留文件被覆盖', async () => {
    const acme = await newTenant('acme');
    await runTask(acme, 'demo.seed', { customers: 100 });
    const oldPath = (await getTenantLake(acme))!.dataPath;
    const before = await inventoryOf(acme);

    // 目标根是一个普通文件：复制时建不了目录
    await mkdir(dirname(LOCAL_TARGET), { recursive: true });
    await writeFile(LOCAL_TARGET, 'not a directory');
    await requestLakeMigration(null, acme, LOCAL_TARGET);
    const queued = await enqueueTask(acme, 'lake.inventory');
    await runDispatcher();

    const failed = (await getTenantLake(acme))!;
    expect(failed.dataPath).toBe(oldPath);
    expect(failed.migration).toMatchObject({ status: 'failed', error: expect.any(String) });
    expect(await getTask(queued.id)).toMatchObject({ status: 'succeeded', result: expect.objectContaining({ tables: before }) });
    expect(await auditOf(acme)).toContainEqual(expect.stringMatching(new RegExp(`^数据湖迁移失败：${oldPath} → .*仍使用原位置`)));

    // 上次复制留下的残留文件（内容不对）被覆盖
    await rm(LOCAL_TARGET);
    const target = tenantDataPath(LOCAL_TARGET, acme);
    const [parquet] = (await listLakeFiles(oldPath)).filter(f => f.path.endsWith('.parquet'));
    await mkdir(dirname(target + parquet.path), { recursive: true });
    await writeFile(target + parquet.path, 'partial');

    await requestLakeMigration(null, acme, LOCAL_TARGET);
    await runDispatcher();
    expect((await getTenantLake(acme))!).toMatchObject({ dataPath: target, migration: { status: 'succeeded' } });
    expect(await inventoryOf(acme)).toEqual(before);
    expect(await readFile(target + parquet.path)).toEqual(await readFile(oldPath + parquet.path));
  });
});

describe('申请迁移', () => {
  it('已在目标位置、正在迁移到别处时拒绝；重复申请同一目标不另起一次迁移', async () => {
    const acme = await newTenant('acme');
    await expect(requestLakeMigration(null, acme, process.env.PLATFORM_LAKE_URI!)).rejects.toThrow('已在');
    const first = await requestLakeMigration(null, acme, LOCAL_TARGET);
    expect(first.created).toBe(true);
    expect(await requestLakeMigration(null, acme, `${LOCAL_TARGET}/`)).toEqual({ migration: first.migration, created: false });
    await expect(requestLakeMigration(null, acme, join(tmpdir(), 'elsewhere'))).rejects.toThrow('正在迁移');
    expect((await auditOf(acme)).filter(l => l.startsWith('开始迁移数据湖'))).toHaveLength(1);
  });

  it('--all 跳过已在目标根下的租户，可以重复执行', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await requestLakeMigration(null, acme, LOCAL_TARGET);
    await runDispatcher();

    const first = await requestLakeMigrations(null, LOCAL_TARGET);
    expect(first.requested.map(r => r.tenantId)).toEqual([globex]);
    await runDispatcher();
    expect(existsSync(tenantDataPath(LOCAL_TARGET, globex))).toBe(true);
    expect((await requestLakeMigrations(null, LOCAL_TARGET)).requested).toEqual([]);
    expect((await getTenantLake(globex))!.dataPath).toBe(tenantDataPath(LOCAL_TARGET, globex));
  });

  it('命令行：--tenant 与 --all，参数不全时给出用法', async () => {
    await newTenant('acme');
    await newTenant('globex');
    const usage = await runCli('scripts/migrate-lake.ts', ['--tenant', 'acme']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('用法');

    const one = await runCli('scripts/migrate-lake.ts', ['--tenant', 'acme', '--to', LOCAL_TARGET]);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('acme');
    const all = await runCli('scripts/migrate-lake.ts', ['--all', '--to', LOCAL_TARGET]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain('globex');
    expect(all.stdout).toMatch(/acme.*迁移中/);
    expect((await runCli('scripts/migrate-lake.ts', ['--tenant', 'nope', '--to', LOCAL_TARGET])).code).toBe(1);
  });
});

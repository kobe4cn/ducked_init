// 开发用重置数据湖的接缝：运营命令（领域函数 / pnpm lake:reset）→ catalog 与存储前缀清空、重新初始化 → 调度器照常派发。
// 本地目录总是测，对象存储在设置了 TEST_S3_LAKE_URI 时测
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb } from '../../app/.server/db/client';
import { getTenantLake } from '../../app/.server/lake';
import { requestLakeMigration } from '../../app/.server/lake-migration';
import { resetTenantLake } from '../../app/.server/lake-reset';
import { listLakeFiles } from '../../app/.server/lake-storage';
import { claimNextTask, enqueueTask, finishTask, getTask } from '../../app/.server/tasks';
import { resetDb, runCli } from '../http/harness';
import { newTenant, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const inventoryOf = async (tenantId: string) => {
  const task = await runTask(tenantId, 'lake.inventory');
  expect(task.status).toBe('succeeded');
  return task.result!.tables;
};

const dataPathOf = async (tenantId: string) => (await getTenantLake(tenantId))!.dataPath;
const filesOf = async (tenantId: string) => (await listLakeFiles(await dataPathOf(tenantId))).map(f => f.path).sort();
const auditOf = async (tenantId: string) => (await listAuditLogs(tenantId)).map(l => `${l.actor} ${l.action}：${l.summary}`);

for (const { storage, root } of [
  { storage: '本地目录', root: process.env.PLATFORM_LAKE_URI },
  { storage: '对象存储', root: process.env.TEST_S3_LAKE_URI },
]) {
  describe.skipIf(!root)(`${storage}上的数据湖重置`, () => {
    const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
    beforeAll(() => { process.env.PLATFORM_LAKE_URI = root; });
    afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

    it('清空表与存储前缀下的旧文件，之后造数正常；其他租户的 catalog 与文件不受影响；记入审计', async () => {
      const acme = await newTenant('acme');
      const globex = await newTenant('globex');
      expect((await runTask(acme, 'demo.seed', { customers: 200 })).status).toBe('succeeded');
      expect((await runTask(globex, 'demo.seed', { customers: 100 })).status).toBe('succeeded');
      const oldFiles = (await filesOf(acme)).filter(f => f.endsWith('.parquet'));
      expect(oldFiles.length).toBeGreaterThan(0);
      const globexBefore = { inventory: await inventoryOf(globex), files: await filesOf(globex) };

      const result = await resetTenantLake(null, acme);
      expect(result.files).toBeGreaterThanOrEqual(oldFiles.length);

      expect(await getTenantLake(acme)).toMatchObject({ ready: true, catalogInitialized: true });
      expect(await inventoryOf(acme)).toEqual([]);
      // 只剩重新初始化时写入的占位对象（对象存储）或空目录（本地）
      expect((await filesOf(acme)).filter(f => f !== '.keep')).toEqual([]);

      expect(await inventoryOf(globex)).toEqual(globexBefore.inventory);
      expect(await filesOf(globex)).toEqual(globexBefore.files);

      expect((await runTask(acme, 'demo.seed', { customers: 30 })).status).toBe('succeeded');
      expect(await inventoryOf(acme)).toContainEqual({ name: 'customers', rows: 30 });
      expect((await filesOf(acme)).some(f => f.endsWith('.parquet') && !oldFiles.includes(f))).toBe(true);

      const dataPath = await dataPathOf(acme);
      expect(await auditOf(acme)).toContainEqual(expect.stringMatching(new RegExp(`^运营者（运营命令） 重置数据湖：.*${dataPath}`)));
    });
  });
}

describe('重置期间的调度', () => {
  it('有运行中的任务时拒绝并说明原因；排队的任务保留，重置完成后执行', async () => {
    const acme = await newTenant('acme');
    await runTask(acme, 'demo.seed', { customers: 50 });
    await enqueueTask(acme, 'lake.inventory');
    const running = (await claimNextTask())!;
    await expect(resetTenantLake(null, acme)).rejects.toThrow(/运行中的任务/);
    // 被拒绝时数据湖原样可用
    expect(await getTenantLake(acme)).toMatchObject({ ready: true });
    await finishTask(running.id, { result: {} });

    const queued = await enqueueTask(acme, 'lake.inventory');
    const { resetAt } = await resetTenantLake(null, acme);
    await runTask(acme, 'lake.inventory');
    const task = await getTask(queued.id);
    expect(task).toMatchObject({ status: 'succeeded', result: { tables: [] } });
    expect(task.startedAt!.getTime()).toBeGreaterThanOrEqual(resetAt.getTime());
  });

  it('数据湖迁移中时拒绝', async () => {
    const acme = await newTenant('acme');
    await requestLakeMigration(null, acme, `${process.env.PLATFORM_LAKE_URI}-elsewhere`);
    await expect(resetTenantLake(null, acme)).rejects.toThrow(/迁移/);
  });
});

describe('命令行 pnpm lake:reset', () => {
  const prod = { NODE_ENV: 'production' };

  it('参数不全时给出用法；租户不存在时失败', async () => {
    expect(await runCli('scripts/reset-lake.ts', [])).toMatchObject({ code: 2, stderr: expect.stringContaining('用法') });
    expect((await runCli('scripts/reset-lake.ts', ['--tenant', 'nope', '--yes'])).code).toBe(1);
  });

  it('打印租户名称与存储前缀，要求再输入一次租户标识确认；输错则不执行', async () => {
    const acme = await newTenant('acme');
    await runTask(acme, 'demo.seed', { customers: 20 });
    const dataPath = await dataPathOf(acme);

    const wrong = await runCli('scripts/reset-lake.ts', ['--tenant', 'acme'], { input: 'acm\n' });
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toContain(dataPath);
    expect(wrong.stderr).toContain('已取消');
    expect(await inventoryOf(acme)).not.toEqual([]);

    const ok = await runCli('scripts/reset-lake.ts', ['--tenant', 'acme'], { input: 'acme\n' });
    expect(ok.code).toBe(0);
    expect(await inventoryOf(acme)).toEqual([]);
  });

  it('生产环境未加 --force 时拒绝；加 --force --yes 时执行', async () => {
    const acme = await newTenant('acme');
    await runTask(acme, 'demo.seed', { customers: 20 });

    const refused = await runCli('scripts/reset-lake.ts', ['--tenant', 'acme', '--yes'], { env: prod });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('生产环境');
    expect(await inventoryOf(acme)).not.toEqual([]);

    const forced = await runCli('scripts/reset-lake.ts', ['--tenant', 'acme', '--yes', '--force'], { env: prod });
    expect(forced.code).toBe(0);
    expect(await inventoryOf(acme)).toEqual([]);
  });
});

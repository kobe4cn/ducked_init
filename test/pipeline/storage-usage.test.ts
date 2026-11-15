// test/pipeline/storage-usage.test.ts —— 租户桶用量统计接缝：调度器 refreshStorageUsage（ADR-0008、ADR-0007）
// → 对数据湖已初始化、用量为空或统计已过 10 分钟的租户，按 tenant_lakes 当前 data_path 用平台账号列出桶内
// 全部文件求和写回 storage_used_bytes；storage_measured_at 同时是统计的抢占锁（多个调度器不重复统计）。
// storageOverQuota 是写入拦截（写入类任务的领取、上传登记）共用的超额判断
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { lakeRow } from '../../app/.server/lake';
import { listLakeFiles } from '../../app/.server/lake-storage';
import { refreshStorageUsage, storageOverQuota } from '../../app/.server/storage-quota';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('调度器统计租户桶用量', () => {
  it('统计已初始化的租户并写回用量与统计时间；刚统计过的不重统；超过 10 分钟的重统', async () => {
    const acme = await newTenant('acme');
    expect((await runTask(acme, 'demo.seed', { customers: 50 })).status).toBe('succeeded');

    await refreshStorageUsage();
    let lake = (await lakeRow(acme))!;
    expect(lake.storageUsedBytes).toBeGreaterThan(0);
    expect(lake.storageMeasuredAt).not.toBeNull();

    // 刚统计过：候选里已没有它，统计时间不变
    const first = lake.storageMeasuredAt!;
    await refreshStorageUsage();
    lake = (await lakeRow(acme))!;
    expect(lake.storageMeasuredAt!.getTime()).toBe(first.getTime());

    // 统计已过 11 分钟：下一轮重统，统计时间前移
    await getDb().execute(sql`UPDATE platform.tenant_lakes SET storage_measured_at = now() - interval '11 minutes' WHERE tenant_id = ${acme}`);
    await refreshStorageUsage();
    lake = (await lakeRow(acme))!;
    expect(lake.storageMeasuredAt!.getTime()).toBeGreaterThan(first.getTime());
    expect(lake.storageUsedBytes).toBeGreaterThan(0);
  });

  it('单个租户统计出错不影响其他租户：出错的用量保持空、统计时间回到原值', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    expect((await runTask(acme, 'demo.seed', { customers: 50 })).status).toBe('succeeded');
    // globex 的桶改成不可达的 s3 前缀：列出文件抛错
    await getDb().execute(sql`UPDATE platform.tenant_lakes SET data_path = 's3://no-such-bucket-for-test/' WHERE tenant_id = ${globex}`);

    await refreshStorageUsage();

    const ok = (await lakeRow(acme))!;
    expect(ok.storageUsedBytes).toBeGreaterThan(0);
    expect(ok.storageMeasuredAt).not.toBeNull();
    const bad = (await lakeRow(globex))!;
    expect(bad.storageUsedBytes).toBeNull();
    expect(bad.storageMeasuredAt).toBeNull();
  });

  it('多个调度器同时统计不重复：结果正确、不报错', async () => {
    const acme = await newTenant('acme');
    expect((await runTask(acme, 'demo.seed', { customers: 50 })).status).toBe('succeeded');
    // 其中一个抢不到（不重统），两个都不报错
    await Promise.all([refreshStorageUsage(), refreshStorageUsage()]);
    const lake = (await lakeRow(acme))!;
    expect(lake.storageUsedBytes).toBeGreaterThan(0);
    expect(lake.storageMeasuredAt).not.toBeNull();
  });
});

describe('storageOverQuota（超额判断，ADR-0008）', () => {
  it('未统计或等于配额返回 null；超额返回写明已用与配额的报错（已用向上取整 MB）', async () => {
    const acme = await newTenant('acme');
    // 默认配额 10240 MB；没有湖行的租户（未统计）同样不拦
    expect(await storageOverQuota(acme)).toBeNull();

    await getDb().execute(sql`UPDATE platform.tenant_lakes SET storage_used_bytes = 10240::bigint * 1048576 WHERE tenant_id = ${acme}`);
    expect(await storageOverQuota(acme)).toBeNull();

    await getDb().execute(sql`UPDATE platform.tenant_lakes SET storage_used_bytes = 10240::bigint * 1048576 + 1 WHERE tenant_id = ${acme}`);
    expect(await storageOverQuota(acme)).toBe('租户存储已超出配额（已用 10241 MB / 配额 10240 MB）');
  });
});

// 对象存储上再测一遍（需 TEST_S3_LAKE_URI）：统计用平台账号列出整个租户桶，与直接列桶求和一致
describe.skipIf(!process.env.TEST_S3_LAKE_URI || !process.env.S3_ACCESS_KEY)('对象存储上的桶用量统计', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('租户桶的全部文件（含造数与占位对象）都计入用量并写回', async () => {
    const acme = await newTenant('acme');
    expect((await runTask(acme, 'demo.seed', { customers: 50 })).status).toBe('succeeded');
    const lake = (await lakeRow(acme))!;
    expect(lake.dataPath).toMatch(new RegExp(`^s3://lake-${acme}/`));

    await refreshStorageUsage();
    const after = (await lakeRow(acme))!;
    expect(after.storageUsedBytes).toBe((await listLakeFiles(lake.dataPath)).reduce((sum, f) => sum + f.size, 0));
    expect(after.storageUsedBytes).toBeGreaterThan(0);
    expect(after.storageMeasuredAt).not.toBeNull();
  });
});

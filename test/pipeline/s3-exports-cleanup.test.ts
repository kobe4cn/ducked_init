// test/pipeline/s3-exports-cleanup.test.ts —— 对象存储上每租户一桶的导出清理接缝：调度器 cleanupExpiredExports
// → 按任务的 lake.dataPath + result.path 删 s3://lake-<租户 ID>/_exports/ 下过了保留期的文件（ADR-0040、ADR-0008、#663）
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { cleanupExpiredExports } from '../../app/.server/exports';
import { lakeRow } from '../../app/.server/lake';
import { platformS3 } from '../../app/.server/s3-accounts';
import { getObjectIfExists, putObject } from '../../app/.server/s3-client';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

// 每租户一桶（ADR-0008、#663）下的清理：租户桶 s3://lake-<id>/ 的 _exports/ 由 ADR-0040 的调度器任务删，
// 不用桶生命周期规则（决策见 ADR-0040）
describe.skipIf(!process.env.TEST_S3_LAKE_URI || !process.env.S3_ACCESS_KEY)('对象存储上每租户一桶的导出清理', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; await closeDb(); });

  it('对象存储上每租户一桶：过了保留期的导出文件由 cleanupExpiredExports 从租户桶的 _exports/ 删掉，保留期内的不动，任务结果去掉 path', async () => {
    const t = await newTenant('acme');
    const lake = (await lakeRow(t))!;
    expect(lake.dataPath).toMatch(new RegExp(`^s3://lake-${t}/`));

    const oldPath = `_exports/${randomUUID()}.parquet`;
    const freshPath = `_exports/${randomUUID()}.parquet`;
    for (const path of [oldPath, freshPath]) {
      await putObject(platformS3(), lake.dataPath + path, 'x');
    }

    const insert = (path: string) => getDb().insert(tasks).values({
      tenantId: t, kind: 'export.tags', params: {}, status: 'succeeded',
      result: { rows: 1, path, format: 'parquet' }, finishedAt: new Date(),
    }).returning();
    const [old] = await insert(oldPath);
    const [fresh] = await insert(freshPath);
    // 照 test/http/exports.test.ts 的清理用例：把旧任务改成 25 小时前结束（保留期 24 小时）
    await getDb().execute(sql`UPDATE platform.tasks SET finished_at = now() - interval '25 hours' WHERE id = ${old.id}`);

    await cleanupExpiredExports();

    expect(await getObjectIfExists(platformS3(), lake.dataPath + oldPath)).toBeNull();
    expect(await getObjectIfExists(platformS3(), lake.dataPath + freshPath)).not.toBeNull();
    const rows = await getDb().select().from(tasks);
    expect(rows.find(r => r.id === old.id)?.result).not.toHaveProperty('path');
    expect(rows.find(r => r.id === fresh.id)?.result).toHaveProperty('path', freshPath);

    // 幂等：删过的（result 已无 path）下一轮不再处理，不报错
    await expect(cleanupExpiredExports()).resolves.toBeUndefined();
    expect(await getObjectIfExists(platformS3(), lake.dataPath + freshPath)).not.toBeNull();
  });
});

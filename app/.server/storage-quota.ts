// app/.server/storage-quota.ts —— 租户桶的用量统计与超额判断（ADR-0008、ADR-0007）：调度器每轮对数据湖已初始化、用量为空或统计已过期的租户，
// 用平台账号按当前 data_path 列出桶内全部文件（含 _serving/、_exports/、_uploads/，正是桶总用量）求和写回 tenant_lakes；
// 超额判断 storageOverQuota 是写入拦截的入口：写入类任务的领取（tasks.ts）与上传数据源的登记（sources.tsx）都先问它
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { tenantLakes, tenants } from './db/schema';
import { listLakeFiles } from './lake-storage';

/** 统计时间早于它（或为空）就算过期，下一轮重统 */
export const STORAGE_USAGE_STALE_MS = 10 * 60_000;

const staleBefore = () => sql`now() - ${STORAGE_USAGE_STALE_MS} * interval '1 millisecond'`;

/**
 * 调度器定期调用：统计各租户桶的总用量并写回 tenant_lakes。
 * 先抢占（把 storage_measured_at 原子地置为 now()）再列出文件求和，多个调度器同时跑不重复统计；
 * 单个租户出错（如桶不可达）只记日志并把统计时间置回旧值（不保留半成品抢占，下一轮重试），不影响其他租户
 */
export async function refreshStorageUsage(): Promise<void> {
  const db = getDb();
  const due = await db.select({ tenantId: tenantLakes.tenantId, measuredAt: tenantLakes.storageMeasuredAt })
    .from(tenantLakes)
    .where(and(
      isNotNull(tenantLakes.catalogInitializedAt),
      or(isNull(tenantLakes.storageMeasuredAt), lt(tenantLakes.storageMeasuredAt, staleBefore())),
    ));
  for (const { tenantId, measuredAt } of due) {
    try {
      // 抢占：没抢到（没有返回行）说明别的调度器已在统计这个租户
      const [claimed] = await db.update(tenantLakes)
        .set({ storageMeasuredAt: sql`now()` })
        .where(and(
          eq(tenantLakes.tenantId, tenantId),
          or(isNull(tenantLakes.storageMeasuredAt), lt(tenantLakes.storageMeasuredAt, staleBefore())),
        ))
        .returning({ dataPath: tenantLakes.dataPath });
      if (!claimed) continue;
      const usedBytes = (await listLakeFiles(claimed.dataPath)).reduce((sum, f) => sum + f.size, 0);
      // 统计期间湖被迁移（data_path 变了）则不写回，把统计时间置回旧值，下一轮按新前缀重统
      const written = await db.update(tenantLakes)
        .set({ storageUsedBytes: usedBytes, storageMeasuredAt: sql`now()` })
        .where(and(eq(tenantLakes.tenantId, tenantId), eq(tenantLakes.dataPath, claimed.dataPath)))
        .returning({ tenantId: tenantLakes.tenantId });
      if (!written.length) await db.update(tenantLakes).set({ storageMeasuredAt: measuredAt }).where(eq(tenantLakes.tenantId, tenantId));
    } catch (e) {
      // 一个统计不了不耽误别的，下一轮再试；用量保持原值
      console.error(`[存储用量] 统计租户 ${tenantId} 的桶用量出错`, e);
      await db.update(tenantLakes).set({ storageMeasuredAt: measuredAt }).where(eq(tenantLakes.tenantId, tenantId));
    }
  }
}

/**
 * 租户桶用量超过存储配额（tenants.storage_quota_mb，软配额）时返回给用户看的报错，未超额返回 null。
 * 没有湖行或用量未统计（为空）不拦——统计最多滞后 10 分钟，任务执行期间的写入同样不拦
 */
export async function storageOverQuota(tenantId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ quotaMb: tenants.storageQuotaMb, usedBytes: tenantLakes.storageUsedBytes })
    .from(tenantLakes)
    .innerJoin(tenants, eq(tenants.id, tenantLakes.tenantId))
    .where(eq(tenantLakes.tenantId, tenantId));
  if (!row?.usedBytes || row.usedBytes <= row.quotaMb * 1048576) return null;
  return `租户存储已超出配额（已用 ${Math.ceil(row.usedBytes / 1048576)} MB / 配额 ${row.quotaMb} MB）`;
}

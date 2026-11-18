// app/.server/api-usage.ts —— 外部点查接口的 API Key 调用计数（ADR-0059）：成功返回前按 (租户, Key, endpoint, UTC 日) upsert 加 1。
// 按天聚合，不是每次调用一行；只记成功的点查（401/404/503、带 ?snapshot= 的请求不记）。计数不放进 requireApiKey：
// catalog、exports 接口也走它，那些不在口径里；last_used_at 照旧由 requireApiKey 每分钟最多更新一次，与计数无关。
// 记录写不进去时接口照常返回（catch 后打日志），也不和读放在同一个事务里
// 读：预览页按 30 个 UTC 日求和（#921）
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { apiKeyUsage, apiKeys } from './db/schema';

/** 计数的两个点查接口 */
export type ApiUsageEndpoint = 'consumers.byId' | 'consumers.bySource';

/** 记一次成功的点查调用；失败只打日志不往外抛 */
export async function recordApiKeyUsage(caller: { tenantId: string; keyId: string }, endpoint: ApiUsageEndpoint): Promise<void> {
  try {
    await getDb().insert(apiKeyUsage).values({
      tenantId: caller.tenantId,
      apiKeyId: caller.keyId,
      endpoint,
      day: sql`(now() at time zone 'UTC')::date`, // UTC 日期在 SQL 里算，不用 JS 的本地日期
      calls: 1,
    }).onConflictDoUpdate({
      target: [apiKeyUsage.tenantId, apiKeyUsage.apiKeyId, apiKeyUsage.endpoint, apiKeyUsage.day],
      set: { calls: sql`${apiKeyUsage.calls} + 1` },
    });
  } catch (e) {
    console.error('[api-usage]', e);
  }
}

/** 预览页的「下游影响」（#921）：本租户最近 30 个 UTC 日（day >= UTC 今天 - 29）按这些 endpoint 有调用的 Key —— 名字、合计次数、是否吊销 */
export async function apiKeyUsageLast30Days(tenantId: string, endpoints: ApiUsageEndpoint[]): Promise<{ name: string; calls: number; revoked: boolean }[]> {
  if (endpoints.length === 0) return []; // inArray 空数组会报错
  const rows = await getDb()
    .select({
      name: apiKeys.name,
      calls: sql<string>`sum(${apiKeyUsage.calls})`, // pg 的 sum 返回 bigint，驱动给字符串
      revoked: sql<boolean>`${apiKeys.revokedAt} is not null`,
    })
    .from(apiKeyUsage)
    // 库里没有 RLS：join 的两张表都带上本租户的条件，别把别的租户的 Key 或调用算进来
    .innerJoin(apiKeys, and(eq(apiKeys.id, apiKeyUsage.apiKeyId), eq(apiKeys.tenantId, tenantId)))
    .where(and(
      eq(apiKeyUsage.tenantId, tenantId),
      inArray(apiKeyUsage.endpoint, endpoints),
      sql`${apiKeyUsage.day} >= (now() at time zone 'UTC')::date - 29`,
    ))
    .groupBy(apiKeys.id, apiKeys.name, apiKeys.revokedAt)
    .orderBy(desc(sql`sum(${apiKeyUsage.calls})`), asc(apiKeys.name));
  return rows.map(r => ({ name: r.name, calls: Number(r.calls), revoked: r.revoked }));
}

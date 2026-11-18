// app/.server/api-usage.ts —— 外部点查接口的 API Key 调用计数（ADR-0059）：成功返回前按 (租户, Key, endpoint, UTC 日) upsert 加 1。
// 按天聚合，不是每次调用一行；只记成功的点查（401/404/503、带 ?snapshot= 的请求不记）。计数不放进 requireApiKey：
// catalog、exports 接口也走它，那些不在口径里；last_used_at 照旧由 requireApiKey 每分钟最多更新一次，与计数无关。
// 记录写不进去时接口照常返回（catch 后打日志），也不和读放在同一个事务里
import { sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { apiKeyUsage } from './db/schema';

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

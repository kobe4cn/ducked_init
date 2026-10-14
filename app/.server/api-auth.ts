// app/.server/api-auth.ts —— 外部系统调用 /api/v1/ 的认证：Authorization: Bearer <API Key>。
// 与成员会话完全分开（同 ADR-0007 的身份分开）：不读 cookie，Bearer 请求也带不出成员的任何能力。
// 没有 Key、Key 错误、已吊销、租户已暂停一律 401，响应相同，不泄露是哪种原因
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { sha256 } from './auth';
import { getDb } from './db/client';
import { apiKeys, tenants } from './db/schema';

export interface ApiCaller { tenantId: string; keyId: string }

const LAST_USED_GRANULARITY = sql`interval '1 minute'`;

const unauthorized = () =>
  Response.json({ error: '未授权：请在 Authorization 头里带上有效的 API Key（Bearer）' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

function bearerToken(request: Request) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') ?? '');
  return m?.[1] ?? null;
}

/** 认证外部系统的请求，失败时抛出 401 响应；成功时顺带记下最近使用时间（同一把 Key 每分钟最多写一次） */
export async function requireApiKey(request: Request): Promise<ApiCaller> {
  const token = bearerToken(request);
  if (!token) throw unauthorized();
  const db = getDb();
  const [row] = await db
    .select({ keyId: apiKeys.id, tenantId: apiKeys.tenantId })
    .from(apiKeys)
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(and(eq(apiKeys.tokenHash, sha256(token)), isNull(apiKeys.revokedAt), isNull(tenants.suspendedAt)));
  if (!row) throw unauthorized();
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(apiKeys.id, row.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - ${LAST_USED_GRANULARITY}`))));
  return row;
}

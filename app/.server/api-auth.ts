// app/.server/api-auth.ts —— 外部系统调用 /api/v1/ 的认证：Authorization: Bearer <API Key>。
// 与成员会话完全分开（同 ADR-0007 的身份分开）：不读 cookie，Bearer 请求也带不出成员的任何能力。
// 没有 Key、Key 错误、已吊销、租户已暂停一律 401，响应相同，不泄露是哪种原因。bearerToken 也给 /mcp 的个人令牌认证用（member-tokens.ts）
// 认证通过后按接口范围（ADR-0061）判路径：Key 没开的类 403。先认证后判范围，401 的情形不变
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { API_SCOPE_LABELS, type ApiScope } from '../lib/api-scopes';
import { sha256 } from './auth';
import { getDb } from './db/client';
import { apiKeys, tenants } from './db/schema';

/** 调用方：所属租户与 Key（prefix 是明文的前 8 位，可以写进审计） */
export interface ApiCaller { tenantId: string; keyId: string; prefix: string; scopes: ApiScope[] }

const underPath = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** 与 React Router 匹配路由前一样逐段解码（同 react-router 的 decodePath）：解码出的 / 保持编码，坏编码原样返回 */
function decodeSegments(pathname: string) {
  try {
    return pathname.split('/').map(v => decodeURIComponent(v).replace(/\//g, '%2F')).join('/');
  } catch {
    return pathname;
  }
}

/** 路径属于哪一类接口：三类外部接口按路径判定（ADR-0061）。导出下载凭令牌、不走 requireApiKey，不会到这里。
 *  路由匹配会逐段解码、不区分大小写、接受结尾的 /，所以这里同样解码、转小写、去掉结尾的 / 再判，
 *  否则 /api/v1/Catalog、/api/v1/catalog/、/api/v1/%63atalog 能绕过范围 */
export function scopeOfPath(pathname: string): ApiScope | null {
  const path = decodeSegments(pathname).toLowerCase().replace(/\/+$/, '');
  if (path === '/api/v1/catalog') return 'catalog';
  if (underPath(path, '/api/v1/consumers')) return 'consumers';
  if (underPath(path, '/api/v1/exports')) return 'exports';
  return null;
}

const LAST_USED_GRANULARITY = sql`interval '1 minute'`;

const unauthorized = () =>
  Response.json({ error: '未授权：请在 Authorization 头里带上有效的 API Key（Bearer）' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

const forbidden = (scope: ApiScope) =>
  Response.json({ error: `这把 Key 没有${API_SCOPE_LABELS[scope]}接口的权限` }, { status: 403 });

export function bearerToken(request: Request) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('Authorization') ?? '');
  return m?.[1] ?? null;
}

/** 认证外部系统的请求，失败时抛出 401 响应；Key 没有这个路径所属类的接口范围时抛 403；
 *  成功时顺带记下最近使用时间（同一把 Key 每分钟最多写一次；被 403 拒绝的请求不算使用，不更新） */
export async function requireApiKey(request: Request): Promise<ApiCaller> {
  const token = bearerToken(request);
  if (!token) throw unauthorized();
  const db = getDb();
  const [row] = await db
    .select({ keyId: apiKeys.id, tenantId: apiKeys.tenantId, prefix: apiKeys.prefix, scopes: apiKeys.scopes })
    .from(apiKeys)
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .where(and(eq(apiKeys.tokenHash, sha256(token)), isNull(apiKeys.revokedAt), isNull(tenants.suspendedAt)));
  if (!row) throw unauthorized();
  const scope = scopeOfPath(new URL(request.url).pathname);
  if (scope && !row.scopes.includes(scope)) throw forbidden(scope);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(apiKeys.id, row.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - ${LAST_USED_GRANULARITY}`))));
  return row;
}

// app/.server/member-tokens.ts —— 成员个人令牌（ADR-0042）：成员自己签发（明文只返回这一次，库里只存哈希）、列出、吊销，
// 以及 /mcp 的 Bearer 认证。令牌不带权限：认证时每次从 members 现查角色，降级立刻生效，成员被移除后令牌随之级联删除。
// 与会话、API Key 都分开（ADR-0007、ADR-0040）：不读 cookie，API Key 也换不出成员身份；各种失败一律同样的 401，不泄露原因
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import { bearerToken } from './api-auth';
import { newToken, sha256, type CurrentMember } from './auth';
import { getDb } from './db/client';
import { members, memberTokens, spaces, tenants } from './db/schema';
import { UUID } from './tenants';
import { TOKEN_DAYS, TOKEN_NAME_MAX as NAME_MAX } from '../lib/member-tokens';

/** 可以展示给成员的业务错误，带对应的 HTTP 状态码 */
export class MemberTokenError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

const TOKEN_PREFIX = 'crm_pat_';
/** 前缀：明文前 16 位（含 crm_pat_），列表与审计里用来辨认是哪一个 */
const PREFIX_LENGTH = 16;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_USED_GRANULARITY = sql`interval '1 minute'`;
const notFound = () => new MemberTokenError('令牌不存在或已吊销', 404);

const unauthorized = () =>
  Response.json({ error: '未授权：请在 Authorization 头里带上有效的个人令牌（Bearer）' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });

/** 本人在本租户签发过的令牌（含已吊销与已过期的），不含明文与哈希 */
export async function listMemberTokens(member: CurrentMember) {
  return getDb()
    .select({
      id: memberTokens.id,
      name: memberTokens.name,
      prefix: memberTokens.prefix,
      allowQuery: memberTokens.allowQuery,
      expiresAt: memberTokens.expiresAt,
      createdAt: memberTokens.createdAt,
      lastUsedAt: memberTokens.lastUsedAt,
      revokedAt: memberTokens.revokedAt,
    })
    .from(memberTokens)
    .where(and(eq(memberTokens.memberId, member.memberId), eq(memberTokens.tenantId, member.tenant.id)))
    .orderBy(desc(memberTokens.createdAt), desc(memberTokens.id));
}

/** 签发一个令牌：返回的 token 是明文，调用方只能把它展示给成员这一次。任一成员都能签发，令牌的权限永远等于成员当前角色 */
export async function createMemberToken(member: CurrentMember, input: { name: string; days: number; allowQuery: boolean }) {
  const name = input.name.trim();
  if (!name) throw new MemberTokenError('请填写名称，用来辨认是哪个 Agent');
  if (name.length > NAME_MAX) throw new MemberTokenError(`名称不能超过 ${NAME_MAX} 个字`);
  if (!(TOKEN_DAYS as readonly number[]).includes(input.days)) throw new MemberTokenError(`有效期只能选 ${TOKEN_DAYS.join(' / ')} 天`);
  const token = TOKEN_PREFIX + newToken();
  const prefix = token.slice(0, PREFIX_LENGTH);
  const expiresAt = new Date(Date.now() + input.days * DAY_MS);
  const row = await getDb().transaction(async tx => {
    const [created] = await tx
      .insert(memberTokens)
      .values({ tenantId: member.tenant.id, memberId: member.memberId, name, prefix, tokenHash: sha256(token), allowQuery: input.allowQuery, expiresAt })
      .returning({ id: memberTokens.id, name: memberTokens.name, prefix: memberTokens.prefix, expiresAt: memberTokens.expiresAt });
    await recordAudit(tx, {
      tenantId: member.tenant.id,
      actor: member,
      action: 'member_token.created',
      targetType: 'member_token',
      targetId: created.id,
      detail: { name, prefix, allowQuery: input.allowQuery, expiresAt: expiresAt.toISOString() },
    });
    return created;
  });
  return { token, row };
}

/** 吊销：用这个令牌的下一个请求即被拒绝。别人的、别的租户的、已吊销的令牌与不存在一样处理 */
export async function revokeMemberToken(member: CurrentMember, id: string) {
  if (!UUID.test(id)) throw notFound();
  await getDb().transaction(async tx => {
    const [row] = await tx
      .update(memberTokens)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(memberTokens.id, id),
        eq(memberTokens.memberId, member.memberId),
        eq(memberTokens.tenantId, member.tenant.id),
        isNull(memberTokens.revokedAt),
      ))
      .returning({ id: memberTokens.id, name: memberTokens.name, prefix: memberTokens.prefix, allowQuery: memberTokens.allowQuery, expiresAt: memberTokens.expiresAt });
    if (!row) throw notFound();
    await recordAudit(tx, {
      tenantId: member.tenant.id,
      actor: member,
      action: 'member_token.revoked',
      targetType: 'member_token',
      targetId: row.id,
      detail: { name: row.name, prefix: row.prefix, allowQuery: row.allowQuery, expiresAt: row.expiresAt.toISOString() },
    });
  });
}

/** 认证 /mcp 的请求：只认 Bearer 个人令牌，失败时抛出 401 响应；成功时返回成员（角色现查）与令牌是否允许执行查询，
 * 顺带记下最近使用时间（同一个令牌每分钟最多写一次） */
export async function requireMemberToken(request: Request): Promise<{ actor: CurrentMember; allowQuery: boolean }> {
  const token = bearerToken(request);
  if (!token) throw unauthorized();
  const db = getDb();
  const [row] = await db
    .select({
      tokenId: memberTokens.id,
      allowQuery: memberTokens.allowQuery,
      memberId: members.id,
      email: members.email,
      role: members.role,
      tenant: { id: tenants.id, slug: tenants.slug, name: tenants.name },
      space: { id: spaces.id, name: spaces.name },
    })
    .from(memberTokens)
    .innerJoin(members, and(eq(members.id, memberTokens.memberId), eq(members.tenantId, memberTokens.tenantId)))
    .innerJoin(tenants, eq(tenants.id, members.tenantId))
    .innerJoin(spaces, and(eq(spaces.tenantId, tenants.id), eq(spaces.isDefault, true)))
    .where(and(
      eq(memberTokens.tokenHash, sha256(token)),
      isNull(memberTokens.revokedAt),
      gt(memberTokens.expiresAt, new Date()),
      isNull(tenants.suspendedAt),
    ));
  if (!row) throw unauthorized();
  await db
    .update(memberTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(memberTokens.id, row.tokenId), or(isNull(memberTokens.lastUsedAt), lt(memberTokens.lastUsedAt, sql`now() - ${LAST_USED_GRANULARITY}`))));
  const { tokenId: _, allowQuery, ...actor } = row;
  return { actor, allowQuery };
}

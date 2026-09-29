// app/.server/auth.ts —— 成员登录：Magic Link（一次性、短时有效、仅限已登记邮箱）与会话
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createCookie, redirect } from 'react-router';
import { getDb } from './db/client';
import { magicLinks, members, sessions, spaces, tenants, type Role } from './db/schema';
import { getMailer } from './mailer';
import { normalizeEmail } from './tenants';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const newToken = () => randomBytes(32).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const sessionCookie = createCookie('crm_session', {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_TTL_MS / 1000,
});

function linkOrigin(requestOrigin: string) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN;
  if (process.env.NODE_ENV === 'production') throw new Error('生产环境必须配置 APP_ORIGIN（登录链接的站点地址）');
  return requestOrigin;
}

/**
 * 为邮箱签发 Magic Link。未登记的邮箱静默忽略（不注册、不发信，也不向请求方透露邮箱是否存在）。
 * 同一邮箱隶属多个租户时，一封邮件里给出每个租户各自的链接。
 * 链接的站点地址取 APP_ORIGIN；生产环境必须配置，否则伪造 Host 头就能让链接指向攻击者站点。
 */
export async function requestMagicLink(rawEmail: string, requestOrigin: string) {
  const base = linkOrigin(requestOrigin);
  // 先取发信实现：配置缺失时无论邮箱是否登记都同样失败，不泄露邮箱是否存在
  const mailer = getMailer();
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  const db = getDb();
  const rows = await db
    .select({ memberId: members.id, tenantName: tenants.name })
    .from(members)
    .innerJoin(tenants, eq(tenants.id, members.tenantId))
    .where(eq(members.email, email));
  if (!rows.length) return;

  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  const links = rows.map(r => ({ ...r, token: newToken() }));
  await db.insert(magicLinks).values(links.map(l => ({ memberId: l.memberId, tokenHash: hashToken(l.token), expiresAt })));

  const lines = links.map(l => `${l.tenantName}：${new URL(`/auth/verify?token=${l.token}`, base)}`);
  await mailer.send({
    to: email,
    subject: '登录 CRM 数据分析平台',
    text: [
      `点击下面的链接登录（${MAGIC_LINK_TTL_MS / 60_000} 分钟内有效，只能使用一次）：`,
      '',
      ...lines,
      '',
      '如果不是你本人操作，请忽略这封邮件。',
    ].join('\n'),
  });
}

/** 消费 Magic Link：原子地标记为已用，成功则开启会话并返回 Set-Cookie 头；过期、已用或不存在返回 null */
export async function consumeMagicLink(token: string): Promise<string | null> {
  if (!token) return null;
  const db = getDb();
  const now = new Date();
  const [link] = await db
    .update(magicLinks)
    .set({ usedAt: now })
    .where(and(eq(magicLinks.tokenHash, hashToken(token)), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, now)))
    .returning({ memberId: magicLinks.memberId });
  if (!link) return null;

  const sessionToken = newToken();
  await db.insert(sessions).values({
    memberId: link.memberId,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return sessionCookie.serialize(sessionToken);
}

export interface CurrentMember {
  memberId: string;
  email: string;
  role: Role;
  tenant: { id: string; slug: string; name: string };
  /** 本期每个租户只有一个默认空间 */
  space: { id: string; name: string };
}

async function readSessionToken(request: Request): Promise<string | null> {
  const token = await sessionCookie.parse(request.headers.get('Cookie'));
  return typeof token === 'string' && token ? token : null;
}

export async function getCurrentMember(request: Request): Promise<CurrentMember | null> {
  const token = await readSessionToken(request);
  if (!token) return null;
  const [row] = await getDb()
    .select({
      memberId: members.id,
      email: members.email,
      role: members.role,
      tenant: { id: tenants.id, slug: tenants.slug, name: tenants.name },
      space: { id: spaces.id, name: spaces.name },
    })
    .from(sessions)
    .innerJoin(members, eq(members.id, sessions.memberId))
    .innerJoin(tenants, eq(tenants.id, members.tenantId))
    .innerJoin(spaces, and(eq(spaces.tenantId, tenants.id), eq(spaces.isDefault, true)))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

/** 服务端入口处调用：未登录一律跳转登录页 */
export async function requireMember(request: Request): Promise<CurrentMember> {
  const member = await getCurrentMember(request);
  if (!member) throw redirect('/login');
  return member;
}

/** 注销：删除会话并清除 cookie，返回 Set-Cookie 头 */
export async function logout(request: Request): Promise<string> {
  const token = await readSessionToken(request);
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  return sessionCookie.serialize('', { maxAge: 0 });
}

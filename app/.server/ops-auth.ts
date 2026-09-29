// app/.server/ops-auth.ts —— 运营者身份（ADR-0007）：独立的表、登录入口、会话与 cookie。
// 登录 = Magic Link + 强制 TOTP；首次登录时绑定 TOTP。运营者只能由运营命令创建，后台不能新增或停用运营者
import { BlockList, isIP } from 'node:net';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createCookie, data, redirect } from 'react-router';
import { recordAudit } from './audit';
import { linkOrigin, MAGIC_LINK_TTL_MS, newToken, recordRequest, sha256 } from './auth';
import { runInBackground } from './background';
import { getDb, isUniqueViolation } from './db/client';
import { operatorMagicLinks, operators, operatorSessions } from './db/schema';
import { getMailer, type Mailer } from './mailer';
import { EMAIL, normalizeEmail } from './tenants';
import { generateSecret, otpauthUri, verifyTotp } from './totp';

export const OPS_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** 通过 Magic Link 后，须在这段时间内完成 TOTP 验证 */
export const OPS_PENDING_TTL_MS = 10 * 60 * 1000;
/** 同一次登录连续输错验证码的上限，超过后会话作废 */
export const MAX_TOTP_FAILURES = 5;

const opsCookie = createCookie('crm_ops_session', {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/ops',
  maxAge: OPS_SESSION_TTL_MS / 1000,
});

export interface CurrentOperator { operatorId: string; email: string }

/** 运营命令创建运营者，同时记一条平台级事件 */
export async function createOperator(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL.test(email)) throw new Error(`邮箱不合法：${rawEmail}`);
  try {
    return await getDb().transaction(async tx => {
      const [operator] = await tx.insert(operators).values({ email }).returning();
      await recordAudit(tx, {
        tenantId: null,
        operator: null,
        action: 'operator.created',
        targetType: 'operator',
        targetId: operator.id,
        detail: { email },
      });
      return operator;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error(`运营者已存在：${email}`);
    throw e;
  }
}

/**
 * 申请运营后台的 Magic Link。与成员登录一样：请求路径上只做限流，查运营者、签发与发信放到后台，
 * 运营者与非运营者邮箱得到的答复和响应时间都一样
 */
export async function requestOperatorMagicLink(rawEmail: string, requestOrigin: string) {
  const base = linkOrigin(requestOrigin);
  const mailer = getMailer();
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: true } as const;

  const retryAfterSeconds = await recordRequest(`operator:${email}`);
  if (retryAfterSeconds) return { ok: false, retryAfterSeconds } as const;

  runInBackground('签发运营后台 Magic Link', () => issueOperatorMagicLink(email, base, mailer));
  return { ok: true } as const;
}

/** 为运营者签发链接：此前未使用的链接一律作废 */
async function issueOperatorMagicLink(email: string, base: string, mailer: Mailer) {
  const db = getDb();
  const [operator] = await db.select({ id: operators.id }).from(operators).where(eq(operators.email, email));
  if (!operator) return;

  const token = newToken();
  await db.transaction(async tx => {
    await tx.delete(operatorMagicLinks).where(and(eq(operatorMagicLinks.operatorId, operator.id), isNull(operatorMagicLinks.usedAt)));
    await tx.insert(operatorMagicLinks).values({
      operatorId: operator.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    });
  });
  await mailer.send({
    to: email,
    subject: '登录运营后台 · CRM 数据分析平台',
    text: [
      `点击下面的链接登录运营后台（${MAGIC_LINK_TTL_MS / 60_000} 分钟内有效，只能使用一次），随后需要输入 TOTP 验证码：`,
      '',
      String(new URL(`/ops/auth/verify?token=${token}`, base)),
      '',
      '如果不是你本人操作，请忽略这封邮件。',
    ].join('\n'),
  });
}

/** 消费 Magic Link：成功则开启一个待 TOTP 验证的会话，返回 Set-Cookie 头；过期、已用或不存在返回 null */
export async function consumeOperatorMagicLink(token: string): Promise<string | null> {
  if (!token) return null;
  const db = getDb();
  const now = new Date();
  const [link] = await db
    .update(operatorMagicLinks)
    .set({ usedAt: now })
    .where(and(eq(operatorMagicLinks.tokenHash, sha256(token)), isNull(operatorMagicLinks.usedAt), gt(operatorMagicLinks.expiresAt, now)))
    .returning({ operatorId: operatorMagicLinks.operatorId });
  if (!link) return null;

  const sessionToken = newToken();
  await db.insert(operatorSessions).values({
    operatorId: link.operatorId,
    tokenHash: sha256(sessionToken),
    expiresAt: new Date(now.getTime() + OPS_PENDING_TTL_MS),
  });
  return opsCookie.serialize(sessionToken);
}

async function readOpsToken(request: Request): Promise<string | null> {
  const token = await opsCookie.parse(request.headers.get('Cookie'));
  return typeof token === 'string' && token ? token : null;
}

/** 当前的运营者会话（含尚未通过 TOTP 的）；没有或已过期返回 null */
async function getOperatorSession(request: Request) {
  const token = await readOpsToken(request);
  if (!token) return null;
  const [row] = await getDb()
    .select({
      sessionId: operatorSessions.id,
      verified: operatorSessions.totpVerifiedAt,
      operatorId: operators.id,
      email: operators.email,
      totpSecret: operators.totpSecret,
      totpConfirmedAt: operators.totpConfirmedAt,
    })
    .from(operatorSessions)
    .innerJoin(operators, eq(operators.id, operatorSessions.operatorId))
    .where(and(eq(operatorSessions.tokenHash, sha256(token)), gt(operatorSessions.expiresAt, new Date())));
  return row ?? null;
}

/** 运营后台页面入口处调用：未登录跳转运营者登录页，尚未通过 TOTP 跳转验证页 */
export async function requireOperator(request: Request): Promise<CurrentOperator> {
  const session = await getOperatorSession(request);
  if (!session) throw redirect('/ops/login');
  if (!session.verified) throw redirect('/ops/totp');
  return { operatorId: session.operatorId, email: session.email };
}

/** TOTP 验证页入口：只接受已通过 Magic Link、尚未通过 TOTP 的会话 */
async function requirePendingSession(request: Request) {
  const session = await getOperatorSession(request);
  if (!session) throw redirect('/ops/login');
  if (session.verified) throw redirect('/ops');
  return session;
}

/**
 * TOTP 验证页要展示的内容：尚未绑定时生成（或沿用未确认的）密钥与 otpauth 链接；已绑定时不再展示密钥
 */
export async function totpChallenge(request: Request) {
  const session = await requirePendingSession(request);
  if (session.totpConfirmedAt) return { email: session.email, setup: null };
  let secret = session.totpSecret;
  if (!secret) {
    const db = getDb();
    await db.update(operators).set({ totpSecret: generateSecret() }).where(and(eq(operators.id, session.operatorId), isNull(operators.totpSecret)));
    [{ totpSecret: secret }] = await db.select({ totpSecret: operators.totpSecret }).from(operators).where(eq(operators.id, session.operatorId));
  }
  return { email: session.email, setup: { secret: secret!, uri: otpauthUri(session.email, secret!) } };
}

export type TotpResult =
  | { ok: true; setCookie: string }
  | { ok: false; locked: false; error: string }
  | { ok: false; locked: true; setCookie: string };

/**
 * 校验 TOTP 验证码。首次通过即完成绑定。通过后换发会话令牌并延长到 8 小时；
 * 同一个验证码不能重复使用；连续输错 5 次则会话作废，须重新申请登录链接
 */
export async function verifyOperatorTotp(request: Request, code: string): Promise<TotpResult> {
  const session = await requirePendingSession(request);
  const now = new Date();
  return getDb().transaction(async tx => {
    const [operator] = await tx.select().from(operators).where(eq(operators.id, session.operatorId)).for('update');
    const step = operator.totpSecret ? verifyTotp(operator.totpSecret, code, now.getTime(), operator.totpLastStep) : null;

    if (step === null) {
      const [s] = await tx
        .update(operatorSessions)
        .set({ totpFailures: sql`${operatorSessions.totpFailures} + 1` })
        .where(eq(operatorSessions.id, session.sessionId))
        .returning({ failures: operatorSessions.totpFailures });
      if (s.failures < MAX_TOTP_FAILURES) return { ok: false, locked: false, error: '验证码不正确或已使用，请输入认证器 App 上的最新验证码。' };
      await tx.delete(operatorSessions).where(eq(operatorSessions.id, session.sessionId));
      return { ok: false, locked: true, setCookie: await opsCookie.serialize('', { maxAge: 0 }) };
    }

    const firstBinding = !operator.totpConfirmedAt;
    await tx
      .update(operators)
      .set({ totpLastStep: step, ...(firstBinding ? { totpConfirmedAt: now } : {}) })
      .where(eq(operators.id, operator.id));
    // 权限提升时换发令牌：待验证阶段的令牌即使泄露，也不能用来进入运营后台
    const token = newToken();
    await tx
      .update(operatorSessions)
      .set({ tokenHash: sha256(token), totpVerifiedAt: now, expiresAt: new Date(now.getTime() + OPS_SESSION_TTL_MS) })
      .where(eq(operatorSessions.id, session.sessionId));

    const actor = { operatorId: operator.id, email: operator.email };
    const event = { tenantId: null, operator: actor, targetType: 'operator', targetId: operator.id, detail: { email: operator.email } };
    if (firstBinding) await recordAudit(tx, { ...event, action: 'operator.totp_bound' });
    await recordAudit(tx, { ...event, action: 'operator.logged_in' });
    return { ok: true, setCookie: await opsCookie.serialize(token) };
  });
}

/** 注销：删除运营者会话并清除 cookie，返回 Set-Cookie 头 */
export async function logoutOperator(request: Request): Promise<string> {
  const token = await readOpsToken(request);
  if (token) await getDb().delete(operatorSessions).where(eq(operatorSessions.tokenHash, sha256(token)));
  return opsCookie.serialize('', { maxAge: 0 });
}

/**
 * 可选的 IP 白名单：配置 OPS_ALLOWED_CIDRS（逗号分隔的 CIDR 或单个地址）后，只允许白名单内的地址访问 /ops。
 * 客户端地址取 OPS_CLIENT_IP_HEADER（默认 X-Forwarded-For）的最后一项，即最近一层反向代理看到的地址；
 * 因此必须部署在会追加或覆盖该请求头的反向代理之后，否则可被伪造。取不到地址时一律拒绝
 */
export function assertOpsIpAllowed(request: Request) {
  const cidrs = process.env.OPS_ALLOWED_CIDRS?.split(',').map(s => s.trim()).filter(Boolean);
  if (!cidrs?.length) return;
  const header = request.headers.get(process.env.OPS_CLIENT_IP_HEADER || 'x-forwarded-for') ?? '';
  const ip = unmapIPv4(header.split(',').at(-1)?.trim() ?? '');
  const family = isIP(ip);
  if (!family || !allowList(cidrs).check(ip, family === 6 ? 'ipv6' : 'ipv4')) {
    throw data({ message: '当前网络不允许访问运营后台。' }, { status: 403 });
  }
}

/** ::ffff:10.1.2.3 → 10.1.2.3 */
const unmapIPv4 = (ip: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

function allowList(cidrs: string[]) {
  const list = new BlockList();
  for (const entry of cidrs) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`OPS_ALLOWED_CIDRS 中的地址不合法：${entry}`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

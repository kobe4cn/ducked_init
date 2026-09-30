// app/.server/tenants.ts —— 运营者管理租户元数据：开通（租户 + 默认空间 + 首个管理员）、改名、指定管理员、停用与恢复。
// 运营命令与运营后台调用同一套函数；每次操作都在同一事务里写入该租户的审计日志
import { and, asc, eq, sql } from 'drizzle-orm';
import { recordAudit, type OperatorActor, type Tx } from './audit';
import { linkOrigin, revokeTenantAccess } from './auth';
import { runInBackground } from './background';
import { getDb, isUniqueViolation } from './db/client';
import { members, ROLE_LABELS, spaces, tenants } from './db/schema';
import { getMailer } from './mailer';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 可以展示给运营者的业务错误（输入不合法、标识重复、租户不存在等），带对应的 HTTP 状态码 */
export class TenantError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 不合法的租户 ID 与不存在一样处理 */
function parseTenantId(tenantId: string) {
  if (!UUID.test(tenantId)) throw new TenantError('租户不存在', 404);
  return tenantId;
}

function parseName(raw: string) {
  const name = raw.trim();
  if (!name) throw new TenantError('租户名称不能为空');
  return name;
}

export interface CreateTenantInput { slug: string; name: string; adminEmail: string }

export async function createTenant(input: CreateTenantInput, operator: OperatorActor = null) {
  const slug = input.slug.trim();
  const name = parseName(input.name);
  const adminEmail = normalizeEmail(input.adminEmail);
  if (!SLUG.test(slug)) throw new TenantError(`租户标识不合法：${slug}（只允许小写字母、数字与连字符）`);
  if (!EMAIL.test(adminEmail)) throw new TenantError(`管理员邮箱不合法：${input.adminEmail}`);

  try {
    return await getDb().transaction(async tx => {
      const [tenant] = await tx.insert(tenants).values({ slug, name }).returning();
      const [space] = await tx.insert(spaces).values({ tenantId: tenant.id, name: '默认空间', isDefault: true }).returning();
      const [admin] = await tx.insert(members).values({ tenantId: tenant.id, email: adminEmail, role: 'admin' }).returning();
      await recordAudit(tx, {
        tenantId: tenant.id,
        operator,
        action: 'tenant.created',
        targetType: 'tenant',
        targetId: tenant.id,
        detail: { slug, name, adminEmail },
      });
      return { tenant, space, admin };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new TenantError(`租户标识已存在：${slug}`);
    throw e;
  }
}

// 租户元数据与成员统计：只给出成员数与管理员邮箱，不给出完整的成员名单（ADR-0007）
const tenantSummaries = () =>
  getDb()
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      createdAt: tenants.createdAt,
      suspendedAt: tenants.suspendedAt,
      suspensionReason: tenants.suspensionReason,
      memberCount: sql<number>`count(${members.id})::int`,
      adminEmails: sql<string[]>`coalesce(array_agg(${members.email} order by ${members.email}) filter (where ${members.role} = 'admin'), '{}')`,
    })
    .from(tenants)
    .leftJoin(members, eq(members.tenantId, tenants.id))
    .$dynamic();

export const listTenants = () =>
  tenantSummaries().groupBy(tenants.id).orderBy(asc(tenants.createdAt), asc(tenants.slug));

/** 单个租户的元数据；不存在时抛出 404 */
export async function getTenant(tenantId: string) {
  const [row] = await tenantSummaries().where(eq(tenants.id, parseTenantId(tenantId))).groupBy(tenants.id);
  if (!row) throw new TenantError('租户不存在', 404);
  return row;
}

/** 在事务内锁住租户行；不存在时抛出 404 */
async function lockTenant(tx: Tx, tenantId: string) {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, parseTenantId(tenantId))).for('update');
  if (!tenant) throw new TenantError('租户不存在', 404);
  return tenant;
}

export async function renameTenant(operator: OperatorActor, tenantId: string, rawName: string) {
  const name = parseName(rawName);
  await getDb().transaction(async tx => {
    const tenant = await lockTenant(tx, tenantId);
    if (tenant.name === name) return;
    await tx.update(tenants).set({ name }).where(eq(tenants.id, tenant.id));
    await recordAudit(tx, {
      tenantId: tenant.id,
      operator,
      action: 'tenant.renamed',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { from: tenant.name, to: name },
    });
  });
}

/**
 * 为租户指定管理员，用于管理员邮箱失效时的恢复：邮箱已是本租户成员则提升为管理员，否则以管理员身份加入。
 * 随后通知对方登录
 */
export async function assignTenantAdmin(operator: OperatorActor, tenantId: string, rawEmail: string, requestOrigin: string) {
  const email = normalizeEmail(rawEmail);
  if (!EMAIL.test(email)) throw new TenantError('邮箱格式不正确');
  const base = linkOrigin(requestOrigin);
  const mailer = getMailer();

  const tenant = await getDb().transaction(async tx => {
    const tenant = await lockTenant(tx, tenantId);
    const [existing] = await tx
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(and(eq(members.tenantId, tenant.id), eq(members.email, email)))
      .for('update');
    if (existing?.role === 'admin') throw new TenantError(`${email} 已是管理员`);

    const [admin] = existing
      ? await tx.update(members).set({ role: 'admin' }).where(eq(members.id, existing.id)).returning()
      : await tx.insert(members).values({ tenantId: tenant.id, email, role: 'admin' }).returning();
    await recordAudit(tx, {
      tenantId: tenant.id,
      operator,
      action: 'tenant.admin_assigned',
      targetType: 'member',
      targetId: admin.id,
      detail: { email, from: existing?.role ?? null },
    });
    return tenant;
  });

  runInBackground('发送管理员指定通知', () =>
    mailer.send({
      to: email,
      subject: `你已成为 ${tenant.name} 的管理员 · CRM 数据分析平台`,
      text: [
        `平台运营者已将你指定为 ${tenant.name} 的「${ROLE_LABELS.admin}」。`,
        '',
        `在登录页输入本邮箱即可收到一次性登录链接：${new URL('/login', base)}`,
      ].join('\n'),
    }),
  );
}

/**
 * 停用租户：必须填写原因。该租户成员的会话与未使用的登录链接随即作废，之后也申请不到这个租户的登录链接。
 * 数据完整保留，恢复后成员重新登录即可
 */
export async function suspendTenant(operator: OperatorActor, tenantId: string, rawReason: string) {
  const reason = rawReason.trim();
  if (!reason) throw new TenantError('请填写停用原因');
  await getDb().transaction(async tx => {
    const tenant = await lockTenant(tx, tenantId);
    if (tenant.suspendedAt) throw new TenantError('租户已停用');
    await tx.update(tenants).set({ suspendedAt: new Date(), suspensionReason: reason }).where(eq(tenants.id, tenant.id));
    await revokeTenantAccess(tx, tenant.id);
    await recordAudit(tx, {
      tenantId: tenant.id,
      operator,
      action: 'tenant.suspended',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { reason },
    });
  });
}

/** 恢复租户：停用时会话已全部作废，成员需要重新登录 */
export async function resumeTenant(operator: OperatorActor, tenantId: string) {
  await getDb().transaction(async tx => {
    const tenant = await lockTenant(tx, tenantId);
    if (!tenant.suspendedAt) throw new TenantError('租户未停用');
    await tx.update(tenants).set({ suspendedAt: null, suspensionReason: null }).where(eq(tenants.id, tenant.id));
    await revokeTenantAccess(tx, tenant.id);
    await recordAudit(tx, {
      tenantId: tenant.id,
      operator,
      action: 'tenant.resumed',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { suspensionReason: tenant.suspensionReason },
    });
  });
}

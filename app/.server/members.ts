// app/.server/members.ts —— 租户管理员管理成员：邀请（指定角色）、修改角色、移除。一律限定在操作者所属租户内
import { and, asc, eq } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import { linkOrigin, type CurrentMember } from './auth';
import { runInBackground } from './background';
import { getDb } from './db/client';
import { members, ROLE_LABELS, ROLES, type Role } from './db/schema';
import { getMailer } from './mailer';
import { EMAIL, normalizeEmail } from './tenants';

/** 可以展示给管理员的业务错误（输入不合法、目标不存在、会让租户失去管理员等），带对应的 HTTP 状态码 */
export class MemberError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

function parseRole(value: string): Role {
  if (!isRole(value)) throw new MemberError('请选择有效的角色');
  return value;
}

export async function listMembers(actor: CurrentMember) {
  assertCan(actor, 'members:manage');
  return getDb()
    .select({ id: members.id, email: members.email, role: members.role, createdAt: members.createdAt })
    .from(members)
    .where(eq(members.tenantId, actor.tenant.id))
    .orderBy(asc(members.createdAt), asc(members.email));
}

/** 邀请：以指定角色把邮箱加入本租户（这是成为成员的唯一途径），并通知对方登录 */
export async function inviteMember(actor: CurrentMember, input: { email: string; role: string }, requestOrigin: string) {
  assertCan(actor, 'members:manage');
  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email)) throw new MemberError('邮箱格式不正确');
  const role = parseRole(input.role);
  const base = linkOrigin(requestOrigin);
  const mailer = getMailer();

  const invited = await getDb().transaction(async tx => {
    const [row] = await tx
      .insert(members)
      .values({ tenantId: actor.tenant.id, email, role })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new MemberError(`${email} 已是本租户成员`);
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'member.invited',
      targetType: 'member',
      targetId: row.id,
      detail: { email, role },
    });
    return row;
  });

  runInBackground('发送邀请邮件', () =>
    mailer.send({
      to: email,
      subject: `邀请你加入 ${actor.tenant.name} · CRM 数据分析平台`,
      text: [
        `${actor.email} 邀请你以「${ROLE_LABELS[role]}」角色加入 ${actor.tenant.name}。`,
        '',
        `在登录页输入本邮箱即可收到一次性登录链接：${new URL('/login', base)}`,
      ].join('\n'),
    }),
  );
  return invited;
}

/**
 * 在事务内锁住本租户的管理员与目标成员，确保变更后租户至少还有一名管理员。
 * 目标不在本租户时与不存在一样处理，不泄露其他租户的成员。
 */
async function lockTarget(tx: Tx, actor: CurrentMember, memberId: string) {
  const rows = await tx
    .select({ id: members.id, email: members.email, role: members.role })
    .from(members)
    .where(eq(members.tenantId, actor.tenant.id))
    .for('update');
  const target = rows.find(r => r.id === memberId);
  if (!target) throw new MemberError('成员不存在', 404);
  const adminCount = rows.filter(r => r.role === 'admin').length;
  /** 目标将不再是管理员时调用：确保租户至少还有一名管理员 */
  const assertAnotherAdmin = () => {
    if (target.role === 'admin' && adminCount <= 1) throw new MemberError('租户至少需要保留一名管理员');
  };
  return { target, assertAnotherAdmin };
}

export async function changeMemberRole(actor: CurrentMember, memberId: string, rawRole: string) {
  assertCan(actor, 'members:manage');
  const role = parseRole(rawRole);
  await getDb().transaction(async tx => {
    const { target, assertAnotherAdmin } = await lockTarget(tx, actor, memberId);
    if (target.role === role) return;
    assertAnotherAdmin();
    await tx.update(members).set({ role }).where(and(eq(members.id, target.id), eq(members.tenantId, actor.tenant.id)));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'member.role_changed',
      targetType: 'member',
      targetId: target.id,
      detail: { email: target.email, from: target.role, to: role },
    });
  });
}

/** 移除成员：会话随成员记录级联删除，已登录的浏览器下一次请求即失效 */
export async function removeMember(actor: CurrentMember, memberId: string) {
  assertCan(actor, 'members:manage');
  await getDb().transaction(async tx => {
    const { target, assertAnotherAdmin } = await lockTarget(tx, actor, memberId);
    assertAnotherAdmin();
    // 先写审计再删除：管理员移除自己时，审计记录的操作者外键随后置空，邮箱仍保留
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'member.removed',
      targetType: 'member',
      targetId: target.id,
      detail: { email: target.email, role: target.role },
    });
    await tx.delete(members).where(and(eq(members.id, target.id), eq(members.tenantId, actor.tenant.id)));
  });
}

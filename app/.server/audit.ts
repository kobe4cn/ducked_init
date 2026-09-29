// app/.server/audit.ts —— 审计日志：记录关键操作，管理员按租户查看
import { desc, eq } from 'drizzle-orm';
import type { CurrentMember } from './auth';
import { getDb, type Db } from './db/client';
import { auditLogs, ROLE_LABELS, type Role } from './db/schema';

type Detail = Record<string, unknown>;
const roleLabel = (role: unknown) => ROLE_LABELS[role as Role] ?? String(role);

// 每种审计动作的名称，以及把明细写成一句话的方式；新增动作只改这里
const ACTIONS = {
  'tenant.created': { label: '开通租户', describe: (d: Detail) => `租户「${d.name}」，首个管理员 ${d.adminEmail}` },
  'member.invited': { label: '邀请成员', describe: (d: Detail) => `${d.email}，角色：${roleLabel(d.role)}` },
  'member.role_changed': { label: '修改角色', describe: (d: Detail) => `${d.email}：${roleLabel(d.from)} → ${roleLabel(d.to)}` },
  'member.removed': { label: '移除成员', describe: (d: Detail) => `${d.email}（原角色：${roleLabel(d.role)}）` },
} satisfies Record<string, { label: string; describe: (d: Detail) => string }>;
export type AuditAction = keyof typeof ACTIONS;

export const AUDIT_PAGE_SIZE = 200;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AuditEntry {
  tenantId: string;
  /** 为空表示运营者 */
  actor: Pick<CurrentMember, 'memberId' | 'email'> | null;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/** 与被审计的变更放在同一事务里写入：变更成功则一定留下记录 */
export async function recordAudit(tx: Tx | Db, entry: AuditEntry) {
  await tx.insert(auditLogs).values({
    tenantId: entry.tenantId,
    actorMemberId: entry.actor?.memberId ?? null,
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? {},
  });
}

/** 本租户最近的审计记录（按时间倒序），已转成可展示的文字 */
export async function listAuditLogs(tenantId: string) {
  const rows = await getDb()
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, tenantId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_PAGE_SIZE);
  return rows.map(r => {
    const action = ACTIONS[r.action as AuditAction];
    return {
      id: r.id,
      at: r.createdAt,
      actor: r.actorEmail ?? '运营者',
      action: action?.label ?? r.action,
      summary: action ? action.describe(r.detail) : JSON.stringify(r.detail),
    };
  });
}

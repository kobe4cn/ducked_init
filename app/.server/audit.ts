// app/.server/audit.ts —— 审计日志：记录关键操作。租户管理员按租户查看；运营者的操作与平台级事件在运营后台查看
import { desc, eq } from 'drizzle-orm';
import type { CurrentMember } from './auth';
import { getDb, type Db } from './db/client';
import { auditLogs, ROLE_LABELS, SOURCE_KIND_LABELS, tenants, type Role, type SourceKind } from './db/schema';
import { TEMPLATES } from './pipeline/templates';
import { describeQuotaChange, type TenantQuota } from './quota';
import { entityLabel } from '../lib/canonical-model';

type Detail = Record<string, unknown>;
const sourceKindLabel = (kind: unknown) => SOURCE_KIND_LABELS[kind as SourceKind] ?? String(kind);
const roleLabel = (role: unknown) => ROLE_LABELS[role as Role] ?? String(role);
const templateLabel = (template: unknown) => TEMPLATES[template as keyof typeof TEMPLATES]?.label ?? String(template);
const dslLabel = (d: Detail) => (d.kind === 'tag' ? '标签' : '指标');


// 每种审计动作的名称，以及把明细写成一句话的方式；新增动作只改这里
const ACTIONS = {
  'tenant.created': { label: '开通租户', describe: (d: Detail) => `租户「${d.name}」，首个管理员 ${d.adminEmail}` },
  'tenant.renamed': { label: '租户改名', describe: (d: Detail) => `${d.from} → ${d.to}` },
  'tenant.admin_assigned': {
    label: '指定管理员',
    describe: (d: Detail) => `${d.email}（${d.from ? `原角色：${roleLabel(d.from)}` : '新增'}）`,
  },
  'tenant.suspended': { label: '停用租户', describe: (d: Detail) => `原因：${d.reason}` },
  'tenant.resumed': { label: '恢复租户', describe: (d: Detail) => `原因：${d.reason}` },
  'tenant.lake_initialized': { label: '初始化数据湖', describe: (d: Detail) => `catalog ${d.catalogSchema}` },
  'tenant.s3_account_created': { label: '建立对象存储账号', describe: (d: Detail) => `${d.s3User}，只能访问 ${d.dataPath}` },
  'tenant.lake_migration_started': { label: '开始迁移数据湖', describe: (d: Detail) => `${d.from} → ${d.to}` },
  'tenant.lake_migrated': {
    label: '数据湖迁移完成',
    describe: (d: Detail) =>
      `${d.from} → ${d.to}，复制 ${d.files} 个文件（${d.bytes} 字节）；旧位置的文件未删除，确认后另行清理${d.warning ? `。注意：${d.warning}` : ''}`,
  },
  'tenant.lake_migration_failed': { label: '数据湖迁移失败', describe: (d: Detail) => `${d.from} → ${d.to}：${d.error}（仍使用原位置，可重试）` },
  'tenant.lake_reset': {
    label: '重置数据湖',
    describe: (d: Detail) => `清空 catalog ${d.catalogSchema} 与 ${d.dataPath} 下的 ${d.files} 个文件，已重新初始化`,
  },
  'tenant.quota_changed': { label: '调整配额', describe: (d: Detail) => describeQuotaChange(d.from as TenantQuota, d.to as TenantQuota) },
  'member.invited': { label: '邀请成员', describe: (d: Detail) => `${d.email}，角色：${roleLabel(d.role)}` },
  'member.role_changed': { label: '修改角色', describe: (d: Detail) => `${d.email}：${roleLabel(d.from)} → ${roleLabel(d.to)}` },
  'member.removed': { label: '移除成员', describe: (d: Detail) => `${d.email}（原角色：${roleLabel(d.role)}）` },
  'source.registered': { label: '登记数据源', describe: (d: Detail) => `「${d.name}」（${sourceKindLabel(d.kind)}），${d.tables} 张表` },
  'source.updated': {
    label: '修改数据源',
    describe: (d: Detail) => [
      `「${d.name}」`,
      d.renamedFrom ? `由「${d.renamedFrom}」改名` : '',
      (d.changed as string[] | undefined)?.length ? `修改 ${(d.changed as string[]).join('、')}` : '',
      d.credentialsRotated ? '轮换凭据' : '',
    ].filter(Boolean).join('，'),
  },
  'source.scope_changed': {
    label: '修改同步范围',
    describe: (d: Detail) => [
      `「${d.name}」`,
      (d.added as string[]).length ? `选入 ${(d.added as string[]).join('、')}` : '',
      (d.removed as string[]).length ? `移出 ${(d.removed as string[]).join('、')}` : '',
    ].filter(Boolean).join('，'),
  },
  'source.watermark_confirmed': { label: '确认水位线', describe: (d: Detail) => `「${d.name}」${d.table}：${d.column}` },
  'source.key_confirmed': { label: '确认业务主键', describe: (d: Detail) => `「${d.name}」${d.table}：${d.column}` },
  'source.soft_delete_confirmed': { label: '确认软删除字段', describe: (d: Detail) => `「${d.name}」${d.table}：${d.column}` },
  'mapping.drafted': {
    label: '起草映射',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，第 ${d.version} 版草稿`,
  },
  'mapping.published': {
    label: '发布映射',
    describe: (d: Detail) =>
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'mapping.draft_discarded': {
    label: '丢弃映射草稿',
    describe: (d: Detail) =>
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '映射已删除'}`,
  },
  'template.drafted': { label: '起草模板参数', describe: (d: Detail) => `${templateLabel(d.template)}，第 ${d.version} 版草稿` },
  'definition.drafted': { label: '起草指标或标签', describe: (d: Detail) => `${dslLabel(d)} ${d.key}，第 ${d.version} 版草稿` },
  'definition.published': {
    label: '发布指标或标签',
    describe: (d: Detail) => `${dslLabel(d)} ${d.key}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'definition.draft_discarded': {
    label: '丢弃指标或标签草稿',
    describe: (d: Detail) => `${dslLabel(d)} ${d.key}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '定义已删除'}`,
  },
  'definition.deleted': { label: '删除指标或标签', describe: (d: Detail) => `${dslLabel(d)} ${d.key}` },
  'definition.backfilled': {
    label: '回刷指标或标签',
    describe: (d: Detail) => {
      const tags = d.tags as string[];
      return `${dslLabel(d)} ${d.key}，按第 ${d.version} 版回刷 ${(d.days as string[]).join('、')}${tags.length ? `，连同标签 ${tags.join('、')}` : ''}`;
    },
  },
  'template.published': {
    label: '发布模板参数',
    describe: (d: Detail) => `${templateLabel(d.template)}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'template.recomputed': {
    label: '重新计算模板',
    describe: (d: Detail) => `${templateLabel(d.template)}，按第 ${d.version} 版参数，参考日期 ${d.asOf}`,
  },
  'template.draft_discarded': {
    label: '丢弃模板参数草稿',
    describe: (d: Detail) => `${templateLabel(d.template)}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '回到默认参数'}`,
  },
  'source_view.drafted': { label: '起草源视图', describe: (d: Detail) => `「${d.source}」${d.name}，第 ${d.version} 版草稿` },
  'source_view.published': {
    label: '发布源视图',
    describe: (d: Detail) => `「${d.source}」${d.name}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'source_view.draft_discarded': {
    label: '丢弃源视图草稿',
    describe: (d: Detail) => `「${d.source}」${d.name}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '源视图已删除'}`,
  },
  'custom_entity.drafted': { label: '起草自定义实体', describe: (d: Detail) => `${d.name}，第 ${d.version} 版草稿` },
  'custom_entity.published': {
    label: '发布自定义实体',
    describe: (d: Detail) => `${d.name}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'custom_entity.draft_discarded': {
    label: '丢弃自定义实体草稿',
    describe: (d: Detail) => `${d.name}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '自定义实体已删除'}`,
  },
  'custom_entity.deleted': { label: '删除自定义实体', describe: (d: Detail) => `${d.name}` },
  // 只记定位记录的主键与原因，不记明文
  'pii.revealed': {
    label: '解密敏感信息',
    describe: (d: Detail) =>
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，主键 ${Object.entries(d.key as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join('，')}，`
      + `字段 ${(d.fields as string[]).join('、')}；原因：${d.reason}`,
  },
  // 平台级事件：不属于任何租户，只在运营后台可见
  'operator.created': { label: '新增运营者', describe: (d: Detail) => `${d.email}` },
  'operator.totp_bound': { label: '绑定 TOTP', describe: (d: Detail) => `${d.email}` },
  'operator.totp_reset': { label: '重置 TOTP', describe: (d: Detail) => `${d.email}` },
  'operator.logged_in': { label: '运营者登录', describe: (d: Detail) => `${d.email}` },
} satisfies Record<string, { label: string; describe: (d: Detail) => string }>;
export type AuditAction = keyof typeof ACTIONS;

export const AUDIT_PAGE_SIZE = 200;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** 运营者身份；经运营命令操作时没有运营者身份，用 null 表示 */
export type OperatorActor = { operatorId: string; email: string } | null;

export type AuditEntry = {
  action: AuditAction;
  targetType: string;
  targetId?: string;
  detail?: Record<string, unknown>;
} & (
  | { tenantId: string; actor: Pick<CurrentMember, 'memberId' | 'email'> }
  /** 运营者的操作；tenantId 为 null 表示与租户无关的平台级事件 */
  | { tenantId: string | null; operator: OperatorActor }
);

/** 与被审计的变更放在同一事务里写入：变更成功则一定留下记录 */
export async function recordAudit(tx: Tx | Db, entry: AuditEntry) {
  const actor = 'actor' in entry
    ? { actorType: 'member' as const, actorMemberId: entry.actor.memberId, actorEmail: entry.actor.email }
    : { actorType: 'operator' as const, actorOperatorId: entry.operator?.operatorId ?? null, actorEmail: entry.operator?.email ?? null };
  await tx.insert(auditLogs).values({
    tenantId: entry.tenantId,
    ...actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    detail: entry.detail ?? {},
  });
}

type AuditRow = typeof auditLogs.$inferSelect;

function present(r: AuditRow) {
  const action = ACTIONS[r.action as AuditAction];
  return {
    id: r.id,
    at: r.createdAt,
    actor: r.actorType === 'operator' ? (r.actorEmail ? `运营者 ${r.actorEmail}` : '运营者（运营命令）') : (r.actorEmail ?? ''),
    action: action?.label ?? r.action,
    summary: action ? action.describe(r.detail) : JSON.stringify(r.detail),
  };
}

/** 本租户最近的审计记录（按时间倒序），已转成可展示的文字。平台级事件的租户为空，不会出现在这里 */
export async function listAuditLogs(tenantId: string) {
  const rows = await getDb()
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, tenantId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_PAGE_SIZE);
  return rows.map(present);
}

/**
 * 运营后台：运营者的操作（对各租户的操作与平台级事件），按时间倒序。
 * 只取运营者的记录：成员在租户内的操作会暴露成员名单，运营者看不到
 */
export async function listOperatorAuditLogs() {
  const rows = await getDb()
    .select({ log: auditLogs, tenantName: tenants.name })
    .from(auditLogs)
    .leftJoin(tenants, eq(tenants.id, auditLogs.tenantId))
    .where(eq(auditLogs.actorType, 'operator'))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_PAGE_SIZE);
  return rows.map(r => ({ ...present(r.log), tenant: r.tenantName }));
}

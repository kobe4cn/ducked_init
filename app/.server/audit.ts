// app/.server/audit.ts —— 审计日志：记录关键操作。租户管理员按租户查看；运营者的操作与平台级事件在运营后台查看
import { desc, eq } from 'drizzle-orm';
import type { CurrentMember } from './auth';
import { getDb, type Db } from './db/client';
import { auditLogs, ROLE_LABELS, SOURCE_KIND_LABELS, tenants, type Role, type SourceKind } from './db/schema';
import { describeBroken } from './pipeline/schema-diff';
import { TEMPLATES } from './pipeline/templates';
import { describeQuotaChange, type TenantQuota } from './quota';
import type { BrokenMapping } from './schema-alerts';
import type { NewFallback } from './fallback-alerts';
import { entityLabel } from '../lib/canonical-model';

type Detail = Record<string, unknown>;
const sourceKindLabel = (kind: unknown) => SOURCE_KIND_LABELS[kind as SourceKind] ?? String(kind);
const roleLabel = (role: unknown) => ROLE_LABELS[role as Role] ?? String(role);
const templateLabel = (template: unknown) => TEMPLATES[template as keyof typeof TEMPLATES]?.label ?? String(template);
const apiKeyLabel = (d: Detail) => `「${d.name}」（${d.prefix}…）`;
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
  // 只记名称与前缀，明文只在创建那次响应里出现
  'api_key.created': { label: '创建 API Key', describe: apiKeyLabel },
  'api_key.revoked': { label: '吊销 API Key', describe: apiKeyLabel },
  // 不记 API Key，只记是否轮换；单独开关发送脱敏样本时只记 allowSamples
  'model_provider.updated': {
    label: '修改模型服务',
    describe: (d: Detail) => ('allowSamples' in d
      ? `${d.allowSamples ? '打开' : '关闭'}发送脱敏样本`
      : `${d.baseUrl}，模型 ${d.model}${d.credentialsRotated ? '，轮换 API Key' : ''}`),
  },
  'model_provider.reset': { label: '恢复平台默认模型服务', describe: () => '清空本租户的端点、模型名与 API Key' },
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
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、') || '平台'}）`,
  },
  'mapping.draft_discarded': {
    label: '丢弃映射草稿',
    describe: (d: Detail) =>
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '映射已删除'}`,
  },
  'mapping.disable_requested': {
    label: '提议停用映射',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}`,
  },
  'mapping.disabled': {
    label: '停用映射',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，提议人 ${d.requestedBy}、确认人 ${d.confirmedBy}`,
  },
  'mapping.restored': {
    label: '恢复映射',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，第 ${d.version} 版`,
  },
  'mapping.column_ignored': {
    label: '忽略源表新列',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，忽略新列 ${d.column}`,
  },
  // 模型输出不合 Schema、请求失败或转出的映射不过校验（ADR-0035）：只记阶段、错误摘要与问题位置，不记提示词、模型原文与取值
  'mapping.model_draft_failed': {
    label: '模型生成映射草稿失败',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，${d.stage === 'model'
      ? `模型服务：${d.error}`
      : `映射校验有 ${d.issues} 处问题`}`,
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
  'definition.recomputed': {
    label: '重新计算指标或标签',
    describe: (d: Detail) => {
      const tags = d.tags as string[];
      return `${dslLabel(d)} ${d.key}，按第 ${d.version} 版重新计算 ${d.asOf}${tags.length ? `，连同标签 ${tags.join('、')}` : ''}`;
    },
  },
  'definition.refreshed': {
    label: '定时刷新指标或标签',
    describe: (d: Detail) => {
      const tags = d.tags as string[];
      return `${dslLabel(d)} ${d.key}，按第 ${d.version} 版刷新 ${d.asOf}${tags.length ? `，连同标签 ${tags.join('、')}` : ''}`;
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
  'template.refreshed': {
    label: '定时刷新模板',
    describe: (d: Detail) => `${templateLabel(d.template)}，按第 ${d.version} 版参数刷新 ${d.asOf}`,
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
  'merge_group.saved': {
    label: '保存合并组草稿',
    describe: (d: Detail) => `${entityLabel(String(d.entity))}，第 ${d.version} 版草稿，${(d.members as string[]).length} 个映射，${d.rule}`,
  },
  'merge_group.published': {
    label: '发布合并组',
    describe: (d: Detail) => `${entityLabel(String(d.entity))}，第 ${d.version} 版（作者 ${(d.authors as string[]).join('、')}）`,
  },
  'merge_group.draft_discarded': {
    label: '丢弃合并组草稿',
    describe: (d: Detail) => `${entityLabel(String(d.entity))}，丢弃第 ${d.version} 版草稿，${d.published ? `回到第 ${d.published} 版` : '合并组已删除'}`,
  },
  // 只记定位记录的主键与原因，不记明文
  'pii.revealed': {
    label: '解密敏感信息',
    describe: (d: Detail) =>
      `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，主键 ${Object.entries(d.key as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join('，')}，`
      + `字段 ${(d.fields as string[]).join('、')}；原因：${d.reason}`,
  },
  // 平台在结果层任务计算前发现的数据质量问题（ADR-0026）：只记断言名、实体与行数，不记行内容
  'assertion.failed': {
    label: '断言失败',
    describe: (d: Detail) => `${d.task}：${(d.summaries as string[]).join('；')}，未产出新快照，继续使用上一版`,
  },
  // 平台在同步时发现源表删了列或破坏性改了类型，且已发布映射引用了这些列（ADR-0034）：只记映射、表与列名
  'source.schema_broken': {
    label: '源表结构变化影响映射',
    describe: (d: Detail) => `「${d.source}」${(d.mappings as BrokenMapping[])
      .map(m => `${m.table} → ${entityLabel(m.entity)}：${describeBroken(m)}`)
      .join('；')}，这些映射的合并会失败`,
  },
  // 平台在源列改名后按规则起草的修复草稿（ADR-0034）：只记列名，不记取值；草稿仍要成员空跑并发布
  'mapping.repair_drafted': {
    label: '平台起草修复草稿',
    describe: (d: Detail) => `「${d.source}」${d.table} → ${entityLabel(String(d.entity))}，第 ${d.version} 版草稿：${(d.renames as { from: string; to: string }[])
      .map(r => `${r.from} 改为 ${r.to}`).join('、')}`,
  },
  // 平台在合并后发现值字典里没写、落入兜底的新取值（ADR-0015）：只记映射、列与新取值的个数，不记取值
  'mapping.fallback_new': {
    label: '出现新的兜底取值',
    describe: (d: Detail) => `${d.task}：${(d.mappings as NewFallback[])
      .map(m => `${m.table} → ${entityLabel(m.entity)} 的 ${m.columns.map(c => `${c.column} ${c.count} 个`).join('、')}`)
      .join('；')}新取值落入兜底`,
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
  /** 平台自己发现的事件，没有操作者 */
  | { tenantId: string; system: true }
);

/** 与被审计的变更放在同一事务里写入：变更成功则一定留下记录 */
export async function recordAudit(tx: Tx | Db, entry: AuditEntry) {
  const actor = 'actor' in entry
    ? { actorType: 'member' as const, actorMemberId: entry.actor.memberId, actorEmail: entry.actor.email }
    : 'system' in entry
      ? { actorType: 'system' as const }
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
    actor: r.actorType === 'operator' ? (r.actorEmail ? `运营者 ${r.actorEmail}` : '运营者（运营命令）') : r.actorType === 'system' ? '平台' : (r.actorEmail ?? ''),
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

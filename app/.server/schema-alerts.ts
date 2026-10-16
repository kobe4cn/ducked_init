// app/.server/schema-alerts.ts —— 源表结构变化告警（ADR-0034）：同步发现源表删了列或破坏性改了类型、且已发布映射引用了这些列时，
// 给租户里能改数据源与映射（sources:write）的成员发邮件并记一条平台审计。只写映射、表与列名，不写取值。
// 这些映射之后的合并会因合并前的结构检查失败（merge-engine.ts checkSourceSchema），邮件提前说明原因。
// 有被删除的列时再给这些表入队一次带 repairFor 的采集，采集完后平台按规则起草修复草稿（schema-repair-drafts.ts）
// 发信给能改映射的成员（mailSourceWriters）与邮件里的页面链接（appLink）也给修复草稿与新的兜底取值告警（fallback-alerts.ts）共用
import { and, eq } from 'drizzle-orm';
import { can } from './access';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { members, sources } from './db/schema';
import { getMailer } from './mailer';
import { publishedPlans } from './mappings';
import { referencedSourceColumns } from './pipeline/mapping-spec';
import { type BrokenColumns, describeBroken, isBreaking, type SchemaDiff } from './pipeline/schema-diff';
import type { SyncRecord } from './pipeline/sync-engine';
import { enqueueTask } from './tasks';
import { entityLabel } from '../lib/canonical-model';

/** 受影响的映射：引用了被删除或破坏性改类型的列 */
export interface BrokenMapping extends BrokenColumns { mapping: string; entity: string; table: string }

/** 同步任务结果里各表的破坏性变化与这个数据源已发布（未停用、读源表）映射引用的列求交；有交集时告警，没有时什么也不做。单个成员发信失败只记日志 */
export async function alertSchemaBreak(tenantId: string, task: { id: string; params: Record<string, unknown> }, result: Record<string, unknown> | undefined) {
  const sourceId = String(task.params.sourceId);
  const changes = new Map<string, SchemaDiff>();
  for (const r of (result?.tables as SyncRecord[] | undefined) ?? []) {
    if ('schema' in r && r.schema?.changed) changes.set(r.table, r.schema);
  }
  if (!changes.size) return;
  const broken: BrokenMapping[] = [];
  for (const plan of await publishedPlans(getDb(), tenantId)) {
    const diff = changes.get(plan.table);
    if (plan.sourceId !== sourceId || plan.view || !diff) continue;
    const used = referencedSourceColumns(plan);
    const removed = diff.removed.filter(c => used.has(c));
    const typeChanged = diff.typeChanged.filter(c => used.has(c.name) && isBreaking(c.from, c.to)).map(({ name, from, to }) => ({ name, from, to }));
    if (removed.length || typeChanged.length) broken.push({ mapping: plan.mapping, entity: plan.entity, table: plan.table, removed, typeChanged });
  }
  if (!broken.length) return;
  const [source] = await getDb().select({ name: sources.name }).from(sources).where(and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId)));
  const sourceName = source?.name ?? sourceId;
  await recordAudit(getDb(), {
    tenantId, system: true, action: 'source.schema_broken', targetType: 'source', targetId: sourceId,
    detail: { source: sourceName, task: task.id, mappings: broken },
  });
  // 起草修复要用改名后的列统计，checkMappingDraft 也按最新采集的列校验：先重新采集有列被删除的表
  const repairing = [...new Set(broken.filter(b => b.removed.length).map(b => b.table))];
  if (repairing.length) {
    await enqueueTask(tenantId, 'source.profile', { sourceId, tables: repairing, repairFor: task.id })
      .catch(e => console.error(`[告警] 给数据源 ${sourceId} 入队起草修复前的采集出错`, e));
  }
  const text = [
    `数据源「${sourceName}」同步时发现源表结构变了（同步任务 ${task.id}），下面这些已发布映射引用的列受影响，它们的合并会失败，标准层保留上一次合并的结果：`,
    '',
    ...broken.map(b => `- ${b.table} → ${entityLabel(b.entity)}（映射 ${b.mapping}）：${describeBroken(b)}`),
    '',
    '请修改映射后重新发布，或在源端恢复这些列。',
    ...(repairing.length ? ['', '平台会按规则尝试起草修复草稿（猜测被删除的列是否改了名），起草后另发邮件。'] : []),
  ].join('\n');
  await mailSourceWriters(tenantId, `源表结构变化影响映射：${sourceName}`, text);
}

/** 给租户里能改数据源与映射（sources:write）的成员各发一封邮件；单个成员发信失败只记日志 */
export async function mailSourceWriters(tenantId: string, subject: string, text: string) {
  const recipients = (await getDb().select({ email: members.email, role: members.role }).from(members).where(eq(members.tenantId, tenantId)))
    .filter(m => can(m.role, 'sources:write'));
  for (const { email } of recipients) {
    await getMailer().send({ to: email, subject, text })
      .catch(e => console.error(`[告警] 给 ${email} 发「${subject}」邮件出错`, e));
  }
}

/** 告警邮件里平台页面的链接：APP_URL（去掉末尾的 /）加路径；没配 APP_URL 时只有路径 */
export const appLink = (path: string) => `${process.env.APP_URL?.replace(/\/+$/, '') ?? ''}${path}`;

// app/.server/knowledge/subjects.ts —— 分析主题与主题归属（ADR-0046）：成员建的多对多分类，只用来检索加权和区分口径。
// 主题本身不是目录条目，只有被归属的条目（实体、字段、已发布指标与标签，不到映射字段）在 knowledge.subjects 里显示主题名。
// 一律要 definitions:draft，限定在操作者所属租户内。归属是当前状态表：加入插一行、移出删掉，删主题时归属一起删（外键 cascade）；
// 历史靠审计（detail 只有 subjectId 与 targetId，不记主题名）。五个动作都在同一事务里记一版目录，目录没变（如删没有归属的主题）时不记
import { and, eq, sql } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { getDb, isUniqueViolation } from '../db/client';
import { analysisSubjects, subjectMemberships } from '../db/schema';
import { UUID } from '../tenants';
import { cmpName } from '../../lib/compare';
import { assertTarget, KnowledgeError } from './basis';

export const SUBJECT_NAME_MAX_LENGTH = 30;

export interface Subject { id: string; name: string }

type Db = Tx | ReturnType<typeof getDb>;

/** 去掉首尾空白后 1–SUBJECT_NAME_MAX_LENGTH 字 */
function subjectName(name: unknown): string {
  if (typeof name !== 'string') throw new KnowledgeError('缺少主题名');
  const trimmed = name.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > SUBJECT_NAME_MAX_LENGTH) throw new KnowledgeError(`主题名去掉首尾空白后要 1–${SUBJECT_NAME_MAX_LENGTH} 字`);
  return trimmed;
}

/** 同租户（不分大小写）已有这个名字时 400；except 是改名时的主题自己 */
async function assertNameFree(tx: Tx, tenantId: string, name: string, except?: string) {
  const rows = await tx.select({ id: analysisSubjects.id }).from(analysisSubjects)
    .where(and(eq(analysisSubjects.tenantId, tenantId), sql`lower(${analysisSubjects.name}) = lower(${name})`));
  if (rows.some(r => r.id !== except)) throw new KnowledgeError(`已有主题「${name}」`);
}

/** 本租户的这个主题（加行锁）；不是 UUID、不存在或属于别的租户时 400 */
async function subjectOf(tx: Tx, tenantId: string, subjectId: unknown) {
  const [row] = typeof subjectId === 'string' && UUID.test(subjectId)
    ? await tx.select().from(analysisSubjects)
      .where(and(eq(analysisSubjects.id, subjectId), eq(analysisSubjects.tenantId, tenantId))).for('update')
    : [];
  if (!row) throw new KnowledgeError('没有这个主题');
  return row;
}

/** 在事务里跑；并发造成的唯一冲突转成 400 */
async function inTx<T>(dupMessage: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await getDb().transaction(fn);
  } catch (e) {
    if (isUniqueViolation(e)) throw new KnowledgeError(dupMessage);
    throw e;
  }
}

/** 新建主题，返回主题 ID */
export async function createSubject(actor: CurrentMember, name: unknown): Promise<string> {
  assertCan(actor, 'definitions:draft');
  const trimmed = subjectName(name);
  const tenantId = actor.tenant.id;
  return inTx(`已有主题「${trimmed}」`, async tx => {
    await assertNameFree(tx, tenantId, trimmed);
    const [row] = await tx.insert(analysisSubjects).values({ tenantId, name: trimmed, createdByEmail: actor.email })
      .returning({ id: analysisSubjects.id });
    await recordAudit(tx, { tenantId, actor, action: 'analysis_subject.created', targetType: 'analysis_subject', targetId: row.id, detail: { subjectId: row.id } });
    return row.id;
  });
}

/** 改主题名；相关条目上的主题名一起变 */
export async function renameSubject(actor: CurrentMember, subjectId: unknown, name: unknown): Promise<void> {
  assertCan(actor, 'definitions:draft');
  const trimmed = subjectName(name);
  const tenantId = actor.tenant.id;
  await inTx(`已有主题「${trimmed}」`, async tx => {
    const row = await subjectOf(tx, tenantId, subjectId);
    await assertNameFree(tx, tenantId, trimmed, row.id);
    await tx.update(analysisSubjects).set({ name: trimmed }).where(eq(analysisSubjects.id, row.id));
    await recordAudit(tx, { tenantId, actor, action: 'analysis_subject.renamed', targetType: 'analysis_subject', targetId: row.id, detail: { subjectId: row.id } });
  });
}

/** 删除主题，它的归属一起删 */
export async function deleteSubject(actor: CurrentMember, subjectId: unknown): Promise<void> {
  assertCan(actor, 'definitions:draft');
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const row = await subjectOf(tx, tenantId, subjectId);
    await tx.delete(analysisSubjects).where(eq(analysisSubjects.id, row.id));
    await recordAudit(tx, { tenantId, actor, action: 'analysis_subject.deleted', targetType: 'analysis_subject', targetId: row.id, detail: { subjectId: row.id } });
  });
}

/** 把目录条目（实体、字段、已发布指标或标签）加入主题；目标不合法（含敏感字段）或已在主题里时 400 */
export async function addMembership(actor: CurrentMember, subjectId: unknown, targetId: unknown): Promise<void> {
  assertCan(actor, 'definitions:draft');
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  const tenantId = actor.tenant.id;
  await inTx(`${targetId} 已在这个主题里`, async tx => {
    const row = await subjectOf(tx, tenantId, subjectId);
    await assertTarget(tx, tenantId, targetId, null);
    const [dup] = await tx.select({ targetId: subjectMemberships.targetId }).from(subjectMemberships)
      .where(and(eq(subjectMemberships.subjectId, row.id), eq(subjectMemberships.targetId, targetId)));
    if (dup) throw new KnowledgeError(`${targetId} 已在这个主题里`);
    await tx.insert(subjectMemberships).values({ tenantId, subjectId: row.id, targetId, createdByEmail: actor.email });
    await recordAudit(tx, { tenantId, actor, action: 'subject_membership.added', targetType: 'analysis_subject', targetId: row.id, detail: { subjectId: row.id, targetId } });
  });
}

/** 把目录条目移出主题；不在主题里时 400 */
export async function removeMembership(actor: CurrentMember, subjectId: unknown, targetId: unknown): Promise<void> {
  assertCan(actor, 'definitions:draft');
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const row = await subjectOf(tx, tenantId, subjectId);
    const removed = await tx.delete(subjectMemberships)
      .where(and(eq(subjectMemberships.subjectId, row.id), eq(subjectMemberships.targetId, targetId)))
      .returning({ targetId: subjectMemberships.targetId });
    if (!removed.length) throw new KnowledgeError(`${targetId} 不在这个主题里`);
    await recordAudit(tx, { tenantId, actor, action: 'subject_membership.removed', targetType: 'analysis_subject', targetId: row.id, detail: { subjectId: row.id, targetId } });
  });
}

/** 本租户的主题（id 与名字），按 cmpName 排 */
export async function listSubjects(db: Db, tenantId: string): Promise<Subject[]> {
  const rows = await db.select({ id: analysisSubjects.id, name: analysisSubjects.name }).from(analysisSubjects)
    .where(eq(analysisSubjects.tenantId, tenantId));
  return rows.sort((a, b) => cmpName(a.name, b.name));
}

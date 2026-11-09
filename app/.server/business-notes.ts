// app/.server/business-notes.ts —— 业务说明（ADR-0041、ADR-0046）：成员给实体字段写的本租户通用口径（definitions:draft），给映射字段写的某个数据源在这个字段上的
// 特殊之处（sources:write），以及给实体、已发布指标、已发布标签写的说明（definitions:draft，按目录条目标识 targetId 保存）。只追加、留历史，每次保存记审计（不记正文）
// 并记一版目录，不走双人发布，保存后马上进语义目录；当前说明是同一 (实体, 字段, 映射) 或同一 targetId 最新的一行，空串表示已清空。实体字段的说明 mappingId 为空。
// 说明去掉首尾空白后 1–2000 字，清空要显式提交空串；每次保存存下依据摘要 based_on（knowledge/basis.ts）。
// 实体与字段必须是本租户的标准实体或已发布的自定义实体里登记的字段，映射字段的映射必须是本租户已发布、映射到了这个字段的。一律限定在操作者所属租户内
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { catalogTx } from './catalog/tx';
import { getDb } from './db/client';
import { businessNotes, mappings } from './db/schema';
import { publishedCustomEntities } from './custom-entities';
import { assertTarget, basisOf, KnowledgeError, type Basis } from './knowledge/basis';
import { publishedPlans } from './mappings';
import { UUID } from './tenants';
import { noteKey } from '../lib/business-note-key';
import { entityOf } from '../lib/canonical-model';

export const NOTE_MAX_LENGTH = 2000;

/** 可以展示给成员的业务错误 */
export class BusinessNoteError extends Error {
  readonly status = 400;
}

export interface NoteVersion { note: string; by: string; at: string }

/** 字段类说明（实体字段，带 mappingId 是映射字段）或实体、指标、标签的说明（targetId 是 entity:x、metric:k、tag:k） */
export type BusinessNoteInput =
  | { entity: string; field: string; mappingId?: string | null; note: unknown }
  | { targetId: unknown; note: unknown };

/** 保存时刻用 clock_timestamp()：同一事务里（接受知识提案时）后存的一版更新 */
const savedAt = () => sql`clock_timestamp()`;

/** 去掉首尾空白，空串为清空 */
function normalizeNote(note: unknown): string {
  if (typeof note !== 'string') throw new BusinessNoteError('缺少说明');
  const trimmed = note.trim();
  if (note !== '' && trimmed === '') throw new BusinessNoteError('说明不能只有空白；要清空说明请提交空内容');
  if ([...trimmed].length > NOTE_MAX_LENGTH) throw new BusinessNoteError(`说明最多 ${NOTE_MAX_LENGTH} 字`);
  return trimmed;
}

/**
 * 在给定事务里保存一版说明（接受知识提案时与提案在同一事务里）：自己不开 catalogTx，调用方必须已经在 catalogTx 里，
 * business_note.updated 这一目录动作才能在事务收尾记一版目录版本（ADR-0054）。实体字段、实体、指标、标签的说明需 definitions:draft，
 * 映射字段的（带 mappingId）需 sources:write；字段的说明只能用 entity / field 形式，targetId 只接受 entity:、metric:、tag:。返回新行 ID
 */
export async function saveBusinessNoteTx(tx: Tx, actor: CurrentMember, input: BusinessNoteInput): Promise<string> {
  const tenantId = actor.tenant.id;
  if ('targetId' in input) {
    assertCan(actor, 'definitions:draft');
    const { targetId } = input;
    if (typeof targetId !== 'string' || !/^(entity|metric|tag):./.test(targetId)) throw new BusinessNoteError('业务说明的目标只能是实体、指标或标签');
    const trimmed = normalizeNote(input.note);
    try {
      await assertTarget(tx, tenantId, targetId);
    } catch (e) {
      throw e instanceof KnowledgeError ? new BusinessNoteError(e.message) : e;
    }
    const basedOn = await basisOf(tx, tenantId, targetId);
    const [row] = await tx.insert(businessNotes)
      .values({ tenantId, targetId, note: trimmed, basedOn, createdByEmail: actor.email, createdAt: savedAt() })
      .returning({ id: businessNotes.id });
    await recordAudit(tx, { tenantId, actor, action: 'business_note.updated', targetType: 'business_note', targetId, detail: { targetId } });
    return row.id;
  }

  const { entity, field, mappingId = null } = input;
  assertCan(actor, mappingId ? 'sources:write' : 'definitions:draft');
  const trimmed = normalizeNote(input.note);
  const fields = entityOf(entity)?.fields ?? (await publishedCustomEntities(tx, tenantId)).get(entity)?.fields;
  if (!fields) throw new BusinessNoteError(`没有实体 ${entity}`);
  if (!fields.some(f => f.name === field)) throw new BusinessNoteError(`实体 ${entity} 没有字段 ${field}`);
  if (mappingId) {
    // 映射字段：本租户已发布（未停用）的映射最新发布版里写了这个字段；锁住映射行，与发布、停用互斥
    const [own] = UUID.test(mappingId)
      ? await tx.select({ id: mappings.id }).from(mappings).where(and(eq(mappings.id, mappingId), eq(mappings.tenantId, tenantId))).for('update')
      : [];
    const plans = own ? await publishedPlans(tx, tenantId, [mappingId]) : [];
    const mapped = plans.some(p => p.mapping === mappingId && p.entity === entity && p.columns.some(c => c.name === field));
    if (!mapped) throw new BusinessNoteError(`映射 ${mappingId} 没有写入 ${entity}.${field}`);
  }
  const basedOn = await basisOf(tx, tenantId, `field:${entity}.${field}`, mappingId);
  const [row] = await tx.insert(businessNotes)
    .values({ tenantId, entity, field, mappingId, note: trimmed, basedOn, createdByEmail: actor.email, createdAt: savedAt() })
    .returning({ id: businessNotes.id });
  await recordAudit(tx, {
    tenantId, actor, action: 'business_note.updated', targetType: 'business_note', targetId: noteKey(entity, field, mappingId),
    detail: { entity, field, mappingId },
  });
  return row.id;
}

/** 保存一版说明，返回新行 ID */
export const saveBusinessNote = (actor: CurrentMember, input: BusinessNoteInput): Promise<string> =>
  catalogTx(actor.tenant.id, tx => saveBusinessNoteTx(tx, actor, input));

/** 本租户每个字段类说明的当前内容（含已清空的空串），键是 noteKey；实体、指标、标签的说明（target_id 非空）不在这里，见 currentTargetNotes */
export async function currentNotes(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinctOn([businessNotes.entity, businessNotes.field, businessNotes.mappingId], {
      entity: businessNotes.entity, field: businessNotes.field, mappingId: businessNotes.mappingId, note: businessNotes.note,
    })
    .from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), isNull(businessNotes.targetId)))
    .orderBy(businessNotes.entity, businessNotes.field, businessNotes.mappingId, desc(businessNotes.createdAt));
  return new Map(rows.map(r => [noteKey(r.entity!, r.field!, r.mappingId), r.note]));
}

/** 本租户每个映射字段说明当前那一版的依据摘要，键是 noteKey；已清空的不给。给需复核比较用（knowledge/catalog.ts） */
export async function currentMappingNoteBases(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, Basis[]>> {
  const rows = await db
    .selectDistinctOn([businessNotes.entity, businessNotes.field, businessNotes.mappingId], {
      entity: businessNotes.entity, field: businessNotes.field, mappingId: businessNotes.mappingId, note: businessNotes.note, basedOn: businessNotes.basedOn,
    })
    .from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), isNull(businessNotes.targetId), isNotNull(businessNotes.mappingId)))
    .orderBy(businessNotes.entity, businessNotes.field, businessNotes.mappingId, desc(businessNotes.createdAt));
  return new Map(rows.filter(r => r.note).map(r => [noteKey(r.entity!, r.field!, r.mappingId), r.basedOn]));
}

/** 本租户实体、指标、标签说明的当前内容（含已清空的空串）与那一版的依据摘要，键是 targetId */
export async function currentTargetNotes(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, { note: string; basedOn: Basis[] }>> {
  const rows = await db.selectDistinctOn([businessNotes.targetId], { targetId: businessNotes.targetId, note: businessNotes.note, basedOn: businessNotes.basedOn })
    .from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), isNotNull(businessNotes.targetId)))
    .orderBy(businessNotes.targetId, desc(businessNotes.createdAt));
  return new Map(rows.map(r => [r.targetId!, { note: r.note, basedOn: r.basedOn }]));
}

const versionColumns = { field: businessNotes.field, note: businessNotes.note, by: businessNotes.createdByEmail, at: businessNotes.createdAt };
const toVersion = ({ note, by, at }: { note: string; by: string; at: Date }): NoteVersion => ({ note, by, at: at.toISOString() });

/** 一个实体各字段说明（实体字段的与映射字段的）的每一版，从旧到新，键是 noteKey；字段抽屉一次取出 */
export async function entityNoteHistory(db: Tx | ReturnType<typeof getDb>, tenantId: string, entity: string): Promise<Map<string, NoteVersion[]>> {
  const rows = await db.select({ ...versionColumns, mappingId: businessNotes.mappingId }).from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), eq(businessNotes.entity, entity)))
    .orderBy(asc(businessNotes.createdAt));
  const byKey = new Map<string, NoteVersion[]>();
  for (const r of rows) {
    const key = noteKey(entity, r.field!, r.mappingId);
    byKey.set(key, [...(byKey.get(key) ?? []), toVersion(r)]);
  }
  return byKey;
}

/** 一个说明的每一版，从旧到新 */
export async function noteHistory(
  db: Tx | ReturnType<typeof getDb>, tenantId: string, entity: string, field: string, mappingId: string | null = null,
): Promise<NoteVersion[]> {
  const rows = await db.select(versionColumns).from(businessNotes)
    .where(and(
      eq(businessNotes.tenantId, tenantId), eq(businessNotes.entity, entity), eq(businessNotes.field, field),
      mappingId ? eq(businessNotes.mappingId, mappingId) : isNull(businessNotes.mappingId),
    ))
    .orderBy(asc(businessNotes.createdAt));
  return rows.map(toVersion);
}

/** 实体、指标、标签的一个说明的每一版，从旧到新 */
export async function targetNoteHistory(db: Tx | ReturnType<typeof getDb>, tenantId: string, targetId: string): Promise<NoteVersion[]> {
  const rows = await db.select(versionColumns).from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), eq(businessNotes.targetId, targetId)))
    .orderBy(asc(businessNotes.createdAt));
  return rows.map(toVersion);
}

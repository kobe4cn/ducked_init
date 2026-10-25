// app/.server/business-notes.ts —— 业务说明（ADR-0041）：成员给实体字段写的本租户通用口径（definitions:draft），以及给映射字段写的某个数据源在这个字段上的
// 特殊之处（sources:write）。只追加、留历史，每次保存记审计（不记正文），不走双人发布，保存后马上进语义目录；
// 当前说明是同一 (实体, 字段, 映射) 最新的一行，空串表示已清空。实体字段的说明 mappingId 为空。说明去掉首尾空白后 1–2000 字，清空要显式提交空串；
// 实体与字段必须是本租户的标准实体或已发布的自定义实体里登记的字段，映射字段的映射必须是本租户已发布、映射到了这个字段的。一律限定在操作者所属租户内
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { businessNotes, mappings } from './db/schema';
import { publishedCustomEntities } from './custom-entities';
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


/** 保存一版说明：去掉首尾空白，空串为清空；实体字段的说明需 definitions:draft，映射字段的（带 mappingId）需 sources:write */
export async function saveBusinessNote(
  actor: CurrentMember, { entity, field, mappingId = null, note }: { entity: string; field: string; mappingId?: string | null; note: unknown },
) {
  assertCan(actor, mappingId ? 'sources:write' : 'definitions:draft');
  if (typeof note !== 'string') throw new BusinessNoteError('缺少说明');
  const trimmed = note.trim();
  if (note !== '' && trimmed === '') throw new BusinessNoteError('说明不能只有空白；要清空说明请提交空内容');
  if ([...trimmed].length > NOTE_MAX_LENGTH) throw new BusinessNoteError(`说明最多 ${NOTE_MAX_LENGTH} 字`);
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
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
    await tx.insert(businessNotes).values({ tenantId, entity, field, mappingId, note: trimmed, createdByEmail: actor.email });
    await recordAudit(tx, {
      tenantId, actor, action: 'business_note.updated', targetType: 'business_note', targetId: noteKey(entity, field, mappingId),
      detail: { entity, field, mappingId },
    });
  });
}

/** 本租户每个说明的当前内容（含已清空的空串），键是 noteKey */
export async function currentNotes(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectDistinctOn([businessNotes.entity, businessNotes.field, businessNotes.mappingId], {
      entity: businessNotes.entity, field: businessNotes.field, mappingId: businessNotes.mappingId, note: businessNotes.note,
    })
    .from(businessNotes)
    .where(eq(businessNotes.tenantId, tenantId))
    .orderBy(businessNotes.entity, businessNotes.field, businessNotes.mappingId, desc(businessNotes.createdAt));
  return new Map(rows.map(r => [noteKey(r.entity, r.field, r.mappingId), r.note]));
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
    const key = noteKey(entity, r.field, r.mappingId);
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

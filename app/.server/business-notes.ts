// app/.server/business-notes.ts —— 业务说明（ADR-0041）：成员给实体字段写的本租户通用口径。只追加、留历史，每次保存记审计（不记正文），不走双人发布；
// 当前说明是同一 (实体, 字段, 映射) 最新的一行，空串表示已清空。实体字段的说明 mappingId 为空。说明去掉首尾空白后 1–2000 字，清空要显式提交空串；
// 实体与字段必须是本租户的标准实体或已发布的自定义实体里登记的字段。一律限定在操作者所属租户内
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { businessNotes, mappings } from './db/schema';
import { publishedCustomEntities } from './custom-entities';
import { entityOf } from '../lib/canonical-model';

export const NOTE_MAX_LENGTH = 2000;

/** 可以展示给成员的业务错误 */
export class BusinessNoteError extends Error {
  readonly status = 400;
}

export interface NoteVersion { note: string; by: string; at: string }

const noteKey = (entity: string, field: string, mappingId: string | null) => `${entity}.${field}${mappingId ? `@${mappingId}` : ''}`;

/** 保存一版说明：去掉首尾空白，空串为清空 */
export async function saveBusinessNote(
  actor: CurrentMember, { entity, field, mappingId = null, note }: { entity: string; field: string; mappingId?: string | null; note: unknown },
) {
  assertCan(actor, 'definitions:draft');
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
      const [own] = await tx.select({ id: mappings.id }).from(mappings)
        .where(and(eq(mappings.id, mappingId), eq(mappings.tenantId, tenantId), eq(mappings.entity, entity)));
      if (!own) throw new BusinessNoteError(`没有写入 ${entity} 的映射 ${mappingId}`);
    }
    await tx.insert(businessNotes).values({ tenantId, entity, field, mappingId, note: trimmed, createdByEmail: actor.email });
    await recordAudit(tx, {
      tenantId, actor, action: 'business_note.updated', targetType: 'business_note', targetId: noteKey(entity, field, mappingId),
      detail: { entity, field, mappingId },
    });
  });
}

/** 本租户每个说明的当前内容（含已清空的空串），键是 entity.field 或 entity.field@mappingId */
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

/** 一个实体各字段（实体字段的说明，不含映射字段的）的每一版，按字段名，从旧到新；字段抽屉一次取出 */
export async function entityNoteHistory(db: Tx | ReturnType<typeof getDb>, tenantId: string, entity: string): Promise<Map<string, NoteVersion[]>> {
  const rows = await db.select(versionColumns).from(businessNotes)
    .where(and(eq(businessNotes.tenantId, tenantId), eq(businessNotes.entity, entity), isNull(businessNotes.mappingId)))
    .orderBy(asc(businessNotes.createdAt));
  const byField = new Map<string, NoteVersion[]>();
  for (const r of rows) byField.set(r.field, [...(byField.get(r.field) ?? []), toVersion(r)]);
  return byField;
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

// app/.server/knowledge/sources.ts —— 知识来源（ADR-0046 入口③，#525）：成员把数据字典、指标说明或 SQL 的原文粘贴进来，按段落切分、
// 带版本地保存。只存原文，不调模型（解析成提案是 #526）；SQL 与文本只是待解析的数据，绝不执行。服务端不做内容识别，
// 只限长度与段数（页面上提示「只粘贴元数据说明，不要粘贴业务数据」是 #527）。同租户同标题的再粘贴不新建来源：
// 种类与正文都没变时返回现有版本（不加版本、不记审计），变了版本 +1、正文更新。一律限定在操作者所属租户内。
// 审计 knowledge_source.created 的 detail 只有标题、种类、版本与段数，不记原文
import { and, eq } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit } from '../audit';
import { sha256, type CurrentMember } from '../auth';
import { getDb, isUniqueViolation } from '../db/client';
import { knowledgeSources } from '../db/schema';
import { UUID } from '../tenants';
import {
  KNOWLEDGE_SOURCE_BODY_MAX, KNOWLEDGE_SOURCE_KINDS, KNOWLEDGE_SOURCE_PARAGRAPHS_MAX, KNOWLEDGE_SOURCE_TITLE_MAX,
  type KnowledgeSourceKind,
} from '../../lib/knowledge-source';
import { KnowledgeError } from './basis';

/** 一段原文：段号从 1 开始（证据 ref 是 source:<id>#p<段号>），text 去掉首尾空白 */
export interface SourceParagraph { no: number; text: string }

/** 保存结果：来源 id、当前版本与段落列表（段号从 1 开始） */
export interface SavedKnowledgeSource { id: string; version: number; paragraphs: SourceParagraph[] }

/** 读出的来源：标题、种类、版本、段落与两个时间 */
export interface KnowledgeSource extends SavedKnowledgeSource {
  title: string;
  kind: KnowledgeSourceKind;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 按种类切段（纯函数）：数据字典与指标说明按空行切段，SQL 按语句（分号）切段；换行先归一成 LF，
 * 每段去首尾空白、空段丢弃，段号从 1 开始。分号在字符串字面量里也会切断：只影响段号定位，不影响保存，不做 SQL 解析
 */
export function paragraphsOf(body: string, kind: KnowledgeSourceKind): SourceParagraph[] {
  const text = body.replace(/\r\n?/g, '\n');
  const parts = (kind === 'sql' ? text.split(';') : text.split(/\n\s*\n/)).map(part => part.trim()).filter(Boolean);
  return parts.map((paragraph, i) => ({ no: i + 1, text: paragraph }));
}

/** 校验标题：字符串，去掉首尾空白后 1–KNOWLEDGE_SOURCE_TITLE_MAX 字 */
function titleOf(title: unknown): string {
  if (typeof title !== 'string') throw new KnowledgeError('缺少标题');
  const trimmed = title.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > KNOWLEDGE_SOURCE_TITLE_MAX) throw new KnowledgeError(`标题去掉首尾空白后要 1–${KNOWLEDGE_SOURCE_TITLE_MAX} 字`);
  return trimmed;
}

/** 校验种类：三种登记过的之一 */
function kindOf(kind: unknown): KnowledgeSourceKind {
  if (typeof kind !== 'string' || !KNOWLEDGE_SOURCE_KINDS.includes(kind as KnowledgeSourceKind)) {
    throw new KnowledgeError('种类要选数据字典、指标说明或 SQL');
  }
  return kind as KnowledgeSourceKind;
}

/** 校验正文：字符串，去掉首尾空白后非空、不超过 KNOWLEDGE_SOURCE_BODY_MAX 字、切段后不超过 KNOWLEDGE_SOURCE_PARAGRAPHS_MAX 段 */
function bodyOf(body: unknown, kind: KnowledgeSourceKind) {
  if (typeof body !== 'string') throw new KnowledgeError('缺少正文');
  const trimmed = body.trim();
  if (!trimmed) throw new KnowledgeError('请先粘贴来源原文');
  if (trimmed.length > KNOWLEDGE_SOURCE_BODY_MAX) throw new KnowledgeError(`来源原文最多 ${KNOWLEDGE_SOURCE_BODY_MAX} 字`);
  const paragraphs = paragraphsOf(trimmed, kind);
  if (paragraphs.length > KNOWLEDGE_SOURCE_PARAGRAPHS_MAX) throw new KnowledgeError(`来源原文最多 ${KNOWLEDGE_SOURCE_PARAGRAPHS_MAX} 段（现在 ${paragraphs.length} 段）`);
  return { body: trimmed, paragraphs };
}

/**
 * 保存成员粘贴的来源原文（#525），需要 definitions:draft。同租户同标题的再粘贴不新建来源：种类与正文（哈希）都没变时
 * 返回现有版本、不加版本也不记审计；变了版本 +1、种类与正文更新，审计 knowledge_source.created（detail 不含原文）。
 * 并发下两人同时首存同标题会撞 (tenant, title) 唯一键：重试一次就走更新分支
 */
export async function saveKnowledgeSource(
  actor: CurrentMember, input: { title: unknown; kind: unknown; body: unknown },
): Promise<SavedKnowledgeSource> {
  assertCan(actor, 'definitions:draft');
  const title = titleOf(input.title);
  const kind = kindOf(input.kind);
  const { body, paragraphs } = bodyOf(input.body, kind);
  const bodyHash = sha256(body);
  const tenantId = actor.tenant.id;
  for (let attempt = 0; ; attempt++) {
    try {
      return await getDb().transaction(async tx => {
        const [existing] = await tx.select().from(knowledgeSources)
          .where(and(eq(knowledgeSources.tenantId, tenantId), eq(knowledgeSources.title, title))).for('update');
        if (existing && existing.kind === kind && existing.bodyHash === bodyHash) {
          return { id: existing.id, version: existing.version, paragraphs };
        }
        const [row] = existing
          ? await tx.update(knowledgeSources)
            .set({ kind, body, bodyHash, version: existing.version + 1, updatedAt: new Date() })
            .where(eq(knowledgeSources.id, existing.id)).returning()
          : await tx.insert(knowledgeSources).values({ tenantId, title, kind, body, bodyHash, createdByEmail: actor.email }).returning();
        await recordAudit(tx, {
          tenantId, actor, action: 'knowledge_source.created', targetType: 'knowledge_source', targetId: row.id,
          detail: { title, kind, version: row.version, paragraphs: paragraphs.length },
        });
        return { id: row.id, version: row.version, paragraphs };
      });
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

/** 读一个来源，有 definitions:read 就能看（原文是成员写的元数据说明，不是业务数据）；不是 UUID、不存在或属于别的租户时 400 */
export async function getKnowledgeSource(member: CurrentMember, id: unknown): Promise<KnowledgeSource> {
  assertCan(member, 'definitions:read');
  const [row] = typeof id === 'string' && UUID.test(id)
    ? await getDb().select().from(knowledgeSources)
      .where(and(eq(knowledgeSources.id, id), eq(knowledgeSources.tenantId, member.tenant.id)))
    : [];
  if (!row) throw new KnowledgeError('没有这个来源');
  return {
    id: row.id, title: row.title, kind: row.kind, version: row.version,
    paragraphs: paragraphsOf(row.body, row.kind), createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

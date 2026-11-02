// app/.server/knowledge/aliases.ts —— 别名（ADR-0046）：成员给目录条目加的本租户说法。别名不表示等价，一个词挂在多个条目上就是歧义。
// 实体、字段、已发布指标与标签的别名要 definitions:draft，映射字段的（带 mappingId）要 sources:write。人加的立即进目录，不走双人发布；
// 只加和停用、不改名（要改就先停用再加），停用的行留着。加与停用都记审计（不记别名原文）并在同一事务里记一版目录。
// 加别名时存下依据摘要（basis.ts），以后依据变了就转为需复核。一律限定在操作者所属租户内
import { and, eq, isNull, sql } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { knowledgeAliases } from '../db/schema';
import { assertTarget, basisOf, KnowledgeError } from './basis';
import { assertCanTouchKnowledge, lockTenantRow, rethrowDuplicateAlias } from './guards';

export const ALIAS_MAX_LENGTH = 50;

export interface AliasInput { targetId: unknown; mappingId?: string | null; alias: unknown }

/**
 * 在给定事务里加一个别名（接受知识提案时与提案在同一事务里），返回别名 ID。
 * 并发加了同一个别名时唯一索引报 23505（不转成 KnowledgeError），调用方像 addAlias 那样处理
 */
export async function addAliasTx(tx: Tx, actor: CurrentMember, { targetId, mappingId = null, alias }: AliasInput): Promise<string> {
  assertCan(actor, mappingId ? 'sources:write' : 'definitions:draft');
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  if (typeof alias !== 'string') throw new KnowledgeError('缺少别名');
  const trimmed = alias.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > ALIAS_MAX_LENGTH) throw new KnowledgeError(`别名去掉首尾空白后要 1–${ALIAS_MAX_LENGTH} 字`);
  const tenantId = actor.tenant.id;
  await assertTarget(tx, tenantId, targetId, mappingId);
  const [dup] = await tx.select({ id: knowledgeAliases.id }).from(knowledgeAliases).where(and(
    eq(knowledgeAliases.tenantId, tenantId), eq(knowledgeAliases.targetId, targetId),
    mappingId ? eq(knowledgeAliases.mappingId, mappingId) : isNull(knowledgeAliases.mappingId),
    sql`lower(${knowledgeAliases.alias}) = lower(${trimmed})`, isNull(knowledgeAliases.retiredAt),
  ));
  if (dup) throw new KnowledgeError(`${targetId} 已有别名「${trimmed}」`);
  const basedOn = await basisOf(tx, tenantId, targetId, mappingId);
  const [row] = await tx.insert(knowledgeAliases)
    .values({ tenantId, targetId, mappingId, alias: trimmed, basedOn, createdByEmail: actor.email })
    .returning({ id: knowledgeAliases.id });
  await recordAudit(tx, { tenantId, actor, action: 'alias.added', targetType: 'knowledge', targetId: row.id, detail: { targetId, mappingId } });
  return row.id;
}

/** 给目录条目加一个别名，返回别名 ID */
export async function addAlias(actor: CurrentMember, input: AliasInput): Promise<string> {
  try {
    return await getDb().transaction(tx => addAliasTx(tx, actor, input));
  } catch (e) {
    rethrowDuplicateAlias(e);
  }
}

/** 停用一个别名：映射字段的要 sources:write，其余要 definitions:draft；已停用或不存在时 400 */
export async function retireAlias(actor: CurrentMember, aliasId: string): Promise<void> {
  assertCanTouchKnowledge(actor);
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const row = await lockTenantRow(tx, knowledgeAliases, aliasId, tenantId);
    if (!row) throw new KnowledgeError('没有这个别名');
    assertCan(actor, row.mappingId ? 'sources:write' : 'definitions:draft');
    if (row.retiredAt) throw new KnowledgeError('别名已停用');
    await tx.update(knowledgeAliases).set({ retiredAt: new Date(), retiredByEmail: actor.email }).where(eq(knowledgeAliases.id, aliasId));
    await recordAudit(tx, {
      tenantId, actor, action: 'alias.retired', targetType: 'knowledge', targetId: aliasId, detail: { targetId: row.targetId, mappingId: row.mappingId },
    });
  });
}

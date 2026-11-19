// app/.server/knowledge/aliases.ts —— 别名（ADR-0046）：成员给目录条目加的本租户说法。别名不表示等价，一个词挂在多个条目上就是歧义。
// 实体、字段、已发布指标与标签的别名要 definitions:draft，映射字段的（带 mappingId）要 sources:write。人加的立即进目录，不走双人发布；
// 只加和停用、不改名（要改就先停用再加），停用的行留着。加与停用都记审计（不记别名原文）并在同一事务里记一版目录。
// 需复核的别名可以确认（confirmAlias）：停用旧行、插入取当前依据的同名新行，别名始终生效。
// 加别名时存下依据摘要（basis.ts），以后依据变了就转为需复核。一律限定在操作者所属租户内
import { and, eq, isNull, sql } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { catalogTx } from '../catalog/tx';
import { knowledgeAliases } from '../db/schema';
import { assertTarget, basisOf, currentBases, KnowledgeError } from './basis';
import { assertCanTouchKnowledge, lockTenantRow, rethrowDuplicateAlias } from './guards';

export const ALIAS_MAX_LENGTH = 50;

export interface AliasInput { targetId: unknown; mappingId?: string | null; alias: unknown }

/**
 * 在给定事务里加一个别名（接受知识提案时与提案在同一事务里），返回别名 ID。不开 catalogTx，
 * 调用方必须已经在 catalogTx 里（目录版本由最外层的 catalogTx 记一版）。
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
    return await catalogTx(actor.tenant.id, tx => addAliasTx(tx, actor, input));
  } catch (e) {
    rethrowDuplicateAlias(e);
  }
}

/** 停用与确认共用：锁住本租户的别名行（FOR UPDATE，并发互斥），按是不是映射字段查权限，已停用或不存在时 400 */
async function lockActiveAlias(tx: Tx, actor: CurrentMember, tenantId: string, aliasId: string) {
  const row = await lockTenantRow(tx, knowledgeAliases, aliasId, tenantId);
  if (!row) throw new KnowledgeError('没有这个别名');
  assertCan(actor, row.mappingId ? 'sources:write' : 'definitions:draft');
  if (row.retiredAt) throw new KnowledgeError('别名已停用');
  return row;
}

/** 停用一个别名：映射字段的要 sources:write，其余要 definitions:draft；已停用或不存在时 400 */
export async function retireAlias(actor: CurrentMember, aliasId: string): Promise<void> {
  assertCanTouchKnowledge(actor);
  const tenantId = actor.tenant.id;
  await catalogTx(tenantId, async tx => {
    const row = await lockActiveAlias(tx, actor, tenantId, aliasId);
    await tx.update(knowledgeAliases).set({ retiredAt: new Date(), retiredByEmail: actor.email }).where(eq(knowledgeAliases.id, aliasId));
    await recordAudit(tx, {
      tenantId, actor, action: 'alias.retired', targetType: 'knowledge', targetId: aliasId, detail: { targetId: row.targetId, mappingId: row.mappingId },
    });
  });
}

/**
 * 确认一个待复核的别名（ADR-0046：依据变了，别名标需复核但仍生效）：在一个事务里停用旧行、插入同名新行
 * （alias、targetId、mappingId 不变，based_on 取当前依据），别名始终生效、不再待复核，返回新别名 ID。
 * 权限与停用一致（映射字段的要 sources:write，其余要 definitions:draft）；已停用、不存在或没有待复核时 400
 */
export async function confirmAlias(actor: CurrentMember, aliasId: string): Promise<string> {
  assertCanTouchKnowledge(actor);
  const tenantId = actor.tenant.id;
  return catalogTx(tenantId, async tx => {
    const row = await lockActiveAlias(tx, actor, tenantId, aliasId);
    // 与 loadKnowledge 的需复核同口径（catalog.ts）：依据还在当前摘要里但摘要变了才算，依据已被删掉的不算
    const bases = await currentBases(tx, tenantId);
    if (!row.basedOn.some(b => bases.has(b.id) && bases.get(b.id) !== b.hash)) throw new KnowledgeError('这个别名不需要复核');
    await tx.update(knowledgeAliases).set({ retiredAt: new Date(), retiredByEmail: actor.email }).where(eq(knowledgeAliases.id, aliasId));
    const [inserted] = await tx.insert(knowledgeAliases)
      .values({
        tenantId, targetId: row.targetId, mappingId: row.mappingId, alias: row.alias,
        basedOn: await basisOf(tx, tenantId, row.targetId, row.mappingId), createdByEmail: actor.email,
      })
      .returning({ id: knowledgeAliases.id });
    await recordAudit(tx, {
      tenantId, actor, action: 'alias.confirmed', targetType: 'knowledge', targetId: inserted.id,
      detail: { targetId: row.targetId, mappingId: row.mappingId, previousAliasId: aliasId, aliasId: inserted.id },
    });
    return inserted.id;
  });
}

// app/.server/knowledge/term-defaults.ts —— 词的默认指向（ADR-0056，修订 ADR-0047 的追问规则）：某个词（目标条目的名称或有效别名）
// 在本租户默认指哪个目录条目，用来在歧义时不再追问。一个词同一时间最多一个有效默认：设置新的就停用旧的（只加和停用、不改值，
// 停用的行留着）。本票只做存储与提案接受（入口⑥，经 ADR-0046 的提案流程），歧义判定读 listTermDefaults；
// 依据（默认条目的定义）变了时不生效，照常追问。审计 detail 只放词与目标，不记用户原话
import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { knowledgeTermDefaults } from '../db/schema';
import { type Basis, KnowledgeError } from './basis';
import { rethrowDuplicateTermDefault } from './guards';

/** 一行词的默认指向 */
export type TermDefault = typeof knowledgeTermDefaults.$inferSelect;

/**
 * 在给定事务里设置一个词的默认指向（接受知识提案时与提案在同一事务里），返回新行 ID。不开 catalogTx，
 * 调用方必须已经在 catalogTx 里（目录版本由最外层的 catalogTx 记一版）。先把同租户、同 lower(term)、
 * 未停用的行停用（一条 UPDATE，被替换的目标进审计），再插入新行。顺序执行不会撞唯一索引（旧的已停用）；
 * 并发接受同一个词的两个提案时撞 23505，改写成 400、整个事务回滚（提案仍是待确认，重试即可，与别名同做法）
 */
export async function setTermDefaultTx(
  tx: Tx, actor: CurrentMember, { term, targetId, basedOn }: { term: string; targetId: string; basedOn: Basis[] },
): Promise<{ id: string }> {
  if (typeof term !== 'string' || !term.trim()) throw new KnowledgeError('默认指向提案缺少词');
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  const tenantId = actor.tenant.id;
  let replaced: { targetId: string } | undefined;
  let row: { id: string };
  try {
    [replaced] = await tx.update(knowledgeTermDefaults)
      .set({ retiredAt: new Date() })
      .where(and(
        eq(knowledgeTermDefaults.tenantId, tenantId),
        sql`lower(${knowledgeTermDefaults.term}) = lower(${term})`,
        isNull(knowledgeTermDefaults.retiredAt),
      ))
      .returning({ targetId: knowledgeTermDefaults.targetId });
    [row] = await tx.insert(knowledgeTermDefaults)
      .values({ tenantId, term, targetId, basedOn, createdByEmail: actor.email })
      .returning({ id: knowledgeTermDefaults.id });
  } catch (e) {
    rethrowDuplicateTermDefault(e);
  }
  await recordAudit(tx, {
    tenantId, actor, action: 'term_default.set', targetType: 'knowledge', targetId: row.id,
    detail: { term, targetId, ...(replaced && { replaced: replaced.targetId }) },
  });
  return { id: row.id };
}

/** 本租户当前有效的默认指向（retiredAt is null），给歧义判定读用 */
export async function listTermDefaults(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<TermDefault[]> {
  return db.select().from(knowledgeTermDefaults)
    .where(and(eq(knowledgeTermDefaults.tenantId, tenantId), isNull(knowledgeTermDefaults.retiredAt)));
}

// app/.server/knowledge/claims.ts —— 口径声明（ADR-0046）：给目录条目声明结构化口径（类型与取值见 app/lib/semantic-claims.ts，取值可以是「未知」「不适用」）。
// 权限与别名相同：实体、字段、已发布指标与标签要 definitions:draft，映射字段（带 mappingId）要 sources:write。人写的立即进目录，不走双人发布；
// 只追加不改，每个 (目标, 映射, 类型) 最新的一行生效，旧行是历史。保存记审计（detail 只有目标与类型）并在同一事务里记一版目录；
// 保存时存下依据摘要（basis.ts）。一律限定在操作者所属租户内
import { and, desc, eq, isNull } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { semanticClaims } from '../db/schema';
import { isClaimType, isClaimValue } from '../../lib/semantic-claims';
import { assertTarget, basisOf, KnowledgeError } from './basis';

export interface ClaimInput { targetId: unknown; mappingId?: string | null; type: unknown; value: unknown }

/** 一版口径声明 */
export interface ClaimVersion { id: string; type: string; value: string; createdByEmail: string; createdAt: Date }

/** 在给定事务里保存一条口径声明（接受知识提案时与提案在同一事务里），返回声明 ID */
export async function saveClaimTx(tx: Tx, actor: CurrentMember, { targetId, mappingId = null, type, value }: ClaimInput): Promise<string> {
  assertCan(actor, mappingId ? 'sources:write' : 'definitions:draft');
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  if (!isClaimType(type)) throw new KnowledgeError('没有这种口径类型');
  if (!isClaimValue(type, value)) throw new KnowledgeError('这种口径没有这个取值');
  const tenantId = actor.tenant.id;
  await assertTarget(tx, tenantId, targetId, mappingId);
  const basedOn = await basisOf(tx, tenantId, targetId, mappingId);
  const [row] = await tx.insert(semanticClaims)
    .values({ tenantId, targetId, mappingId, claimType: type, value, basedOn, createdByEmail: actor.email })
    .returning({ id: semanticClaims.id });
  await recordAudit(tx, { tenantId, actor, action: 'semantic_claim.saved', targetType: 'knowledge', targetId: row.id, detail: { targetId, mappingId, type } });
  return row.id;
}

/** 保存一条口径声明，返回声明 ID */
export const saveClaim = (actor: CurrentMember, input: ClaimInput): Promise<string> =>
  getDb().transaction(tx => saveClaimTx(tx, actor, input));

/** 一个挂载点的口径声明历史：每一版的类型、取值、作者与时间，新的在前 */
export async function claimHistory(db: Tx | ReturnType<typeof getDb>, tenantId: string, targetId: string, mappingId: string | null = null): Promise<ClaimVersion[]> {
  const c = semanticClaims;
  return db.select({ id: c.id, type: c.claimType, value: c.value, createdByEmail: c.createdByEmail, createdAt: c.createdAt })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.targetId, targetId), mappingId ? eq(c.mappingId, mappingId) : isNull(c.mappingId)))
    .orderBy(desc(c.createdAt), desc(c.id));
}

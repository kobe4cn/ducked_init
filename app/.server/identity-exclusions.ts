// app/.server/identity-exclusions.ts —— 不参与身份打通匹配的值（ADR-0039）：成员在数据质量页把热值标为不参与匹配，或撤销。
// 只存加盐哈希与标记时的记录数，审计也只记这两项；登记或撤销后本模块在同一个事务里入队合并（带上排除列表并强制重算），入不了队就整个回滚
import { asc, desc, eq, and } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { identityExcludedValues, members } from './db/schema';
import { enqueueMerge, latestIdentitySummary } from './merges';

/** 可以展示给成员的错误：哈希不在最近一次打通的 hot 里 400，没有登记过 404，重复标记或已有合并在运行（回滚整个事务）409 */
export class ExclusionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

/** 本租户不参与匹配的值，新标记的在前；标记人已被移除时 createdBy 为 null */
export async function listExcludedValues(tenantId: string) {
  return getDb().select({ hash: identityExcludedValues.hash, records: identityExcludedValues.records, createdBy: members.email, createdAt: identityExcludedValues.createdAt })
    .from(identityExcludedValues).leftJoin(members, eq(members.id, identityExcludedValues.createdBy))
    .where(eq(identityExcludedValues.tenantId, tenantId))
    .orderBy(desc(identityExcludedValues.createdAt), asc(identityExcludedValues.hash));
}

/** 本租户排除列表里的哈希（按 JS 默认顺序排好，与 mustRecomputeIdentities 比对上次参数时同一种排法），写进合并参数 identityExclude */
export async function excludedHashes(tx: Tx, tenantId: string) {
  const rows = await tx.select({ hash: identityExcludedValues.hash }).from(identityExcludedValues).where(eq(identityExcludedValues.tenantId, tenantId));
  return rows.map(r => r.hash).sort();
}

/** 登记一个不参与匹配的值并记审计；已经登记过时什么都不做，返回 false */
async function addExclusion(tx: Tx, tenantId: string, actor: CurrentMember, hash: string, records: number) {
  const [row] = await tx.insert(identityExcludedValues).values({ tenantId, hash, records, createdBy: actor.memberId })
    .onConflictDoNothing().returning();
  if (!row) return false;
  await recordAudit(tx, { tenantId, actor, action: 'identity.value_excluded', targetType: 'identity_value', targetId: hash, detail: { hash, records } });
  return true;
}

/** 撤销登记并记审计；没有登记时什么都不做，返回 false */
async function removeExclusion(tx: Tx, tenantId: string, actor: CurrentMember, hash: string) {
  const [row] = await tx.delete(identityExcludedValues)
    .where(and(eq(identityExcludedValues.tenantId, tenantId), eq(identityExcludedValues.hash, hash))).returning();
  if (!row) return false;
  await recordAudit(tx, { tenantId, actor, action: 'identity.value_included', targetType: 'identity_value', targetId: hash, detail: { hash, records: row.records } });
  return true;
}

/** 改排除列表并在同一个事务里入队合并（带上新的排除列表，与上次打通的参数不同，强制重算打通）。合并正在运行时入不了队，定时检查也不会
 *  因排除列表变了补一次合并，所以整个回滚、请成员稍后再试（同恢复映射） */
async function changeWithMerge(actor: CurrentMember, change: (tx: Tx, tenantId: string) => Promise<boolean>, conflict: ExclusionError) {
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    if (!await change(tx, tenantId)) throw conflict;
    if (!await enqueueMerge(tx, tenantId)) throw new ExclusionError('已有一次合并在运行，等它结束后再试。', 409);
  });
}

/** 成员把最近一次成功打通的 hot 里的一个值标为不参与匹配（只收 hot 里有的哈希，记录数也取自那里，不收任意输入），并在同一个事务里入队合并 */
export async function excludeValue(actor: CurrentMember, hash: string) {
  assertCan(actor, 'sources:write');
  const hot = (await latestIdentitySummary(actor.tenant.id))?.hot.find(h => h.hash === hash);
  if (!hot) throw new ExclusionError('这个值不在最近一次打通的告警里，不能标记。', 400);
  await changeWithMerge(actor, (tx, tenantId) => addExclusion(tx, tenantId, actor, hash, hot.records), new ExclusionError('这个值已经标为不参与匹配。', 409));
}

/** 成员撤销一个不参与匹配的值，并在同一个事务里入队合并（不需要在 hot 里，列表里有就能撤销） */
export async function includeValue(actor: CurrentMember, hash: string) {
  assertCan(actor, 'sources:write');
  await changeWithMerge(actor, (tx, tenantId) => removeExclusion(tx, tenantId, actor, hash), new ExclusionError('这个值不在不参与匹配的列表里。', 404));
}

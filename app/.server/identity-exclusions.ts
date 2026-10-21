// app/.server/identity-exclusions.ts —— 不参与身份打通匹配的值（ADR-0039）：成员在数据质量页把热值标为不参与匹配，或撤销。
// 只存加盐哈希与标记时的记录数，审计也只记这两项；入队合并（带上排除列表并强制重算）由调用方在同一个事务里做
import { asc, desc, eq, and } from 'drizzle-orm';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { identityExcludedValues, members } from './db/schema';

type Actor = Pick<CurrentMember, 'memberId' | 'email'>;

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
export async function excludeValue(tx: Tx, tenantId: string, actor: Actor, hash: string, records: number) {
  const [row] = await tx.insert(identityExcludedValues).values({ tenantId, hash, records, createdBy: actor.memberId })
    .onConflictDoNothing().returning();
  if (!row) return false;
  await recordAudit(tx, { tenantId, actor, action: 'identity.value_excluded', targetType: 'identity_value', targetId: hash, detail: { hash, records } });
  return true;
}

/** 撤销登记并记审计；没有登记时什么都不做，返回 false */
export async function includeValue(tx: Tx, tenantId: string, actor: Actor, hash: string) {
  const [row] = await tx.delete(identityExcludedValues)
    .where(and(eq(identityExcludedValues.tenantId, tenantId), eq(identityExcludedValues.hash, hash))).returning();
  if (!row) return false;
  await recordAudit(tx, { tenantId, actor, action: 'identity.value_included', targetType: 'identity_value', targetId: hash, detail: { hash, records: row.records } });
  return true;
}

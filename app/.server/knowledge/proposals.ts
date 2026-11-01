// app/.server/knowledge/proposals.ts —— 知识提案（ADR-0046）：系统或 AI 给出的别名、口径声明、业务说明建议先存成提案（proposed），
// 接受前不进目录、检索与起草上下文（这里的表不读进 loadKnowledge）。成员接受（可以先改值）后在同一事务里变成对应的知识，作者是接受的成员，
// 目录版本由生成知识的那条审计记；拒绝时记下理由，按指纹（目标 + 映射 + 种类 + 声明 + 依据摘要）记住，同样的提案不再提出。
// 权限同别名：映射字段（带 mappingId）要 sources:write，其余要 definitions:draft。依据已变化的提案不能接受（409）。一律限定在操作者所属租户内
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { assertCan, can } from '../access';
import { recordAudit, type Tx } from '../audit';
import { sha256, type CurrentMember } from '../auth';
import { saveBusinessNoteTx } from '../business-notes';
import { getDb, isUniqueViolation } from '../db/client';
import { knowledgeProposals, type ProposalClaim, type ProposalKind, type ProposalStatus } from '../db/schema';
import { UUID } from '../tenants';
import { isClaimType, isClaimValue } from '../../lib/semantic-claims';
import { addAliasTx } from './aliases';
import { assertTarget, basisOf, KnowledgeError, stableJson } from './basis';
import { saveClaimTx } from './claims';

/** 可以展示给成员的错误：提案不存在 404，已处理过或依据已变化 409 */
export class ProposalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

export type Proposal = typeof knowledgeProposals.$inferSelect;
export interface Evidence { ref: string; version?: number }

export interface ProposalInput {
  targetId: string;
  mappingId?: string | null;
  kind: ProposalKind;
  claim: unknown;
  /** 元数据引用，不放取值 */
  evidence: Evidence[];
  generatorVersion: string;
}

const REASON_MAX_LENGTH = 500;

/** 校验种类与声明的形状，只留下该种类的键；不合法时抛 KnowledgeError */
function claimOf(kind: unknown, claim: unknown): ProposalClaim {
  const c = (claim && typeof claim === 'object' ? claim : {}) as Record<string, unknown>;
  if (kind === 'alias') {
    if (typeof c.alias !== 'string' || !c.alias.trim()) throw new KnowledgeError('别名提案缺少别名');
    return { alias: c.alias };
  }
  if (kind === 'claim') {
    if (!isClaimType(c.type)) throw new KnowledgeError('没有这种口径类型');
    if (!isClaimValue(c.type, c.value)) throw new KnowledgeError('这种口径没有这个取值');
    return { type: c.type, value: c.value };
  }
  if (kind === 'note') {
    if (typeof c.note !== 'string') throw new KnowledgeError('业务说明提案缺少说明');
    return { note: c.note };
  }
  throw new KnowledgeError(`没有这种提案：${String(kind)}`);
}

function evidenceOf(evidence: unknown): Evidence[] {
  if (!Array.isArray(evidence)) throw new KnowledgeError('证据要是列表');
  return evidence.map(e => {
    const { ref, version } = (e ?? {}) as Record<string, unknown>;
    if (typeof ref !== 'string' || !ref) throw new KnowledgeError('证据缺少引用');
    if (version !== undefined && !Number.isInteger(version)) throw new KnowledgeError('证据的版本要是整数');
    return version === undefined ? { ref } : { ref, version: version as number };
  });
}

/**
 * 存下一条提案（供系统调用，不查成员权限），依据摘要现算。指纹相同的已有提案（待处理或已接受）原样返回、不写入；
 * 命中已拒绝的返回 null。目标不合法（不存在、敏感字段、映射没写入）或声明形状不对时抛 KnowledgeError（400）
 */
export async function proposeKnowledge(tx: Tx, tenantId: string, input: ProposalInput): Promise<Proposal | null> {
  const { targetId, generatorVersion } = input;
  const mappingId = input.mappingId ?? null;
  const { kind } = input;
  // 未知种类由 claimOf 抛 400
  const claim = claimOf(kind, input.claim);
  const evidence = evidenceOf(input.evidence);
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  await assertTarget(tx, tenantId, targetId, mappingId);
  const basedOn = await basisOf(tx, tenantId, targetId, mappingId);
  const fingerprint = sha256(stableJson({ targetId, mappingId, kind, claim, basedOn }));
  // 并发提出同一条时唯一索引兜底，之后按指纹读回
  await tx.insert(knowledgeProposals)
    .values({ tenantId, targetId, mappingId, kind, claim, evidence, basedOn, fingerprint, generatorVersion })
    .onConflictDoNothing();
  const [row] = await tx.select().from(knowledgeProposals)
    .where(and(eq(knowledgeProposals.tenantId, tenantId), eq(knowledgeProposals.fingerprint, fingerprint)));
  return row!.status === 'rejected' ? null : row!;
}

/** 查看者（两种权限都没有）不必读行就 403；有其中一种的，读出行后按是不是映射字段再查 */
function assertCanReview(actor: CurrentMember) {
  if (!can(actor.role, 'definitions:draft') && !can(actor.role, 'sources:write')) assertCan(actor, 'definitions:draft');
}

/** 锁住本租户待处理的提案并查权限：不存在 404，已处理过 409 */
async function lockPending(tx: Tx, actor: CurrentMember, id: string): Promise<Proposal> {
  const [row] = UUID.test(id)
    ? await tx.select().from(knowledgeProposals)
      .where(and(eq(knowledgeProposals.id, id), eq(knowledgeProposals.tenantId, actor.tenant.id))).for('update')
    : [];
  if (!row) throw new ProposalError('没有这个提案', 404);
  if (row.status !== 'proposed') throw new ProposalError(row.status === 'accepted' ? '提案已接受' : '提案已拒绝', 409);
  assertCan(actor, row.mappingId ? 'sources:write' : 'definitions:draft');
  return row;
}

/** 把（改过的）声明写成对应的知识，返回知识行 ID */
async function materialize(tx: Tx, actor: CurrentMember, p: Proposal, claim: ProposalClaim): Promise<string> {
  const { targetId, mappingId } = p;
  if ('alias' in claim) return addAliasTx(tx, actor, { targetId, mappingId, alias: claim.alias });
  if ('type' in claim) return saveClaimTx(tx, actor, { targetId, mappingId, type: claim.type, value: claim.value });
  // 字段（含映射字段）的说明按 entity / field 存，实体、指标、标签的按 targetId 存
  const field = /^field:([^.]+)\.(.+)$/.exec(targetId);
  return field
    ? saveBusinessNoteTx(tx, actor, { entity: field[1]!, field: field[2]!, mappingId, note: claim.note })
    : saveBusinessNoteTx(tx, actor, { targetId, note: claim.note });
}

/**
 * 接受提案：可以先改值（edits 是同种类的声明），生成的知识用改后的值，提案行的声明与指纹保持原样。
 * 依据与提出时不同时 409「依据已变化」；生成知识出错（如别名重复）时整个事务回滚，提案仍待处理
 */
export async function acceptProposal(actor: CurrentMember, id: string, edits?: unknown): Promise<Proposal> {
  assertCanReview(actor);
  const tenantId = actor.tenant.id;
  try {
    return await getDb().transaction(async tx => {
      const p = await lockPending(tx, actor, id);
      const claim = edits === undefined ? p.claim : claimOf(p.kind, edits);
      // 先校验目标（映射字段会锁住映射行，与发布、停用互斥），再比依据
      await assertTarget(tx, tenantId, p.targetId, p.mappingId);
      const basedOn = await basisOf(tx, tenantId, p.targetId, p.mappingId);
      if (stableJson(basedOn) !== stableJson(p.basedOn)) throw new ProposalError('依据已变化', 409);
      const ref = await materialize(tx, actor, p, claim);
      const [row] = await tx.update(knowledgeProposals)
        .set({ status: 'accepted', reviewedByEmail: actor.email, reviewedAt: new Date(), acceptedRef: ref })
        .where(eq(knowledgeProposals.id, p.id)).returning();
      await recordAudit(tx, {
        tenantId, actor, action: 'knowledge_proposal.accepted', targetType: 'knowledge_proposal', targetId: p.id,
        detail: { proposalId: p.id, kind: p.kind, targetId: p.targetId },
      });
      return row!;
    });
  } catch (e) {
    // 并发加了同一个别名：唯一索引兜底
    if (isUniqueViolation(e)) throw new KnowledgeError('已有同样的别名');
    throw e;
  }
}

/** 拒绝提案：理由（去掉首尾空白，最多 500 字）只存在表里、不进审计；指纹留着，同样的提案不再提出 */
export async function rejectProposal(actor: CurrentMember, id: string, reason: unknown): Promise<Proposal> {
  assertCanReview(actor);
  if (typeof reason !== 'string') throw new ProposalError('缺少拒绝理由');
  const trimmed = reason.trim();
  if ([...trimmed].length > REASON_MAX_LENGTH) throw new ProposalError(`拒绝理由最多 ${REASON_MAX_LENGTH} 字`);
  const tenantId = actor.tenant.id;
  return getDb().transaction(async tx => {
    const p = await lockPending(tx, actor, id);
    const [row] = await tx.update(knowledgeProposals)
      .set({ status: 'rejected', reviewedByEmail: actor.email, reviewedAt: new Date(), rejectedReason: trimmed })
      .where(eq(knowledgeProposals.id, p.id)).returning();
    await recordAudit(tx, {
      tenantId, actor, action: 'knowledge_proposal.rejected', targetType: 'knowledge_proposal', targetId: p.id,
      detail: { proposalId: p.id, kind: p.kind, targetId: p.targetId },
    });
    return row!;
  });
}

/** 本租户的提案，可按目标与状态筛选，新的在前 */
export async function listProposals(
  db: Tx | ReturnType<typeof getDb>, tenantId: string, filter: { targetId?: string; status?: ProposalStatus } = {},
): Promise<Proposal[]> {
  const k = knowledgeProposals;
  const conds: SQL[] = [eq(k.tenantId, tenantId)];
  if (filter.targetId) conds.push(eq(k.targetId, filter.targetId));
  if (filter.status) conds.push(eq(k.status, filter.status));
  return db.select().from(k).where(and(...conds)).orderBy(desc(k.createdAt), desc(k.id));
}

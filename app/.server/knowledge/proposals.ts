// app/.server/knowledge/proposals.ts —— 知识提案（ADR-0046）：系统或 AI 生成的别名、口径声明、业务说明、主题归属先存成提案（proposed），等成员确认，
// 接受前不进目录、检索与起草上下文（这里的表不读进 loadKnowledge）。成员接受（主题归属不能改值）后在同一事务里变成对应的知识，作者是接受的成员，
// 目录版本由生成知识的那条审计记；拒绝时记下理由，按指纹（目标 + 映射 + 种类 + 内容 + 依据摘要）记住，同样的提案不再提出。
// 权限同别名：映射字段（带 mappingId）要 sources:write，其余要 definitions:draft。依据已变化的提案不能接受（409）。一律限定在操作者所属租户内。
// 批量入口 proposeMany 逐条在保存点里提出：单条不合法只回滚这一条、不连累整批，可选按生成前的依据快照跳过依据已变的目标
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit, type Tx } from '../audit';
import { sha256, type CurrentMember } from '../auth';
import { NOTE_MAX_LENGTH, saveBusinessNoteTx } from '../business-notes';
import { getDb } from '../db/client';
import {
  knowledgeProposals, type ProposalContent, type ProposalContentOf, type ProposalEvidence, type ProposalKind, type ProposalStatus,
} from '../db/schema';
import { isClaimType, isClaimValue } from '../../lib/semantic-claims';
import { UUID } from '../tenants';
import { addAliasTx, ALIAS_MAX_LENGTH } from './aliases';
import { assertTarget, basisOf, KnowledgeError, stableJson } from './basis';
import { saveClaimTx } from './claims';
import { assertCanTouchKnowledge, lockTenantRow, rethrowDuplicateAlias } from './guards';
import { addMembershipTx, assertSubject } from './subjects';

/** 可以展示给成员的错误：提案不存在 404，已处理过或依据已变化 409（输入不合法的 400 一律是 KnowledgeError） */
export class ProposalError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); }
}

export type Proposal = typeof knowledgeProposals.$inferSelect;

export interface ProposalInput {
  targetId: string;
  mappingId?: string | null;
  kind: ProposalKind;
  content: unknown;
  /** 元数据引用，不放取值 */
  evidence: ProposalEvidence[];
  generatorVersion: string;
}

const REASON_MAX_LENGTH = 500;

/** 一个种类的提案：parse 校验内容形状、只留下该种类的键（不合法时抛 KnowledgeError），materialize 把内容写成对应的知识、返回知识行 ID。
 *  check 是提出时要查库的额外校验（如主题归属要主题属于本租户），不合法时抛 KnowledgeError */
interface KindSpec<K extends ProposalKind> {
  parse(c: Record<string, unknown>): ProposalContentOf[K];
  check?(tx: Tx, tenantId: string, input: { mappingId: string | null; content: ProposalContentOf[K] }): Promise<void>;
  materialize(tx: Tx, actor: CurrentMember, p: Proposal, content: ProposalContentOf[K]): Promise<string>;
}

// 每个种类一项，新增种类只在这里加。别名与业务说明去掉首尾空白（与生成的知识一致，再进指纹）；长度在提出时就按上限校验（与 addAlias /
// saveBusinessNote 的上限一致），不要等接受时才报错
const KINDS: { [K in ProposalKind]: KindSpec<K> } = {
  alias: {
    parse(c) {
      const alias = typeof c.alias === 'string' ? c.alias.trim() : '';
      if (!alias) throw new KnowledgeError('别名提案缺少别名');
      if ([...alias].length > ALIAS_MAX_LENGTH) throw new KnowledgeError(`别名最多 ${ALIAS_MAX_LENGTH} 字`);
      return { alias };
    },
    async materialize(tx, actor, { targetId, mappingId }, { alias }) {
      // 并发加了同一个别名：唯一索引兜底（只改写别名的，其他种类的唯一冲突原样抛出）
      try { return await addAliasTx(tx, actor, { targetId, mappingId, alias }); } catch (e) { rethrowDuplicateAlias(e); }
    },
  },
  claim: {
    parse(c) {
      if (!isClaimType(c.type)) throw new KnowledgeError('没有这种口径类型');
      if (!isClaimValue(c.type, c.value)) throw new KnowledgeError('这种口径没有这个取值');
      return { type: c.type, value: c.value };
    },
    materialize: (tx, actor, { targetId, mappingId }, { type, value }) => saveClaimTx(tx, actor, { targetId, mappingId, type, value }),
  },
  note: {
    parse(c) {
      if (typeof c.note !== 'string') throw new KnowledgeError('业务说明提案缺少说明');
      const note = c.note.trim();
      if ([...note].length > NOTE_MAX_LENGTH) throw new KnowledgeError(`说明最多 ${NOTE_MAX_LENGTH} 字`);
      return { note };
    },
    materialize(tx, actor, { targetId, mappingId }, { note }) {
      // 字段（含映射字段）的说明按 entity / field 存，实体、指标、标签的按 targetId 存
      const field = /^field:([^.]+)\.(.+)$/.exec(targetId);
      return field
        ? saveBusinessNoteTx(tx, actor, { entity: field[1]!, field: field[2]!, mappingId, note })
        : saveBusinessNoteTx(tx, actor, { targetId, note });
    },
  },
  subject: {
    parse(c) {
      // 主题是否属于本租户、是否已删除要查库，放在 check；这里只校验形状，多余的键不进指纹
      if (typeof c.subjectId !== 'string' || !UUID.test(c.subjectId)) throw new KnowledgeError('主题归属提案缺少主题');
      return { subjectId: c.subjectId };
    },
    async check(tx, tenantId, { mappingId, content }) {
      // 主题归属和 addMembership 一样只挂目录条目，不挂映射字段
      if (mappingId) throw new KnowledgeError('映射字段不能归入主题');
      await assertSubject(tx, tenantId, content.subjectId);
    },
    // 条目已在主题里（被手动加过）时接受也成功：ifAbsent 不重复插入、不记审计，返回主题 ID 作为 acceptedRef
    materialize: (tx, actor, { targetId }, { subjectId }) => addMembershipTx(tx, actor, subjectId, targetId, { ifAbsent: true }),
  },
};

function isProposalKind(kind: unknown): kind is ProposalKind {
  return typeof kind === 'string' && Object.hasOwn(KINDS, kind);
}

/** 按种类校验提案内容；未知种类或内容不合法时抛 KnowledgeError */
function contentOf(kind: unknown, content: unknown): ProposalContent {
  if (!isProposalKind(kind)) throw new KnowledgeError(`没有这种提案：${String(kind)}`);
  return KINDS[kind].parse((content && typeof content === 'object' ? content : {}) as Record<string, unknown>);
}

/** 提案指纹。键名 claim 是改名前的写法，改了已有提案的指纹全变、拒绝过的会再出现，不能改 */
export function proposalFingerprint(input: Pick<Proposal, 'targetId' | 'mappingId' | 'kind' | 'content' | 'basedOn'>): string {
  const { targetId, mappingId, kind, content, basedOn } = input;
  return sha256(stableJson({ targetId, mappingId, kind, claim: content, basedOn }));
}

function evidenceOf(evidence: unknown): ProposalEvidence[] {
  if (!Array.isArray(evidence)) throw new KnowledgeError('证据要是列表');
  return evidence.map(e => {
    const { ref, version } = (e ?? {}) as Record<string, unknown>;
    if (typeof ref !== 'string' || !ref) throw new KnowledgeError('证据缺少引用');
    if (version !== undefined && !Number.isInteger(version)) throw new KnowledgeError('证据的版本要是整数');
    return version === undefined ? { ref } : { ref, version: version as number };
  });
}

/** proposeOne 走了哪条分支：新建（插入了行）、指纹已有（待处理或已接受，读回那条）、命中已拒绝、依据与快照不同跳过 */
type ProposalOutcome =
  | { proposal: Proposal; outcome: 'created' | 'existing' }
  | { proposal: null; outcome: 'rejected' | 'stale' };

/**
 * 提出一条（proposeKnowledge 与 proposeMany 共用的主体），依据摘要现算。目标不合法（不存在、敏感字段、映射没写入）
 * 或内容不合法（含超长）时抛 KnowledgeError（400）。给了 expectedBases（生成前 currentBases 的快照）时：
 * 写入时依据摘要与快照不同（含快照里没有这个 id）就不写、计 stale；依据为空的目标（实体、普通字段）永不过期
 */
async function proposeOne(
  tx: Tx, tenantId: string, input: ProposalInput, expectedBases?: Map<string, string>,
): Promise<ProposalOutcome> {
  const { targetId, mappingId = null, kind, generatorVersion } = input;
  // 未知种类由 contentOf 抛 400
  const content = contentOf(kind, input.content);
  const evidence = evidenceOf(input.evidence);
  if (typeof targetId !== 'string' || !targetId) throw new KnowledgeError('缺少目标');
  await assertTarget(tx, tenantId, targetId, mappingId);
  // 种类自己的校验（主题归属查主题）在目标校验之后、算指纹之前，不合法时 400 不写入
  await checkKind(tx, tenantId, kind, { mappingId, content });
  const basedOn = await basisOf(tx, tenantId, targetId, mappingId);
  if (expectedBases && basedOn.some(b => expectedBases.get(b.id) !== b.hash)) return { proposal: null, outcome: 'stale' };
  const fingerprint = proposalFingerprint({ targetId, mappingId, kind, content, basedOn });
  // 并发提出同一条时唯一索引兜底：插入返回了行就是新建，没插上再按指纹读回区分已有与已拒绝
  const [row] = await tx.insert(knowledgeProposals)
    .values({ tenantId, targetId, mappingId, kind, content, evidence, basedOn, fingerprint, generatorVersion })
    .onConflictDoNothing().returning();
  if (row) return { proposal: row, outcome: 'created' };
  const [existing] = await tx.select().from(knowledgeProposals)
    .where(and(eq(knowledgeProposals.tenantId, tenantId), eq(knowledgeProposals.fingerprint, fingerprint)));
  return existing!.status === 'rejected' ? { proposal: null, outcome: 'rejected' } : { proposal: existing!, outcome: 'existing' };
}

/**
 * 存下一条提案（供系统调用，不查成员权限），依据摘要现算。指纹相同的已有提案（待处理或已接受）原样返回、不写入；
 * 命中已拒绝的返回 null。目标不合法（不存在、敏感字段、映射没写入）或声明形状不对时抛 KnowledgeError（400）
 */
export async function proposeKnowledge(tx: Tx, tenantId: string, input: ProposalInput): Promise<Proposal | null> {
  const { proposal, outcome } = await proposeOne(tx, tenantId, input);
  return outcome === 'rejected' ? null : proposal;
}

/** proposeMany 的结果：created 是新建的提案行，existing / rejected / stale 是命中计数，invalid 记第几条、为什么不合法 */
export interface ProposeManyResult {
  created: Proposal[];
  existing: number;
  rejected: number;
  invalid: { index: number; reason: string }[];
  stale: number;
}

/**
 * 批量提出（供系统调用，不查成员权限）：逐条在保存点（drizzle 嵌套事务）里提出。单条不合法（目标不存在、敏感字段、
 * 内容不合法、超长）只回滚这一条、计入 invalid，不作废整批与外层事务；指纹已有计 existing，命中已拒绝计 rejected，
 * 依据与 expectedBases 快照不同计 stale（不写入）；其他错误照抛（连外层事务一起回滚）
 */
export async function proposeMany(
  tx: Tx, tenantId: string, inputs: ProposalInput[], opts: { expectedBases?: Map<string, string> } = {},
): Promise<ProposeManyResult> {
  const out: ProposeManyResult = { created: [], existing: 0, rejected: 0, invalid: [], stale: 0 };
  for (const [index, input] of inputs.entries()) {
    try {
      const { proposal, outcome } = await tx.transaction(sp => proposeOne(sp, tenantId, input, opts.expectedBases));
      if (outcome === 'created') out.created.push(proposal);
      else if (outcome === 'existing') out.existing++;
      else if (outcome === 'rejected') out.rejected++;
      else out.stale++;
    } catch (e) {
      if (!(e instanceof KnowledgeError)) throw e;
      out.invalid.push({ index, reason: e.message });
    }
  }
  return out;
}

/** 锁住本租户待处理的提案并查权限：不存在 404，已处理过 409 */
async function lockPending(tx: Tx, actor: CurrentMember, id: string): Promise<Proposal> {
  const row = await lockTenantRow(tx, knowledgeProposals, id, actor.tenant.id);
  if (!row) throw new ProposalError('没有这个提案', 404);
  if (row.status !== 'proposed') throw new ProposalError(row.status === 'accepted' ? '提案已接受' : '提案已拒绝', 409);
  assertCan(actor, row.mappingId ? 'sources:write' : 'definitions:draft');
  return row;
}

/** 把（改过的）内容按种类写成对应的知识，返回知识行 ID。泛型 K 把种类与内容绑在一起，查表时不用断言 */
function materialize<K extends ProposalKind>(tx: Tx, actor: CurrentMember, p: Proposal, kind: K, content: ProposalContentOf[K]): Promise<string> {
  return KINDS[kind].materialize(tx, actor, p, content);
}

/** 提出时按种类做要查库的额外校验（没有 check 的种类直接过）。泛型 K 把种类与内容绑在一起，查表时不用断言 */
function checkKind<K extends ProposalKind>(
  tx: Tx, tenantId: string, kind: K, input: { mappingId: string | null; content: ProposalContentOf[K] },
): Promise<void> {
  return KINDS[kind].check?.(tx, tenantId, input) ?? Promise.resolve();
}

/**
 * 接受提案：可以先改值（edits 是同种类的内容），生成的知识用改后的值，提案行的内容与指纹保持原样。
 * 依据与提出时不同时 409「依据已变化」；生成知识出错（如别名重复）时整个事务回滚，提案仍待处理
 */
export async function acceptProposal(actor: CurrentMember, id: string, edits?: unknown): Promise<Proposal> {
  assertCanTouchKnowledge(actor);
  const tenantId = actor.tenant.id;
  return getDb().transaction(async tx => {
    const p = await lockPending(tx, actor, id);
    // 主题归属不提供修改后接受：改 subjectId 等于把条目改归别的主题，面板不渲染入口，这里挡住直接提交
    if (p.kind === 'subject' && edits !== undefined) throw new KnowledgeError('主题归属提案不能修改后接受');
    const content = edits === undefined ? p.content : contentOf(p.kind, edits);
    // 先校验目标（映射字段会锁住映射行，与发布、停用互斥），再比依据
    await assertTarget(tx, tenantId, p.targetId, p.mappingId);
    const basedOn = await basisOf(tx, tenantId, p.targetId, p.mappingId);
    if (stableJson(basedOn) !== stableJson(p.basedOn)) throw new ProposalError('依据已变化', 409);
    const ref = await materialize(tx, actor, p, p.kind, content);
    const [row] = await tx.update(knowledgeProposals)
      .set({ status: 'accepted', reviewedByEmail: actor.email, reviewedAt: new Date(), acceptedRef: ref })
      .where(eq(knowledgeProposals.id, p.id)).returning();
    await recordAudit(tx, {
      tenantId, actor, action: 'knowledge_proposal.accepted', targetType: 'knowledge_proposal', targetId: p.id,
      detail: { proposalId: p.id, kind: p.kind, targetId: p.targetId },
    });
    return row!;
  });
}

/** 拒绝提案：理由（去掉首尾空白，最多 500 字）只存在表里、不进审计；指纹留着，同样的提案不再提出 */
export async function rejectProposal(actor: CurrentMember, id: string, reason: unknown): Promise<Proposal> {
  assertCanTouchKnowledge(actor);
  if (typeof reason !== 'string') throw new KnowledgeError('缺少拒绝理由');
  const trimmed = reason.trim();
  if ([...trimmed].length > REASON_MAX_LENGTH) throw new KnowledgeError(`拒绝理由最多 ${REASON_MAX_LENGTH} 字`);
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
  const conds: SQL[] = [eq(knowledgeProposals.tenantId, tenantId)];
  if (filter.targetId) conds.push(eq(knowledgeProposals.targetId, filter.targetId));
  if (filter.status) conds.push(eq(knowledgeProposals.status, filter.status));
  return db.select().from(knowledgeProposals).where(and(...conds))
    .orderBy(desc(knowledgeProposals.createdAt), desc(knowledgeProposals.id));
}

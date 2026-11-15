// app/.server/assistant/knowledge-ask.ts —— 助手「记为知识提案」卡片与提交（⑥-4，ADR-0046 / 0056 / 0043）：
// 点选歧义候选的回答（user 消息上的 chosen）只是数据，把它变成知识要成员确认。卡片由服务端确定性组装（不是模型生成的）：
// 词与条目取自存下的 chosen、名称取自成员自己的目录，显示卡片与提交都要 definitions:draft；同词已有待复核的默认指向提案
// （不论挂哪个条目，proposals 的唯一索引只按指纹、挡不住这种情况）或这条提案的指纹已被拒绝 / 已接受过时不给卡片，
// 读时计算、不存库（审核状态变了，读回跟着变）。确认后生成一条 term_default 提案（接受前不进目录，ADR-0046），
// 证据只记对话引用（ADR-0056 第⑤条）：不放用户原话，审核人也读不了别人的对话。
import { can, deniedReason } from '../access';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { basisOf } from '../knowledge/basis';
import { listProposals, proposeKnowledge, proposalFingerprint } from '../knowledge/proposals';
import type { ProposalContentOf } from '../db/schema';
import { readConversation } from './conversations';
import { catalogFor } from './tools';

/** 助手答复下的「记为知识提案」卡片：index 是带 chosen 的 user 消息在对话里的下标（提交时按它取回选择） */
export interface AskCard { index: number; term: string; entryId: string; name: string }

/**
 * 这个默认指向提案该不该提出：返回阻止原因，不阻止时返回 null。
 * 同词已有待复核提案（不论挂哪个条目，也不分大小写）优先——否则成员换一个条目再点一次就能重复提案；
 * 再按指纹查这个目标上的历史提案：已拒绝的不再提（ADR-0046），已接受的说明已有默认指向
 */
export async function proposalBlock(tenantId: string, term: string, entryId: string): Promise<string | null> {
  const db = getDb();
  for (const p of await listProposals(db, tenantId, { status: 'proposed' })) {
    if (p.kind !== 'term_default') continue;
    // kind 与 content 的对应在 proposeKnowledge 写入时已校验，表列类型表达不了，这里按它收窄
    const { term: existing } = p.content as ProposalContentOf['term_default'];
    if (existing.toLowerCase() === term.toLowerCase()) return '这个词已有待复核的默认指向提案';
  }
  // 指纹与 proposeKnowledge 内部同口径：内容先经种类的规范化（trim），依据现算
  const basedOn = await basisOf(db, tenantId, entryId, null);
  const fingerprint = proposalFingerprint({ targetId: entryId, mappingId: null, kind: 'term_default', content: { term: term.trim() }, basedOn });
  const same = (await listProposals(db, tenantId, { targetId: entryId })).find(p => p.fingerprint === fingerprint);
  if (same?.status === 'rejected') return '这条默认指向提案已被拒绝过';
  if (same?.status === 'accepted') return '已接受过这条默认指向';
  return null;
}

/**
 * 按存下的选择组装卡片：无 definitions:draft、条目不在成员自己的目录里（#539）或 proposalBlock 挡住时返回 null。
 * 只在本人读回 / 本人点选的答复里调用——被分享人只读，不替主人提提案
 */
export async function askCardFor(member: CurrentMember, chosen: { term: string; entryId: string }, index: number): Promise<AskCard | null> {
  if (!can(member.role, 'definitions:draft')) return null;
  const entry = (await catalogFor(member)).entries.find(e => e.id === chosen.entryId);
  if (!entry) return null;
  if (await proposalBlock(member.tenant.id, chosen.term, chosen.entryId) !== null) return null;
  return { index, term: chosen.term, entryId: chosen.entryId, name: entry.name };
}

/**
 * 确认提交：把对话 messages[index] 上存着的 chosen 变成一条待复核的 term_default 提案。词与条目只取自 chosen，
 * 不收客户端传来的值。出错时返回 Response（路由原样发回）；readConversation 读不到对话时照抛 404，
 * proposeKnowledge 的种类校验不通过（如词已不是目标条目的名称或别名）时照抛 KnowledgeError，路由的 errorResponse 都认得
 */
export async function proposeDefault(member: CurrentMember, conversationId: string, index: number): Promise<{ ok: true; proposalId: string } | Response> {
  // 用 can 不用 assertCan：assertCan 抛的是 data({ message })，不是这里的 { error }
  if (!can(member.role, 'definitions:draft')) return Response.json({ error: deniedReason('definitions:draft') }, { status: 403 });
  const conversation = await readConversation(member, conversationId);
  if (!conversation.owned) return Response.json({ error: '没有这个对话' }, { status: 404 });
  const chosen = conversation.messages[index]?.chosen;
  if (!chosen) return Response.json({ error: '这条消息不是点选候选的回答' }, { status: 400 });
  if (!(await catalogFor(member)).entries.some(e => e.id === chosen.entryId)) {
    return Response.json({ error: '这个条目不在你的目录里' }, { status: 400 });
  }
  const block = await proposalBlock(member.tenant.id, chosen.term, chosen.entryId);
  if (block) return Response.json({ error: block }, { status: 409 });
  const proposal = await getDb().transaction(tx => proposeKnowledge(tx, member.tenant.id, {
    targetId: chosen.entryId,
    mappingId: null,
    kind: 'term_default',
    content: { term: chosen.term },
    evidence: [{ ref: `assistant_conversation:${conversationId}` }],
    generatorVersion: 'assistant-choice/1',
  }));
  // 指纹已拒绝过（与拒绝并发的窗口里预检没拦住）时 proposeKnowledge 返回 null，不能当成新建
  if (!proposal) return Response.json({ error: '这条默认指向提案已被拒绝过' }, { status: 409 });
  return { ok: true, proposalId: proposal.id };
}

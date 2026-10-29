// app/.server/assistant/conversations.ts —— AI 助手对话的保存与只读分享（ADR-0043）。
// 对话按成员存在 platform.assistant_conversations：标题与消息用租户数据密钥加密后存一个字段（ADR-0009），表里没有明文。
// 消息只有成员与助手的文字和用过的工具名，不存工具输出、不存查询结果行。只有本人能读、续写与分享；
// 被分享人（同租户成员）只能读。按 id 访问别人没分享给自己的对话一律 404（管理员也一样）。
// 成员被移出租户时，其对话与分享经外键级联删除
import { and, desc, eq } from 'drizzle-orm';
import { recordAudit, type Tx } from '../audit';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { assistantConversations, assistantConversationShares, members } from '../db/schema';
import { decryptForTenant, encryptForTenant } from '../secrets';
import { normalizeEmail, UUID } from '../tenants';
import { MAX_CONTENT } from './loop';

export const ASSISTANT_CONTEXT = 'assistant.conversation';
/** 列表最多列出的对话数 */
const LIST_LIMIT = 50;
const TITLE_LENGTH = 40;

export class ConversationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) { super(message); }
}

export interface StoredMessage { role: 'user' | 'assistant'; content: string; toolsUsed?: string[] }
interface SealedBody { title: string; messages: StoredMessage[] }
export interface ConversationSummary { id: string; title: string; updatedAt: Date }
export interface Conversation extends SealedBody {
  id: string;
  /** 是不是本人的对话：只有本人能续写与分享 */
  owned: boolean;
  /** 本人的对话分享给了谁（邮箱）；被分享人看到的是空列表 */
  sharedWith: string[];
}

const NOT_FOUND = () => new ConversationError('没有这个对话', 404);

async function unseal(tenantId: string, sealed: string): Promise<SealedBody> {
  return JSON.parse((await decryptForTenant(tenantId, ASSISTANT_CONTEXT, sealed)).body);
}

const seal = (tenantId: string, body: SealedBody) => encryptForTenant(tenantId, ASSISTANT_CONTEXT, { body: JSON.stringify(body) });

/** 按 rows 的顺序解密出标题，其余字段原样带上 */
async function summaries<T extends { id: string; sealed: string; updatedAt: Date }>(tenantId: string, rows: T[]) {
  return Promise.all(rows.map(async ({ sealed, ...rest }) => ({ ...rest, title: (await unseal(tenantId, sealed)).title })));
}

const SUMMARY_COLUMNS = { id: assistantConversations.id, sealed: assistantConversations.sealed, updatedAt: assistantConversations.updatedAt };

/** 自己最近更新的 LIST_LIMIT 个对话 */
export async function listMyConversations(actor: CurrentMember): Promise<ConversationSummary[]> {
  const rows = await getDb().select(SUMMARY_COLUMNS)
    .from(assistantConversations)
    .where(and(eq(assistantConversations.tenantId, actor.tenant.id), eq(assistantConversations.memberId, actor.memberId)))
    .orderBy(desc(assistantConversations.updatedAt)).limit(LIST_LIMIT);
  return summaries(actor.tenant.id, rows);
}

/** 别人分享给自己的最近更新的 LIST_LIMIT 个对话，带主人的邮箱 */
export async function listSharedWithMe(actor: CurrentMember): Promise<(ConversationSummary & { owner: string })[]> {
  const rows = await getDb().select({ ...SUMMARY_COLUMNS, owner: members.email })
    .from(assistantConversationShares)
    .innerJoin(assistantConversations, eq(assistantConversations.id, assistantConversationShares.conversationId))
    .innerJoin(members, eq(members.id, assistantConversations.memberId))
    .where(and(eq(assistantConversationShares.memberId, actor.memberId), eq(assistantConversations.tenantId, actor.tenant.id)))
    .orderBy(desc(assistantConversations.updatedAt)).limit(LIST_LIMIT);
  return summaries(actor.tenant.id, rows);
}

/** 读对话 id：本人或被分享人可读，否则（包括管理员、其他租户、id 不合法）404 */
export async function readConversation(actor: CurrentMember, id: string): Promise<Conversation> {
  if (!UUID.test(id)) throw NOT_FOUND();
  const db = getDb();
  const [row] = await db.select().from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.tenantId, actor.tenant.id)));
  if (!row) throw NOT_FOUND();
  const owned = row.memberId === actor.memberId;
  const shares = await db.select({ memberId: members.id, email: members.email }).from(assistantConversationShares)
    .innerJoin(members, eq(members.id, assistantConversationShares.memberId))
    .where(eq(assistantConversationShares.conversationId, id));
  if (!owned && !shares.some(s => s.memberId === actor.memberId)) throw NOT_FOUND();
  return { id, owned, sharedWith: owned ? shares.map(s => s.email).sort() : [], ...await unseal(actor.tenant.id, row.sealed) };
}

/**
 * 把一轮问答（成员的问题、助手的答复与用过的工具名）记进自己的对话 id；id 为 null 时新建，标题取问题的前 TITLE_LENGTH 字。
 * 返回对话 id。不是自己的对话时 404（被分享人也不能续写）
 */
export async function appendTurn(actor: CurrentMember, id: string | null, userText: string, reply: string, toolsUsed: string[]): Promise<string> {
  const tenantId = actor.tenant.id;
  const turn: StoredMessage[] = [
    { role: 'user', content: userText.slice(0, MAX_CONTENT) },
    { role: 'assistant', content: reply.slice(0, MAX_CONTENT), toolsUsed },
  ];
  const db = getDb();
  if (id === null) {
    const title = userText.trim().replace(/\s+/g, ' ').slice(0, TITLE_LENGTH) || '新对话';
    const [row] = await db.insert(assistantConversations)
      .values({ tenantId, memberId: actor.memberId, sealed: await seal(tenantId, { title, messages: turn }) })
      .returning({ id: assistantConversations.id });
    return row.id;
  }
  return db.transaction(async tx => {
    const row = await ownConversation(tx, actor, id);
    const body = await unseal(tenantId, row.sealed);
    await tx.update(assistantConversations)
      .set({ sealed: await seal(tenantId, { ...body, messages: [...body.messages, ...turn] }), updatedAt: new Date() })
      .where(eq(assistantConversations.id, id));
    return id;
  });
}

// 分享与撤销照 workbench.ts 的 shareSandboxTable / unshareSandboxTable（锁住自己的行 → 按邮箱找本租户成员 → 增删分享行 → 记审计），
// memberByEmail 也与那边相同：再有第三处只读分享时，把这副骨架抽成共用的模块（深化候选）
/**
 * 把自己的对话 id 只读分享给本租户成员 email（已分享过时不变、不再记审计），记审计；返回规范化后的邮箱。
 * 不是自己的对话 404；对方不是本租户成员或是自己 400
 */
export async function shareConversation(actor: CurrentMember, id: string, email: string) {
  const target = normalizeEmail(email);
  await getDb().transaction(async tx => {
    await ownConversation(tx, actor, id);
    const member = await memberByEmail(tx, actor, target);
    if (member.id === actor.memberId) throw new ConversationError('不用分享给自己', 400);
    const inserted = await tx.insert(assistantConversationShares).values({ conversationId: id, memberId: member.id }).onConflictDoNothing().returning();
    if (inserted.length) await recordAudit(tx, { tenantId: actor.tenant.id, actor, action: 'assistant.conversation_shared', targetType: 'assistant_conversation', targetId: id, detail: { member: target } });
  });
  return target;
}

/** 撤销把自己的对话 id 分享给 email，记审计；返回规范化后的邮箱。不是自己的对话 404，没有分享给对方 400 */
export async function unshareConversation(actor: CurrentMember, id: string, email: string) {
  const target = normalizeEmail(email);
  await getDb().transaction(async tx => {
    await ownConversation(tx, actor, id);
    const member = await memberByEmail(tx, actor, target);
    const deleted = await tx.delete(assistantConversationShares)
      .where(and(eq(assistantConversationShares.conversationId, id), eq(assistantConversationShares.memberId, member.id))).returning();
    if (!deleted.length) throw new ConversationError(`这个对话没有分享给 ${target}`, 400);
    await recordAudit(tx, { tenantId: actor.tenant.id, actor, action: 'assistant.conversation_unshared', targetType: 'assistant_conversation', targetId: id, detail: { member: target } });
  });
  return target;
}

/** 自己的对话 id（锁住这一行，续写互斥）；不是自己的或没有时 404 */
async function ownConversation(tx: Tx, actor: CurrentMember, id: string) {
  if (!UUID.test(id)) throw NOT_FOUND();
  const [row] = await tx.select({ sealed: assistantConversations.sealed }).from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.tenantId, actor.tenant.id), eq(assistantConversations.memberId, actor.memberId)))
    .for('update');
  if (!row) throw NOT_FOUND();
  return row;
}

/** 本租户邮箱为 email 的成员；没有时（包括其他租户的成员）400 */
async function memberByEmail(tx: Tx, actor: CurrentMember, email: string) {
  const [member] = await tx.select({ id: members.id }).from(members)
    .where(and(eq(members.tenantId, actor.tenant.id), eq(members.email, email)));
  if (!member) throw new ConversationError(`本租户没有成员 ${email}`, 400);
  return member;
}

// app/.server/knowledge/panel.ts —— 业务知识面板（ADR-0046）的读模型与表单分发：一个目录条目上成员写的知识（别名带 ID 以便停用、每种类型最新的口径声明、
// 当前业务说明与历史、本租户全部主题与已加入的那些），需复核标记取自 loadKnowledge，不另写一套规则。目录里的 Knowledge 只有别名字符串，所以别名直接查表。
// 表单按 intent（alias.* / claim.* / note.* / subject.*）交给各领域函数，权限由它们检查（403 照抛）；输入不合法转成 400 和中文消息。本期只做 mappingId 为空的目标
import { and, eq, isNull } from 'drizzle-orm';
import { can } from '../access';
import type { CurrentMember } from '../auth';
import { BusinessNoteError, saveBusinessNote, targetNoteHistory, type NoteVersion } from '../business-notes';
import { getDb } from '../db/client';
import { knowledgeAliases, subjectMemberships } from '../db/schema';
import { cmpName } from '../../lib/compare';
import { addAlias, retireAlias } from './aliases';
import { KnowledgeError } from './basis';
import { knowledgeKey, loadKnowledge, type Claim } from './catalog';
import { saveClaim } from './claims';
import { addMembership, createSubject, listSubjects, removeMembership, type Subject } from './subjects';

export interface KnowledgePanel {
  aliases: { id: string; alias: string; needsReview: boolean }[];
  /** 每种类型最新的一条，按登记顺序；需复核时 value 是 'unknown'、previous 是原值 */
  claims: Claim[];
  /** current 为空串表示没有或已清空；history 从旧到新 */
  note: { current: string; history: NoteVersion[]; needsReview: boolean };
  /** all 是本租户全部主题，memberOf 是这个条目已加入的主题 ID */
  subjects: { all: Subject[]; memberOf: string[] };
  canEdit: boolean;
}

/** 一个目录条目（targetId 如 metric:k、tag:k）的面板数据；mappingId 给定时是映射字段的，编辑要 sources:write */
export async function knowledgePanel(member: CurrentMember, targetId: string, mappingId: string | null = null): Promise<KnowledgePanel> {
  const db = getDb();
  const tenantId = member.tenant.id;
  const k = (await loadKnowledge(db, tenantId)).byTarget.get(knowledgeKey(targetId, mappingId)) ?? {};
  const aliases = await db.select({ id: knowledgeAliases.id, alias: knowledgeAliases.alias }).from(knowledgeAliases).where(and(
    eq(knowledgeAliases.tenantId, tenantId), eq(knowledgeAliases.targetId, targetId),
    mappingId ? eq(knowledgeAliases.mappingId, mappingId) : isNull(knowledgeAliases.mappingId), isNull(knowledgeAliases.retiredAt),
  ));
  const memberOf = await db.select({ id: subjectMemberships.subjectId }).from(subjectMemberships)
    .where(and(eq(subjectMemberships.tenantId, tenantId), eq(subjectMemberships.targetId, targetId)));
  const history = await targetNoteHistory(db, tenantId, targetId);
  return {
    aliases: aliases.sort((a, b) => cmpName(a.alias, b.alias))
      .map(a => ({ ...a, needsReview: Boolean(k.aliasesNeedReview?.includes(a.alias)) })),
    claims: k.claims ?? [],
    note: { current: history.at(-1)?.note ?? '', history, needsReview: Boolean(k.noteNeedsReview) },
    subjects: { all: await listSubjects(db, tenantId), memberOf: memberOf.map(r => r.id) },
    canEdit: can(member.role, mappingId ? 'sources:write' : 'definitions:draft'),
  };
}

/** 面板表单的 intent 前缀；路由据此把提交交给 handleKnowledgeIntent */
export const isKnowledgeIntent = (intent: string) => /^(alias|claim|note|subject)\./.test(intent);

/** 按 intent 执行一次面板提交；输入不合法返回 400 和消息，没有权限照抛 403 */
export async function handleKnowledgeIntent(member: CurrentMember, form: FormData): Promise<{ ok: true } | { error: string; status: number }> {
  const field = (name: string) => form.get(name) ?? undefined;
  const targetId = field('targetId');
  try {
    switch (field('intent')) {
      case 'alias.add':
        await addAlias(member, { targetId, alias: field('alias') });
        break;
      case 'alias.retire':
        await retireAlias(member, String(field('aliasId') ?? ''));
        break;
      case 'claim.save':
        await saveClaim(member, { targetId, type: field('type'), value: field('value') });
        break;
      case 'note.save':
        await saveBusinessNote(member, { targetId, note: field('note') });
        break;
      case 'subject.add':
        await addMembership(member, field('subjectId'), targetId);
        break;
      case 'subject.create':
        await addMembership(member, await createSubject(member, field('name')), targetId);
        break;
      case 'subject.remove':
        await removeMembership(member, field('subjectId'), targetId);
        break;
      default:
        return { error: '未知操作', status: 400 };
    }
  } catch (e) {
    if (e instanceof KnowledgeError || e instanceof BusinessNoteError) return { error: e.message, status: e.status };
    throw e;
  }
  return { ok: true };
}

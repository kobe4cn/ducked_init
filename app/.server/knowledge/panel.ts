// app/.server/knowledge/panel.ts —— 业务知识面板（ADR-0046）的读模型与表单分发：一个目录条目上成员写的知识（别名带 ID 以便停用、每种类型最新的口径声明、
// 当前业务说明与历史、本租户全部主题与已加入的那些）和待确认的知识提案，需复核标记取自 loadKnowledge，不另写一套规则。目录里的 Knowledge 只有别名字符串，所以别名直接查表。
// 表单按 intent（alias.* / claim.* / note.* / subject.* / proposal.*）交给各领域函数，权限由它们检查（403 照抛）；输入不合法转成 400 和中文消息。本期只做 mappingId 为空的目标
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { can } from '../access';
import type { CurrentMember } from '../auth';
import { BusinessNoteError, saveBusinessNote, targetNoteHistory, type NoteVersion } from '../business-notes';
import { getDb } from '../db/client';
import { knowledgeAliases, sources, subjectMemberships, type ProposalContentOf, type ProposalEvidence } from '../db/schema';
import { cmpName } from '../../lib/compare';
import { addAlias, retireAlias } from './aliases';
import { KnowledgeError } from './basis';
import { knowledgeKey, loadKnowledge, type Claim } from './catalog';
import { saveClaim } from './claims';
import { acceptProposal, listProposals, ProposalError, rejectProposal } from './proposals';
import { addMembership, createSubject, listSubjects, removeMembership, type Subject } from './subjects';

/** 面板里一条提案证据的展示文字与可选链接（#524）：ref 不直接下发，source_comment 在服务端按权限换成脱敏文字 */
export interface PanelEvidence {
  text: string;
  href?: string;
}

/** 面板里的一条待确认提案：只带展示与处理要的列（不带时间列与指纹），content 按 kind 收窄 */
export type PanelProposal = { [K in keyof ProposalContentOf]: { id: string; kind: K; content: ProposalContentOf[K]; evidence: PanelEvidence[] } }[keyof ProposalContentOf];

/** source:<id>#p<段号> 的证据（#527）：链到来源原文页的对应段落，带上证据记下的版本；不是这种 ref 时返回 null */
function sourceDocHref(ref: string, version?: number): string | null {
  const m = /^source:([^#]+)#p(\d+)$/.exec(ref);
  return m ? `/knowledge/sources/${m[1]}${version === undefined ? '' : `?v=${version}`}#p${m[2]}` : null;
}

/**
 * 各提案的证据转成展示文字与链接（#524）：普通证据原样显示（有版本加 vN）；source_comment:<源 ID>/<schema.表.列> 在成员有
 * sources:read 且源没有被软删时显示源名并链到数据源页「源端注释」的锚点，否则只给「源端注释 vN」——没有权限的成员
 * 不能从 HTML 里看到源、表与列名，所以必须在服务端替换，不能只在组件里隐藏。涉及的源一次查出，不逐条查
 */
async function evidenceOf(member: CurrentMember, proposals: { evidence: ProposalEvidence[] }[]): Promise<PanelEvidence[][]> {
  // 源 ID 在第一个 / 之前；key 是 <schema>.<表>.<列>，不再按 . 切
  const ids = [...new Set(proposals.flatMap(p => p.evidence)
    .map(e => /^source_comment:([^/]+)/.exec(e.ref)?.[1]).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length && can(member.role, 'sources:read')) {
    const rows = await getDb().select({ id: sources.id, name: sources.name }).from(sources)
      .where(and(eq(sources.tenantId, member.tenant.id), inArray(sources.id, ids), isNull(sources.deletedAt)));
    for (const r of rows) names.set(r.id, r.name);
  }
  return proposals.map(({ evidence }) => evidence.map(e => {
    const v = e.version === undefined ? '' : ` v${e.version}`;
    const comment = /^source_comment:([^/]*)\/(.+)$/.exec(e.ref);
    if (comment) {
      const [, id, key] = comment;
      const name = names.get(id);
      return name === undefined
        ? { text: `源端注释${v}` }
        : { text: `源端注释 ${name} ${key}${v}`, href: `/sources/${id}#comment-${encodeURIComponent(key)}` };
    }
    const href = sourceDocHref(e.ref, e.version);
    return { text: `${e.ref}${v}`, ...(href ? { href } : {}) };
  }));
}

export interface KnowledgePanel {
  aliases: { id: string; alias: string; needsReview: boolean }[];
  /** 每种类型最新的一条，按登记顺序；需复核时 value 是 'unknown'、previous 是原值 */
  claims: Claim[];
  /** current 为空串表示没有或已清空；history 从旧到新 */
  note: { current: string; history: NoteVersion[]; needsReview: boolean };
  /** all 是本租户全部主题，memberOf 是这个条目已加入的主题 ID */
  subjects: { all: Subject[]; memberOf: string[] };
  /** 本目标待确认的提案，新的在前 */
  proposals: PanelProposal[];
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
  const proposals = (await listProposals(db, tenantId, { targetId, status: 'proposed' })).filter(p => p.mappingId === mappingId);
  const evidence = await evidenceOf(member, proposals);
  return {
    aliases: aliases.sort((a, b) => cmpName(a.alias, b.alias))
      .map(a => ({ ...a, needsReview: Boolean(k.aliasesNeedReview?.includes(a.alias)) })),
    claims: k.claims ?? [],
    note: { current: history.at(-1)?.note ?? '', history, needsReview: Boolean(k.noteNeedsReview) },
    subjects: { all: await listSubjects(db, tenantId), memberOf: memberOf.map(r => r.id) },
    // kind 与 content 的对应在 proposeKnowledge 写入时已校验，表列类型表达不了，这里按它收窄
    proposals: proposals.map((p, i) => ({ id: p.id, kind: p.kind, content: p.content, evidence: evidence[i] }) as PanelProposal),
    canEdit: can(member.role, mappingId ? 'sources:write' : 'definitions:draft'),
  };
}

/** 面板表单的 intent 前缀；路由据此把提交交给 handleKnowledgeIntent */
export const isKnowledgeIntent = (intent: string) => /^(alias|claim|note|subject|proposal)\./.test(intent);

/** 「修改后接受」表单里改后的内容，按隐藏字段 kind 取对应的输入；种类与提案不符或不合法时由 acceptProposal 抛 400 */
function editsOf(field: (name: string) => FormDataEntryValue | undefined): unknown {
  switch (field('kind')) {
    case 'alias': return { alias: field('alias') };
    case 'claim': return { type: field('type'), value: field('value') };
    case 'note': return { note: field('note') };
    default: return {};
  }
}

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
      case 'proposal.accept':
        await acceptProposal(member, String(field('proposalId') ?? ''));
        break;
      case 'proposal.acceptEdited': {
        await acceptProposal(member, String(field('proposalId') ?? ''), editsOf(field));
        break;
      }
      case 'proposal.reject': {
        // rejectProposal 放过空理由，面板上理由必填
        const reason = String(field('reason') ?? '').trim();
        if (!reason) return { error: '请填写拒绝理由', status: 400 };
        await rejectProposal(member, String(field('proposalId') ?? ''), reason);
        break;
      }
      default:
        return { error: '未知操作', status: 400 };
    }
  } catch (e) {
    if (e instanceof KnowledgeError || e instanceof BusinessNoteError || e instanceof ProposalError) return { error: e.message, status: e.status };
    throw e;
  }
  return { ok: true };
}

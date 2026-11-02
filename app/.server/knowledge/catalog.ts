// app/.server/knowledge/catalog.ts —— 业务知识（ADR-0046）在语义目录里的挂载点：每个目录条目（映射字段挂在字段条目下该映射的血缘项上）可选地带一份 Knowledge，
// 参与搜索、写进 Markdown。目前有别名、口径声明、所属分析主题与实体、指标、标签的业务说明（字段与映射字段的说明仍由 catalog/index.ts 挂在 note 上）。
// 需复核：知识行存下的依据摘要（based_on）里有一项与当前摘要（currentBases）不同时，这条知识需复核——别名照常生效、另列进 aliasesNeedReview，
// 说明带 noteNeedsReview，口径声明按「未知」输出并带上原值；映射字段说明的需复核算成 staleNotes 交给 catalog/index.ts。依据已不在当前摘要里的
// （定义删除、映射停用）目标本来就不在目录里，不算需复核；没有依据的（实体、普通字段、旧行）永远不需复核。重新保存（别名停用后重新加）后依据更新，标记消失。
// 没有知识的条目不带 knowledge 键，目录快照与没有知识时一样。没有声明的口径类型不输出（没有声明不等于声明了「未知」）
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../audit';
import { currentMappingNoteBases, currentTargetNotes } from '../business-notes';
import type { getDb } from '../db/client';
import { analysisSubjects, knowledgeAliases, semanticClaims, subjectMemberships } from '../db/schema';
import { cmpName } from '../../lib/compare';
import { currentBases, type Basis } from './basis';
import { CLAIM_TYPE_ORDER, claimTypeLabel, claimValueLabel, isClaimType, isClaimValue, type ClaimType } from '../../lib/semantic-claims';

/** 挂在一个目录条目（或映射字段）上的业务知识；没有的部分不给 */
export interface Knowledge {
  aliases?: string[];
  /** aliases 里需复核的那些（仍然生效） */
  aliasesNeedReview?: string[];
  claims?: Claim[];
  subjects?: string[];
  note?: string;
  noteNeedsReview?: true;
}

/** 一条生效的口径声明：同一挂载点、同一类型最新的一行。需复核时 value 是 'unknown'、previous 是原值 */
export interface Claim { type: ClaimType; value: string; previous?: string; needsReview?: true }

/** 生成目录用的业务知识：键是 knowledgeKey；staleNotes 是需复核的映射字段说明，键是 noteKey */
export interface KnowledgeInput { byTarget: ReadonlyMap<string, Knowledge>; staleNotes?: ReadonlySet<string> }

/** 知识挂载点的键：目录条目标识，映射字段再带映射 ID */
export const knowledgeKey = (targetId: string, mappingId: string | null = null) => (mappingId ? `${targetId}\n${mappingId}` : targetId);

/** 去掉空的部分；什么都没有时为 undefined（条目就不带 knowledge 键） */
export function presentKnowledge(k: Knowledge | undefined): Knowledge | undefined {
  const out: Knowledge = {};
  if (k?.aliases?.length) out.aliases = k.aliases;
  if (k?.aliases?.length && k.aliasesNeedReview?.length) out.aliasesNeedReview = k.aliasesNeedReview;
  if (k?.claims?.length) out.claims = k.claims;
  if (k?.subjects?.length) out.subjects = k.subjects;
  if (k?.note) out.note = k.note;
  if (k?.note && k.noteNeedsReview) out.noteNeedsReview = true;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 本租户的业务知识，按挂载点归拢：未停用的别名（同一挂载点内按 cmpName 排，ADR-0045），
 * 每个 (挂载点, 类型) 最新的口径声明（按登记顺序排），所属分析主题名（按 cmpName 排；主题只归属到目录条目，不到映射字段），
 * 实体、指标、标签的当前业务说明（已清空的不给），各自按依据摘要标出需复核。最新一行的类型或取值已从登记表删掉时，这种类型不输出、也不退回到上一版
 * （登记表只加不删，删取值要先迁移数据）
 */
export async function loadKnowledge(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<KnowledgeInput> {
  const bases = await currentBases(db, tenantId);
  const stale = (basedOn: Basis[]) => basedOn.some(b => bases.has(b.id) && bases.get(b.id) !== b.hash);
  const aliases = await db.select({
    targetId: knowledgeAliases.targetId, mappingId: knowledgeAliases.mappingId, alias: knowledgeAliases.alias, basedOn: knowledgeAliases.basedOn,
  })
    .from(knowledgeAliases)
    .where(and(eq(knowledgeAliases.tenantId, tenantId), isNull(knowledgeAliases.retiredAt)));
  const c = semanticClaims;
  const claims = await db.selectDistinctOn([c.targetId, c.mappingId, c.claimType], {
    targetId: c.targetId, mappingId: c.mappingId, type: c.claimType, value: c.value, basedOn: c.basedOn,
  }).from(c).where(eq(c.tenantId, tenantId))
    .orderBy(asc(c.targetId), asc(c.mappingId), asc(c.claimType), desc(c.createdAt), desc(c.id));
  const subjects = await db.select({ targetId: subjectMemberships.targetId, name: analysisSubjects.name })
    .from(subjectMemberships).innerJoin(analysisSubjects, eq(analysisSubjects.id, subjectMemberships.subjectId))
    .where(eq(subjectMemberships.tenantId, tenantId));
  const byTarget = new Map<string, Knowledge>();
  const knowledgeAt = (targetId: string, mappingId: string | null) => {
    const key = knowledgeKey(targetId, mappingId);
    if (!byTarget.has(key)) byTarget.set(key, {});
    return byTarget.get(key)!;
  };
  for (const r of aliases) {
    const k = knowledgeAt(r.targetId, r.mappingId);
    (k.aliases ??= []).push(r.alias);
    if (stale(r.basedOn)) (k.aliasesNeedReview ??= []).push(r.alias);
  }
  for (const r of claims) {
    if (!isClaimType(r.type) || !isClaimValue(r.type, r.value)) continue;
    (knowledgeAt(r.targetId, r.mappingId).claims ??= []).push(stale(r.basedOn)
      ? { type: r.type, value: 'unknown', previous: r.value, needsReview: true }
      : { type: r.type, value: r.value });
  }
  for (const r of subjects) (knowledgeAt(r.targetId, null).subjects ??= []).push(r.name);
  for (const [targetId, { note, basedOn }] of await currentTargetNotes(db, tenantId)) {
    if (!note) continue;
    const k = knowledgeAt(targetId, null);
    k.note = note;
    if (stale(basedOn)) k.noteNeedsReview = true;
  }
  const staleNotes = new Set([...await currentMappingNoteBases(db, tenantId)].filter(([, basedOn]) => stale(basedOn)).map(([key]) => key));
  for (const k of byTarget.values()) {
    k.aliases?.sort(cmpName);
    k.aliasesNeedReview?.sort(cmpName);
    k.subjects?.sort(cmpName);
    k.claims?.sort((a, b) => CLAIM_TYPE_ORDER.indexOf(a.type) - CLAIM_TYPE_ORDER.indexOf(b.type));
  }
  return { byTarget, staleNotes };
}

/** 一条口径声明的中文说法：「币种：人民币」；需复核的「币种：未知（待复核，原为 人民币）」 */
export const claimPhrase = ({ type, value, previous, needsReview }: Claim) => `${claimTypeLabel(type)}：${claimValueLabel(type, value)}`
  + (needsReview ? `（待复核，原为 ${claimValueLabel(type, previous ?? '')}）` : '');

/** 需复核的别名后面加「（待复核）」 */
const aliasPhrase = (k: Knowledge) => (a: string) => (k.aliasesNeedReview?.includes(a) ? `${a}（待复核）` : a);

/** 参与搜索的文字 */
export const knowledgeText = (k: Knowledge | undefined): string =>
  [...(k?.aliases ?? []), ...(k?.claims ?? []).map(claimPhrase), ...(k?.subjects ?? []), ...(k?.note ? [k.note] : [])].join('\n');

/** Markdown 行；indent 是缩进（血缘项下的知识要缩进） */
export const knowledgeMarkdown = (k: Knowledge | undefined, indent = ''): string[] => [
  ...(k?.aliases?.length ? [`${indent}- 别名：${k.aliases.map(aliasPhrase(k)).join('、')}`] : []),
  ...(k?.claims?.length ? [`${indent}- 口径：`, ...k.claims.map(c => `${indent}  - ${claimPhrase(c)}`)] : []),
  ...(k?.subjects?.length ? [`${indent}- 分析主题：${k.subjects.join('、')}`] : []),
  ...(k?.note ? [`${indent}- 业务说明${k.noteNeedsReview ? '（待复核）' : ''}：${k.note}`] : []),
];

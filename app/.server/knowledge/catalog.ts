// app/.server/knowledge/catalog.ts —— 业务知识（ADR-0046）在语义目录里的挂载点：每个目录条目（映射字段挂在字段条目下该映射的血缘项上）可选地带一份 Knowledge，
// 参与搜索、写进 Markdown。目前有别名与口径声明；分析主题、业务说明扩展与需复核以后都加在这里，目录本身（catalog/index.ts）不用再改。
// 没有知识的条目不带 knowledge 键，目录快照与没有知识时一样。没有声明的口径类型不输出（没有声明不等于声明了「未知」）
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../audit';
import type { getDb } from '../db/client';
import { knowledgeAliases, semanticClaims } from '../db/schema';
import { cmpName } from '../../lib/compare';
import { CLAIM_TYPE_ORDER, claimTypeLabel, claimValueLabel, isClaimType, isClaimValue, type ClaimType } from '../../lib/semantic-claims';

/** 挂在一个目录条目（或映射字段）上的业务知识；没有的部分不给 */
export interface Knowledge { aliases?: string[]; claims?: Claim[] }

/** 一条生效的口径声明：同一挂载点、同一类型最新的一行 */
export interface Claim { type: ClaimType; value: string }

/** 生成目录用的业务知识：键是 knowledgeKey */
export interface KnowledgeInput { byTarget: ReadonlyMap<string, Knowledge> }

/** 知识挂载点的键：目录条目标识，映射字段再带映射 ID */
export const knowledgeKey = (targetId: string, mappingId: string | null = null) => (mappingId ? `${targetId}\n${mappingId}` : targetId);

/** 去掉空的部分；什么都没有时为 undefined（条目就不带 knowledge 键） */
export function presentKnowledge(k: Knowledge | undefined): Knowledge | undefined {
  const out: Knowledge = {};
  if (k?.aliases?.length) out.aliases = k.aliases;
  if (k?.claims?.length) out.claims = k.claims;
  return Object.keys(out).length ? out : undefined;
}

/**
 * 本租户的业务知识，按挂载点归拢：未停用的别名（同一挂载点内按 cmpName 排，ADR-0045），
 * 每个 (挂载点, 类型) 最新的口径声明（按登记顺序排）。最新一行的类型或取值已从登记表删掉时，这种类型不输出、也不退回到上一版
 * （登记表只加不删，删取值要先迁移数据）
 */
export async function loadKnowledge(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<KnowledgeInput> {
  const aliases = await db.select({ targetId: knowledgeAliases.targetId, mappingId: knowledgeAliases.mappingId, alias: knowledgeAliases.alias })
    .from(knowledgeAliases)
    .where(and(eq(knowledgeAliases.tenantId, tenantId), isNull(knowledgeAliases.retiredAt)));
  const c = semanticClaims;
  const claims = await db.selectDistinctOn([c.targetId, c.mappingId, c.claimType], {
    targetId: c.targetId, mappingId: c.mappingId, type: c.claimType, value: c.value,
  }).from(c).where(eq(c.tenantId, tenantId))
    .orderBy(asc(c.targetId), asc(c.mappingId), asc(c.claimType), desc(c.createdAt), desc(c.id));
  const byTarget = new Map<string, Knowledge>();
  const knowledgeAt = (targetId: string, mappingId: string | null) => {
    const key = knowledgeKey(targetId, mappingId);
    if (!byTarget.has(key)) byTarget.set(key, {});
    return byTarget.get(key)!;
  };
  for (const r of aliases) (knowledgeAt(r.targetId, r.mappingId).aliases ??= []).push(r.alias);
  for (const r of claims) {
    if (isClaimType(r.type) && isClaimValue(r.type, r.value)) (knowledgeAt(r.targetId, r.mappingId).claims ??= []).push({ type: r.type, value: r.value });
  }
  for (const k of byTarget.values()) {
    k.aliases?.sort(cmpName);
    k.claims?.sort((a, b) => CLAIM_TYPE_ORDER.indexOf(a.type) - CLAIM_TYPE_ORDER.indexOf(b.type));
  }
  return { byTarget };
}

/** 一条口径声明的中文说法：「币种：人民币」 */
const claimPhrase = ({ type, value }: Claim) => `${claimTypeLabel(type)}：${claimValueLabel(type, value)}`;

/** 参与搜索的文字 */
export const knowledgeText = (k: Knowledge | undefined): string => [...(k?.aliases ?? []), ...(k?.claims ?? []).map(claimPhrase)].join('\n');

/** Markdown 行；indent 是缩进（血缘项下的知识要缩进） */
export const knowledgeMarkdown = (k: Knowledge | undefined, indent = ''): string[] => [
  ...(k?.aliases?.length ? [`${indent}- 别名：${k.aliases.join('、')}`] : []),
  ...(k?.claims?.length ? [`${indent}- 口径：`, ...k.claims.map(c => `${indent}  - ${claimPhrase(c)}`)] : []),
];

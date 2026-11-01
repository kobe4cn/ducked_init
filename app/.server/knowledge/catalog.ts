// app/.server/knowledge/catalog.ts —— 业务知识（ADR-0046）在语义目录里的挂载点：每个目录条目（映射字段挂在字段条目下该映射的血缘项上）可选地带一份 Knowledge，
// 参与搜索、写进 Markdown。目前只有别名；口径声明、分析主题、业务说明扩展与需复核以后都加在这里，目录本身（catalog/index.ts）不用再改。
// 没有知识的条目不带 knowledge 键，目录快照与没有知识时一样
import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../audit';
import type { getDb } from '../db/client';
import { knowledgeAliases } from '../db/schema';
import { cmpName } from '../../lib/compare';

/** 挂在一个目录条目（或映射字段）上的业务知识；没有的部分不给 */
export interface Knowledge { aliases?: string[] }

/** 生成目录用的业务知识：键是 knowledgeKey */
export interface KnowledgeInput { byTarget: ReadonlyMap<string, Knowledge> }

/** 知识挂载点的键：目录条目标识，映射字段再带映射 ID */
export const knowledgeKey = (targetId: string, mappingId: string | null = null) => (mappingId ? `${targetId}\n${mappingId}` : targetId);

/** 去掉空的部分；什么都没有时为 undefined（条目就不带 knowledge 键） */
export function presentKnowledge(k: Knowledge | undefined): Knowledge | undefined {
  if (!k?.aliases?.length) return undefined;
  return { aliases: k.aliases };
}

/** 本租户未停用的别名，按挂载点归拢，同一挂载点内按 cmpName 排（ADR-0045） */
export async function loadKnowledge(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<KnowledgeInput> {
  const rows = await db.select({ targetId: knowledgeAliases.targetId, mappingId: knowledgeAliases.mappingId, alias: knowledgeAliases.alias })
    .from(knowledgeAliases)
    .where(and(eq(knowledgeAliases.tenantId, tenantId), isNull(knowledgeAliases.retiredAt)));
  const byTarget = new Map<string, Knowledge>();
  for (const r of rows) {
    const key = knowledgeKey(r.targetId, r.mappingId);
    byTarget.set(key, { aliases: [...(byTarget.get(key)?.aliases ?? []), r.alias] });
  }
  for (const k of byTarget.values()) k.aliases!.sort(cmpName);
  return { byTarget };
}

/** 参与搜索的文字 */
export const knowledgeText = (k: Knowledge | undefined): string => (k?.aliases ?? []).join('\n');

/** Markdown 行；indent 是缩进（血缘项下的知识要缩进） */
export const knowledgeMarkdown = (k: Knowledge | undefined, indent = ''): string[] => [
  ...(k?.aliases?.length ? [`${indent}- 别名：${k.aliases.join('、')}`] : []),
];

// app/.server/catalog/draft-search.ts —— 定义起草与一句话解析共用的检索（#827）：与助手 catalog_search 同一条路——rankedSearch（持久化投影，
// 租户开了 hybrid_search 时带向量一路，ADR-0047、0049）加 judgeAmbiguity 的歧义判定（ADR-0056）。
// 按成员权限选投影类别（ADR-0005）；能力说明已在起草的 system 里，检索时多取 CAPABILITIES.length 条再去掉能力条目，不占名额；
// 投影不可用回退（fallback: true、得分全为 0）时 judgeAmbiguity 会一律判成歧义，这种情况不提示、只照常起草（#827 的决定）。
// 目录模块不依赖 assistant：tools.ts 的 catalogFor 在那一侧，这里自己组装 visibleCatalog(tenantCatalog(…))
import { eq } from 'drizzle-orm';
import type { CurrentMember } from '../auth';
import { getDb } from '../db/client';
import { tenants } from '../db/schema';
import { judgeAmbiguity } from './ambiguity';
import { CAPABILITIES } from './capabilities';
import type { Catalog, CatalogEntry } from './index';
import { tenantCatalog } from './load';
import { rankedSearch, visibilityClass, visibleCatalog } from './projection';

/** 歧义提示（#827）：判为歧义的词与候选，只放标识与名称（不放口径取值），候选链到业务知识页 */
export type DraftAmbiguity = { groups: { term: string; candidates: { id: string; name: string }[] }[] };

/**
 * 起草用的检索：按成员权限可见的目录、与需求相关的条目（能力条目除外）与歧义判定。
 * 词的默认指向（ADR-0056）生效的组不再歧义，默认条目挪到最前、其余保持名次；embedding 超时或不可用由 vectorHits 自己吞掉，
 * 只少向量一路，起草不失败
 */
export async function draftSearch(actor: CurrentMember, query: string, limit: number): Promise<{ catalog: Catalog; entries: CatalogEntry[]; ambiguity: DraftAmbiguity | null }> {
  const cls = visibilityClass(actor.role);
  const catalog = visibleCatalog(await tenantCatalog(actor.tenant.id), cls);
  const [tenant] = await getDb().select({ hybridSearch: tenants.hybridSearch }).from(tenants).where(eq(tenants.id, actor.tenant.id));
  const { ranked, fallback } = await rankedSearch(actor.tenant.id, cls, catalog, query,
    { memberSpaceId: actor.space.id }, limit + CAPABILITIES.length, { hybrid: tenant?.hybridSearch ?? false });
  const hits = ranked.filter(r => !r.entry.id.startsWith('capability:')).slice(0, limit);
  const { ambiguous, groups, defaults } = judgeAmbiguity(hits, catalog, query);
  const defaulted = new Set(defaults.map(d => d.entryId));
  const entries = [...hits.filter(r => defaulted.has(r.entry.id)), ...hits.filter(r => !defaulted.has(r.entry.id))].map(r => r.entry);
  const names = new Map(catalog.entries.map(e => [e.id, e.name]));
  return {
    catalog, entries,
    ambiguity: ambiguous && !fallback
      ? { groups: groups.map(g => ({ term: g.term, candidates: g.candidates.map(id => ({ id, name: names.get(id) ?? id })) })) }
      : null,
  };
}

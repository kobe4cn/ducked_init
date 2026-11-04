// app/.server/catalog/rank.ts —— 检索排序（ADR-0047，设计文档 8.2–8.3）：在检索投影行上多路召回（精确标识、别名、名称、中文关键词二元组），
// 用 RRF（Σ 权重 / (k + 名次)）融合。别名已经拼进了投影文字，单靠关键词分不出「别名命中」与「正文命中」，所以别名单独一路、权重高于关键词。
// 作用域只加权不排除：成员这次明确说的（scope.subjects、scope.spaceIds、查询里出现的主题名）> 页面上下文 > 对话里已确定的主题 > 成员所属空间，
// 一个条目只取命中的最高一级；不命中作用域的不扣分、不去掉。纯函数，不读库；能力条目不特殊处理，由调用方过滤
import { cmp } from '../../lib/compare';
import { terms, type Catalog, type CatalogEntry } from './index';
import type { ProjectionRow } from './projection';

export const RRF_K = 60;
export const LANE_WEIGHTS = { id: 4, alias: 3, name: 2, keyword: 1 } as const;
/** 每一路最多取的名次 */
export const LANE_LIMIT = 30;
export const SCOPE_BOOST = { explicit: 1, page: 0.5, conversation: 0.25, member: 0.1 } as const;

export type Lane = keyof typeof LANE_WEIGHTS;
export interface HitReason { lane: Lane; matched: string[] }
export interface Ranked { entry: CatalogEntry; score: number; reasons: HitReason[] }
/** 作用域：page / conversation 先留接口 */
export interface RankScope {
  subjects?: string[];
  spaceIds?: string[];
  pageSubjects?: string[];
  pageSpaceId?: string;
  conversationSubjects?: string[];
  memberSpaceId?: string;
}

interface LaneHit { entryId: string; score: number; matched: string[] }

/** 一路的名次：只留得分 > 0 的，按分降序、同分按 entryId 升序，取前 LANE_LIMIT */
const ordered = (hits: LaneHit[]) => hits
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || cmp(a.entryId, b.entryId))
  .slice(0, LANE_LIMIT);

/** 文字列表里出现在 q 中的那些（q 已小写，比较不分大小写），matched 放原文、按小写去重、按长度降序；分是最长的长度 */
function contained(entryId: string, texts: string[], q: string): LaneHit {
  const seen = new Map<string, string>();
  for (const t of texts) {
    const lower = t.toLowerCase();
    if (lower && q.includes(lower) && !seen.has(lower)) seen.set(lower, t);
  }
  const matched = [...seen.values()].sort((a, b) => b.length - a.length);
  return { entryId, score: matched[0]?.length ?? 0, matched };
}

const intersects = (a: readonly string[], b: ReadonlySet<string>) => a.some(x => b.has(x.toLowerCase()));

export function rank(rows: ProjectionRow[], c: Catalog, query: string, scope: RankScope = {}, limit = 20): Ranked[] {
  const q = query.toLowerCase();
  const byId = new Map(c.entries.map(e => [e.id, e]));
  const present = rows.flatMap(row => {
    const entry = byId.get(row.entryId);
    return entry ? [{ row, entry }] : [];
  });
  const words = terms(query);

  const lanes: Record<Lane, LaneHit[]> = {
    id: ordered(present.map(({ row: r }) => contained(r.entryId, [r.entryId, r.entryId.slice(r.entryId.indexOf(':') + 1)], q))),
    alias: ordered(present.map(({ row: r }) => contained(r.entryId, r.aliases, q))),
    name: ordered(present.map(({ row: r, entry }) => contained(r.entryId, [entry.name], q))),
    keyword: ordered(present.map(({ row: r }) => {
      const matched = words.filter(w => r.text.includes(w));
      return { entryId: r.entryId, score: matched.length, matched };
    })),
  };

  const fused = new Map<string, { score: number; reasons: HitReason[] }>();
  for (const lane of Object.keys(lanes) as Lane[]) {
    lanes[lane].forEach((h, i) => {
      const f = fused.get(h.entryId) ?? { score: 0, reasons: [] };
      f.score += LANE_WEIGHTS[lane] / (RRF_K + i + 1);
      f.reasons.push({ lane, matched: h.matched });
      fused.set(h.entryId, f);
    });
  }

  const lower = (xs: string[] | undefined) => new Set((xs ?? []).map(x => x.toLowerCase()));
  const explicitSubjects = lower([...(scope.subjects ?? []), ...present.flatMap(p => p.row.subjects).filter(s => q.includes(s.toLowerCase()))]);
  const explicitSpaces = new Set(scope.spaceIds ?? []);
  const pageSubjects = lower(scope.pageSubjects);
  const conversationSubjects = lower(scope.conversationSubjects);
  const boost = (r: ProjectionRow) => {
    if (intersects(r.subjects, explicitSubjects) || (r.spaceId !== null && explicitSpaces.has(r.spaceId))) return SCOPE_BOOST.explicit;
    if (intersects(r.subjects, pageSubjects) || (r.spaceId !== null && r.spaceId === scope.pageSpaceId)) return SCOPE_BOOST.page;
    if (intersects(r.subjects, conversationSubjects)) return SCOPE_BOOST.conversation;
    if (r.spaceId !== null && r.spaceId === scope.memberSpaceId) return SCOPE_BOOST.member;
    return 0;
  };

  return present
    .flatMap(({ row, entry }) => {
      const f = fused.get(row.entryId);
      return f ? [{ entry, score: f.score * (1 + boost(row)), reasons: f.reasons }] : [];
    })
    .sort((a, b) => b.score - a.score || cmp(a.entry.id, b.entry.id))
    .slice(0, limit);
}

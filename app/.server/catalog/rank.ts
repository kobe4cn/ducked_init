// app/.server/catalog/rank.ts —— 检索排序（ADR-0047，设计文档 8.2–8.3）：在检索投影行上多路召回（精确标识、别名、名称、中文关键词二元组），
// 用 RRF（Σ 权重 / (k + 名次)）融合。别名已经拼进了投影文字，单靠关键词分不出「别名命中」与「正文命中」，所以别名单独一路、权重高于关键词。
// 别名一路同分时先按别名以外的文字里的关键词命中数、再按标识排（多个近义指标挂同一别名很常见，按标识排会让近义项占第 1）；
// 查询里的别名出现如果落在别的条目更长的名称命中里（名称在查询里按该条目自身文字往两边延长，如 order.channel 的「渠道」延长成「下单渠道」），就不算，与点名排除的「最长匹配」一致。
// 作用域只加权不排除：成员这次明确说的（scope.subjects、scope.spaceIds、查询里出现的主题名）> 页面上下文 > 对话里已确定的主题 > 成员所属空间，
// 一个条目只取命中的最高一级；不命中作用域的不扣分、不去掉。纯函数，不读库；能力条目不特殊处理，由调用方过滤
import { cmp } from '../../lib/compare';
import { expand } from './expand';
import { terms, type Catalog, type CatalogEntry } from './index';
import type { ProjectionRow } from './projection';

export const RRF_K = 60;
export const LANE_WEIGHTS = { id: 4, alias: 3, name: 2, keyword: 1 } as const;
/** 每一路最多取的名次 */
export const LANE_LIMIT = 30;
export const SCOPE_BOOST = { explicit: 1, page: 0.5, conversation: 0.25, member: 0.1 } as const;

export type Lane = keyof typeof LANE_WEIGHTS;
/** expand 是依赖展开补进来的（expand.ts），不是一路召回，不进 LANE_WEIGHTS */
export interface HitReason { lane: Lane | 'expand'; matched: string[] }
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

/** 一路的名次：只留得分 > 0 的，按分降序、同分按 tie 降序（只有别名一路传，是别名以外的文字里的关键词命中数）、再按 entryId 升序，取前 LANE_LIMIT */
const ordered = (hits: LaneHit[], tie?: (entryId: string) => number) => hits
  .filter(h => h.score > 0)
  .sort((a, b) => b.score - a.score || (tie ? tie(b.entryId) - tie(a.entryId) : 0) || cmp(a.entryId, b.entryId))
  .slice(0, LANE_LIMIT);

interface Span { entryId: string; start: number; end: number; text: string }

/** 名称命中跨度：名称在 q 里的每处出现，只要往左右多取一个字后仍包含在该条目自身文字里就继续延长；只留比名称长的 */
function nameSpans(entryId: string, name: string, text: string, q: string): Span[] {
  const t = name.toLowerCase();
  if (!t) return [];
  const out: Span[] = [];
  for (let i = q.indexOf(t); i >= 0; i = q.indexOf(t, i + 1)) {
    let start = i, end = i + t.length;
    for (let grew = true; grew;) {
      grew = false;
      if (start > 0 && text.includes(q.slice(start - 1, end))) { start--; grew = true; }
      if (end < q.length && text.includes(q.slice(start, end + 1))) { end++; grew = true; }
    }
    if (end - start > t.length) out.push({ entryId, start, end, text: q.slice(start, end) });
  }
  return out;
}

/** 别名的每处出现都落在别的条目更长的名称跨度里（且本条目文字不含该跨度）时，这个别名不算 */
function uncovered(hit: LaneHit, text: string, spans: Span[], q: string): LaneHit {
  const covered = (alias: string) => {
    const u = alias.toLowerCase();
    for (let i = q.indexOf(u); i >= 0; i = q.indexOf(u, i + 1)) {
      if (!spans.some(s => s.entryId !== hit.entryId && s.start <= i && i + u.length <= s.end && s.end - s.start > u.length && !text.includes(s.text))) return false;
    }
    return true;
  };
  const matched = hit.matched.filter(a => !covered(a));
  return { entryId: hit.entryId, score: matched[0]?.length ?? 0, matched };
}

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
  const keywordHits = present.map(({ row: r }) => {
    const matched = words.filter(w => r.text.includes(w));
    return { entryId: r.entryId, score: matched.length, matched };
  });
  // 别名一路的次级比较：别名以外的文字里命中的关键词数。别名本身已经在别名一路记过分，再算进来会让只靠别名带上这个词的条目多一票
  const evidence = new Map(present.map(({ row: r }) => {
    const aliases = new Set(r.aliases.map(a => a.toLowerCase()));
    const rest = r.text.split('\n').filter(line => !aliases.has(line)).join('\n');
    return [r.entryId, words.filter(w => rest.includes(w)).length];
  }));
  const nameHits = present.map(({ row: r, entry }) => contained(r.entryId, [entry.name], q));
  // 只用名称命中造跨度：别名命中不算（只能靠别名命中的条目不能被别人的说明文字压掉）
  const spans = present.flatMap(({ row: r, entry }, i) => (nameHits[i]!.score > 0 ? nameSpans(r.entryId, entry.name, r.text, q) : []));

  const lanes: Record<Lane, LaneHit[]> = {
    id: ordered(present.map(({ row: r }) => contained(r.entryId, [r.entryId, r.entryId.slice(r.entryId.indexOf(':') + 1)], q))),
    alias: ordered(present.map(({ row: r }) => uncovered(contained(r.entryId, r.aliases, q), r.text, spans, q)), id => evidence.get(id) ?? 0),
    name: ordered(nameHits),
    keyword: ordered(keywordHits),
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

  const direct = present
    .flatMap(({ row, entry }) => {
      const f = fused.get(row.entryId);
      return f ? [{ entry, score: f.score * (1 + boost(row)), reasons: f.reasons }] : [];
    })
    .sort((a, b) => b.score - a.score || cmp(a.entry.id, b.entry.id));
  return expand(direct, present, c, query, limit);
}

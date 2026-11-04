// app/.server/catalog/expand.ts —— 依赖展开（设计文档 8.5，ADR-0047）：rank() 排序之后的确定性定向补召回，需求缺什么补什么。
// 需求里有时间窗口（「近 7 天」）而前 limit 名里没有锚点实体的时间字段时，补锚点的时间字段；锚点没有时间字段时沿它出发的关系一跳，补关系条目与对端的时间字段。
// 需求里有维度词（名称或别名命中别的实体上的 string 字段，如「城市」；它不给锚点投票）时，补锚点 → 维度实体（最多 2 跳）的关系条目与维度字段。
// 补进来的最多 MAX_EXPANDED 个，排在直接命中之后、理由标 expand；候选只从投影行与目录的交集（present）里取，不会漏出调用方看不到的条目。
// 两种都没有时原样返回直接命中的前 limit 个。纯函数，不读库、不调模型
import { cmp } from '../../lib/compare';
import type { Catalog, CatalogEntry, FieldEntry, RelationEntry } from './index';
import type { ProjectionRow } from './projection';
import type { Ranked } from './rank';

/** 补召回候选最多几个 */
export const MAX_EXPANDED = 4;
/** 最多几个锚点实体 */
export const MAX_ANCHORS = 2;
/** 锚点从直接命中的前几名里投票 */
const ANCHOR_WINDOW = 5;
/** 维度补召回的最大跳数 */
const MAX_HOPS = 2;
/** 补召回候选的分比最后一个直接命中低多少（逐个再低一点，保持顺序） */
const EPSILON = 1e-9;

const WINDOW = /(近|最近|过去)\s*\d+\s*(天|日|周|个?月|年)/;

interface Candidate { entry: CatalogEntry; anchor: number; hops: number; origin: string }

/** 字段标识（field:实体.字段）所属实体的标识（entity:实体） */
const entityOf = (fieldId: string) => `entity:${fieldId.slice(fieldId.indexOf(':') + 1, fieldId.indexOf('.'))}`;

/** 条目落在哪个实体上（实体标识）：字段取所属实体，实体取自己，指标取 base；别的没有 */
function entryEntity(e: CatalogEntry): string | null {
  if (e.kind === 'entity') return e.id;
  if (e.kind === 'field') return e.entity;
  if (e.kind === 'metric') return e.base;
  return null;
}

const isTimeField = (e: CatalogEntry): e is FieldEntry => e.kind === 'field' && e.type === 'timestamp' && e.field !== 'updated_at';

/** 直接命中前 ANCHOR_WINDOW 名所在的实体按出现次数投票（维度词命中的字段不投票），平票时名次靠前的优先，取前 MAX_ANCHORS 个 */
function anchorsOf(direct: Ranked[], dimensions: ReadonlySet<string>): string[] {
  const votes = new Map<string, { n: number; first: number }>();
  direct.slice(0, ANCHOR_WINDOW).forEach((r, i) => {
    const entity = dimensions.has(r.entry.id) ? null : entryEntity(r.entry);
    if (!entity) return;
    const v = votes.get(entity) ?? { n: 0, first: i };
    v.n++;
    votes.set(entity, v);
  });
  return [...votes].sort(([, a], [, b]) => b.n - a.n || a.first - b.first).slice(0, MAX_ANCHORS).map(([entity]) => entity);
}

export function expand(direct: Ranked[], present: { row: ProjectionRow; entry: CatalogEntry }[], c: Catalog, query: string, limit: number): Ranked[] {
  const window = WINDOW.test(query);
  // 维度词：名称或别名路直接命中的 string 字段（不是关系引用字段）；它们不给锚点投票，实体不是锚点的才补
  const references = new Set(c.entries.flatMap(e => (e.kind === 'relation' ? [e.from] : [])));
  const named = direct.flatMap(r => {
    const e = r.entry;
    const byName = r.reasons.some(h => h.lane === 'name' || h.lane === 'alias');
    return byName && e.kind === 'field' && e.type === 'string' && !references.has(e.id) ? [e] : [];
  });
  const anchors = anchorsOf(direct, new Set(named.map(e => e.id)));
  const dimensions = named.filter(e => !anchors.includes(e.entity));
  if ((!window && !dimensions.length) || !anchors.length) return direct.slice(0, limit);

  const entries = present.map(p => p.entry);
  const relations = entries.filter((e): e is RelationEntry => e.kind === 'relation');
  const timeFields = (entity: string) => entries.filter((e): e is FieldEntry => isTimeField(e) && e.entity === entity);
  const top = new Set(direct.slice(0, limit).map(r => r.entry.id));
  const candidates: Candidate[] = [];

  anchors.forEach((anchor, a) => {
    const own = timeFields(anchor);
    if (window && !own.some(f => top.has(f.id))) {
      for (const f of own) candidates.push({ entry: f, anchor: a, hops: 0, origin: `${anchor} 的时间字段` });
      if (!own.length) {
        for (const rel of relations.filter(r => entityOf(r.from) === anchor)) {
          const path = `${anchor} → ${rel.id}`;
          const far = timeFields(entityOf(rel.to));
          if (!far.length) continue;
          candidates.push({ entry: rel, anchor: a, hops: 1, origin: path });
          for (const f of far) candidates.push({ entry: f, anchor: a, hops: 1, origin: `${path} 的时间字段` });
        }
      }
    }
    for (const d of dimensions) {
      const path = pathBetween(anchor, d.entity, relations);
      if (!path) continue;
      const via = (n: number) => [anchor, ...path.slice(0, n).map(r => r.id)].join(' → ');
      path.forEach((rel, i) => candidates.push({ entry: rel, anchor: a, hops: i + 1, origin: via(i + 1) }));
      candidates.push({ entry: d, anchor: a, hops: path.length, origin: `${via(path.length)} 的维度字段` });
    }
  });
  if (!candidates.length) return direct.slice(0, limit);

  // 锚点名次 → 跳数 → 标识；同一条目只留排在最前的由来
  candidates.sort((x, y) => x.anchor - y.anchor || x.hops - y.hops || cmp(x.entry.id, y.entry.id));
  const seen = new Set<string>();
  const unique = candidates.filter(x => !seen.has(x.entry.id) && seen.add(x.entry.id));

  // k 个补召回候选 + 前 limit - k 个直接命中；已在这 limit - k 名里的不算补召回，k 只会越调越小
  let k = Math.max(0, Math.min(MAX_EXPANDED, limit - 1));
  let extra: Candidate[] = [];
  for (;;) {
    const head = new Set(direct.slice(0, limit - k).map(r => r.entry.id));
    extra = unique.filter(x => !head.has(x.entry.id)).slice(0, k);
    if (extra.length === k) break;
    k = extra.length;
  }
  const head = direct.slice(0, limit - k);
  if (!extra.length) return head;

  const last = head.length ? head[head.length - 1]!.score : 0;
  const byId = new Map(direct.map(r => [r.entry.id, r]));
  return [
    ...head,
    ...extra.map((x, i) => ({
      entry: x.entry,
      score: last - EPSILON * (i + 1),
      reasons: [...(byId.get(x.entry.id)?.reasons ?? []), { lane: 'expand' as const, matched: [x.origin] }],
    })),
  ];
}

/** 从实体 from 到实体 to 的最短关系路径（不分方向，最多 MAX_HOPS 跳）；到不了为 null */
function pathBetween(from: string, to: string, relations: RelationEntry[]): RelationEntry[] | null {
  let frontier: { entity: string; path: RelationEntry[] }[] = [{ entity: from, path: [] }];
  const seen = new Set([from]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next: typeof frontier = [];
    for (const { entity, path } of frontier) {
      for (const rel of [...relations].sort((a, b) => cmp(a.id, b.id))) {
        const [x, y] = [entityOf(rel.from), entityOf(rel.to)];
        const other = x === entity ? y : y === entity ? x : null;
        if (other === null || seen.has(other)) continue;
        if (other === to) return [...path, rel];
        seen.add(other);
        next.push({ entity: other, path: [...path, rel] });
      }
    }
    frontier = next;
  }
  return null;
}

// scripts/eval-requirements/retrieval.ts —— 黄金集的检索与追问指标（#318，ADR-0047）：对 retrieval-catalog.ts 的固定目录跑 search()，
// 每条算 Recall@20 与追问判定，再按失败类型 a–d 与合计分组。test/retrieval-golden.test.ts 的逐条断言与 pnpm eval:requirements 共用这里，
// 两边的 Recall@20 是同一算法。追问按服务端的歧义判定算（ADR-0047：歧义由服务端发现，不交给模型），「该追问」= 标注了 clarify。
// 纯函数，不读库、不走模型
import { search, type Catalog, type CatalogEntry } from '../../app/.server/catalog';
import { FAILURE_TYPES, type GoldenEntry } from './golden';
import { RETRIEVAL_CATALOG } from './retrieval-catalog';

/**
 * 查看者（没有 sources:read）看到的目录：去掉数据源与源表，字段不带血缘，实体不带来源表与合并组。
 * 照抄 app/.server/assistant/tools.ts 的 catalogFor（抽成纯函数留给 P2）
 */
export function viewerView(c: Catalog): Catalog {
  const entries = c.entries.flatMap((e): CatalogEntry[] => {
    switch (e.kind) {
      case 'source':
      case 'table':
        return [];
      case 'field':
        return [{ ...e, lineage: [] }];
      case 'entity':
        return [{ ...e, tables: [], unscoped: [], mergeGroups: [] }];
      default:
        return [e];
    }
  });
  return { ...c, entries };
}

export const LIMIT = 20;
const VIEWER = viewerView(RETRIEVAL_CATALOG);

export interface Retrieved { top: string[]; hits: number; ambiguous: boolean }

/** 一条的检索结果：前 20（先去掉能力说明，与 model-draft 的 relevantMarkdown 一致）、命中的候选数与歧义判定 */
export function retrieve(g: GoldenEntry): Retrieved {
  const c = g.role === 'viewer' ? VIEWER : RETRIEVAL_CATALOG;
  const top = search(c, g.retrieval.query, c.entries.length).filter(e => e.kind !== 'capability').slice(0, LIMIT).map(e => e.id);
  const hits = g.retrieval.candidates.filter(id => top.includes(id)).length;
  // 现有 search() 不判歧义
  const ambiguous = false;
  return { top, hits, ambiguous };
}

/** 前 20 里命中的候选数 / 候选数；没有候选的条目为 null，不计入平均 */
export const recallAt = (g: GoldenEntry, r: Retrieved) => (g.retrieval.candidates.length ? r.hits / g.retrieval.candidates.length : null);

export interface RetrievalRow {
  id: string;
  type: GoldenEntry['failure_type'];
  holdout: boolean;
  recall: number | null;
  /** 去掉能力说明后的第 1 名，没有结果为 null */
  top1: string | null;
  /** 服务端判了歧义（会追问） */
  asked: boolean;
  /** 标注了期望的追问 */
  shouldAsk: boolean;
}

export const retrievalRows = (gs: GoldenEntry[]): RetrievalRow[] => gs.map(g => {
  const r = retrieve(g);
  return { id: g.id, type: g.failure_type, holdout: g.holdout, recall: recallAt(g, r), top1: r.top[0] ?? null, asked: r.ambiguous, shouldAsk: g.clarify !== null };
});

export interface GroupStats {
  cases: number;
  /** 组内有候选的条目的平均 Recall@20；一条都没有时为 null */
  recall: number | null;
  /** 追问判定与标注一致的条数 / 条数（空组为 1，与 summarize 的通过率一致） */
  clarifyAccuracy: number;
  /** 应追问的条目里追问了的比例；组里没有应追问的条目时为 null */
  clarifyRecall: number | null;
}

export type GroupKey = (typeof FAILURE_TYPES)[number] | '合计';
export const GROUP_KEYS: readonly GroupKey[] = [...FAILURE_TYPES, '合计'];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stats(rows: RetrievalRow[]): GroupStats {
  const should = rows.filter(r => r.shouldAsk);
  return {
    cases: rows.length,
    recall: mean(rows.flatMap(r => (r.recall === null ? [] : [r.recall]))),
    clarifyAccuracy: rows.length ? rows.filter(r => r.asked === r.shouldAsk).length / rows.length : 1,
    clarifyRecall: should.length ? should.filter(r => r.asked).length / should.length : null,
  };
}

/** 按失败类型 a–d 分组，另加覆盖全部行的「合计」 */
export function groupByType(rows: RetrievalRow[]): Record<GroupKey, GroupStats> {
  const of = (t: GoldenEntry['failure_type']) => stats(rows.filter(r => r.type === t));
  return { a: of('a'), b: of('b'), c: of('c'), d: of('d'), 合计: stats(rows) };
}

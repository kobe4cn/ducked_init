// scripts/eval-requirements/retrieval.ts —— 黄金集的检索与追问指标（#318，ADR-0047）：对 retrieval-catalog.ts 的固定目录按角色的可见性类别派生检索投影、跑 rank()，
// 每条算 Recall@20 与追问判定，再按失败类型 a–d 与合计分组。test/retrieval-golden.test.ts 的逐条断言与 pnpm eval:requirements 共用这里，
// 两边的 Recall@20 是同一算法。追问按服务端的歧义判定算（ADR-0047：歧义由服务端发现，不交给模型），「该追问」= 标注了 clarify。
// 行里另带计划模式的期望（plan-modes.ts）与模型结果（跑过 runPlanCase 的 planned 为 true、解析出的模式填进 mode，失败时 mode 为 null 但仍算跑过，#423、ADR-0050），
// 分组多算一个模式正确率。
// 纯函数，不读库、不走模型
import type { Catalog } from '../../app/.server/catalog';
import { deriveProjection, visibleCatalog, type ProjectionClass } from '../../app/.server/catalog/projection';
import { judgeAmbiguity, type Ambiguity } from '../../app/.server/catalog/ambiguity';
import { rank } from '../../app/.server/catalog/rank';
import { vectorLane } from '../../app/.server/catalog/vector';
import type { PlanMode } from '../../app/.server/catalog/plan';
import { FAILURE_TYPES, type GoldenEntry } from './golden';
import { expectedMode } from './plan-modes';
import { RETRIEVAL_CATALOG } from './retrieval-catalog';

/** 查看者（没有 sources:read）看到的目录：restricted 类，去掉数据源与源表，字段不带血缘，实体不带来源表与合并组 */
export const viewerView = (c: Catalog): Catalog => visibleCatalog(c, 'restricted');

export const LIMIT = 20;
const view = (cls: ProjectionClass) => ({ rows: deriveProjection(RETRIEVAL_CATALOG, cls), catalog: visibleCatalog(RETRIEVAL_CATALOG, cls) });
/** 两类视图的投影行与裁剪后目录（#416 开关对比要给两边视图的行算向量，导出） */
export const VIEWS = { full: view('full'), restricted: view('restricted') };

/** 向量一路的输入（#416）：rows 是文本哈希 → 行向量（与 embeddings.ts 的缓存同键），queries 是黄金集 id → 查询向量 */
export interface RetrievalVectors { rows: Map<string, number[]>; queries: Map<string, number[]> }

export interface Retrieved { top: string[]; hits: number; ambiguous: boolean; ambiguity: Ambiguity }

/** 一条的检索结果与歧义判定：前 20（排序前先去掉能力说明的投影行，与 model-draft 的 relevantMarkdown 一致：否则能力说明占着直接命中的名额，依赖展开补进来的候选会落到第 20 名之后）、命中的候选数与歧义判定。
 *  vectors 给了且该条有查询向量时多融合一路向量命中（vector.ts）；没有查询向量时与不带 vectors 完全相同 */
export function retrieve(g: GoldenEntry, vectors?: RetrievalVectors): Retrieved {
  const v = VIEWS[g.role === 'viewer' ? 'restricted' : 'full'];
  const viewRows = v.rows.filter(r => !r.entryId.startsWith('capability:'));
  const queryVec = vectors?.queries.get(g.id);
  const ranked = rank(viewRows, v.catalog, g.retrieval.query, {}, LIMIT, vectors && queryVec ? vectorLane(queryVec, viewRows, vectors.rows) : []);
  const top = ranked.map(r => r.entry.id);
  const hits = g.retrieval.candidates.filter(id => top.includes(id)).length;
  // 歧义判定用同一个排序结果（ambiguity.ts）
  const ambiguity = judgeAmbiguity(ranked, v.catalog, g.retrieval.query);
  return { top, hits, ambiguous: ambiguity.ambiguous, ambiguity };
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
  /** 跑过 runPlanCase（不管成没成功）；没跑模型为 false */
  planned: boolean;
  /** 模型选的计划模式（runPlanCase 解析出的 plan.mode）；没跑模型，或跑了但模型调用 / Schema / 计划结构失败，为 null（后者 planned 为 true，算错） */
  mode: PlanMode | null;
  /** 期望的计划模式（plan-modes.ts 的标注） */
  expectedMode: PlanMode;
}

export const retrievalRows = (gs: GoldenEntry[], vectors?: RetrievalVectors): RetrievalRow[] => gs.map(g => {
  const r = retrieve(g, vectors);
  return {
    id: g.id, type: g.failure_type, holdout: g.holdout, recall: recallAt(g, r), top1: r.top[0] ?? null,
    asked: r.ambiguous, shouldAsk: g.clarify !== null, planned: false, mode: null, expectedMode: expectedMode(g),
  };
});

export interface GroupStats {
  cases: number;
  /** 组内有候选的条目的平均 Recall@20；一条都没有时为 null */
  recall: number | null;
  /** 追问判定与标注一致的条数 / 条数（空组为 1，与 summarize 的通过率一致） */
  clarifyAccuracy: number;
  /** 应追问的条目里追问了的比例；组里没有应追问的条目时为 null */
  clarifyRecall: number | null;
  /** 计划模式与期望一致的条数 / 跑过模型的条数（planned，#423，ADR-0050；跑了但失败的 mode 为 null，算错、进分母）；组里一条都没跑模型时为 null */
  modeAccuracy: number | null;
}

export type GroupKey = (typeof FAILURE_TYPES)[number] | '合计';
export const GROUP_KEYS: readonly GroupKey[] = [...FAILURE_TYPES, '合计'];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stats(rows: RetrievalRow[]): GroupStats {
  const should = rows.filter(r => r.shouldAsk);
  const planned = rows.filter(r => r.planned);
  return {
    cases: rows.length,
    recall: mean(rows.flatMap(r => (r.recall === null ? [] : [r.recall]))),
    clarifyAccuracy: rows.length ? rows.filter(r => r.asked === r.shouldAsk).length / rows.length : 1,
    clarifyRecall: should.length ? should.filter(r => r.asked).length / should.length : null,
    modeAccuracy: planned.length ? planned.filter(r => r.mode === r.expectedMode).length / planned.length : null,
  };
}

/** 按失败类型 a–d 分组，另加覆盖全部行的「合计」 */
export function groupByType(rows: RetrievalRow[]): Record<GroupKey, GroupStats> {
  const of = (t: GoldenEntry['failure_type']) => stats(rows.filter(r => r.type === t));
  return { a: of('a'), b: of('b'), c: of('c'), d: of('d'), 合计: stats(rows) };
}

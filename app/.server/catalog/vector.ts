// app/.server/catalog/vector.ts —— 检索的向量一路（ADR-0047、0049）：查询向量对投影行向量的余弦相似度排序，作为 rank() 的第五路召回参与 RRF 融合。
// 向量由调用方给（产品从 embeddings.ts 的缓存读，评测脚本现算，测试手工构造），这里只算相似度不碰库、不走网络；
// 没配 embedding 端点时调用方不传向量，检索退回纯关键词，与向量一路无关
import { cmp } from '../../lib/compare';
import type { ProjectionRow } from './projection';
import { LANE_LIMIT } from './rank';

/** 向量一路的一条命中：entryId 与查询的余弦相似度 */
export type VectorHit = { entryId: string; similarity: number };

/** 余弦相似度；任一为零向量（没有方向）或两边维度不一样（换模型后混到旧缓存）时没有可比的方向，返回 0 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 向量一路的名次：只看 vectors 里有 textHash 的行，按相似度降序、同分按 entryId 升序，取前 limit（默认与文字各路同一个 LANE_LIMIT） */
export function vectorLane(queryVec: readonly number[], rows: readonly ProjectionRow[], vectors: ReadonlyMap<string, number[]>, limit = LANE_LIMIT): VectorHit[] {
  return rows
    .flatMap(row => {
      const v = vectors.get(row.textHash);
      return v ? [{ entryId: row.entryId, similarity: cosine(queryVec, v) }] : [];
    })
    .sort((a, b) => b.similarity - a.similarity || cmp(a.entryId, b.entryId))
    .slice(0, limit);
}

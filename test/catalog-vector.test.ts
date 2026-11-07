// test/catalog-vector.test.ts —— 检索的向量一路（ADR-0047、0049）：cosine 与 vectorLane 都是纯函数，
// 向量由调用方给（缓存在 embeddings.ts、评测脚本现算或测试手工构造），这里只按余弦相似度在投影行上排出前几名
import { describe, expect, it } from 'vitest';
import type { ProjectionRow } from '../app/.server/catalog/projection';
import { LANE_LIMIT } from '../app/.server/catalog/rank';
import { cosine, vectorLane } from '../app/.server/catalog/vector';

const row = (entryId: string, textHash = `h:${entryId}`): ProjectionRow =>
  ({ entryId, text: `${entryId} 的检索文字`, textHash, aliases: [], subjects: [], spaceId: null });

describe('检索的向量一路', () => {
  it('cosine：同向 1、反向 -1、正交 0、任一为零向量 0', () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [-2, 0])).toBeCloseTo(-1, 12);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(cosine([0, 0], [1, 2])).toBe(0);
    expect(cosine([1, 2], [0, 0])).toBe(0);
  });

  it('vectorLane：只看有向量的行，按相似度降序、同分按 entryId 升序', () => {
    const rows = [row('metric:b'), row('metric:a'), row('metric:c'), row('metric:d')];
    // b、c 与查询 [1,0] 同为完全同向（同分，按标识 b 在前），a 斜向 45°，d 没有向量被跳过
    const hits = vectorLane([1, 0], rows, new Map([['h:metric:c', [0.5, 0]], ['h:metric:a', [1, 1]], ['h:metric:b', [2, 0]]]));
    expect(hits.map(h => h.entryId)).toEqual(['metric:b', 'metric:c', 'metric:a']);
    expect(hits[0]!.similarity).toBe(1);
    expect(hits[2]!.similarity).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('vectorLane：取前 limit，默认 LANE_LIMIT', () => {
    // e00…e39 的向量 [1, i] 与查询 [1, 0] 的相似度随 i 严格递减，没有同分
    const rows = Array.from({ length: 40 }, (_, i) => row(`metric:e${i.toString().padStart(2, '0')}`));
    const vectors = new Map(rows.map((r, i) => [r.textHash, [1, i]]));
    const all = vectorLane([1, 0], rows, vectors, 5);
    expect(all.map(h => h.entryId)).toEqual(['metric:e00', 'metric:e01', 'metric:e02', 'metric:e03', 'metric:e04']);
    expect(vectorLane([1, 0], rows, vectors)).toHaveLength(LANE_LIMIT);
  });
});

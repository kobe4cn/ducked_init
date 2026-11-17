// test/pipeline/vector-store.test.ts —— 向量存储接口（ADR-0058）的系统自带实现 platformStore：直接用假向量写读 platform.catalog_embeddings，不经 provider 与调度器；
// topN 只在调用方传入的哈希里取（当前可见类的行），一个哈希对应多条投影行时展开后与 vectorLane 同序
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectionRow } from '../../app/.server/catalog/projection';
import { vectorLane } from '../../app/.server/catalog/vector';
import { platformStore } from '../../app/.server/catalog/vector-store';
import { cmp } from '../../app/lib/compare';
import { closeDb } from '../../app/.server/db/client';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const row = (entryId: string, textHash: string): ProjectionRow =>
  ({ entryId, text: `${entryId} 的检索文字`, textHash, aliases: [], subjects: [], spaceId: null });

describe('向量存储接口的系统自带实现', () => {
  it('topN 只在传入的哈希里取：库里与查询完全同向但不在列表里的哈希不进结果', async () => {
    const acme = await newTenant('acme');
    const store = platformStore(acme);
    await store.upsert('m', [
      { textHash: 'h:aligned', vector: [2, 0] }, // 与查询 [1,0] 完全同向，但不在下面传入的哈希里
      { textHash: 'h:a', vector: [1, 0] },
      { textHash: 'h:b', vector: [0, 1] },
    ]);
    const hits = await store.topN('m', [1, 0], ['h:a', 'h:b'], 10);
    expect(hits).toEqual([{ textHash: 'h:a', similarity: 1 }, { textHash: 'h:b', similarity: 0 }]);
  });

  it('别的租户、别的模型的行不命中：hashes、read、topN 都只看本租户当前模型', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const store = platformStore(acme);
    await store.upsert('m1', [{ textHash: 'h:a', vector: [1, 0] }]);
    await platformStore(globex).upsert('m1', [{ textHash: 'h:other-tenant', vector: [1, 0] }]);
    await store.upsert('m2', [{ textHash: 'h:other-model', vector: [1, 0] }]);
    expect(await store.hashes('m1')).toEqual(new Set(['h:a']));
    expect(await store.read('m1', ['h:other-tenant', 'h:other-model', 'h:a'])).toEqual(new Map([['h:a', [1, 0]]]));
    expect(await store.topN('m1', [1, 0], ['h:other-tenant', 'h:other-model'], 5)).toEqual([]);
  });

  it('一个哈希对应多条投影行时，topN 的结果展开成行后，条目顺序与相似度和 vectorLane 一致（同分按 entryId 升序）', async () => {
    const acme = await newTenant('acme');
    const store = platformStore(acme);
    // 四个哈希与查询 [1,0] 的相似度严格递减、互不同分；h1 挂两条投影行
    const vectors: [string, number[]][] = [['h1', [1, 0]], ['h2', [2, 1]], ['h3', [1, 1]], ['h4', [0, 1]]];
    await store.upsert('m', vectors.map(([textHash, vector]) => ({ textHash, vector })));
    const rows = [row('metric:z', 'h1'), row('metric:a', 'h1'), row('metric:m', 'h2'), row('metric:k', 'h3'), row('metric:n', 'h4')];
    const hashes = vectors.map(([h]) => h);
    const hits = await store.topN('m', [1, 0], hashes, hashes.length);
    expect(hits.map(h => h.textHash)).toEqual(hashes); // limit 不小于哈希数时全取
    // 展开在调用方做：每个哈希展开成共用它的投影行，同分按 entryId 升序
    const expanded = hits.flatMap(h => rows.filter(r => r.textHash === h.textHash).map(r => ({ entryId: r.entryId, similarity: h.similarity })))
      .sort((a, b) => b.similarity - a.similarity || cmp(a.entryId, b.entryId));
    const lane = vectorLane([1, 0], rows, await store.read('m', hashes), rows.length);
    expect(expanded).toEqual(lane);
    expect(lane.map(h => h.entryId)).toEqual(['metric:a', 'metric:z', 'metric:m', 'metric:k', 'metric:n']);
  });
});

// test/pipeline/vector-store.test.ts —— 向量存储接口（ADR-0058）的契约用例：同一组用例（contractCases）对系统自带实现 platformStore 一直跑，
// 对 pgvector 外部实现只在设置 TEST_PGVECTOR_URL 时跑（skipIf；本地 .env.test、CI 与 Sandcastle 沙箱都设置，测试 PG 镜像带 pgvector，#850）；
// topN 展开成行后与 vectorLane 同序的用例依赖精确相等，只属于 platformStore。preparePgvector 的失败路径（连不上、抹凭据）一直跑。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectionRow } from '../../app/.server/catalog/projection';
import { vectorLane } from '../../app/.server/catalog/vector';
import { platformStore, type VectorStore } from '../../app/.server/catalog/vector-store';
import { closePgvectorPools, pgvectorStore, preparePgvector, setPgvectorConnect } from '../../app/.server/catalog/vector-store-pgvector';
import { cmp } from '../../app/lib/compare';
import { closeDb } from '../../app/.server/db/client';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); await closePgvectorPools(); });
beforeEach(async () => { await resetDb(); });

const row = (entryId: string, textHash: string): ProjectionRow =>
  ({ entryId, text: `${entryId} 的检索文字`, textHash, aliases: [], subjects: [], spaceId: null });

// 契约用例：两种实现共用同一组（platformStore 的表有外键，租户一律用 newTenant 建真实的）。
// 注册成函数而不是「循环一个 stores 数组」：vitest 5 的 describe 回调在文件求值之后才跑，数组在循环处还看不到 skipIf 里的新条目
const contractCases = (make: (tenantId: string) => VectorStore) => () => {
  it('写入后 hashes 与 read 命中；read 不返回没有的哈希，空列表返回空 Map', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('m', [{ textHash: 'h:a', vector: [1, 0, 0.5] }, { textHash: 'h:b', vector: [0.5, 0.25, 0] }]);
    expect(await store.hashes('m')).toEqual(new Set(['h:a', 'h:b']));
    expect(await store.read('m', ['h:a', 'h:missing'])).toEqual(new Map([['h:a', [1, 0, 0.5]]]));
    expect(await store.read('m', [])).toEqual(new Map());
  });

  it('别的模型的行不命中：hashes、read、topN 都只看当前模型', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('m1', [{ textHash: 'h:a', vector: [1, 0] }]);
    await store.upsert('m2', [{ textHash: 'h:b', vector: [1, 0] }]); // 与查询同向，但属于别的模型
    expect(await store.hashes('m1')).toEqual(new Set(['h:a']));
    expect(await store.read('m1', ['h:b', 'h:a'])).toEqual(new Map([['h:a', [1, 0]]]));
    expect(await store.topN('m1', [1, 0], ['h:b'], 5)).toEqual([]);
    expect((await store.topN('m1', [1, 0], ['h:a', 'h:b'], 5)).map(h => h.textHash)).toEqual(['h:a']);
  });

  it('同哈希 upsert 两次只留一行，保留第一次的向量（先写上的算数）', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('m', [{ textHash: 'h:a', vector: [1, 0] }]);
    await store.upsert('m', [{ textHash: 'h:a', vector: [0, 1] }]);
    expect(await store.hashes('m')).toEqual(new Set(['h:a']));
    expect(await store.read('m', ['h:a'])).toEqual(new Map([['h:a', [1, 0]]]));
  });

  it('换模型清理：deleteOtherModels 删掉旧模型的行，当前模型的行还在', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('old', [{ textHash: 'h:a', vector: [1, 0] }]);
    await store.upsert('m', [{ textHash: 'h:b', vector: [0, 1] }]);
    await store.deleteOtherModels('m');
    expect(await store.hashes('old')).toEqual(new Set());
    expect(await store.hashes('m')).toEqual(new Set(['h:b']));
  });

  it('topN 只在传入的哈希里取前 N 个：按分数降序、同分按哈希升序，库里同向但不在列表里的哈希不进结果', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('m', [
      { textHash: 'h:aligned', vector: [3, 0] }, // 与查询 [1,0] 完全同向，但不在传入的哈希里
      { textHash: 'h:b', vector: [2, 0] },
      { textHash: 'h:a', vector: [1, 0] }, // 与 h:b 同为 1 分：同分按哈希升序，h:a 在前
      { textHash: 'h:c', vector: [1, 1] }, // √2/2
      { textHash: 'h:d', vector: [0, 1] }, // 0 分，被 limit 截掉
    ]);
    const hits = await store.topN('m', [1, 0], ['h:d', 'h:c', 'h:b', 'h:a', 'h:a'], 3); // 重复哈希只算一条
    expect(hits.map(h => h.textHash)).toEqual(['h:a', 'h:b', 'h:c']);
    expect(hits[0]!.similarity).toBe(1);
    expect(hits[2]!.similarity).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('零向量与维度不同的旧缓存都没有方向：相似度按 0 参与排序，不挤掉正分的行', async () => {
    const acme = await newTenant('acme');
    const store = make(acme);
    await store.upsert('m', [
      { textHash: 'h:zero', vector: [0, 0] }, // 零向量：cosine() 返回 0，pgvector 的余弦距离是 NaN
      { textHash: 'h:dim3', vector: [1, 0, 0] }, // 换模型混进来的三维向量：与二维查询没有可比方向
      { textHash: 'h:a', vector: [1, 0] },
      { textHash: 'h:b', vector: [1, 1] },
    ]);
    const hits = await store.topN('m', [1, 0], ['h:zero', 'h:dim3', 'h:a', 'h:b'], 4);
    expect(hits.map(h => h.textHash)).toEqual(['h:a', 'h:b', 'h:dim3', 'h:zero']); // 0 分的按哈希升序排在后面
    expect(hits[0]!.similarity).toBe(1);
    expect(hits[1]!.similarity).toBeCloseTo(Math.SQRT1_2, 5);
    expect(hits[2]!.similarity).toBe(0);
    expect(hits[3]!.similarity).toBe(0);
  });

  it('两个租户互不可见：同一个（模型, 哈希）各自只读到自己的向量，topN 也只算自己的', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await make(acme).upsert('m', [{ textHash: 'h:a', vector: [1, 0] }]);
    await make(globex).upsert('m', [{ textHash: 'h:a', vector: [0, 1] }]); // 同哈希、不同向量
    expect(await make(acme).read('m', ['h:a'])).toEqual(new Map([['h:a', [1, 0]]]));
    expect(await make(globex).read('m', ['h:a'])).toEqual(new Map([['h:a', [0, 1]]]));
    expect(await make(acme).topN('m', [1, 0], ['h:a'], 5)).toEqual([{ textHash: 'h:a', similarity: 1 }]);
    expect(await make(globex).topN('m', [1, 0], ['h:a'], 5)).toEqual([{ textHash: 'h:a', similarity: 0 }]);
  });
};

describe('platformStore 的向量存储契约', contractCases(platformStore));

describe.skipIf(!process.env.TEST_PGVECTOR_URL)('pgvector 外部向量存储（TEST_PGVECTOR_URL）', () => {
  const url = process.env.TEST_PGVECTOR_URL!;
  const tenants = new Set<string>(); // resetDb 只清平台库：用例用到的租户在外部库的行由 afterEach 清掉
  beforeAll(async () => {
    const prepared = await preparePgvector(url);
    if (!prepared.ok) throw new Error(prepared.error);
  });
  afterEach(async () => {
    await Promise.all([...tenants].map(tenantId => pgvectorStore(tenantId, url).clear()));
    tenants.clear();
  });
  it('preparePgvector 幂等：表已存在时重复调用仍 ok（扩展与表都是 IF NOT EXISTS）', async () => {
    expect(await preparePgvector(url)).toEqual({ ok: true });
  });
  describe('pgvectorStore 的向量存储契约', contractCases(tenantId => (tenants.add(tenantId), pgvectorStore(tenantId, url))));
});

describe('platformStore 的 topN 展开与 vectorLane 同序', () => {
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

describe('preparePgvector 连不上', () => {
  it('返回 ok:false，错误里没有连接串和密码', async () => {
    const prepared = await preparePgvector('postgres://u:s3cret@127.0.0.1:1/x'); // 端口 1 关着：连接被拒
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.error).not.toContain('s3cret');
      expect(prepared.error).not.toContain('postgres://u');
      expect(prepared.error).toContain('准备 pgvector 向量库失败');
    }
  });

  it('用户名和密码带百分号编码的特殊字符：错误里原文、编码形式和整串连接串都抹掉', async () => {
    const url = 'postgres://us%40r:p%40ss%2Fw@h:1/x';
    setPgvectorConnect(() => ({
      query: () => Promise.reject(new Error(`password authentication failed for user "us@r" (p@ss/w) ${url}`)),
    }));
    try {
      const prepared = await preparePgvector(url);
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) {
        for (const secret of ['p@ss/w', 'p%40ss%2Fw', 'us@r', url]) expect(prepared.error).not.toContain(secret);
        expect(prepared.error).toContain('准备 pgvector 向量库失败');
      }
    } finally {
      setPgvectorConnect(undefined);
    }
  });
});

// app/.server/catalog/vector-store.ts —— 检索向量的存储接口（ADR-0058）：embeddings.ts 只经这个接口读写向量，不直接查表；
// 系统自带实现 platformStore 把向量缓存在平台库 platform.catalog_embeddings（ADR-0047、0049 建的表），首个外部实现 pgvector 由后续子票接入。
// 接口实例绑定一个租户，每条读写都只碰该租户的行；外部存储的写没法和平台库事务放在一起，方法各自独立生效，补算的入队去重由调用方（ensureEmbeddings）在平台事务里保证
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import { getDb } from '../db/client';
import { catalogEmbeddings } from '../db/schema';
import { cosine } from './vector';

/** 向量存储（ADR-0058）：一个实例管一个租户的向量，按（模型, 文本哈希）寻址 */
export interface VectorStore {
  /** 当前模型下写入一批（文本哈希, 向量）：向量由哈希对应的文本与模型决定，重复写时先写上的算数 */
  upsert(model: string, rows: { textHash: string; vector: number[] }[]): Promise<void>;
  /** 当前模型下该租户已有向量的文本哈希 */
  hashes(model: string): Promise<Set<string>>;
  /** 读当前模型下这些文本哈希的向量：只按（租户, 模型, 文本哈希）命中，旧模型与别的租户的行不算 */
  read(model: string, hashes: string[]): Promise<Map<string, number[]>>;
  /** 删掉其他模型的行：换模型后旧模型的行命中不了，补算时删（ADR-0049） */
  deleteOtherModels(model: string): Promise<void>;
  /** 删掉当前模型下不在 keep 里的哈希的行（投影里已没有的文字） */
  deleteMissing(model: string, keep: string[]): Promise<void>;
  /** 查询向量在给定哈希里按余弦相似度取前 limit 个（按哈希计数）：只在调用方给的哈希（当前可见类的行）里取，restricted 条目不会被取到；展开成条目由调用方做 */
  topN(model: string, queryVec: number[], hashes: string[], limit: number): Promise<{ textHash: string; similarity: number }[]>;
  /** 删掉本租户全部行（切换存储时用，ADR-0058） */
  clear(): Promise<void>;
}

/** 系统自带实现：向量缓存在平台库 platform.catalog_embeddings */
export function platformStore(tenantId: string): VectorStore {
  const read = async (model: string, hashes: string[]): Promise<Map<string, number[]>> => {
    if (!hashes.length) return new Map();
    const rows = await getDb().select({ textHash: catalogEmbeddings.textHash, vector: catalogEmbeddings.vector })
      .from(catalogEmbeddings)
      .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, model), inArray(catalogEmbeddings.textHash, hashes)));
    return new Map(rows.map(r => [r.textHash, r.vector]));
  };
  return {
    async upsert(model, rows) {
      if (!rows.length) return;
      await getDb().insert(catalogEmbeddings).values(rows.map(r => ({
        tenantId, modelId: model, textHash: r.textHash,
        dimension: r.vector.length, vector: r.vector,
      }))).onConflictDoNothing(); // 两个调度器的钩子可能同时补：谁先写上都行
    },
    async hashes(model) {
      const rows = await getDb().select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
        .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, model)));
      return new Set(rows.map(r => r.textHash));
    },
    read,
    async deleteOtherModels(model) {
      await getDb().delete(catalogEmbeddings)
        .where(and(eq(catalogEmbeddings.tenantId, tenantId), ne(catalogEmbeddings.modelId, model)));
    },
    async deleteMissing(model, keep) {
      await getDb().delete(catalogEmbeddings).where(and(
        eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, model),
        keep.length ? notInArray(catalogEmbeddings.textHash, keep) : undefined));
    },
    async topN(model, queryVec, hashes, limit) {
      const vectors = await read(model, hashes);
      return [...new Set(hashes)] // 只在调用方给的哈希里取；重复哈希只算一条
        .flatMap(textHash => {
          const v = vectors.get(textHash);
          return v ? [{ textHash, similarity: cosine(queryVec, v) }] : [];
        })
        .sort((a, b) => b.similarity - a.similarity || cmp(a.textHash, b.textHash)) // 同分按哈希升序，展开成条目后同分按 entryId（vectorLane）
        .slice(0, limit);
    },
    async clear() {
      await getDb().delete(catalogEmbeddings).where(eq(catalogEmbeddings.tenantId, tenantId));
    },
  };
}

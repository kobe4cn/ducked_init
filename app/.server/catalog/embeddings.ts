// app/.server/catalog/embeddings.ts —— 检索投影文字的向量缓存（ADR-0047、0049）：按（租户, 模型, 文本哈希）缓存 embedding，由调度器在后台补算。
// 向量是昂贵的派生计算：丢了可以重算、不参与权限判断；换 embedding 模型后旧模型的行命中不了，补算时删掉。
// 向量读写一律经 VectorStore 接口（ADR-0058），由 resolveVectorStore 按租户在模型服务页的选型解析：系统自带 platformStore 或外部 pgvector，不直接查 catalog_embeddings。
// vectorHits 是查询时的向量一路：对查询算一次 embedding（短超时）后经存储的 topN 取相似哈希排行次，失败只去掉这一路、不拖垮关键词检索；
// 缓存补齐由 ensureEmbeddings 入队去重，fillEmbeddings 在任务的调度器结束钩子里补算
import { and, eq, inArray } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import type { Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogProjection, modelProviders, tasks } from '../db/schema';
import { embedWith, resolveEmbeddingProvider } from '../llm';
import { decryptForTenant } from '../secrets';
import { insertTask } from '../tasks';
import type { ProjectionRow } from './projection';
import { LANE_LIMIT } from './rank';
import { type VectorHit } from './vector';
import { pgvectorStore, redactUrl } from './vector-store-pgvector';
import { platformStore, type VectorStore } from './vector-store';

/** 每批补算的条数：一次 /embeddings 请求的输入条数 */
export const EMBED_BATCH = 64;

/** 查询向量一次 embedding 的短超时：检索在请求路径上，宁可只走关键词也不让成员等一个完整超时（默认 60 秒） */
export const QUERY_EMBED_TIMEOUT_MS = 3000;

/** 解析租户当前选定的向量存储（ADR-0058，做法照 llm.ts 的 resolveEmbeddingProvider）：选了外部 pgvector 且连接串密文在时返回外部实现与解出的 url，
 *  否则返回系统自带的 platformStore（url: null）。url 一并返回：补算失败写 vector_store_error、检索失败打日志时都要拿它抹掉凭据 */
export async function resolveVectorStore(tenantId: string): Promise<{ store: VectorStore; url: string | null }> {
  const [row] = await getDb().select({ vectorStore: modelProviders.vectorStore, vectorStoreUrl: modelProviders.vectorStoreUrl })
    .from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  if (row?.vectorStore === 'pgvector' && row.vectorStoreUrl) {
    // 'vector_store' 与 model-provider.ts 里 VECTOR_STORE_CONTEXT 是同一个加密 context；
    // 不从那边 import：model-provider 经 sources → catalog/tx 绕回本模块，有循环依赖的风险
    const url = (await decryptForTenant(tenantId, 'vector_store', row.vectorStoreUrl)).url;
    return { store: pgvectorStore(tenantId, url), url };
  }
  return { store: platformStore(tenantId), url: null };
}

/** 读当前模型下这些文本哈希的向量：只按（租户, 模型, 文本哈希）命中，旧模型与别的租户的行不算 */
export async function readEmbeddings(tenantId: string, model: string, hashes: string[]): Promise<Map<string, number[]>> {
  return (await resolveVectorStore(tenantId)).store.read(model, hashes);
}

/** 该租户两类投影里不同的（文本哈希, 文本），按哈希排序，补算的分批顺序确定 */
async function projectionTexts(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const rows = await db.selectDistinct({ textHash: catalogProjection.textHash, text: catalogProjection.text })
    .from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
  return rows.sort((a, b) => cmp(a.textHash, b.textHash));
}

/**
 * 保证投影文字的向量齐了（请求里或调度器结束钩子里调用）：没配置 embedding 端点返回 off；
 * 当前模型下投影的每个文本哈希都已有向量返回 fresh；否则入队一个 catalog.embed（已有排队中或运行中的同类任务就不重复入队）返回 queued，
 * 由调度器在任务成功后调 fillEmbeddings 补算
 */
export async function ensureEmbeddings(tenantId: string): Promise<'queued' | 'fresh' | 'off'> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return 'off';
  // 读哈希经 store，不在下面的事务里：store 可能是没法和平台事务放在一起的外部实现（ADR-0058），
  // 判断 fresh 只是提示，入队去重仍在事务里，读到的哈希偏旧至多多排一个任务
  const existing = await (await resolveVectorStore(tenantId)).store.hashes(provider.model);
  return getDb().transaction(async tx => {
    const wanted = await projectionTexts(tx, tenantId);
    if (wanted.every(r => existing.has(r.textHash))) return 'fresh';
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed'), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (!pending) await insertTask(tx, tenantId, 'catalog.embed');
    return 'queued';
  });
}

/**
 * 补算（在 catalog.embed 任务的调度器结束钩子里跑，不进请求）：开始时解析一次 provider 与向量存储（ADR-0058），一次补算只用一个模型、一个存储；
 * 把两类投影里当前模型还没有向量的文字按每批 EMBED_BATCH 条调 embedding 写入，全部写完后删掉旧模型的行和投影里已没有的哈希的行。
 * 某一批失败就停（不删旧行、保留已写好的批次），抛出交给调用方打日志；没配置 embedding 端点时什么都不做。
 * 存储是外部库时：store 的调用连不上就把抹掉凭据的错误写进 model_providers.vector_store_error（页面「向量存储」卡能看到）再抛出，
 * 全部成功时清掉这个错误——只写检查结果两列，不动 updated_at（照 testVectorStore）；embedWith 失败是 embedding 端点的事，不算外部库的错、不写这两列
 */
export async function fillEmbeddings(tenantId: string): Promise<void> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return;
  const { store, url } = await resolveVectorStore(tenantId);
  const wanted = await projectionTexts(getDb(), tenantId);
  const storeCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (url) await getDb().update(modelProviders)
        .set({ vectorStoreCheckedAt: new Date(), vectorStoreError: `补算写入外部向量库失败：${redactUrl(e instanceof Error ? e.message : String(e), url)}` })
        .where(eq(modelProviders.tenantId, tenantId));
      throw e;
    }
  };
  const existing = await storeCall(() => store.hashes(provider.model));
  const missing = wanted.filter(r => !existing.has(r.textHash));
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await embedWith(tenantId, provider, batch.map(r => r.text));
    await storeCall(() => store.upsert(provider.model, batch.map((r, j) => ({ textHash: r.textHash, vector: vectors[j] }))));
  }
  await storeCall(() => store.deleteOtherModels(provider.model));
  const keep = wanted.map(r => r.textHash);
  if (keep.length) await storeCall(() => store.deleteMissing(provider.model, keep));
  if (url) await getDb().update(modelProviders)
    .set({ vectorStoreCheckedAt: new Date(), vectorStoreError: null })
    .where(eq(modelProviders.tenantId, tenantId));
}

/**
 * 检索查询的向量一路（ADR-0047、0049）：对查询文本算一次 embedding（QUERY_EMBED_TIMEOUT_MS 短超时），从租户选定的向量存储（ADR-0058）
 * 按余弦相似度取本批行的前 LANE_LIMIT 个哈希，展开回行排出名次（顺序与 vectorLane 一致：相似度降序、同分按 entryId 升序）。
 * 查询向量不缓存、不落库；调用日志（embedWith 经 logged）只记条数与 token，不含查询文本。
 * 行只用调用方按可见类读出的那批（restricted 不另按 full 类读），topN 也只喂这批行的哈希，restricted 条目带不出来；
 * limit 按哈希计数，展开成条目后要再排一次、截一次。
 * embedding 没配置、超时或失败、外部库连不上时返回 undefined——调用方只去掉向量这一路，不落进整体回退；任何错误都吞在这里（不打查询文本，也不打连接串）。
 * 缓存里缺向量的哈希（刚换模型、后台还在补算）入队补算，去重由 ensureEmbeddings 的事务保证
 */
export async function vectorHits(tenantId: string, rows: ProjectionRow[], query: string): Promise<VectorHit[] | undefined> {
  let url: string | null = null; // 外部库的连接串：只用来把日志里的凭据抹掉，本身不进日志
  const logged = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    return url ? redactUrl(message, url) : message;
  };
  try {
    const provider = await resolveEmbeddingProvider(tenantId);
    if (!provider) return undefined;
    const [queryVec] = await embedWith(tenantId, provider, [query], { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
    const resolved = await resolveVectorStore(tenantId);
    url = resolved.url;
    const store = resolved.store;
    const hashes = [...new Set(rows.map(r => r.textHash))];
    const existing = await store.hashes(provider.model);
    if (hashes.some(h => !existing.has(h))) {
      await ensureEmbeddings(tenantId).catch(e => console.warn('混合检索入队补算向量失败', tenantId, logged(e)));
    }
    const top = await store.topN(provider.model, queryVec, hashes, LANE_LIMIT);
    return top
      .flatMap(h => rows.filter(r => r.textHash === h.textHash).map(r => ({ entryId: r.entryId, similarity: h.similarity })))
      .sort((a, b) => b.similarity - a.similarity || cmp(a.entryId, b.entryId))
      .slice(0, LANE_LIMIT);
  } catch (e) {
    console.warn('混合检索的向量一路不可用，只走关键词', tenantId, logged(e));
    return undefined;
  }
}

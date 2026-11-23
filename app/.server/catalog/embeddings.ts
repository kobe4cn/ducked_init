// app/.server/catalog/embeddings.ts —— 检索投影文字的向量缓存（ADR-0047、0049）：按（租户, 模型, 文本哈希）缓存 embedding，由调度器在后台补算。
// 向量是昂贵的派生计算：丢了可以重算、不参与权限判断；换 embedding 模型后旧模型的行命中不了，补算时删掉。
// 向量读写一律经 VectorStore 接口（ADR-0058），由 resolveVectorStore 按租户在模型服务页的选型解析：系统自带 platformStore 或外部 pgvector，不直接查 catalog_embeddings。
// vectorHits 是查询时的向量一路：对查询算一次 embedding（短超时）后经存储的 topN 取相似哈希排行次，失败只去掉这一路、不拖垮关键词检索，并向调用方报告降级原因（off / embed_failed / store_unreachable / not_ready）；
// 缓存补齐由 ensureEmbeddings 入队去重，fillEmbeddings 在任务的调度器结束钩子里补算，成败记在 model_providers.embedding_fill_*，最近一次失败后 EMBED_FILL_BACKOFF_MS 内不再入队
import { and, eq, inArray } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import type { Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogProjection, modelProviders, tasks } from '../db/schema';
import { embedWith, type LlmProvider, resolveEmbeddingProvider } from '../llm';
import { decryptForTenant } from '../secrets';
import { insertTask } from '../tasks';
import type { ProjectionRow } from './projection';
import { LANE_LIMIT } from './rank';
import { type VectorHit } from './vector';
import { pgvectorStore, redactUrl } from './vector-store-pgvector';
import { platformStore, type VectorStore } from './vector-store';

/** 每批补算默认的条数：DashScope text-embedding-v3 / v4 每批最多 10 条（OpenAI 是 2048），默认取最严的，平台可用 LLM_EMBEDDING_BATCH_SIZE 调大 */
const DEFAULT_EMBED_BATCH = 10;

/** 每批补算的条数（一次 /embeddings 请求的输入条数），「测试 embedding」也发这么多条：LLM_EMBEDDING_BATCH_SIZE 每次调用都读（默认参数在调用时求值，stubEnv 生效），
 *  正整数字符串才用（照 llm.ts 的 timeoutMs）；没填或空串用默认 10，填了但非法时告警后回落默认——配错不让补算整个失败 */
export function embedBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LLM_EMBEDDING_BATCH_SIZE;
  if (!raw) return DEFAULT_EMBED_BATCH;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  console.warn(`LLM_EMBEDDING_BATCH_SIZE=${JSON.stringify(raw)} is not a positive integer, falling back to the default batch size ${DEFAULT_EMBED_BATCH}`);
  return DEFAULT_EMBED_BATCH;
}

/** 查询向量一次 embedding 的短超时：检索在请求路径上，宁可只走关键词也不让成员等一个完整超时（补算默认 LLM_TIMEOUT_SECONDS，60 秒） */
export const QUERY_EMBED_TIMEOUT_MS = 3000;

/** 补算失败后的退避期（#1172）：最近一次补算失败且不到这么久时 ensureEmbeddings 不入队，免得每次检索都重新发一遍注定失败的批量请求 */
export const EMBED_FILL_BACKOFF_MS = 10 * 60_000;

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
 * 最近一次补算失败（model_providers.embedding_fill_error 不为空）且距 embedding_fill_at 不到 EMBED_FILL_BACKOFF_MS 时返回 backoff，不入队；
 * 当前模型下投影的每个文本哈希都已有向量返回 fresh；否则入队一个 catalog.embed（已有排队中或运行中的同类任务就不重复入队）返回 queued，
 * 由调度器在任务成功后调 fillEmbeddings 补算
 */
export async function ensureEmbeddings(tenantId: string): Promise<'queued' | 'fresh' | 'off' | 'backoff'> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return 'off';
  // 时间一律用 JS 的 Date 比较（写入也是），不用 SQL now()：测试的假时钟才管得到
  const [fill] = await getDb().select({ error: modelProviders.embeddingFillError, at: modelProviders.embeddingFillAt })
    .from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  if (fill?.error && fill.at && Date.now() - fill.at.getTime() < EMBED_FILL_BACKOFF_MS) return 'backoff';
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
 * 把两类投影里当前模型还没有向量的文字按每批 embedBatchSize() 条（开始时读一次）调 embedding 写入，全部写完后删掉旧模型的行和投影里已没有的哈希的行。
 * 某一批失败就停（不删旧行、保留已写好的批次），抛出交给调用方打日志；没配置 embedding 端点时什么都不做。
 * 存储是外部库时：store 的调用连不上就把抹掉凭据的错误写进 model_providers.vector_store_error（页面「向量存储」卡能看到）再抛出，
 * 全部成功时清掉这个错误——只写检查结果两列，不动 updated_at（照 testVectorStore）；embedWith 失败是 embedding 端点的事，不算外部库的错、不写这两列。
 * 另外不论哪一步失败（embedding 或存储），都把抹掉 Key 与连接串的原因写进 embedding_fill_error、时间写进 embedding_fill_at 再抛出（#1172，
 * 任务本身仍记 succeeded，这里是唯一能看到失败的地方）；全部成功时清空错误、记下时间。没有本行（走平台 embedding）时 upsert 建行，只写这两列
 */
export async function fillEmbeddings(tenantId: string): Promise<void> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return;
  const batchSize = embedBatchSize();
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
  try {
    const existing = await storeCall(() => store.hashes(provider.model));
    const missing = wanted.filter(r => !existing.has(r.textHash));
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const vectors = await embedWith(tenantId, provider, batch.map(r => r.text));
      await storeCall(() => store.upsert(provider.model, batch.map((r, j) => ({ textHash: r.textHash, vector: vectors[j] }))));
    }
    await storeCall(() => store.deleteOtherModels(provider.model));
    const keep = wanted.map(r => r.textHash);
    if (keep.length) await storeCall(() => store.deleteMissing(provider.model, keep));
    if (url) await getDb().update(modelProviders)
      .set({ vectorStoreCheckedAt: new Date(), vectorStoreError: null })
      .where(eq(modelProviders.tenantId, tenantId));
  } catch (e) {
    // LlmError 的消息已经过 maskKey；外部库的错误要抹掉连接串。写错误列本身失败只告警，不能吞掉原来的错误
    const message = e instanceof Error ? e.message : String(e);
    await recordFill(tenantId, (url ? redactUrl(message, url) : message).slice(0, 500))
      .catch(err => console.warn('记录向量补算失败原因时出错', tenantId, err instanceof Error ? err.message : String(err)));
    throw e;
  }
  await recordFill(tenantId, null);
}

/** 写补算结果两列（#1172）：只写 embedding_fill_error / embedding_fill_at，不动 updated_at（那是配置的修改时间）；没有本行时 upsert 建出来，其余列都有默认值 */
async function recordFill(tenantId: string, error: string | null): Promise<void> {
  const columns = { embeddingFillError: error, embeddingFillAt: new Date() };
  await getDb().insert(modelProviders).values({ tenantId, ...columns })
    .onConflictDoUpdate({ target: modelProviders.tenantId, set: columns });
}

/** 向量一路没用上时的降级原因（ADR-0049、0058）：只放枚举值，绝不能带错误消息（消息里可能有连接串；补算失败的原因只进 model_providers.embedding_fill_error）。
 *  not_ready：这批行的哈希在存储里一个向量都没有（刚换模型还在补算，或补算一直失败） */
export type VectorFallback = 'off' | 'embed_failed' | 'store_unreachable' | 'not_ready';

/**
 * 检索查询的向量一路（ADR-0047、0049）：对查询文本算一次 embedding（QUERY_EMBED_TIMEOUT_MS 短超时），从租户选定的向量存储（ADR-0058）
 * 按余弦相似度取本批行的前 LANE_LIMIT 个哈希，展开回行排出名次（顺序与 vectorLane 一致：相似度降序、同分按 entryId 升序）。
 * 查询向量不缓存、不落库；调用日志（embedWith 经 logged）只记条数与 token，不含查询文本。
 * 行只用调用方按可见类读出的那批（restricted 不另按 full 类读），topN 也只喂这批行的哈希，restricted 条目带不出来；
 * limit 按哈希计数，展开成条目后要再排一次、截一次。
 * 向量一路没用上时返回 fallback 原因而不是 hits：off（没配置 embedding，不算错误、不打 warn）、embed_failed（查询 embedding 失败或超时）、
 * store_unreachable（从解析存储到读写抛错，含连接串解密失败）——调用方只去掉向量这一路，不落进整体回退；任何错误都吞在这里（不打查询文本，也不打连接串）。
 * 这批行的哈希一个向量都没有时返回 not_ready（照样入队补算，退避中也一样返回 not_ready）；
 * 只缺一部分（后台还在补算）不算降级：照常返回 hits 并入队补算，去重由 ensureEmbeddings 的事务保证
 */
export async function vectorHits(tenantId: string, rows: ProjectionRow[], query: string): Promise<{ hits: VectorHit[] } | { fallback: VectorFallback }> {
  let url: string | null = null; // 外部库的连接串：只用来把日志里的凭据抹掉，本身不进日志
  const logged = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    return url ? redactUrl(message, url) : message;
  };
  // 第一段：查询 embedding。没配置不算错误（不打 warn）；配了但失败或超时是 embed_failed
  let provider: LlmProvider;
  let queryVec: number[];
  try {
    const resolvedProvider = await resolveEmbeddingProvider(tenantId);
    if (!resolvedProvider) return { fallback: 'off' };
    provider = resolvedProvider;
    [queryVec] = await embedWith(tenantId, provider, [query], { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
  } catch (e) {
    console.warn('混合检索的向量一路不可用，只走关键词', tenantId, logged(e));
    return { fallback: 'embed_failed' };
  }
  // 第二段：向量存储。从解析（含连接串解密失败）到读哈希、取 topN，抛错都是 store_unreachable
  try {
    const resolved = await resolveVectorStore(tenantId);
    url = resolved.url;
    const store = resolved.store;
    const hashes = [...new Set(rows.map(r => r.textHash))];
    const existing = await store.hashes(provider.model);
    if (hashes.some(h => !existing.has(h))) {
      await ensureEmbeddings(tenantId).catch(e => console.warn('混合检索入队补算向量失败', tenantId, logged(e)));
      if (hashes.every(h => !existing.has(h))) return { fallback: 'not_ready' };
    }
    const top = await store.topN(provider.model, queryVec, hashes, LANE_LIMIT);
    return {
      hits: top
        .flatMap(h => rows.filter(r => r.textHash === h.textHash).map(r => ({ entryId: r.entryId, similarity: h.similarity })))
        .sort((a, b) => b.similarity - a.similarity || cmp(a.entryId, b.entryId))
        .slice(0, LANE_LIMIT),
    };
  } catch (e) {
    console.warn('混合检索的向量一路不可用，只走关键词', tenantId, logged(e));
    return { fallback: 'store_unreachable' };
  }
}

// app/.server/catalog/embeddings.ts —— 检索投影文字的向量缓存（ADR-0047、0049）：按（租户, 模型, 文本哈希）缓存 embedding，由调度器在后台补算。
// 向量是昂贵的派生计算：丢了可以重算、不参与权限判断；换 embedding 模型后旧模型的行命中不了，补算时删掉。
// 本票不改检索路径（查询时的向量召回想在后面的子票）：这里只负责把缓存补齐——ensureEmbeddings 入队去重，fillEmbeddings 在任务的调度器结束钩子里补算
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import type { Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogEmbeddings, catalogProjection, tasks } from '../db/schema';
import { embedWith, resolveEmbeddingProvider } from '../llm';
import { insertTask } from '../tasks';

/** 每批补算的条数：一次 /embeddings 请求的输入条数 */
export const EMBED_BATCH = 64;

/** 读当前模型下这些文本哈希的向量：只按（租户, 模型, 文本哈希）命中，旧模型与别的租户的行不算 */
export async function readEmbeddings(tenantId: string, model: string, hashes: string[]): Promise<Map<string, number[]>> {
  if (!hashes.length) return new Map();
  const rows = await getDb().select({ textHash: catalogEmbeddings.textHash, vector: catalogEmbeddings.vector })
    .from(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, model), inArray(catalogEmbeddings.textHash, hashes)));
  return new Map(rows.map(r => [r.textHash, r.vector]));
}

/** 该租户两类投影里不同的（文本哈希, 文本），按哈希排序，补算的分批顺序确定 */
async function projectionTexts(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const rows = await db.selectDistinct({ textHash: catalogProjection.textHash, text: catalogProjection.text })
    .from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
  return rows.sort((a, b) => cmp(a.textHash, b.textHash));
}

/** 当前模型下该租户已有向量的文本哈希 */
async function embeddedHashes(db: Tx | ReturnType<typeof getDb>, tenantId: string, model: string) {
  const rows = await db.select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, model)));
  return new Set(rows.map(r => r.textHash));
}

/**
 * 保证投影文字的向量齐了（请求里或调度器结束钩子里调用）：没配置 embedding 端点返回 off；
 * 当前模型下投影的每个文本哈希都已有向量返回 fresh；否则入队一个 catalog.embed（已有排队中或运行中的同类任务就不重复入队）返回 queued，
 * 由调度器在任务成功后调 fillEmbeddings 补算
 */
export async function ensureEmbeddings(tenantId: string): Promise<'queued' | 'fresh' | 'off'> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return 'off';
  return getDb().transaction(async tx => {
    const wanted = await projectionTexts(tx, tenantId);
    const existing = await embeddedHashes(tx, tenantId, provider.model);
    if (wanted.every(r => existing.has(r.textHash))) return 'fresh';
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed'), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (!pending) await insertTask(tx, tenantId, 'catalog.embed');
    return 'queued';
  });
}

/**
 * 补算（在 catalog.embed 任务的调度器结束钩子里跑，不进请求）：开始时解析一次 provider，一次补算只用一个模型；
 * 把两类投影里当前模型还没有向量的文字按每批 EMBED_BATCH 条调 embedding 写入，全部写完后删掉旧模型的行和投影里已没有的哈希的行。
 * 某一批失败就停（不删旧行、保留已写好的批次），抛出交给调用方打日志；没配置 embedding 端点时什么都不做
 */
export async function fillEmbeddings(tenantId: string): Promise<void> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return;
  const db = getDb();
  const wanted = await projectionTexts(db, tenantId);
  const existing = await embeddedHashes(db, tenantId, provider.model);
  const missing = wanted.filter(r => !existing.has(r.textHash));
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await embedWith(tenantId, provider, batch.map(r => r.text));
    await db.insert(catalogEmbeddings).values(batch.map((r, j) => ({
      tenantId, modelId: provider.model, textHash: r.textHash,
      dimension: vectors[j].length, vector: vectors[j],
    }))).onConflictDoNothing(); // 两个调度器的钩子可能同时补：谁先写上都行
  }
  await db.delete(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), ne(catalogEmbeddings.modelId, provider.model)));
  const hashes = wanted.map(r => r.textHash);
  if (hashes.length) await db.delete(catalogEmbeddings).where(and(
    eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, provider.model), notInArray(catalogEmbeddings.textHash, hashes)));
}

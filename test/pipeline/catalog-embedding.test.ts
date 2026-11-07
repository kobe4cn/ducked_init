// test/pipeline/catalog-embedding.test.ts —— 检索向量缓存（ADR-0047、0049）的接缝：ensureEmbeddings 入队去重 catalog.embed → 调度器结束钩子 fillEmbeddings → platform.catalog_embeddings；
// 换 embedding 模型后旧模型的行命中不了、补算时删掉；某一批失败就停、已存的向量不动；llm_calls 只记条数与 token、不记文本
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBED_BATCH, ensureEmbeddings, readEmbeddings } from '../../app/.server/catalog/embeddings';
import { cmp } from '../../app/lib/compare';
import { refreshProjection } from '../../app/.server/catalog/projection';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogEmbeddings, catalogProjection, llmCalls, modelProviders, tasks } from '../../app/.server/db/schema';
import { MODEL_PROVIDER_CONTEXT, setLlmFetch } from '../../app/.server/llm';
import { encryptForTenant } from '../../app/.server/secrets';
import { enqueueTask } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { drain, newTenant } from './fixtures';
import { embeddings, fakeLlm, platformEmbedding, type LlmBody } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** n 条按 EMBED_BATCH 一批的分批（每批的条数，按顺序） */
const batches = (n: number) => Array.from({ length: Math.ceil(n / EMBED_BATCH) }, (_, i) => Math.min(EMBED_BATCH, n - i * EMBED_BATCH));

/** 开通租户并同步建投影（新租户的目录有规范实体等条目，两类投影的文字相同） */
async function setup(slug = 'acme') {
  const tenantId = await newTenant(slug);
  await refreshProjection(tenantId);
  return tenantId;
}

/** 该租户两类投影里不同的（文本哈希, 文本），按哈希排序（fillEmbeddings 的分批顺序） */
const projectionTexts = async (tenantId: string) =>
  (await getDb().selectDistinct({ textHash: catalogProjection.textHash, text: catalogProjection.text })
    .from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId)))
    .sort((a, b) => cmp(a.textHash, b.textHash));

/** 本租户的向量行，按哈希排序 */
const embeddingRows = (tenantId: string) =>
  getDb().select().from(catalogEmbeddings).where(eq(catalogEmbeddings.tenantId, tenantId)).orderBy(catalogEmbeddings.textHash);

/** 本租户的 catalog.embed 任务，按提交时间排序 */
const embedTasks = (tenantId: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed')));

const callLogs = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));

/** 每条文本的假向量由内容决定（[文本长度, 0.5]），与分批、排序无关，用来核对哈希与向量没有错位 */
const byLength = (_n: number, body: LlmBody) => embeddings(body.input.map((t: string) => [t.length, 0.5]), { prompt_tokens: 7 });

/** 断言一组向量行与投影文字一一对应：都在 model 下、向量是 [文本长度, 0.5] */
async function expectAligned(tenantId: string, model: string, hashes: string[]) {
  const texts = await projectionTexts(tenantId);
  const rows = await embeddingRows(tenantId);
  expect(rows.map(r => r.textHash)).toEqual(hashes);
  for (const r of rows) {
    expect(r.modelId, r.textHash).toBe(model);
    expect(r.vector, r.textHash).toEqual([texts.find(t => t.textHash === r.textHash)!.text.length, 0.5]);
    expect(r.dimension).toBe(r.vector.length);
  }
}

/** 给租户配自己的 embedding 三项（chat 三列为空），换模型用 */
async function tenantEmbedding(tenantId: string, model: string) {
  await getDb().insert(modelProviders).values({
    tenantId, embeddingBaseUrl: 'https://tenant-embed.example.com/v1', embeddingModel: model,
    embeddingApiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-embed-secret' }),
  });
}

/** 直接往投影里加一个假条目（只占 full 一类），返回它的文本哈希 */
async function fakeProjectionRow(tenantId: string, i: number) {
  const text = `假条目 ${i} 号，参与检索的文字`;
  const textHash = createHash('sha256').update(text).digest('hex');
  await getDb().insert(catalogProjection).values({
    tenantId, visibilityClass: 'full', entryId: `fake:${i}`, text, textHash,
    subjects: [], aliases: [], spaceId: null, catalogVersion: 1,
  });
  return textHash;
}

/** 直接往投影里加 n 个假条目（编号从 from 起），凑出要补算的哈希 */
async function fakeProjectionRows(tenantId: string, from: number, n: number) {
  for (let i = from; i < from + n; i++) await fakeProjectionRow(tenantId, i);
}

describe('检索向量缓存', () => {
  it('配置了 embedding 时 ensureEmbeddings 入队一个 catalog.embed（已有排队的不重复入队），drain 后两类投影里每个不同的 text_hash 在当前模型下各有一行向量，再跑一次不发请求；没配置时不入队、不发请求', async () => {
    const acme = await setup();
    expect(await ensureEmbeddings(acme)).toBe('off');
    expect(await embedTasks(acme)).toHaveLength(0);

    platformEmbedding();
    const { received } = fakeLlm(setLlmFetch, byLength);
    expect(await ensureEmbeddings(acme)).toBe('queued');
    expect(await ensureEmbeddings(acme)).toBe('queued');
    expect(await embedTasks(acme)).toHaveLength(1);
    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded']);

    const texts = await projectionTexts(acme);
    expect(texts.length).toBeGreaterThan(EMBED_BATCH); // 本仓库的规范实体条目足够分出多批
    expect(received.map(r => r.body.input.length)).toEqual(batches(texts.length)); // 按 64 条一批
    await expectAligned(acme, 'text-embedding-v3', texts.map(t => t.textHash));

    // 再跑一次：向量齐了返回 fresh，不再入队、不发请求
    expect(await ensureEmbeddings(acme)).toBe('fresh');
    await drain();
    expect(await embedTasks(acme)).toHaveLength(1);
    expect(received.map(r => r.body.input.length)).toEqual(batches(texts.length));

    // 调用日志只记条数与 token，不记文本
    const logs = await callLogs(acme);
    expect(logs.map(l => l.inputCount)).toEqual(batches(texts.length));
    for (const l of logs) expect(l).toMatchObject({
      purpose: 'embedding', model: 'text-embedding-v3',
      promptTokens: 7, completionTokens: null, schemaValid: null, error: null,
    });
    expect(JSON.stringify(logs)).not.toContain('capability:');
  });

  it('换 embedding 模型后 readEmbeddings 对旧模型的行不命中；再补算后新模型每个哈希都有向量、旧模型与投影里已没有的哈希的行被删掉；别的租户同样文本的行不受影响', async () => {
    const acme = await setup();
    const globex = await setup('globex');
    platformEmbedding();
    fakeLlm(setLlmFetch, byLength);
    for (const t of [acme, globex]) { await ensureEmbeddings(t); await drain(); }

    const hashes = (await projectionTexts(acme)).map(t => t.textHash);
    expect((await embeddingRows(globex)).map(r => r.textHash)).toEqual(hashes); // 两个租户的目录相同（同样的哈希）

    // 投影里删掉一个条目（两类各一行）
    await getDb().delete(catalogProjection).where(and(eq(catalogProjection.tenantId, acme), eq(catalogProjection.entryId, 'capability:tag-dsl')));
    const afterDelete = (await projectionTexts(acme)).map(t => t.textHash);
    expect(afterDelete).toHaveLength(hashes.length - 1);

    await tenantEmbedding(acme, 'bge-m3');
    expect((await readEmbeddings(acme, 'bge-m3', afterDelete)).size).toBe(0); // 新模型还没有行
    expect((await readEmbeddings(acme, 'text-embedding-v3', hashes)).size).toBe(hashes.length); // 旧模型的行只在旧模型下命中
    expect(await ensureEmbeddings(acme)).toBe('queued');
    await drain();
    await expectAligned(acme, 'bge-m3', afterDelete); // 旧模型的行（含投影里已没有的哈希）删掉了

    // 别的租户同样文本的行不受影响：还是平台模型、原来的哈希都在
    expect((await embeddingRows(globex)).map(r => r.textHash)).toEqual(hashes);
    expect((await embeddingRows(globex)).every(r => r.modelId === 'text-embedding-v3')).toBe(true);

    // 当前模型下投影里已没有的哈希：加一个新条目触发补算，补算后删掉该哈希的行、新哈希补上；别的租户的同哈希行不动
    const stale = afterDelete[0];
    await getDb().delete(catalogProjection).where(and(eq(catalogProjection.tenantId, acme), eq(catalogProjection.textHash, stale)));
    const added = await fakeProjectionRow(acme, 1);
    expect(await ensureEmbeddings(acme)).toBe('queued');
    await drain();
    await expectAligned(acme, 'bge-m3', [...afterDelete.slice(1), added].sort(cmp));
    expect((await readEmbeddings(globex, 'text-embedding-v3', hashes)).size).toBe(hashes.length);
  });

  it('embedding 请求失败时任务仍结束、已存的向量不动、调用日志记 error；llm_calls 只记条数与 token、不记文本', async () => {
    const acme = await setup();
    platformEmbedding();
    fakeLlm(setLlmFetch, byLength);
    await ensureEmbeddings(acme);
    await drain();
    const stored = await embeddingRows(acme);
    const okBatches = batches(stored.length);
    expect(stored.length).toBeGreaterThan(EMBED_BATCH);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fakeProjectionRows(acme, 1, EMBED_BATCH + 6); // 凑出要补算的哈希，第一批（64 条）就失败
    setLlmFetch(async () => new Response('server exploded', { status: 500 }));
    expect(await ensureEmbeddings(acme)).toBe('queued');
    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']); // 失败只由结束钩子打日志，任务仍结束
    expect(await embeddingRows(acme)).toEqual(stored); // 已存的向量不动，失败的批次一行都不写

    const logs = await callLogs(acme);
    expect(logs.filter(l => l.error === null)).toHaveLength(okBatches.length);
    const failed = logs.filter(l => l.error !== null);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      purpose: 'embedding', model: 'text-embedding-v3', inputCount: EMBED_BATCH,
      promptTokens: null, completionTokens: null, schemaValid: null,
    });
    expect(failed[0].error).toContain('HTTP 500');
    expect(JSON.stringify(failed[0])).not.toContain('假条目');
    expect(JSON.stringify(failed[0])).not.toContain('capability:');
  });

  it('某一批失败就停（不删旧行、保留已写好的批次），恢复后再补算一次补齐并清掉旧模型的行', async () => {
    const acme = await setup();
    platformEmbedding();
    fakeLlm(setLlmFetch, byLength);
    await ensureEmbeddings(acme);
    await drain();
    const stored = await embeddingRows(acme);
    expect(stored).toHaveLength((await projectionTexts(acme)).length); // 全都补齐了（旧模型）

    const added = await fakeProjectionRow(acme, 1);
    await tenantEmbedding(acme, 'bge-m3'); // 换模型：已有的行是旧模型的，全部要重算
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = fakeLlm(setLlmFetch, (n, body) => (n === 1 ? byLength(n, body) : new Response('server exploded', { status: 500 })));
    expect(await ensureEmbeddings(acme)).toBe('queued');
    await drain();
    expect(failing.received.map(r => r.body.input.length)).toEqual(batches(stored.length + 1).slice(0, 2)); // 第一批成功、第二批失败就停
    expect(failing.received.every(r => r.body.model === 'bge-m3')).toBe(true); // 一次补算只用一个模型
    expect(warn).toHaveBeenCalled(); // 结束钩子打日志，任务仍是 succeeded
    const partial = await embeddingRows(acme);
    expect(partial.filter(r => r.modelId === 'bge-m3').map(r => r.textHash)).toHaveLength(EMBED_BATCH); // 已写好的批次保留
    expect(partial.filter(r => r.modelId === 'text-embedding-v3')).toEqual(stored); // 失败就停：旧模型的行没删

    const ok = fakeLlm(setLlmFetch, byLength);
    expect(await ensureEmbeddings(acme)).toBe('queued');
    await drain();
    expect(ok.received.map(r => r.body.input.length)).toEqual(batches(stored.length + 1 - EMBED_BATCH)); // 只补缺的
    await expectAligned(acme, 'bge-m3', [...stored.map(r => r.textHash), added].sort(cmp)); // 旧模型的行删掉了
  });

  it('catalog.projection 任务成功重建投影后顺带入队补算向量：一次 drain 后投影与向量都齐', async () => {
    const acme = await setup();
    platformEmbedding();
    const { received } = fakeLlm(setLlmFetch, byLength);
    await enqueueTask(acme, 'catalog.projection');
    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded']);
    const texts = await projectionTexts(acme);
    expect(received.map(r => r.body.input.length)).toEqual(batches(texts.length));
    await expectAligned(acme, 'text-embedding-v3', texts.map(t => t.textHash));
  });
});

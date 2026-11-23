// test/pipeline/catalog-hybrid.test.ts —— 混合检索（ADR-0047、0049）的接缝：rankedSearch({ hybrid: true }) → vectorHits（查询 embedding + catalog_embeddings 缓存）→ rank 的向量一路；
// embedding 超时（短超时）、5xx 或没配置时只去掉向量这一路（fallback 仍为 false、结果与关键词检索逐项相同，vectorFallback 给出原因）；换模型后这批行一个向量都没有时 vectorFallback 是 not_ready、只走关键词并入队补算，drain 后向量一路恢复；
// 补算批量请求失败时记下 embedding_fill_error、10 分钟内检索不再入队（backoff）、catalog_search 输出 not_ready，成功后清空错误（#1172）；
// catalog_search（内部与 MCP 同一入口）按租户 hybrid_search 开关决定是否走混合（#432）；
// hybridReady 断言向量缓存齐全，缺了就在报错里列出诊断（#610）
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../../app/.server/assistant/tools';
import { EMBED_FILL_BACKOFF_MS, ensureEmbeddings, QUERY_EMBED_TIMEOUT_MS } from '../../app/.server/catalog/embeddings';
import { haystack, terms } from '../../app/.server/catalog/index';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { projectionVersion, rankedSearch, refreshProjection } from '../../app/.server/catalog/projection';
import { currentCatalogVersion } from '../../app/.server/catalog/versions';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogEmbeddings, catalogProjection, llmCalls, modelProviders, tasks, tenants } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { MODEL_PROVIDER_CONTEXT, setLlmFetch } from '../../app/.server/llm';
import { encryptForTenant } from '../../app/.server/secrets';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant } from './fixtures';
import { embeddings, fakeLlm, platformEmbedding, type LlmBody } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.useRealTimers(); setLlmFetch(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** 只靠向量命中的查询；MARK 只出现在目标指标的说明里——关键词分不出它们，假向量让两者同向、其余正交 */
const QUERY = '顾客流失风险';
const MARK = '不再复购';
const CHURN = `base: order\nmeasure: { agg: count }\ndescription: 未来 90 天内${MARK}的倾向打分\n`;

/** 假向量按文本内容决定：查询与含 MARK 的文本同向 [1,0]，其余正交 [0,1]（维度一致，余弦可比） */
const vec = (t: string): number[] => t === QUERY || t.includes(MARK) ? [1, 0] : [0, 1];

/** 该租户的 catalog.embed 任务 */
const embedTasks = (tenantId: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed')));

/** drain 之后该有的向量缓存：text-embedding-v3（platformEmbedding 设的模型）下，投影的每个文本哈希都有向量。
 *  缺了就带着诊断报错（#610）：缺向量的行、租户全部任务、投影版本、当前目录版本——分不清「缓存没写全」还是「排序截断」时，报错里直接能看出根因。
 *  只断言、不补救：不调 ensureEmbeddings、不重跑 drain（会多入队任务，破坏用例对任务个数的精确断言），也不轮询（没有证据说明等一下就好） */
async function assertEmbeddingsComplete(tenantId: string) {
  const db = getDb();
  const rows = await db.select({ entryId: catalogProjection.entryId, visibilityClass: catalogProjection.visibilityClass, textHash: catalogProjection.textHash })
    .from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
  const existing = new Set((await db.select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, 'text-embedding-v3'))))
    .map(v => v.textHash));
  const missing = rows.filter(r => !existing.has(r.textHash));
  if (!missing.length) return;
  const allTasks = await db.select({ kind: tasks.kind, status: tasks.status }).from(tasks).where(eq(tasks.tenantId, tenantId));
  const diag = `hybridReady 结束时向量缓存不全（#610）`
    + `；缺向量的投影行 ${missing.map(r => `${r.entryId}/${r.visibilityClass}/${r.textHash.slice(0, 8)}`).join(' ')}`
    + `；租户全部任务 ${allTasks.map(t => `${t.kind}/${t.status}`).join(' ') || '(无)'}`
    + `；投影版本 ${await projectionVersion(db, tenantId)}`
    + `；当前目录版本 ${await currentCatalogVersion(db, tenantId)}`;
  expect(missing, diag).toEqual([]);
}

/** 开通租户、发布只靠向量命中的指标、建投影、配平台 embedding 并 drain 补齐向量缓存（assertEmbeddingsComplete 把缓存齐全钉住），读出调用方的目录 */
async function hybridReady() {
  const acme = await newTenant('acme');
  const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
  const reviewer = await memberOf(acme, 'rv@acme.com', 'data_engineer');
  await createDefinition(analyst, 'metric', 'churn_forecast', CHURN);
  await publishDefinition(reviewer, 'metric', 'churn_forecast', 1);
  await refreshProjection(acme);
  platformEmbedding();
  const { received } = fakeLlm(setLlmFetch, (_n, body: LlmBody) => embeddings(body.input.map((t: string) => vec(t)), { prompt_tokens: 3 }));
  await ensureEmbeddings(acme);
  await drain();
  await assertEmbeddingsComplete(acme);
  return { acme, c: await tenantCatalog(acme), received, analyst };
}

/** 给租户配自己的 embedding 三项（chat 三列为空），换模型用 */
async function tenantEmbedding(tenantId: string, model: string) {
  const columns = {
    embeddingBaseUrl: 'https://tenant-embed.example.com/v1', embeddingModel: model,
    embeddingApiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-embed-secret' }),
  };
  // upsert：hybridReady 的补算成功时已经建了本行（只写了 embedding_fill_* 两列，#1172）
  await getDb().insert(modelProviders).values({ tenantId, ...columns })
    .onConflictDoUpdate({ target: modelProviders.tenantId, set: columns });
}

describe('混合检索', () => {
  it('缓存齐全时 hybrid: true 把向量一路融合进结果（只靠向量命中的条目能进结果、理由带 lane: vector），fallback: false；不传 hybrid 不发 embedding 请求、结果不含该条目', async () => {
    const { acme, c, received } = await hybridReady();
    // 租户没有 model_providers 行（走平台 embedding）：补算成功时 upsert 建行，只写 embedding_fill_* 两列（#1172）
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toBeDefined();
    expect(row.embeddingFillError).toBeNull();
    expect(row.embeddingFillAt).toBeInstanceOf(Date);
    expect({ baseUrl: row.baseUrl, embeddingBaseUrl: row.embeddingBaseUrl, embeddingModel: row.embeddingModel, vectorStore: row.vectorStore })
      .toEqual({ baseUrl: null, embeddingBaseUrl: null, embeddingModel: null, vectorStore: 'platform' });
    // 前置：查询的词没有一个出现在目标指标的检索文字里，它只可能靠向量命中
    const text = haystack(c.entries.find(e => e.id === 'metric:churn_forecast')!);
    expect(terms(QUERY).every(w => !text.includes(w))).toBe(true);
    const callsBefore = received.length;
    const fillLogIds = new Set((await getDb().select({ id: llmCalls.id }).from(llmCalls).where(eq(llmCalls.tenantId, acme))).map(l => l.id));

    const plain = await rankedSearch(acme, 'full', c, QUERY, {});
    expect(plain.fallback).toBe(false);
    expect(plain.ranked.length).toBeGreaterThan(0); // 关键词一路有别的候选（流失风险的模板条目）
    expect(plain.ranked.map(r => r.entry.id)).not.toContain('metric:churn_forecast');
    expect(received.length).toBe(callsBefore); // 不传 hybrid 不发 embedding 请求

    const hybrid = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(hybrid.fallback).toBe(false);
    expect(hybrid.vectorFallback).toBeUndefined(); // 补算成功时建出的 model_providers 行没改变 provider 的解析
    const hit = hybrid.ranked.find(r => r.entry.id === 'metric:churn_forecast')!;
    expect(hit, JSON.stringify(hybrid.ranked.map(r => [r.entry.id, r.reasons.map(x => x.lane)]))).toBeDefined();
    expect(hit.reasons).toContainEqual({ lane: 'vector', matched: ['1.00'] });
    expect(received.slice(callsBefore).map(r => r.body.input)).toEqual([[QUERY]]); // 只为查询算一次向量

    // 查询的调用日志只记条数与 token，不含查询文本；缓存齐了不再入队补算
    const queryLogs = (await getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, acme))).filter(l => !fillLogIds.has(l.id)); // 补算的末批也可能只有 1 条，按查询前已有的日志排除
    expect(queryLogs.map(l => ({ purpose: l.purpose, model: l.model, promptTokens: l.promptTokens, error: l.error })))
      .toEqual([{ purpose: 'embedding', model: 'text-embedding-v3', promptTokens: 3, error: null }]);
    expect(JSON.stringify(queryLogs)).not.toContain(QUERY);
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded']);
  });

  it('embedding 超时（按 QUERY_EMBED_TIMEOUT_MS 短超时）、5xx 或没配置时，hybrid: true 的 ranked 与不传的逐项相同、fallback: false、vectorFallback 给出原因，查询文本不进日志', async () => {
    const { acme, c } = await hybridReady();
    const plain = await rankedSearch(acme, 'full', c, QUERY, {});
    expect('vectorFallback' in plain).toBe(false); // 不传 hybrid 时连这个键都没有
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 超时：永不 resolve、但遵守 abort 的 fetch，按短超时中断而不是 60 秒
    setLlmFetch((_url, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', function aborted(this: AbortSignal) { reject(this.reason); })));
    const started = Date.now();
    const timedOut = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(timedOut.ranked).toEqual(plain.ranked);
    expect(timedOut.fallback).toBe(false);
    expect(timedOut.vectorFallback).toBe('embed_failed');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(warn).toHaveBeenCalledTimes(1);

    // 5xx
    setLlmFetch(async () => new Response('server exploded', { status: 500 }));
    const exploded = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(exploded.ranked).toEqual(plain.ranked);
    expect(exploded.fallback).toBe(false);
    expect(exploded.vectorFallback).toBe('embed_failed');
    expect(warn).toHaveBeenCalledTimes(2);

    // 没配置（租户与平台都没有）：不发请求、不算错误，原因是 off
    let called = false;
    setLlmFetch(async () => { called = true; throw new TypeError('fetch failed'); });
    vi.unstubAllEnvs();
    const off = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(off.ranked).toEqual(plain.ranked);
    expect(off.fallback).toBe(false);
    expect(off.vectorFallback).toBe('off');
    expect(called).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);

    // 查询文本不进日志：warn 的参数与 llm_calls 的行都不含查询文本；超时的消息按实际秒数
    expect(JSON.stringify(warn.mock.calls)).not.toContain(QUERY);
    const failed = (await getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, acme))).filter(l => l.error !== null);
    expect(failed.map(l => l.inputCount)).toEqual([1, 1]);
    expect(failed[0]!.error).toContain(`${QUERY_EMBED_TIMEOUT_MS / 1000} 秒内没有返回`);
    expect(failed[1]!.error).toContain('HTTP 500');
    expect(JSON.stringify(failed)).not.toContain(QUERY);
  });

  it('换模型后、补算完成前 hybrid: true 仍正常返回：这批行一个向量都没有时 vectorFallback 是 not_ready，只走关键词并入队一个 catalog.embed（重复检索不重复入队）；drain 后再检索向量一路恢复', async () => {
    const { acme, c } = await hybridReady();
    await tenantEmbedding(acme, 'bge-m3'); // 缓存里的行都是旧模型的，当前模型一个都命中不了
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const degraded = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(degraded.fallback).toBe(false);
    expect(degraded.vectorFallback).toBe('not_ready');
    expect(degraded.ranked.map(r => r.entry.id)).not.toContain('metric:churn_forecast');
    expect(degraded.ranked.flatMap(r => r.reasons.map(x => x.lane))).not.toContain('vector');
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'queued']); // 入队补算

    await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(await embedTasks(acme)).toHaveLength(2); // 重复检索不重复入队

    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
    const restored = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    const hit = restored.ranked.find(r => r.entry.id === 'metric:churn_forecast')!;
    expect(hit).toBeDefined();
    expect(hit.reasons).toContainEqual({ lane: 'vector', matched: ['1.00'] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('这批行只缺一部分向量时不降级：照旧返回向量命中（lane: vector）、vectorFallback 为 undefined，并入队一个 catalog.embed（#1172）', async () => {
    const { acme, c } = await hybridReady();
    // 直接往投影里加一个假条目：这批行只缺它这一个哈希
    const text = '假条目，只缺它的向量';
    await getDb().insert(catalogProjection).values({
      tenantId: acme, visibilityClass: 'full', entryId: 'fake:partial', text, textHash: createHash('sha256').update(text).digest('hex'),
      subjects: [], aliases: [], spaceId: null, catalogVersion: 1,
    });

    const hybrid = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(hybrid.vectorFallback).toBeUndefined();
    const hit = hybrid.ranked.find(r => r.entry.id === 'metric:churn_forecast')!;
    expect(hit, JSON.stringify(hybrid.ranked.map(r => [r.entry.id, r.reasons.map(x => x.lane)]))).toBeDefined();
    expect(hit.reasons.map(r => r.lane)).toContain('vector');
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'queued']); // 缺的那一个入队补算
  });

  it('catalog_search 按租户 hybrid_search 开关走混合 / 原有路径（MCP 是同一入口，开关同样作用）：关着时排到的条目与不传 hybrid 的 rankedSearch 一致、不发 embedding 请求；打开后向量一路生效', async () => {
    const { acme, c, received, analyst } = await hybridReady();
    const callsBefore = received.length;

    // 开关关着（列默认 false）：输出就是关键词一路——排到的条目 id 顺序与直接 rankedSearch 不传 hybrid 时一致，不发 embedding 请求、不含只靠向量命中的条目
    const plain = await rankedSearch(acme, 'full', c, QUERY, { memberSpaceId: analyst.space.id });
    const off = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(off).not.toContain('churn_forecast');
    expect(off).not.toContain(MARK);
    expect(off).not.toContain('vector_fallback'); // 开关关着（没走向量一路）就没有这一行
    expect(off.startsWith('ambiguous: ')).toBe(true);
    expect([...off.matchAll(/^## (\S+)/gm)].map(m => m[1])).toEqual(plain.ranked.map(r => r.entry.id));
    expect(received.length).toBe(callsBefore);

    // 打开同一租户的开关（直接改库即可，审计与权限已由 #431 的 ops 测试覆盖）：同一查询走混合，多一条查询 embedding 请求、只靠向量命中的条目带「语义」理由进结果
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    const on = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(on).toContain('churn_forecast');
    expect(on).toContain('语义');
    expect(on).not.toContain('vector_fallback'); // 向量一路正常时也没有这一行
    expect(received.slice(callsBefore).map(r => r.body.input)).toEqual([[QUERY]]);
  });

  it('catalog_search 打开混合检索但向量一路没用上时，输出在 ambiguous 后紧跟一行 vector_fallback 原因（结果只来自关键词）', async () => {
    const { acme, analyst } = await hybridReady();
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    setLlmFetch(async () => new Response('server exploded', { status: 500 })); // 照上面 5xx 的写法：查询 embedding 失败
    const out = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(out.split('\n\n')[1]).toBe('vector_fallback: embed_failed');
    expect(out).not.toContain(MARK); // 向量一路没生效：只靠向量命中的条目不在结果里
  });

  it('补算的批量 embedding 请求返回 400：记下 embedding_fill_error（不含 Key）、10 分钟内检索不再发补算请求（ensureEmbeddings 返回 backoff）、catalog_search 输出 not_ready；过了退避期换好端点后补算成功、错误清空、向量一路恢复（#1172）', async () => {
    const { acme, analyst } = await hybridReady();
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    await tenantEmbedding(acme, 'bge-m3'); // 当前模型下一个向量都没有
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 查询 embedding（1 条输入）正常，补算的批量请求（多于 1 条）一律 400
    const { received } = fakeLlm(setLlmFetch, (_n, body: LlmBody) => body.input.length > 1
      ? new Response('{"error":{"message":"batch size is invalid, it should not be larger than 10"}}', { status: 400 })
      : embeddings(body.input.map((t: string) => vec(t))));
    const batches = () => received.filter(r => r.body.input.length > 1).length;
    const fill = async () => (await getDb().select({ error: modelProviders.embeddingFillError, at: modelProviders.embeddingFillAt })
      .from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0]!;

    expect((await runTool(analyst, 'catalog_search', { query: QUERY })).split('\n\n')[1]).toBe('vector_fallback: not_ready');
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'queued']); // 照样入队
    await drain();
    expect(batches()).toBe(1); // 第一批就失败，后面的批次不再发
    const failed = await fill();
    expect(failed.error).toContain('HTTP 400');
    expect(failed.error).not.toContain('sk-tenant-embed-secret');
    expect(failed.at).toBeInstanceOf(Date);

    // 退避期内：检索两次都不入队、不发补算请求，输出仍是 not_ready
    for (let i = 0; i < 2; i++) {
      expect((await runTool(analyst, 'catalog_search', { query: QUERY })).split('\n\n')[1]).toBe('vector_fallback: not_ready');
    }
    expect(await ensureEmbeddings(acme)).toBe('backoff');
    await drain();
    expect(batches()).toBe(1);
    expect(await embedTasks(acme)).toHaveLength(2);

    // 过了退避期、端点修好：检索照常入队，drain 后补算成功，错误清空、时间更新，向量一路恢复
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + EMBED_FILL_BACKOFF_MS + 60_000);
    fakeLlm(setLlmFetch, (_n, body: LlmBody) => embeddings(body.input.map((t: string) => vec(t))));
    expect((await runTool(analyst, 'catalog_search', { query: QUERY })).split('\n\n')[1]).toBe('vector_fallback: not_ready');
    expect(await embedTasks(acme)).toHaveLength(3);
    await drain();
    const ok = await fill();
    expect(ok.error).toBeNull();
    expect(ok.at!.getTime()).toBeGreaterThan(failed.at!.getTime());
    const restored = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(restored).not.toContain('vector_fallback');
    expect(restored).toContain('churn_forecast');
  });
});

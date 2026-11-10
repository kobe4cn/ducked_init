// test/pipeline/catalog-hybrid.test.ts —— 混合检索（ADR-0047、0049）的接缝：rankedSearch({ hybrid: true }) → vectorHits（查询 embedding + catalog_embeddings 缓存）→ rank 的向量一路；
// embedding 超时（短超时）、5xx 或没配置时只去掉向量这一路（fallback 仍为 false、结果与关键词检索逐项相同）；换模型后缺向量的条目只走关键词并入队补算，drain 后向量一路恢复；
// catalog_search（内部与 MCP 同一入口）按租户 hybrid_search 开关决定是否走混合（#432）；
// hybridReady 断言向量缓存齐全，缺了就在报错里列出诊断（#610）
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '../../app/.server/assistant/tools';
import { ensureEmbeddings, QUERY_EMBED_TIMEOUT_MS } from '../../app/.server/catalog/embeddings';
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
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
  await getDb().insert(modelProviders).values({
    tenantId, embeddingBaseUrl: 'https://tenant-embed.example.com/v1', embeddingModel: model,
    embeddingApiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-embed-secret' }),
  });
}

describe('混合检索', () => {
  it('缓存齐全时 hybrid: true 把向量一路融合进结果（只靠向量命中的条目能进结果、理由带 lane: vector），fallback: false；不传 hybrid 不发 embedding 请求、结果不含该条目', async () => {
    const { acme, c, received } = await hybridReady();
    // 前置：查询的词没有一个出现在目标指标的检索文字里，它只可能靠向量命中
    const text = haystack(c.entries.find(e => e.id === 'metric:churn_forecast')!);
    expect(terms(QUERY).every(w => !text.includes(w))).toBe(true);
    const callsBefore = received.length;

    const plain = await rankedSearch(acme, 'full', c, QUERY, {});
    expect(plain.fallback).toBe(false);
    expect(plain.ranked.length).toBeGreaterThan(0); // 关键词一路有别的候选（流失风险的模板条目）
    expect(plain.ranked.map(r => r.entry.id)).not.toContain('metric:churn_forecast');
    expect(received.length).toBe(callsBefore); // 不传 hybrid 不发 embedding 请求

    const hybrid = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(hybrid.fallback).toBe(false);
    const hit = hybrid.ranked.find(r => r.entry.id === 'metric:churn_forecast')!;
    expect(hit, JSON.stringify(hybrid.ranked.map(r => [r.entry.id, r.reasons.map(x => x.lane)]))).toBeDefined();
    expect(hit.reasons).toContainEqual({ lane: 'vector', matched: ['1.00'] });
    expect(received.slice(callsBefore).map(r => r.body.input)).toEqual([[QUERY]]); // 只为查询算一次向量

    // 查询的调用日志只记条数与 token，不含查询文本；缓存齐了不再入队补算
    const queryLogs = (await getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, acme))).filter(l => l.inputCount === 1);
    expect(queryLogs.map(l => ({ purpose: l.purpose, model: l.model, promptTokens: l.promptTokens, error: l.error })))
      .toEqual([{ purpose: 'embedding', model: 'text-embedding-v3', promptTokens: 3, error: null }]);
    expect(JSON.stringify(queryLogs)).not.toContain(QUERY);
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded']);
  });

  it('embedding 超时（按 QUERY_EMBED_TIMEOUT_MS 短超时）、5xx 或没配置时，hybrid: true 的结果与不传的逐项相同、fallback: false，查询文本不进日志', async () => {
    const { acme, c } = await hybridReady();
    const plain = await rankedSearch(acme, 'full', c, QUERY, {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 超时：永不 resolve、但遵守 abort 的 fetch，按短超时中断而不是 60 秒
    setLlmFetch((_url, init) => new Promise((_resolve, reject) =>
      init?.signal?.addEventListener('abort', function aborted(this: AbortSignal) { reject(this.reason); })));
    const started = Date.now();
    expect(await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true })).toEqual(plain);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(warn).toHaveBeenCalledTimes(1);

    // 5xx
    setLlmFetch(async () => new Response('server exploded', { status: 500 }));
    expect(await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true })).toEqual(plain);
    expect(warn).toHaveBeenCalledTimes(2);

    // 没配置（租户与平台都没有）：不发请求、不算错误
    let called = false;
    setLlmFetch(async () => { called = true; throw new TypeError('fetch failed'); });
    vi.unstubAllEnvs();
    expect(await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true })).toEqual(plain);
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

  it('换模型后、补算完成前 hybrid: true 仍正常返回：缺向量的条目只走关键词并入队一个 catalog.embed（重复检索不重复入队）；drain 后再检索向量一路恢复', async () => {
    const { acme, c } = await hybridReady();
    await tenantEmbedding(acme, 'bge-m3'); // 缓存里的行都是旧模型的，当前模型一个都命中不了
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const degraded = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(degraded.fallback).toBe(false);
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

  it('catalog_search 按租户 hybrid_search 开关走混合 / 原有路径（MCP 是同一入口，开关同样作用）：关着时排到的条目与不传 hybrid 的 rankedSearch 一致、不发 embedding 请求；打开后向量一路生效', async () => {
    const { acme, c, received, analyst } = await hybridReady();
    const callsBefore = received.length;

    // 开关关着（列默认 false）：输出就是关键词一路——排到的条目 id 顺序与直接 rankedSearch 不传 hybrid 时一致，不发 embedding 请求、不含只靠向量命中的条目
    const plain = await rankedSearch(acme, 'full', c, QUERY, { memberSpaceId: analyst.space.id });
    const off = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(off).not.toContain('churn_forecast');
    expect(off).not.toContain(MARK);
    expect(off.startsWith('ambiguous: ')).toBe(true);
    expect([...off.matchAll(/^## (\S+)/gm)].map(m => m[1])).toEqual(plain.ranked.map(r => r.entry.id));
    expect(received.length).toBe(callsBefore);

    // 打开同一租户的开关（直接改库即可，审计与权限已由 #431 的 ops 测试覆盖）：同一查询走混合，多一条查询 embedding 请求、只靠向量命中的条目带「语义」理由进结果
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    const on = await runTool(analyst, 'catalog_search', { query: QUERY });
    expect(on).toContain('churn_forecast');
    expect(on).toContain('语义');
    expect(received.slice(callsBefore).map(r => r.body.input)).toEqual([[QUERY]]);
  });
});

// test/pipeline/catalog-vector-store-switch.test.ts —— 补算与混合检索走租户选定的向量存储（ADR-0058，#849-1）：
// 从「系统自带」切到外部 pgvector 后平台表本租户的行清空、入队 catalog.embed 从零补算，drain 后向量都在外部库、hybrid 只靠向量命中的条目带 lane: vector；
// 切回「系统自带」外部库的行保留不删、平台表补齐；换连接串同样入队补算；补算连不上外部库时抹掉凭据的错误写进 vector_store_error，混合检索只去掉向量一路、不落进整体回退
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureEmbeddings, fillEmbeddings } from '../../app/.server/catalog/embeddings';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { rankedSearch, refreshProjection } from '../../app/.server/catalog/projection';
import { closePgvectorPools, pgvectorStore, preparePgvector, setPgvectorConnect } from '../../app/.server/catalog/vector-store-pgvector';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogEmbeddings, catalogProjection, modelProviders, tasks } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { setLlmFetch } from '../../app/.server/llm';
import { saveVectorStore } from '../../app/.server/model-provider';
import { encryptForTenant } from '../../app/.server/secrets';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant } from './fixtures';
import { embeddings, fakeLlm, platformEmbedding, type LlmBody } from './llm-fixtures';

/** 平台默认 embedding 的模型（platformEmbedding 设的） */
const MODEL = 'text-embedding-v3';

/** 只靠向量命中的查询；MARK 只出现在目标指标的说明里——关键词分不出它们，假向量让两者同向、其余正交（照 catalog-hybrid.test.ts） */
const QUERY = '顾客流失风险';
const MARK = '不再复购';
const CHURN = `base: order\nmeasure: { agg: count }\ndescription: 未来 90 天内${MARK}的倾向打分\n`;
const vec = (t: string): number[] => t === QUERY || t.includes(MARK) ? [1, 0] : [0, 1];

/** 该租户的 catalog.embed 任务 */
const embedTasks = (tenantId: string) =>
  getDb().select({ status: tasks.status }).from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed')));

/** 平台表 catalog_embeddings 里本租户在当前模型下的文本哈希 */
async function platformHashes(tenantId: string): Promise<Set<string>> {
  const rows = await getDb().select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, MODEL)));
  return new Set(rows.map(r => r.textHash));
}

/** 该租户两类投影里不同的文本哈希（补算应该覆盖的全部） */
async function projectionHashes(tenantId: string): Promise<string[]> {
  const rows = await getDb().selectDistinct({ textHash: catalogProjection.textHash }).from(catalogProjection)
    .where(eq(catalogProjection.tenantId, tenantId));
  return rows.map(r => r.textHash);
}

/** 本租户的 model_providers 行 */
const providerRow = async (tenantId: string) =>
  (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId)))[0]!;

afterAll(async () => { await closePgvectorPools(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); setPgvectorConnect(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** 开通租户、发布只靠向量命中的指标、建投影、配平台 embedding 与假向量（缓存的去向由每个用例自己切换），读出调用方的目录 */
async function vectorReady() {
  const acme = await newTenant('acme');
  const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
  const reviewer = await memberOf(acme, 'rv@acme.com', 'data_engineer');
  const admin = await memberOf(acme, 'admin@acme.com', 'admin');
  await createDefinition(analyst, 'metric', 'churn_forecast', CHURN);
  await publishDefinition(reviewer, 'metric', 'churn_forecast', 1);
  await refreshProjection(acme);
  platformEmbedding();
  fakeLlm(setLlmFetch, (_n, body: LlmBody) => embeddings(body.input.map((t: string) => vec(t)), { prompt_tokens: 3 }));
  return { acme, admin, c: await tenantCatalog(acme) };
}

describe.skipIf(!process.env.TEST_PGVECTOR_URL)('补算与混合检索走外部 pgvector（TEST_PGVECTOR_URL）', () => {
  const url = process.env.TEST_PGVECTOR_URL!;
  const tenants = new Set<string>(); // resetDb 只清平台库：用到的租户在外部库的行由 afterEach 清掉（照 vector-store.test.ts）
  beforeAll(async () => {
    const prepared = await preparePgvector(url);
    if (!prepared.ok) throw new Error(prepared.error);
  });
  afterEach(async () => {
    await Promise.all([...tenants].map(tenantId => pgvectorStore(tenantId, url).clear()));
    tenants.clear();
  });

  it('从「系统自带」切到 pgvector：平台表本租户的行清空并入队补算；drain 后向量都在外部库，hybrid 只靠向量命中的条目带 lane: vector；补算成功后 vector_store_error 清掉', async () => {
    const { acme, admin, c } = await vectorReady();
    tenants.add(acme);
    // 起点：缓存在平台表里
    await ensureEmbeddings(acme);
    await drain();
    expect((await platformHashes(acme)).size).toBeGreaterThan(0);

    expect(await saveVectorStore(admin, { kind: 'pgvector', url })).toEqual({ ok: true });
    expect((await platformHashes(acme)).size).toBe(0); // 平台表本租户的行删掉（ADR-0058）
    expect((await embedTasks(acme)).filter(t => t.status === 'queued')).toHaveLength(1); // 入队从零补算

    await drain();
    const external = await pgvectorStore(acme, url).hashes(MODEL);
    expect((await projectionHashes(acme)).filter(h => !external.has(h))).toEqual([]); // 外部库覆盖全部投影哈希

    // hybrid 用外部库的 topN 取相似条目：目标指标只靠向量进结果，不传 hybrid 进不了
    const plain = await rankedSearch(acme, 'full', c, QUERY, {}, 20);
    expect(plain.ranked.map(r => r.entry.id)).not.toContain('metric:churn_forecast');
    const hybrid = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(hybrid.fallback).toBe(false);
    const hit = hybrid.ranked.find(r => r.entry.id === 'metric:churn_forecast')!;
    expect(hit, JSON.stringify(hybrid.ranked.map(r => [r.entry.id, r.reasons.map(x => x.lane)]))).toBeDefined();
    expect(hit.reasons).toContainEqual({ lane: 'vector', matched: ['1.00'] });

    // 补算成功时清掉 vector_store_error：先写一个旧错误，再直接跑一次补算（没有缺的向量，只走 store 的读删）
    await getDb().update(modelProviders).set({ vectorStoreError: '旧错误' }).where(eq(modelProviders.tenantId, acme));
    await fillEmbeddings(acme);
    expect((await providerRow(acme)).vectorStoreError).toBeNull();
  });

  it('从 pgvector 切回「系统自带」：外部库的行保留不删，平台表入队补齐', async () => {
    const { acme, admin } = await vectorReady();
    tenants.add(acme);
    await saveVectorStore(admin, { kind: 'pgvector', url });
    await drain();
    const externalBefore = await pgvectorStore(acme, url).hashes(MODEL);
    expect(externalBefore.size).toBeGreaterThan(0);

    expect(await saveVectorStore(admin, { kind: 'platform', url: '' })).toEqual({ ok: true });
    expect((await embedTasks(acme)).filter(t => t.status === 'queued')).toHaveLength(1);
    await drain();
    // 外部库的行还在（租户自己的库不替它删），平台表补齐
    expect(await pgvectorStore(acme, url).hashes(MODEL)).toEqual(externalBefore);
    const platform = await platformHashes(acme);
    expect((await projectionHashes(acme)).filter(h => !platform.has(h))).toEqual([]);
  });

  it('换外部库连接串（urlRotated）：新库是空的时同样入队补算', async () => {
    const { acme, admin } = await vectorReady();
    tenants.add(acme);
    await saveVectorStore(admin, { kind: 'pgvector', url });
    await drain();
    await pgvectorStore(acme, url).clear(); // 模拟换到的新库还没向量
    // 同一台库、不同的连接串（多一个连接参数）：对 saveVectorStore 来说就是换了连接串
    const rotated = `${url}${url.includes('?') ? '&' : '?'}application_name=vector_switch_test`;

    expect(await saveVectorStore(admin, { kind: 'pgvector', url: rotated })).toEqual({ ok: true });
    expect((await embedTasks(acme)).filter(t => t.status === 'queued')).toHaveLength(1);
    await drain();
    const external = await pgvectorStore(acme, rotated).hashes(MODEL);
    expect((await projectionHashes(acme)).filter(h => !external.has(h))).toEqual([]);
  });
});

describe('补算与混合检索连不上外部库（pgvector 替身）', () => {
  // 连接串带百分号编码的凭据：错误信息抹掉时原文与编码形式都不能有（照 vector-store.test.ts 的用例）
  const url = 'postgres://us%40r:p%40ss%2Fw@h:1/x';

  /** 在库里直接写上「选了 pgvector」与加密的连接串（不走 saveVectorStore：它先测连通，连不上就不让保存） */
  async function tenantOnBrokenStore() {
    const ready = await vectorReady();
    const sealed = await encryptForTenant(ready.acme, 'vector_store', { url });
    await getDb().insert(modelProviders).values({ tenantId: ready.acme, vectorStore: 'pgvector', vectorStoreUrl: sealed })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { vectorStore: 'pgvector', vectorStoreUrl: sealed } });
    return ready;
  }

  it('fillEmbeddings rejects，vector_store_error 写上错误：不含用户名、密码的原文与编码形式，也不含整串连接串', async () => {
    const { acme } = await tenantOnBrokenStore();
    setPgvectorConnect(() => ({
      query: () => Promise.reject(new Error(`password authentication failed for user "us@r" (p@ss/w) ${url}`)),
    }));
    await expect(fillEmbeddings(acme)).rejects.toThrow('password authentication failed');
    const error = (await providerRow(acme)).vectorStoreError;
    expect(error).toContain('补算写入外部向量库失败');
    for (const secret of ['p@ss/w', 'p%40ss%2Fw', 'us@r', 'us%40r', url]) expect(error).not.toContain(secret);
  });

  it('混合检索连不上外部库：ranked 与不传 hybrid 逐项相同、fallback: false、vectorFallback: store_unreachable，不抛错，warn 里也不带连接串', async () => {
    const { acme, c } = await tenantOnBrokenStore();
    const plain = await rankedSearch(acme, 'full', c, QUERY, {}, 20);
    setPgvectorConnect(() => ({ query: () => Promise.reject(new Error(`connect failed ${url}`)) }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hybrid = await rankedSearch(acme, 'full', c, QUERY, {}, 20, { hybrid: true });
    expect(hybrid.ranked).toEqual(plain.ranked);
    expect(hybrid.fallback).toBe(false);
    expect(hybrid.vectorFallback).toBe('store_unreachable');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(url);
  });
});

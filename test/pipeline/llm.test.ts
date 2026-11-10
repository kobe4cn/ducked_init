// test/pipeline/llm.test.ts —— 模型服务客户端（ADR-0035）：按租户配置 > 平台默认（环境变量）解析端点，chatJson → 注入的假 fetch → platform.llm_calls 的调用日志；
// embedding 端点（ADR-0049）：租户 embedding 三项 > 平台 LLM_EMBEDDING_*（与 chat 互不影响），都没配置时 embed 返回 null；
// tableContextFor：采集统计 + 允许时原始层的脱敏样本行
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { llmCalls, modelProviders } from '../../app/.server/db/schema';
import { chatJson, embed, LlmError, MODEL_PROVIDER_CONTEXT, resolveEmbeddingProvider, resolveProvider, resolveRoute, setLlmFetch } from '../../app/.server/llm';
import { tableContextFor } from '../../app/.server/model-provider';
import { encryptForTenant } from '../../app/.server/secrets';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, selectAllTables } from './fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, platformTier } from './llm-fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

const SCHEMA = { type: 'object', required: ['table'], properties: { table: { type: 'string' } } };
const MESSAGES = [
  { role: 'system' as const, content: '你是映射助手' },
  { role: 'user' as const, content: '样本行：13800138000' },
];

/** 平台默认端点带尾 /，拼出的 URL 不应出现 // */
const BASE_WITH_SLASH = 'https://platform.example.com/v1/';
/** 答复带的 token 数，记进 llm_calls */
const USAGE = { prompt_tokens: 120, completion_tokens: 30 };

/** 档位列（tenantProvider 的第二个参数）：model 必填；要换端点时 baseUrl 与 apiKey 一起给，Key 明文进来、插库前加密 */
interface TierCols { model: string; baseUrl?: string; apiKey?: string }

async function tenantProvider(tenantId: string, tiers: { fast?: TierCols; reasoning?: TierCols } = {}) {
  const tier = (t: 'fast' | 'reasoning') => ({ model: tiers[t]?.model ?? null, baseUrl: tiers[t]?.baseUrl ?? null, apiKey: tiers[t]?.apiKey ?? null });
  const fast = tier('fast'), reasoning = tier('reasoning');
  const seal = (k: string | null) => k ? encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: k }) : null;
  await getDb().insert(modelProviders).values({
    tenantId, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat',
    apiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-secret' }),
    fastModel: fast.model, fastBaseUrl: fast.baseUrl, fastApiKey: await seal(fast.apiKey),
    reasoningModel: reasoning.model, reasoningBaseUrl: reasoning.baseUrl, reasoningApiKey: await seal(reasoning.apiKey),
  });
}

/** 调用应当失败：返回抛出的错误 */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as Error);

const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));

describe('模型服务客户端', () => {
  it('只有环境变量时用平台默认', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    expect(await resolveProvider(acme)).toMatchObject({ source: 'platform', model: 'qwen-plus' });
    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('https://platform.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-platform-secret');
    expect(received[0].body).toEqual({ model: 'qwen-plus', messages: MESSAGES, response_format: { type: 'json_object' }, temperature: 0 });
  });

  it('租户有自己的配置时整套用租户的，库里不存 Key 明文', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    await tenantProvider(acme);
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'connectivity', MESSAGES, SCHEMA);
    expect(received[0].url).toBe('https://tenant.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-secret');
    expect(received[0].body.model).toBe('deepseek-chat');
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row.apiKey).not.toContain('sk-tenant-secret');
    expect(await resolveProvider(acme)).toMatchObject({ source: 'tenant', model: 'deepseek-chat' });
  });

  it('租户与平台都没有配置时报错且不发请求', async () => {
    const acme = await newTenant('acme');
    vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');   // 只配了一部分不算
    const { f } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    expect(await resolveProvider(acme)).toBeNull();
    await expect(chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).rejects.toThrow(/未配置模型服务/);
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
  });

  it('返回不合 Schema 时记 schemaValid=false 并抛错', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => json({ tabel: 'orders' }, USAGE));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/不符合.*table/);
    const [row] = await calls(acme);
    expect(row).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-plus', schemaValid: false, promptTokens: 120, completionTokens: 30 });
    expect(row.error).toMatch(/table/);
  });

  it('HTTP 500 时记 error，消息里没有 Key', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => new Response(`upstream failed for key sk-platform-secret ${'x'.repeat(500)}`, { status: 500 }));

    const err = await failure(chatJson(acme, 'connectivity', MESSAGES, SCHEMA));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toContain('sk-platform-secret');
    expect(err.message.length).toBeLessThan(300);
    const [row] = await calls(acme);
    expect(row.schemaValid).toBeNull();
    expect(row.error).toMatch(/500/);
    expect(row.error).not.toContain('sk-platform-secret');
  });

  it('成功时记令牌数与耗时，日志里没有提示词与返回原文', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => json({ table: '13900139000' }, { prompt_tokens: 200, completion_tokens: 50 }));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);
    const rows = await calls(acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-plus', promptTokens: 200, completionTokens: 50, schemaValid: true, error: null });
    // 档位与回落原因（ADR-0055）：mapping_draft 属 reasoning 档，没配档位时记 unbound
    expect(rows[0].route).toBe('reasoning');
    expect(rows[0].fallbackReason).toBe('unbound');
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain('13800138000');
    expect(logged).not.toContain('13900139000');
  });
});

describe('按用途选档位（ADR-0055）', () => {
  it('没配任何档位时请求与现在完全一样，日志 route 记档位、fallbackReason=unbound，不分档的用途为 null', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformEmbedding();
    // chat 与 embedding 都走同一个假 fetch：按请求体有没有 input 分流答复
    const { received } = fakeLlm(setLlmFetch, (n, body) => (body.input ? embeddings([[0.5]]) : json({ table: 'orders' }, USAGE)));

    await chatJson(acme, 'metric_draft', MESSAGES, SCHEMA);
    await chatJson(acme, 'assertion_draft', MESSAGES, SCHEMA);
    await chatJson(acme, 'connectivity', MESSAGES, SCHEMA);
    await embed(acme, ['成交额']);

    expect(received).toHaveLength(4);
    for (const r of received.slice(0, 3)) {
      expect(r.url).toBe('https://platform.example.com/v1/chat/completions');
      expect(r.headers.get('authorization')).toBe('Bearer sk-platform-secret');
      expect(r.body.model).toBe('qwen-plus');
    }
    const rows = await calls(acme);
    expect(rows.map(r => [r.purpose, r.route, r.fallbackReason])).toEqual([
      ['metric_draft', 'reasoning', 'unbound'],
      ['assertion_draft', 'fast', 'unbound'],
      ['connectivity', null, null],
      ['embedding', null, null],
    ]);
  });

  it('平台只填 LLM_REASONING_MODEL 时 reasoning 用途换模型、复用默认端点与 Key，fast 用途照旧用默认模型', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);
    await chatJson(acme, 'metric_parse', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://platform.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-platform-secret');
    expect(received[0].body.model).toBe('qwen-max');
    expect(received[1].body.model).toBe('qwen-plus');
    const rows = await calls(acme);
    expect(rows[0]).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-max', route: 'reasoning', fallbackReason: null });
    expect(rows[1]).toMatchObject({ purpose: 'metric_parse', model: 'qwen-plus', route: 'fast', fallbackReason: 'unbound' });
  });

  it('档位的 BASE_URL 与 API_KEY 一起填时整套用档位自己的端点与 Key', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max', { baseUrl: 'https://reasoning.example.com/v1', apiKey: 'sk-reasoning-secret' });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://reasoning.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-reasoning-secret');
    expect(received[0].body.model).toBe('qwen-max');
    expect((await calls(acme))[0]).toMatchObject({ model: 'qwen-max', route: 'reasoning', fallbackReason: null });
  });

  it('BASE_URL 与 API_KEY 只填一个时按没绑定处理：默认 Key 不发到档位端点，console.warn，记 unbound', async () => {
    const acme = await newTenant('acme');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max', { baseUrl: 'https://reasoning.example.com/v1' });   // 只填了 BASE_URL
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://platform.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-platform-secret');
    expect(received[0].body.model).toBe('qwen-plus');
    expect((await calls(acme))[0]).toMatchObject({ model: 'qwen-plus', route: 'reasoning', fallbackReason: 'unbound' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('LLM_REASONING');
    warn.mockRestore();
  });

  it('租户整套自配时平台档位不生效：请求租户的端点与模型，记 unbound', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');
    await tenantProvider(acme);
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://tenant.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-secret');
    expect(received[0].body.model).toBe('deepseek-chat');
    expect((await calls(acme))[0]).toMatchObject({ model: 'deepseek-chat', route: 'reasoning', fallbackReason: 'unbound' });
  });

  it('租户 reasoning 档只填模型名时：端点与 Key 沿用租户默认、模型换档位的，不分档的用途照旧，平台档位不生效', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');   // 平台的档位不作用于租户
    await tenantProvider(acme, { reasoning: { model: 'deepseek-reasoner' } });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);
    await chatJson(acme, 'connectivity', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://tenant.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-secret');
    expect(received[0].body.model).toBe('deepseek-reasoner');
    expect(received[1].url).toBe('https://tenant.example.com/v1/chat/completions');   // connectivity 不分档，照旧租户默认
    expect(received[1].body.model).toBe('deepseek-chat');
    const rows = await calls(acme);
    expect(rows[0]).toMatchObject({ model: 'deepseek-reasoner', route: 'reasoning', fallbackReason: null });
    expect(rows[1]).toMatchObject({ model: 'deepseek-chat', route: null, fallbackReason: null });
  });

  it('租户 reasoning 档带自己的端点与 Key 时：整套用档位自己的端点与 Key，不发租户默认的 Key', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    await tenantProvider(acme, { reasoning: { model: 'deepseek-reasoner', baseUrl: 'https://tenant-reasoning.example.com/v1', apiKey: 'sk-tenant-reasoning-secret' } });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://tenant-reasoning.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-reasoning-secret');
    expect(received[0].body.model).toBe('deepseek-reasoner');
    expect((await calls(acme))[0]).toMatchObject({ model: 'deepseek-reasoner', route: 'reasoning', fallbackReason: null });
  });

  it('租户只绑了 fast 档时：reasoning 用途仍用租户默认并记 unbound，fast 用途用 fast 档的模型', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    await tenantProvider(acme, { fast: { model: 'deepseek-chat-fast' } });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);
    await chatJson(acme, 'metric_parse', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://tenant.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-secret');
    expect(received[0].body.model).toBe('deepseek-chat');
    expect(received[1].body.model).toBe('deepseek-chat-fast');
    const rows = await calls(acme);
    expect(rows[0]).toMatchObject({ model: 'deepseek-chat', route: 'reasoning', fallbackReason: 'unbound' });
    expect(rows[1]).toMatchObject({ model: 'deepseek-chat-fast', route: 'fast', fallbackReason: null });
  });

  it('租户档位有端点但没有 Key（保存校验不允许，脏数据）时按没绑定处理：默认 Key 不发到档位端点，console.warn，记 unbound', async () => {
    const acme = await newTenant('acme');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    platformDefault(BASE_WITH_SLASH);
    await getDb().insert(modelProviders).values({
      tenantId: acme, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat',
      apiKey: await encryptForTenant(acme, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-secret' }),
      reasoningModel: 'deepseek-reasoner', reasoningBaseUrl: 'https://tenant-reasoning.example.com/v1',   // 只有端点没有 Key
    });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://tenant.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-secret');
    expect(received[0].body.model).toBe('deepseek-chat');
    expect((await calls(acme))[0]).toMatchObject({ model: 'deepseek-chat', route: 'reasoning', fallbackReason: 'unbound' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('reasoning');
    warn.mockRestore();
  });

  it('平台来源的租户：库里留着档位列也不生效，照旧走 LLM_<TIER>_*，不出现租户档位的模型或 Key', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');
    // 只插档位列、chat 三项为空：providerSource 为 platform，档位列不生效
    await getDb().insert(modelProviders).values({
      tenantId: acme, reasoningModel: 'deepseek-reasoner', reasoningBaseUrl: 'https://tenant-reasoning.example.com/v1',
      reasoningApiKey: await encryptForTenant(acme, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-reasoning-secret' }),
    });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);

    expect(received[0].url).toBe('https://platform.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-platform-secret');
    expect(received[0].body.model).toBe('qwen-max');
    expect((await calls(acme))[0]).toMatchObject({ model: 'qwen-max', route: 'reasoning', fallbackReason: null });
    const logged = JSON.stringify(received);
    expect(logged).not.toContain('deepseek-reasoner');
    expect(logged).not.toContain('sk-tenant-reasoning-secret');
  });

  it('配了档位、返回 500 或 429 时只发一次请求，抛 transient 的 LlmError，不换模型不重试', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');
    for (const status of [500, 429]) {
      const { f, received } = fakeLlm(setLlmFetch, () => new Response('upstream failed', { status }));

      const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)) as LlmError;
      expect(err).toBeInstanceOf(LlmError);
      expect(err.transient).toBe(true);
      expect(err.message).toMatch(new RegExp(String(status)));
      expect(f).toHaveBeenCalledTimes(1);
      expect(received[0].body.model).toBe('qwen-max');
      const rows = await calls(acme);
      expect(rows.at(-1)).toMatchObject({ model: 'qwen-max', route: 'reasoning', fallbackReason: null, error: expect.stringMatching(new RegExp(String(status))) });
    }
  });

  it('平台默认三项不全时就算配了档位也报「未配置模型服务」，不发请求、不记日志', async () => {
    const acme = await newTenant('acme');
    vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');   // 只配了一部分不算
    platformTier('reasoning', 'qwen-max');
    const { f } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    expect(await resolveRoute(acme, 'mapping_draft')).toBeNull();
    await expect(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)).rejects.toThrow(/未配置模型服务/);
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
  });
});

describe('embedding 端点', () => {
  /** 租户自己的 embedding 三项（chat 三列为空），Key 用与 chat 相同的 context 加密 */
  async function tenantEmbedding(tenantId: string) {
    await getDb().insert(modelProviders).values({
      tenantId, embeddingBaseUrl: 'https://tenant-embed.example.com/v1', embeddingModel: 'bge-m3',
      embeddingApiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-embed-secret' }),
    });
  }

  it('只设平台环境变量时请求平台的 /embeddings，按输入顺序返回向量', async () => {
    const acme = await newTenant('acme');
    platformEmbedding('https://embed.example.com/v1/');   // 带尾 /，拼出的 URL 不应出现 //
    // 返回的 data 乱序（index 1 在前），embed 要按 index 排回输入顺序
    const { received } = fakeLlm(setLlmFetch, () => Response.json({
      data: [{ index: 1, embedding: [0.25] }, { index: 0, embedding: [0.125] }], usage: { prompt_tokens: 9 },
    }));

    expect(await resolveEmbeddingProvider(acme)).toMatchObject({ source: 'platform', model: 'text-embedding-v3' });
    expect(await embed(acme, ['成交额', '复购率'])).toEqual([[0.125], [0.25]]);
    expect(received[0].url).toBe('https://embed.example.com/v1/embeddings');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-embed-secret');
    expect(received[0].body).toEqual({ model: 'text-embedding-v3', input: ['成交额', '复购率'] });
  });

  it('租户只配了 chat 时 embedding 仍用平台的', async () => {
    const acme = await newTenant('acme');
    platformEmbedding();
    await tenantProvider(acme);
    const { received } = fakeLlm(setLlmFetch, () => embeddings([[0.5]]));

    expect(await resolveEmbeddingProvider(acme)).toMatchObject({ source: 'platform', model: 'text-embedding-v3' });
    await embed(acme, ['成交额']);
    expect(received[0].url).toBe('https://embed.example.com/v1/embeddings');
  });

  it('租户配了 embedding 三项时整套用租户的，库里不存 Key 明文', async () => {
    const acme = await newTenant('acme');
    platformEmbedding();
    await tenantEmbedding(acme);
    const { received } = fakeLlm(setLlmFetch, () => embeddings([[0.75, 0.125]]));

    expect(await resolveEmbeddingProvider(acme)).toMatchObject({ source: 'tenant', model: 'bge-m3' });
    expect(await embed(acme, ['客户数'])).toEqual([[0.75, 0.125]]);
    expect(received[0].url).toBe('https://tenant-embed.example.com/v1/embeddings');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-tenant-embed-secret');
    expect(received[0].body.model).toBe('bge-m3');
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row.embeddingApiKey).not.toContain('sk-tenant-embed-secret');
  });

  it('两边都没配置时返回 null，不发请求、不写 llm_calls（chat 的配置不算数）', async () => {
    const acme = await newTenant('acme');
    platformDefault();   // chat 的平台默认在，embedding 不受影响
    vi.stubEnv('LLM_EMBEDDING_BASE_URL', 'https://embed.example.com/v1');   // 只配了一部分不算
    const { f } = fakeLlm(setLlmFetch, () => embeddings([[0.5]]));

    expect(await resolveEmbeddingProvider(acme)).toBeNull();
    expect(await embed(acme, ['成交额'])).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
  });

  it('成功时记 purpose=embedding、模型与条数、令牌数与耗时，日志里没有请求文本与向量', async () => {
    const acme = await newTenant('acme');
    platformEmbedding();
    fakeLlm(setLlmFetch, () => embeddings([[0.12345], [0.6789]], { prompt_tokens: 42 }));

    await embed(acme, ['成交额', '复购率']);
    const rows = await calls(acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'embedding', model: 'text-embedding-v3', inputCount: 2, promptTokens: 42,
      completionTokens: null, schemaValid: null, error: null,
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain('成交额');
    expect(logged).not.toContain('0.12345');
    expect(logged).not.toContain('0.6789');
  });

  it('超时、连不上、5xx、429 时抛 transient 的 LlmError（消息里没有 Key）并记带 error 的调用', async () => {
    const acme = await newTenant('acme');
    platformEmbedding();
    const cases: { respond: () => Response; message: RegExp }[] = [
      { respond: () => { throw new DOMException('signal timed out', 'TimeoutError'); }, message: /60 秒内没有返回/ },
      // 假 fetch 是 async，同步 throw 到它外面就是 rejected promise，与连不上同一条路
      { respond: () => { throw new TypeError('fetch failed'); }, message: /fetch failed/ },
      { respond: () => new Response(`upstream failed for key sk-embed-secret ${'x'.repeat(500)}`, { status: 500 }), message: /500/ },
      { respond: () => new Response('rate limited', { status: 429 }), message: /429/ },
    ];
    for (const c of cases) {
      fakeLlm(setLlmFetch, () => c.respond());
      const err = await failure(embed(acme, ['成交额'])) as LlmError;
      expect(err).toBeInstanceOf(LlmError);
      expect(err.transient).toBe(true);
      expect(err.message).toMatch(c.message);
      expect(err.message).not.toContain('sk-embed-secret');
      expect(err.message.length).toBeLessThan(300);
    }
    const rows = await calls(acme);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({ purpose: 'embedding', model: 'text-embedding-v3', promptTokens: null, completionTokens: null, schemaValid: null });
      expect(row.error).toBeTruthy();
      expect(row.error).not.toContain('sk-embed-secret');
    }
  });
});

/** 登记电商库、选入全部表并采集；synced 时确认 customers 的水位线并同步一次 */
async function profiledSource(synced: boolean) {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, id);
  await drain();
  if (synced) {
    await confirmWatermark(author, id, 'customers', 'updated_at');
    await syncSource(author, id);
    await drain();
  }
  return { acme, id };
}

const allowSamples = (tenantId: string) =>
  getDb().insert(modelProviders).values({ tenantId, allowSamples: true });

describe('给模型的表上下文', () => {
  it('默认只有表结构与列统计；打开发送样本后带 5 行，敏感列是哈希、没有平台列', async () => {
    const { acme, id } = await profiledSource(true);

    const plain = await tableContextFor(acme, id, 'customers');
    expect('samples' in plain).toBe(false);
    expect(plain).toMatchObject({ table: 'customers', rows: 40, primaryKey: ['customer_id'] });
    expect(plain.columns.map(c => c.name)).toEqual(['customer_id', 'name', 'email', 'phone', 'city', 'created_at', 'updated_at']);
    expect(plain.columns.find(c => c.name === 'email')!.top).toBeNull();

    await allowSamples(acme);
    const { samples } = await tableContextFor(acme, id, 'customers');
    expect(samples).toHaveLength(5);
    for (const r of samples!) {
      expect(Object.keys(r).sort()).toEqual(['city', 'created_at', 'customer_id', 'email', 'name', 'phone', 'updated_at']);
      for (const c of ['name', 'phone']) expect(String(r[c])).toMatch(/^[0-9a-f]{64}$/);
      if (r.email !== null) expect(String(r.email)).toMatch(/^[0-9a-f]{64}$/);
    }
    const sent = JSON.stringify(samples);
    expect(sent).not.toContain('@example.com');
    expect(sent).not.toContain('消费者');
    // 样本里其余列是 64 位十六进制哈希，会碰巧含有 138 加 8 位数字；只认前后不是十六进制字符的明文手机号
    expect(sent).not.toMatch(/(?<![0-9a-f])138\d{8}(?![0-9a-f])/);
  });

  it('打开发送样本但表还没同步时只有结构，不报错', async () => {
    const { acme, id } = await profiledSource(false);
    await allowSamples(acme);
    const context = await tableContextFor(acme, id, 'customers');
    expect('samples' in context).toBe(false);
    expect(context.rows).toBe(40);
  });
});

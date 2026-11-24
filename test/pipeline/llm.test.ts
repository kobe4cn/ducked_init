// test/pipeline/llm.test.ts —— 模型服务客户端（ADR-0035）：按租户配置 > 平台默认（环境变量）解析端点，chatJson → 注入的假 fetch → platform.llm_calls 的调用日志；
// callModel 容错（#1160）：可选键为 null（qwen-max）按没给处理（必填键为 null 仍不合格、Schema 允许 null 的原样保留）、输出截断（finish_reason: length）报截断原因、```json 代码块去外壳、minItems / maximum 等报中文；
// 解析加固（#1224）：开头的 <think>…</think> 先去掉再解析、JSON 前后带说明文字时取第一个完整对象（字符串里的 } 不截断），服务商没给工具调用 id 时本地生成互不相同的 id；
// LLM_CHAT_EXTRA（#952）：服务商参数合并进 chat 请求体（平台字段不被覆盖、档位 LLM_<TIER>_CHAT_EXTRA 覆盖默认），不是合法 JSON 对象时调用失败并记 error；
// 租户服务商参数（#1169）：租户默认 chat_extra 与档位的 fast_ / reasoning_chat_extra 进租户请求体（档位覆盖、只填模型名或带端点的档位继承默认），
// 平台 LLM_*CHAT_EXTRA 不串进租户请求体；saveModelProvider / saveTierProvider 拒绝非对象 JSON 与受保护键、审计只记 chatExtraChanged、reset 清列；
// LLM_TIMEOUT_SECONDS（#952）：控制 chat 超时与超时消息里的秒数，不是正整数时回落 60；
// embedding 端点（ADR-0049）：租户 embedding 三项 > 平台 LLM_EMBEDDING_*（与 chat 互不影响），都没配置时 embed 返回 null；
// tableContextFor：采集统计 + 允许时原始层的脱敏样本行
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, modelProviders } from '../../app/.server/db/schema';
import { chatJson, chatTools, embed, LlmError, MODEL_PROVIDER_CONTEXT, resolveEmbeddingProvider, resolveProvider, resolveRoute, setLlmFetch, setLlmSleep } from '../../app/.server/llm';
import { ModelProviderError, resetModelProvider, resetTierProvider, saveModelProvider, saveTierProvider, tableContextFor } from '../../app/.server/model-provider';
import { encryptForTenant } from '../../app/.server/secrets';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, selectAllTables } from './fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, platformTier, text, truncated } from './llm-fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
/** 重试前的等待（#1215）：记下毫秒数、不真等 */
let waits: number[] = [];
beforeEach(async () => { await resetDb(); waits = []; setLlmSleep(ms => { waits.push(ms); return Promise.resolve(); }); });
afterEach(() => { setLlmFetch(undefined); setLlmSleep(undefined); vi.unstubAllEnvs(); });

const SCHEMA = { type: 'object', required: ['table'], properties: { table: { type: 'string' } } };
/** chatJson 发出的 response_format：SCHEMA 以 json_schema 发出，name 是用途（#1191） */
const asSchema = (name: string) => ({ type: 'json_schema', json_schema: { name, schema: SCHEMA, strict: false } });
const MESSAGES = [
  { role: 'system' as const, content: '你是映射助手' },
  { role: 'user' as const, content: '样本行：13800138000' },
];

/** 平台默认端点带尾 /，拼出的 URL 不应出现 // */
const BASE_WITH_SLASH = 'https://platform.example.com/v1/';
/** 答复带的 token 数，记进 llm_calls */
const USAGE = { prompt_tokens: 120, completion_tokens: 30 };

/** 档位列（tenantProvider 的第二个参数）：model 必填；要换端点时 baseUrl 与 apiKey 一起给，Key 明文进来、插库前加密 */
interface TierCols { model: string; baseUrl?: string; apiKey?: string; chatExtra?: string }

async function tenantProvider(tenantId: string, tiers: { fast?: TierCols; reasoning?: TierCols; chatExtra?: string } = {}) {
  const tier = (t: 'fast' | 'reasoning') => ({ model: tiers[t]?.model ?? null, baseUrl: tiers[t]?.baseUrl ?? null, apiKey: tiers[t]?.apiKey ?? null });
  const fast = tier('fast'), reasoning = tier('reasoning');
  const seal = (k: string | null) => k ? encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: k }) : null;
  await getDb().insert(modelProviders).values({
    tenantId, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat',
    apiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-secret' }),
    fastModel: fast.model, fastBaseUrl: fast.baseUrl, fastApiKey: await seal(fast.apiKey),
    reasoningModel: reasoning.model, reasoningBaseUrl: reasoning.baseUrl, reasoningApiKey: await seal(reasoning.apiKey),
    chatExtra: tiers.chatExtra ?? null, fastChatExtra: tiers.fast?.chatExtra ?? null, reasoningChatExtra: tiers.reasoning?.chatExtra ?? null,
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
    expect(received[0].body).toEqual({ model: 'qwen-plus', messages: MESSAGES, response_format: asSchema('connectivity'), temperature: 0 });
    // 平台默认端点解析出的调用记 source='platform'（#843）
    const [row] = await calls(acme);
    expect(row.source).toBe('platform');
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
    // 租户端点的调用记 source='tenant'（#843）
    const [logged] = await calls(acme);
    expect(logged.source).toBe('tenant');
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

  it('可选键为 null 时按没给处理：删掉后重校验通过，Schema 允许 null 的键原样保留', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    // qwen-max 对用不到的可选键会写 null（extra: type 'array' 不收 null）；note 的 Schema 允许 null，不该被删
    const NULLABLE = { type: 'object', required: ['table'], properties: { table: { type: 'string' }, extra: { type: 'array' }, note: { type: ['string', 'null'] } } };
    fakeLlm(setLlmFetch, () => json({ table: 'orders', extra: null, note: null }, USAGE));

    expect(await chatJson(acme, 'mapping_draft', MESSAGES, NULLABLE)).toEqual({ table: 'orders', note: null });
    const [row] = await calls(acme);
    expect(row).toMatchObject({ schemaValid: true, error: null });
  });

  it('必填键为 null 时仍判不合格', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => json({ table: null }, USAGE));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/不符合 Schema：缺少 table/);
    const [row] = await calls(acme);
    expect(row.schemaValid).toBe(false);
  });

  it('输出被 max_tokens 截断（finish_reason: length）时报截断原因，不报「不是 JSON」', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => truncated('{"table": "order'));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toBe('模型输出被截断（达到输出长度上限），请把需求写得更具体，或换上下文更长的模型');
    const [row] = await calls(acme);
    expect(row.schemaValid).toBeNull();
    expect(row.error).toMatch(/被截断/);
  });

  it('内容被 ```json 代码块包着时去掉外壳再解析', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => text('```json\n{"table": "orders"}\n```', USAGE));

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    const [row] = await calls(acme);
    expect(row.schemaValid).toBe(true);
  });

  it('开头的 <think>…</think> 先去掉再解析（think 段里的 { 不算），think 段后跟 ```json 代码块也行', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const replies = [
      '<think>想一想 {不是JSON}</think>\n{"table": "orders"}',
      '<THINK>\n先看 {样本}\n</THINK>\n```json\n{"table": "members"}\n```',
    ];
    fakeLlm(setLlmFetch, n => text(replies[n - 1]));

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'members' });
  });

  it('JSON 后带说明文字、字符串值里含 } 时取第一个完整的 JSON 对象；<think> 没闭合时不删内容', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const replies = [
      '映射如下：{"table": "a}\\"{b", "note": {"x": 1}}\n以上是映射，{另一段} 请确认。',
      '<think>没闭合 {"table": "x"}',
    ];
    fakeLlm(setLlmFetch, n => text(replies[n - 1]));

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'a}"{b', note: { x: 1 } });
    // <think> 没闭合时不删任何内容，照常从第一个 { 起取对象
    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'x' });
  });

  it('只有说明文字、没有 JSON 对象时报「模型返回的内容不是 JSON」', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    fakeLlm(setLlmFetch, () => text('<think>{"table": "orders"}</think>\n抱歉，我无法完成。'));

    const err = await failure(chatJson(acme, 'connectivity', MESSAGES, SCHEMA));
    expect(err.message).toBe('模型返回的内容不是 JSON');
  });

  it('服务商没给工具调用 id 时本地生成互不相同的 id，给了的原样保留', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const TOOL = { name: 'lookup_metric', description: '查指标', parameters: { type: 'object' } };
    const call = (id?: string) => ({ ...(id && { id }), type: 'function', function: { name: 'lookup_metric', arguments: '{}' } });
    const replies = [[call(), call()], [call('srv_1'), call('')]];
    fakeLlm(setLlmFetch, n => Response.json({ choices: [{ message: { content: null, tool_calls: replies[n - 1] } }] }));

    const first = await chatTools(acme, 'assistant', MESSAGES, [TOOL]);
    const ids = first.toolCalls.map(c => c.id);
    expect(ids).toHaveLength(2);
    expect(ids.every(id => /^call_[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(ids[0]).not.toBe(ids[1]);
    const second = await chatTools(acme, 'assistant', MESSAGES, [TOOL]);
    expect(second.toolCalls[0].id).toBe('srv_1');
    expect(second.toolCalls[1].id).toMatch(/^call_[0-9a-f-]{36}$/);
  });

  it('minItems / maximum 等校验错误是中文说明，不出现 ajv 原文', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const LIMITS = {
      type: 'object', required: ['rules'],
      properties: { rules: { type: 'array', minItems: 1 }, score: { type: 'number', maximum: 1 }, name: { type: 'string', minLength: 2 } },
    };
    fakeLlm(setLlmFetch, () => json({ rules: [], score: 2, name: 'a' }, USAGE));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, LIMITS));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain('rules：至少要有 1 项');
    expect(err.message).toContain('score：不能大于 1');
    expect(err.message).toContain('name：至少 2 个字');
    expect(err.message).not.toContain('must NOT');
    const [row] = await calls(acme);
    expect(row.schemaValid).toBe(false);
    expect(row.error).not.toContain('must NOT');
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

  it('json_schema 里的 Schema 剥掉 allOf / if / then / not / uniqueItems，原 Schema 不变，本地仍按完整 Schema 校验（#1191）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const conditional = {
      type: 'object', required: ['mode'],
      properties: { mode: { type: 'string', not: { const: 'bad' } }, dims: { type: 'array', uniqueItems: true, items: { type: 'string' } } },
      allOf: [{ if: { properties: { mode: { const: 'group' } } }, then: { required: ['dims'] } }],
    };
    const original = structuredClone(conditional);
    const { received } = fakeLlm(setLlmFetch, () => json({ mode: 'group' }, USAGE));

    const err = await failure(chatJson(acme, 'metric_draft', MESSAGES, conditional));
    expect(received[0].body.response_format).toEqual({ type: 'json_schema', json_schema: {
      name: 'metric_draft', strict: false,
      schema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string' }, dims: { type: 'array', items: { type: 'string' } } } },
    } });
    expect(conditional).toEqual(original);
    // 返回缺 dims，只违反 if / then：本地校验仍拒绝
    expect(err).toBeInstanceOf(LlmError);
    expect((await calls(acme))[0].schemaValid).toBe(false);
  });

  it('服务商 400 拒绝 json_schema 时同一模型改发 json_object 成功，之后这个端点 + 模型 + Schema 直接发 json_object（#1191）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, (n, body) => (body.response_format as { type: string }).type === 'json_schema'
      ? new Response('response_format json_schema not supported', { status: 400 }) : json({ table: 'orders' }, USAGE));

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(2);
    expect(received[0].body.response_format).toEqual(asSchema('connectivity'));
    expect(received[1].body).toEqual({ model: 'qwen-plus', messages: MESSAGES, response_format: { type: 'json_object' }, temperature: 0 });
    // 只记一行日志，令牌数来自成功的那次
    const rows = await calls(acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schemaValid: true, error: null, promptTokens: 120 });

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(3);
    expect(received[2].body.response_format).toEqual({ type: 'json_object' });
  });

  it('一份 Schema 被拒退回 json_object 后，同一端点 + 模型的其他 Schema 仍发 json_schema（#1191）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const rejected = { type: 'object', required: ['table'], properties: { table: { type: 'string', pattern: '^o' } } };
    const { received } = fakeLlm(setLlmFetch, (n, body) => {
      const rf = body.response_format as { type: string; json_schema?: { schema: unknown } };
      return rf.type === 'json_schema' && JSON.stringify(rf.json_schema?.schema).includes('pattern')
        ? new Response('unsupported keyword', { status: 400 }) : json({ table: 'orders' }, USAGE);
    });

    expect(await chatJson(acme, 'connectivity', MESSAGES, rejected)).toEqual({ table: 'orders' });
    expect(received.map((r) => (r.body.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);

    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received[2].body.response_format).toEqual(asSchema('connectivity'));
    expect(await chatJson(acme, 'connectivity', MESSAGES, rejected)).toEqual({ table: 'orders' });
    expect(received[3].body.response_format).toEqual({ type: 'json_object' });
    expect(received).toHaveLength(4);
  });

  it('HTTP 500 时不回退 json_object：重试的那次仍发 json_schema，共 2 次请求，抛 transient 错误（#1191、#1215）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => new Response('upstream failed', { status: 500 }));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA));
    expect(received.map(r => r.body.response_format)).toEqual([asSchema('mapping_draft'), asSchema('mapping_draft')]);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).transient).toBe(true);
  });

  it('根不是 object 的 Schema（根上 anyOf）直接发 json_object（#1191）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'metric_parse', MESSAGES, { anyOf: [SCHEMA, { type: 'object', required: ['error'] }] });
    expect(received).toHaveLength(1);
    expect(received[0].body.response_format).toEqual({ type: 'json_object' });
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

  it('LLM_CHAT_EXTRA 合并进 /chat/completions 请求体，档位 LLM_<TIER>_CHAT_EXTRA 覆盖默认，平台字段不被覆盖', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    // extra 里写了平台字段也会被删掉：model / messages / response_format / tools / tool_choice / temperature 不能被服务商参数覆盖
    vi.stubEnv('LLM_CHAT_EXTRA', JSON.stringify({
      enable_thinking: false, top_p: 0.9,
      model: 'evil-model', messages: [], response_format: { type: 'text' },
      tools: [{ type: 'function', function: { name: 'evil' } }], tool_choice: 'none', temperature: 1,
    }));
    const TOOL = { name: 'lookup_metric', description: '查指标', parameters: { type: 'object' } };
    // chatJson 的请求体带 response_format，chatTools 的带 tools：按哪个分流答复
    const { received } = fakeLlm(setLlmFetch, (n, body) => 'response_format' in body ? json({ table: 'orders' }, USAGE) : text('好的'));

    await chatJson(acme, 'connectivity', MESSAGES, SCHEMA);
    await chatTools(acme, 'assistant', MESSAGES, [TOOL]);
    expect(received[0].body).toEqual({
      enable_thinking: false, top_p: 0.9,
      model: 'qwen-plus', messages: MESSAGES, response_format: asSchema('connectivity'), temperature: 0,
    });
    // chatTools 不带 response_format，tools 是平台给的、不是 extra 里的 evil
    expect(received[1].body).toEqual({
      enable_thinking: false, top_p: 0.9, model: 'qwen-plus', messages: MESSAGES,
      tools: [{ type: 'function', function: TOOL }], tool_choice: 'auto', temperature: 0,
    });

    // fast 档绑了模型后 LLM_FAST_CHAT_EXTRA 覆盖默认 extra：默认的 top_p 不再出现
    platformTier('fast', 'qwen3.8-flash');
    vi.stubEnv('LLM_FAST_CHAT_EXTRA', JSON.stringify({ enable_thinking: false, top_k: 5 }));
    await chatJson(acme, 'metric_parse', MESSAGES, SCHEMA);
    expect(received[2].body).toEqual({
      enable_thinking: false, top_k: 5,
      model: 'qwen3.8-flash', messages: MESSAGES, response_format: asSchema('metric_parse'), temperature: 0,
    });
  });

  it('LLM_CHAT_EXTRA 不是合法的 JSON 对象时调用失败：报配置错误、不发请求，消息与日志里没有 Key 与原文', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    // {bad 不是 JSON，[1] 是 JSON 但不是对象（数组、null、标量都算）
    for (const raw of ['{bad', '[1]']) {
      vi.stubEnv('LLM_CHAT_EXTRA', raw);
      const { f } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

      const err = await failure(chatJson(acme, 'connectivity', MESSAGES, SCHEMA)) as LlmError;
      expect(err).toBeInstanceOf(LlmError);
      expect(err.transient).toBe(false);
      expect(err.message).toBe('模型服务配置错误：LLM_CHAT_EXTRA 不是合法的 JSON 对象');
      expect(err.message).not.toContain('sk-platform-secret');
      expect(err.message).not.toContain(raw);
      expect(f).not.toHaveBeenCalled();
      const rows = await calls(acme);
      expect(rows.at(-1)).toMatchObject({ purpose: 'connectivity', model: 'qwen-plus', error: '模型服务配置错误：LLM_CHAT_EXTRA 不是合法的 JSON 对象' });
      expect(rows.at(-1)!.error).not.toContain(raw);
    }
    expect(await calls(acme)).toHaveLength(2);
  });

  it('LLM_TIMEOUT_SECONDS 控制 chat 超时，超时消息里的秒数跟着变；不是正整数时回落 60', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    // 假 fetch 同步 throw TimeoutError，不会真的等：断言的是超时消息里的秒数跟着环境变量走
    for (const [seconds, message] of [['5', /5 秒内没有返回/], ['abc', /60 秒内没有返回/]] as const) {
      vi.stubEnv('LLM_TIMEOUT_SECONDS', seconds);
      fakeLlm(setLlmFetch, () => { throw new DOMException('signal timed out', 'TimeoutError'); });

      const err = await failure(chatJson(acme, 'connectivity', MESSAGES, SCHEMA)) as LlmError;
      expect(err).toBeInstanceOf(LlmError);
      expect(err.transient).toBe(true);
      expect(err.message).toMatch(message);
      expect((await calls(acme)).at(-1)).toMatchObject({ purpose: 'connectivity', error: expect.stringMatching(message) });
    }
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

  it('配了档位、返回 500 或 429 时同一档位模型重试 1 次共 2 次请求，抛 transient 的 LlmError，不换模型（#1215）', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    platformTier('reasoning', 'qwen-max');
    for (const status of [500, 429]) {
      const { f, received } = fakeLlm(setLlmFetch, () => new Response('upstream failed', { status }));

      const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)) as LlmError;
      expect(err).toBeInstanceOf(LlmError);
      expect(err.transient).toBe(true);
      expect(err.message).toMatch(new RegExp(String(status)));
      expect(f).toHaveBeenCalledTimes(2);
      expect(received.map(r => r.body.model)).toEqual(['qwen-max', 'qwen-max']);
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

describe('transient 错误重试 1 次（#1215）', () => {
  const attempts = async (tenantId: string) => (await calls(tenantId)).sort((a, b) => a.attempt - b.attempt);

  it('第 1 次 503、第 2 次 200 时拿到结果：llm_calls 两行 attempt 1、2，第 1 行带 error；只等 1 次，1–3 秒', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, n => n === 1 ? new Response('busy', { status: 503 }) : json({ table: 'orders' }, USAGE));

    expect(await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(2);
    const rows = await attempts(acme);
    expect(rows).toMatchObject([
      { attempt: 1, error: expect.stringMatching(/503/), promptTokens: null },
      { attempt: 2, error: null, schemaValid: true, promptTokens: 120 },
    ]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThanOrEqual(3000);
  });

  it('两次都 503 时抛 transient 的 LlmError：正好 2 次请求、2 行', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => new Response('busy', { status: 503 }));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/503/);
    expect(received).toHaveLength(2);
    expect((await attempts(acme)).map(r => r.attempt)).toEqual([1, 2]);
  });

  it('第 1 次 429 也重试，第 2 次成功拿到结果', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, n => n === 1 ? new Response('slow down', { status: 429 }) : json({ table: 'orders' }));

    expect(await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(2);
  });

  it('网络错误（连不上）也重试', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, n => { if (n === 1) throw new TypeError('fetch failed'); return json({ table: 'orders' }); });

    expect(await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(2);
  });

  it('超时不重试：只发 1 次请求、不等待，错误带 timeout', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => { throw new DOMException('signal timed out', 'TimeoutError'); });

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)) as LlmError;
    expect(err.transient).toBe(true);
    expect(err.timeout).toBe(true);
    expect(received).toHaveLength(1);
    expect(waits).toEqual([]);
    expect((await calls(acme)).map(r => r.attempt)).toEqual([1]);
  });

  it('401（非 429 的 4xx）不重试：只发 1 次', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => new Response('bad key', { status: 401 }));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA)) as LlmError;
    expect(err.transient).toBe(false);
    expect(received).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('connectivity 用途 503 时不重试：只发 1 次，如实反映这一次请求', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => new Response('busy', { status: 503 }));

    await failure(chatJson(acme, 'connectivity', MESSAGES, SCHEMA));
    expect(received).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('chatTools（助手）503 时不重试：只发 1 次', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    const { received } = fakeLlm(setLlmFetch, () => new Response('busy', { status: 503 }));

    await failure(chatTools(acme, 'assistant', MESSAGES, [{ name: 'lookup_metric', description: '查指标', parameters: { type: 'object' } }]));
    expect(received).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});

describe('租户的服务商参数（#1169）', () => {
  const ROUTE = { assertion_draft: 'fast', mapping_draft: 'reasoning', connectivity: null } as const;

  it('租户默认与档位的服务商参数进入请求体：档位有值时覆盖，只填模型名或带端点但没填的档位继承默认，平台字段不被覆盖', async () => {
    const acme = await newTenant('acme');
    platformDefault(BASE_WITH_SLASH);
    await tenantProvider(acme, {
      chatExtra: JSON.stringify({ enable_thinking: false, top_p: 0.9, model: 'evil-model', temperature: 1 }),
      fast: { model: 'qwen3.8-flash', chatExtra: JSON.stringify({ enable_thinking: false, top_k: 5 }) },
      reasoning: { model: 'deepseek-reasoner', baseUrl: 'https://tenant-reasoning.example.com/v1', apiKey: 'sk-tenant-reasoning-secret' },
    });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    for (const purpose of Object.keys(ROUTE) as (keyof typeof ROUTE)[]) await chatJson(acme, purpose, MESSAGES, SCHEMA);

    const rest = (purpose: string) => ({ messages: MESSAGES, response_format: asSchema(purpose), temperature: 0 });
    // fast 档自己的覆盖默认：默认的 top_p 不出现
    expect(received[0].body).toEqual({ enable_thinking: false, top_k: 5, model: 'qwen3.8-flash', ...rest('assertion_draft') });
    // reasoning 档带自己的端点、没填服务商参数：继承租户默认的
    expect(received[1].url).toBe('https://tenant-reasoning.example.com/v1/chat/completions');
    expect(received[1].body).toEqual({ enable_thinking: false, top_p: 0.9, model: 'deepseek-reasoner', ...rest('mapping_draft') });
    // 不分档的用途用租户默认的
    expect(received[2].body).toEqual({ enable_thinking: false, top_p: 0.9, model: 'deepseek-chat', ...rest('connectivity') });
  });

  it('只填模型名的档位继承租户默认；租户没填时平台的 LLM_*CHAT_EXTRA 不进租户请求体', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    platformDefault(BASE_WITH_SLASH);
    vi.stubEnv('LLM_CHAT_EXTRA', JSON.stringify({ platform_only: true }));
    vi.stubEnv('LLM_FAST_CHAT_EXTRA', JSON.stringify({ platform_fast: true }));
    await tenantProvider(acme, { chatExtra: JSON.stringify({ enable_thinking: false }), fast: { model: 'qwen3.8-flash' } });
    await tenantProvider(globex, { fast: { model: 'qwen3.8-flash' } });
    const { received } = fakeLlm(setLlmFetch, () => json({ table: 'orders' }, USAGE));

    await chatJson(acme, 'assertion_draft', MESSAGES, SCHEMA);
    await chatJson(globex, 'assertion_draft', MESSAGES, SCHEMA);
    await chatJson(globex, 'connectivity', MESSAGES, SCHEMA);

    expect(received[0].body).toMatchObject({ enable_thinking: false, model: 'qwen3.8-flash' });
    expect(received[0].body).not.toHaveProperty('platform_only');
    expect(received[0].body).not.toHaveProperty('platform_fast');
    for (const r of received.slice(1)) {
      expect(r.body).not.toHaveProperty('platform_only');
      expect(r.body).not.toHaveProperty('platform_fast');
    }
  });

  it('save 存原文、空串存 null，拒绝非对象 JSON 与受保护键；审计只记 chatExtraChanged；reset 清列', async () => {
    const acme = await newTenant('acme');
    const admin = await memberOf(acme, 'admin@acme.com', 'admin');
    const base = { baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat', apiKey: 'sk-tenant-secret' };
    const row = async () => (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    // saveTierProvider 保存前会先发一次 json_object 探测（#1213）
    fakeLlm(setLlmFetch, () => json({ ok: true }, USAGE));

    for (const bad of ['[1]', 'null', '"x"', '{oops', '{"model":"x"}', '{"enable_thinking":false,"messages":[]}']) {
      expect(await failure(saveModelProvider(admin, { ...base, chatExtra: bad }))).toBeInstanceOf(ModelProviderError);
    }
    expect(await row()).toBeUndefined();

    const extra = '{"enable_thinking": false}';
    await saveModelProvider(admin, { ...base, chatExtra: extra });
    await saveTierProvider(admin, 'fast', { baseUrl: '', model: 'qwen3.8-flash', apiKey: '', chatExtra: '{"top_k": 5}' });
    expect(await failure(saveTierProvider(admin, 'reasoning', { baseUrl: '', model: 'r1', apiKey: '', chatExtra: '{"tools":[]}' })))
      .toBeInstanceOf(ModelProviderError);
    expect(await row()).toMatchObject({ chatExtra: extra, fastChatExtra: '{"top_k": 5}', reasoningChatExtra: null });

    // 不带 chatExtra 时不动列；带空串清成 null
    await saveModelProvider(admin, base);
    expect((await row()).chatExtra).toBe(extra);
    await saveTierProvider(admin, 'fast', { baseUrl: '', model: 'qwen3.8-flash', apiKey: '', chatExtra: '  ' });
    expect((await row()).fastChatExtra).toBeNull();

    const audits = await getDb().select().from(auditLogs).where(eq(auditLogs.tenantId, acme)).orderBy(auditLogs.createdAt);
    const details = audits.filter(a => a.action === 'model_provider.updated').map(a => a.detail as Record<string, unknown>);
    expect(details.map(d => d.chatExtraChanged)).toEqual([true, true, false, true]);
    expect(JSON.stringify(audits)).not.toContain('enable_thinking');
    expect(JSON.stringify(audits)).not.toContain('top_k');

    await saveTierProvider(admin, 'fast', { baseUrl: '', model: 'qwen3.8-flash', apiKey: '', chatExtra: '{"top_k": 5}' });
    await resetTierProvider(admin, 'fast');
    expect(await row()).toMatchObject({ chatExtra: extra, fastChatExtra: null });
    await resetModelProvider(admin);
    expect((await row()).chatExtra).toBeNull();
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
    // chat 用租户端点不影响 embedding：日志的 source 跟着这次用的端点走，记 'platform'（#843）
    const [row] = await calls(acme);
    expect(row.source).toBe('platform');
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
    // 租户 embedding 端点的调用记 source='tenant'（#843）
    const [logged] = await calls(acme);
    expect(logged.source).toBe('tenant');
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

  it('openid、unionid、external_userid 列打开发送样本后也只有加盐哈希，没有明文（#1212）', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`
      CREATE TABLE shop.wx_buyers (buyer_key serial primary key, "买家openid" text, unionid text, external_userid text, channel text, updated_at timestamptz);
      INSERT INTO shop.wx_buyers ("买家openid", unionid, external_userid, channel, updated_at) SELECT
        'oABC_' || i, 'uXYZ_' || i, 'wmEXT_' || i, CASE WHEN i % 2 = 0 THEN 'web' ELSE 'app' END, timestamptz '2024-06-01' + i * interval '1 hour'
      FROM generate_series(1, 8) i;
      GRANT SELECT ON shop.wx_buyers TO ${READER.user};`);
    const { id } = await registerSource(author, input);
    await selectAllTables(author, id);
    await drain();
    await confirmWatermark(author, id, 'wx_buyers', 'updated_at');
    await syncSource(author, id);
    await drain();
    await allowSamples(acme);

    const { samples } = await tableContextFor(acme, id, 'wx_buyers');
    expect(samples).toHaveLength(5);
    for (const r of samples!) {
      for (const c of ['买家openid', 'unionid', 'external_userid']) expect(String(r[c]), c).toMatch(/^[0-9a-f]{64}$/);
      expect(['web', 'app']).toContain(r.channel);
    }
    const sent = JSON.stringify(samples);
    for (const plain of ['oABC_', 'uXYZ_', 'wmEXT_']) expect(sent).not.toContain(plain);
  });

  it('打开发送样本但表还没同步时只有结构，不报错', async () => {
    const { acme, id } = await profiledSource(false);
    await allowSamples(acme);
    const context = await tableContextFor(acme, id, 'customers');
    expect('samples' in context).toBe(false);
    expect(context.rows).toBe(40);
  });
});

// test/pipeline/llm.test.ts —— 模型服务客户端（ADR-0035）：按租户配置 > 平台默认（环境变量）解析端点，chatJson → 注入的假 fetch → platform.llm_calls 的调用日志
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { llmCalls, modelProviders } from '../../app/.server/db/schema';
import { chatJson, LlmError, MODEL_PROVIDER_CONTEXT, resolveProvider, setLlmFetch } from '../../app/.server/llm';
import { encryptForTenant } from '../../app/.server/secrets';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

const SCHEMA = { type: 'object', required: ['table'], properties: { table: { type: 'string' } } };
const MESSAGES = [
  { role: 'system' as const, content: '你是映射助手' },
  { role: 'user' as const, content: '样本行：13800138000' },
];

interface Received { url: string; headers: Headers; body: Record<string, unknown> }

/** 假 fetch：记下收到的请求，返回 respond 构造的 Response */
function fakeFetch(respond: () => Response) {
  const received: Received[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    received.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(init?.body as string) });
    return respond();
  });
  setLlmFetch(f as unknown as typeof fetch);
  return { f, received };
}

/** OpenAI 兼容接口的成功返回：content 是 JSON 文本 */
const completion = (content: unknown, usage = { prompt_tokens: 120, completion_tokens: 30 }) =>
  () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }], usage });

function platformDefault() {
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1/');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
}

async function tenantProvider(tenantId: string) {
  await getDb().insert(modelProviders).values({
    tenantId, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat',
    apiKey: await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey: 'sk-tenant-secret' }),
  });
}

/** 调用应当失败：返回抛出的错误 */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as Error);

const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));

describe('模型服务客户端', () => {
  it('只有环境变量时用平台默认', async () => {
    const acme = await newTenant('acme');
    platformDefault();
    const { received } = fakeFetch(completion({ table: 'orders' }));

    expect(await resolveProvider(acme)).toMatchObject({ source: 'platform', model: 'qwen-plus' });
    expect(await chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).toEqual({ table: 'orders' });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('https://platform.example.com/v1/chat/completions');
    expect(received[0].headers.get('authorization')).toBe('Bearer sk-platform-secret');
    expect(received[0].body).toEqual({ model: 'qwen-plus', messages: MESSAGES, response_format: { type: 'json_object' }, temperature: 0 });
  });

  it('租户有自己的配置时整套用租户的，库里不存 Key 明文', async () => {
    const acme = await newTenant('acme');
    platformDefault();
    await tenantProvider(acme);
    const { received } = fakeFetch(completion({ table: 'orders' }));

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
    const { f } = fakeFetch(completion({ table: 'orders' }));

    expect(await resolveProvider(acme)).toBeNull();
    await expect(chatJson(acme, 'connectivity', MESSAGES, SCHEMA)).rejects.toThrow(/未配置模型服务/);
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
  });

  it('返回不合 Schema 时记 schemaValid=false 并抛错', async () => {
    const acme = await newTenant('acme');
    platformDefault();
    fakeFetch(completion({ tabel: 'orders' }));

    const err = await failure(chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/不符合.*table/);
    const [row] = await calls(acme);
    expect(row).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-plus', schemaValid: false, promptTokens: 120, completionTokens: 30 });
    expect(row.error).toMatch(/table/);
  });

  it('HTTP 500 时记 error，消息里没有 Key', async () => {
    const acme = await newTenant('acme');
    platformDefault();
    fakeFetch(() => new Response(`upstream failed for key sk-platform-secret ${'x'.repeat(500)}`, { status: 500 }));

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
    platformDefault();
    fakeFetch(completion({ table: '13900139000' }, { prompt_tokens: 200, completion_tokens: 50 }));

    await chatJson(acme, 'mapping_draft', MESSAGES, SCHEMA);
    const rows = await calls(acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-plus', promptTokens: 200, completionTokens: 50, schemaValid: true, error: null });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain('13800138000');
    expect(logged).not.toContain('13900139000');
  });
});

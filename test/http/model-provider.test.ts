// test/http/model-provider.test.ts —— 「模型服务」页的 HTTP 接缝：管理员在 /model-provider 保存端点、模型名与 API Key（Key 不回显、加密入库、留空沿用），
// 测试连通性与工具调用探测（假 fetch 经 app.setLlmFetch 注入，结果看页面与 platform.llm_calls），恢复平台默认后 resolveProvider 回到环境变量；
// 开关发送脱敏样本（默认关、记审计）；embedding 三项（ADR-0049）自成一张卡，与 chat 互不影响（不动 chat 配置与探测结果）；非管理员 403
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, modelProviders } from '../../app/.server/db/schema';
import { resolveEmbeddingProvider, resolveProvider } from '../../app/.server/llm';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, text, toolCalls } from '../pipeline/llm-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const KEY = 'sk-tenant-secret-1234';
const NEW_KEY = 'sk-tenant-rotated-5678';
const EKEY = 'sk-embed-tenant-1234';
const NEW_EKEY = 'sk-embed-rotated-5678';

const save = (admin: Client, apiKey = KEY) =>
  admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1/', model: 'deepseek-chat', apiKey });

const saveEmbedding = (admin: Client, apiKey = EKEY, baseUrl = 'https://embed-tenant.example.com/v1/') =>
  admin.post('/model-provider', { intent: 'embedding_save', embeddingBaseUrl: baseUrl, embeddingModel: 'bge-m3', embeddingApiKey: apiKey });

const setLlm = (f: typeof fetch | undefined) => app.setLlmFetch(f);
const ok = () => json({ ok: true }, { prompt_tokens: 10, completion_tokens: 3 });

const connectivityCalls = (tenantId: string) =>
  getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, tenantId), eq(llmCalls.purpose, 'connectivity')));

const embeddingCalls = (tenantId: string) =>
  getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, tenantId), eq(llmCalls.purpose, 'embedding')));

describe('模型服务页', () => {
  it('管理员保存后页面不回显 Key、库里不是明文、审计无明文；留空沿用，填新值记轮换', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/')).text()).toContain('href="/model-provider"');
    expect(await (await admin.get('/model-provider')).text()).toContain('data-provider-source="none"');

    expect((await save(admin, '')).status).toBe(400); // 第一次配置须填 Key
    expect((await admin.post('/model-provider', { intent: 'save', baseUrl: 'ftp://x', model: 'm', apiKey: KEY })).status).toBe(400);

    const saved = await save(admin);
    expect(saved.status).toBe(302);
    const page = await (await admin.get('/model-provider')).text();
    expect(page).not.toContain(KEY);
    expect(page).toContain('data-provider-source="tenant"');
    expect(page).toContain('value="https://tenant.example.com/v1"');
    expect(page).toContain('value="deepseek-chat"');
    expect(page).toContain('已设置，留空不修改');

    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row.apiKey).toBeTruthy();
    expect(row.apiKey).not.toContain(KEY);
    expect((await resolveProvider(acme))?.apiKey).toBe(KEY);

    expect((await save(admin, '')).status).toBe(302);
    expect((await resolveProvider(acme))?.apiKey).toBe(KEY);
    expect((await save(admin, NEW_KEY)).status).toBe(302);
    expect((await resolveProvider(acme))?.apiKey).toBe(NEW_KEY);

    // 改了端点必须重新填 Key：已存的 Key 不能发给新的主机
    const moved = await admin.post('/model-provider', { intent: 'save', baseUrl: 'https://attacker.example.com/v1', model: 'deepseek-chat', apiKey: '' });
    expect(moved.status).toBe(400);
    expect(await moved.text()).toContain('改了端点须重新填写 API Key');
    expect((await resolveProvider(acme))?.baseUrl).toBe('https://tenant.example.com/v1');

    const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.updated')).orderBy(auditLogs.createdAt);
    expect(logs.map(l => l.detail.credentialsRotated)).toEqual([true, false, true]);
    expect(logs[0].detail).toMatchObject({ baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat' });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(NEW_KEY);
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('修改模型服务');
    expect(audit).toContain('轮换 API Key');
  });

  it('管理员保存 embedding 三项后页面显示租户自定义、不回显 Key，库里不是明文，审计只记端点、模型与是否轮换；留空沿用，改了端点不填 Key 报错', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/model-provider')).text()).toContain('data-embedding-source="none"');

    expect((await saveEmbedding(admin, '')).status).toBe(400); // 第一次配置须填 Key
    const saved = await saveEmbedding(admin);
    expect(saved.status).toBe(302);
    const page = await (await admin.get('/model-provider')).text();
    expect(page).not.toContain(EKEY);
    expect(page).toContain('data-embedding-source="tenant"');
    expect(page).toContain('value="https://embed-tenant.example.com/v1"');
    expect(page).toContain('value="bge-m3"');
    expect(page).toContain('已设置，留空不修改');

    // 第一次保存 embedding 时可能还没有配置行：chat 三列留空（providerSource 只看 baseUrl，不会误判）
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row.embeddingApiKey).toBeTruthy();
    expect(row.embeddingApiKey).not.toContain(EKEY);
    expect(row).toMatchObject({ baseUrl: null, model: null, apiKey: null });
    expect(await resolveEmbeddingProvider(acme)).toMatchObject({ source: 'tenant', apiKey: EKEY });

    expect((await saveEmbedding(admin, '')).status).toBe(302); // 留空沿用
    expect((await resolveEmbeddingProvider(acme))?.apiKey).toBe(EKEY);
    expect((await saveEmbedding(admin, NEW_EKEY)).status).toBe(302);
    expect((await resolveEmbeddingProvider(acme))?.apiKey).toBe(NEW_EKEY);

    // 改了端点必须重新填 Key：已存的 Key 不能发给新的主机
    const moved = await saveEmbedding(admin, '', 'https://attacker.example.com/v1');
    expect(moved.status).toBe(400);
    expect(await moved.text()).toContain('改了端点须重新填写 API Key');
    expect((await resolveEmbeddingProvider(acme))?.baseUrl).toBe('https://embed-tenant.example.com/v1');

    const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.updated')).orderBy(auditLogs.createdAt);
    expect(logs.map(l => l.detail.credentialsRotated)).toEqual([true, false, true]);
    expect(logs.every(l => l.detail.embedding === true)).toBe(true);
    expect(logs[0].detail).toMatchObject({ baseUrl: 'https://embed-tenant.example.com/v1', model: 'bge-m3' });
    expect(JSON.stringify(logs)).not.toContain(EKEY);
    expect(JSON.stringify(logs)).not.toContain(NEW_EKEY);
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('向量检索 https://embed-tenant.example.com/v1');
  });

  it('测试 embedding：没配置时说明原因；成功显示模型、维度与耗时，失败显示抹掉 Key 的错误；恢复平台默认清掉 embedding 三项、chat 配置不动', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/model-provider')).text()).toContain('data-embedding-source="none"');

    // 租户与平台都没配置：不发请求、不记日志，页面说明原因
    const { received: noneReceived } = fakeLlm(setLlm, () => embeddings([[1]]));
    const nonePage = await (await admin.post('/model-provider', { intent: 'embedding_test' })).text();
    expect(nonePage).toContain('data-embedding-test="failed"');
    expect(nonePage).toContain('没有可用的 embedding 配置：平台没有配置默认，请先填写');
    expect(noneReceived).toHaveLength(0);
    expect(await embeddingCalls(acme)).toHaveLength(0);

    platformEmbedding();
    await save(admin); // chat 也配置，验证 embedding 的操作不动它
    await saveEmbedding(admin);

    const { received } = fakeLlm(setLlm, () => embeddings([[0.1, 0.2, 0.3]], { prompt_tokens: 5 }));
    const passed = await admin.post('/model-provider', { intent: 'embedding_test' });
    expect(passed.status).toBe(200);
    const okPage = await passed.text();
    expect(okPage).toContain('data-embedding-test="ok"');
    expect(okPage).toContain('data-embedding-model="bge-m3"');
    expect(okPage).toContain('data-embedding-dimensions="3"');
    expect(okPage).toMatch(/data-embedding-duration-ms="\d+"/);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('https://embed-tenant.example.com/v1/embeddings');
    expect(received[0].body).toMatchObject({ model: 'bge-m3', input: ['连通测试'] });
    expect(received[0].headers.get('authorization')).toBe(`Bearer ${EKEY}`);
    const [call] = await embeddingCalls(acme);
    expect(call).toMatchObject({ model: 'bge-m3', inputCount: 1, promptTokens: 5, error: null });

    fakeLlm(setLlm, () => new Response(`invalid api key ${EKEY}`, { status: 401 }));
    const failedPage = await (await admin.post('/model-provider', { intent: 'embedding_test' })).text();
    expect(failedPage).toContain('data-embedding-test="failed"');
    expect(failedPage).toContain('HTTP 401');
    expect(failedPage).not.toContain(EKEY);
    expect(await embeddingCalls(acme)).toHaveLength(2);

    // 恢复平台默认：embedding 回到环境变量，chat 的配置原样，审计只记 embedding 那条
    expect((await admin.post('/model-provider', { intent: 'embedding_reset' })).status).toBe(302);
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({
      embeddingBaseUrl: null, embeddingModel: null, embeddingApiKey: null,
      baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat',
    });
    expect(await resolveEmbeddingProvider(acme)).toMatchObject({ source: 'platform', model: 'text-embedding-v3' });
    expect(await resolveProvider(acme)).toMatchObject({ source: 'tenant', apiKey: KEY });
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-embedding-source="platform"');
    expect(page).toContain('data-provider-source="tenant"');
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'))).toHaveLength(1);
    expect(await (await admin.get('/audit')).text()).toContain('清空本租户的 embedding 端点、模型名与 API Key');
    // 本来就没配置时再恢复：不记审计
    expect((await admin.post('/model-provider', { intent: 'embedding_reset' })).status).toBe(302);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'))).toHaveLength(1);
  });

  it('测试连通性：成功显示模型名与耗时，失败显示抹掉 Key 的错误；每次都记一条 connectivity', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);

    const { received } = fakeLlm(setLlm, ok);
    const passed = await admin.post('/model-provider', { intent: 'test' });
    expect(passed.status).toBe(200);
    const okPage = await passed.text();
    expect(okPage).toContain('data-connectivity="ok"');
    expect(okPage).toContain('data-model="deepseek-chat"');
    expect(okPage).toMatch(/data-duration-ms="\d+"/);
    expect(received.map(r => r.headers.get('authorization'))).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]); // 连通性与工具调用探测各一次

    fakeLlm(setLlm, () => new Response(`invalid api key ${KEY}`, { status: 401 }));
    const failedPage = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(failedPage).toContain('data-connectivity="failed"');
    expect(failedPage).toContain('HTTP 401');
    expect(failedPage).not.toContain(KEY);

    const calls = await connectivityCalls(acme);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.error === null).sort()).toEqual([false, true]);
  });

  it('测试连通性时一并探测工具调用：返回 tool_calls 显示支持，400 提示不支持，只回文本提示没能确认，连通结果照旧；每次记一条 tool_probe', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);
    /** 第一次请求（连通性）照常返回，第二次（探测）由 respond 构造 */
    const probeWith = (respond: () => Response) => fakeLlm(setLlm, n => n === 1 ? ok() : respond());

    const { received } = probeWith(() => toolCalls({ name: 'ping', args: {} }));
    const supported = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(supported).toContain('data-connectivity="ok"');
    expect(supported).toContain('data-tools="yes"');
    expect(supported).toContain('支持工具调用');
    expect(received[1].body).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'ping' } }] });
    expect(received[1].body).not.toHaveProperty('response_format');

    probeWith(() => new Response('tools not supported', { status: 400 }));
    const unsupported = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(unsupported).toContain('data-connectivity="ok"');
    expect(unsupported).toContain('data-tools="no"');
    expect(unsupported).toContain('该模型服务不支持工具调用，AI 助手无法使用');
    // 只回了文本：tool_choice 是 auto，支持的模型也可能不调用，算没能确认
    probeWith(() => text('好的'));
    const unsure = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(unsure).toContain('data-connectivity="ok"');
    expect(unsure).toContain('data-tools="unknown"');
    expect(unsure).toContain('这次没能确认是否支持工具调用');

    const probeCalls = await getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, acme), eq(llmCalls.purpose, 'tool_probe')));
    expect(probeCalls).toHaveLength(3);
    expect(probeCalls.filter(c => c.error !== null)).toHaveLength(1); // 只回文本的那次调用本身是成功的
    expect(await connectivityCalls(acme)).toHaveLength(3);
  });

  it('恢复平台默认清空本租户的端点、模型名与 Key，之后用环境变量的配置；本来没配置时不记审计', async () => {
    platformDefault();
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/model-provider')).text()).toContain('data-provider-source="platform"');
    expect((await admin.post('/model-provider', { intent: 'reset' })).status).toBe(302);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'))).toHaveLength(0);
    await save(admin);
    expect((await resolveProvider(acme))?.source).toBe('tenant');

    expect((await admin.post('/model-provider', { intent: 'reset' })).status).toBe(302);
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ baseUrl: null, model: null, apiKey: null });
    expect(await resolveProvider(acme)).toMatchObject({ source: 'platform', model: 'qwen-plus' });
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-provider-source="platform"');
    expect(page).toContain('placeholder="未设置"');
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'))).toHaveLength(1);
    expect(await (await admin.get('/audit')).text()).toContain('恢复平台默认模型服务');
  });

  it('发送脱敏样本默认关闭，管理员打开 / 关闭各记一条审计（值没变不记），不影响端点配置', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    const checkbox = async () => (await (await admin.get('/model-provider')).text()).match(/<input[^>]*name="allowSamples"[^>]*>/)![0];
    expect(await checkbox()).not.toContain('checked');

    expect((await admin.post('/model-provider', { intent: 'samples', allowSamples: 'on' })).status).toBe(302);
    expect(await checkbox()).toContain('checked');
    const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ allowSamples: true, baseUrl: null, model: null, apiKey: null });
    expect(await (await admin.get('/model-provider')).text()).toContain('data-provider-source="none"');

    expect((await admin.post('/model-provider', { intent: 'samples', allowSamples: 'on' })).status).toBe(302); // 没变，不记审计
    expect((await admin.post('/model-provider', { intent: 'samples' })).status).toBe(302);
    expect(await checkbox()).not.toContain('checked');
    const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.updated')).orderBy(auditLogs.createdAt);
    expect(logs.map(l => l.detail)).toEqual([{ allowSamples: true }, { allowSamples: false }]);
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('打开发送脱敏样本');
    expect(audit).toContain('关闭发送脱敏样本');
  });

  it('数据工程师看不到入口，页面与提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get('/')).text()).not.toContain('href="/model-provider"');
    const page = await engineer.get('/model-provider');
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('配置模型服务');
    for (const intent of ['save', 'reset', 'test', 'samples', 'embedding_save', 'embedding_reset', 'embedding_test']) {
      expect((await engineer.post('/model-provider', {
        intent, baseUrl: 'https://x.example.com', model: 'm', apiKey: KEY, allowSamples: 'on',
        embeddingBaseUrl: 'https://x.example.com', embeddingModel: 'm', embeddingApiKey: KEY,
      })).status).toBe(403);
    }
    expect(await getDb().select().from(modelProviders)).toHaveLength(0);
    expect(await connectivityCalls(acme)).toHaveLength(0);
    expect(await embeddingCalls(acme)).toHaveLength(0);
  });

  it('保存 / 恢复 embedding 不清掉 chat 的工具调用探测结果', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);
    fakeLlm(setLlm, n => n === 1 ? ok() : toolCalls({ name: 'ping', args: {} }));
    await admin.post('/model-provider', { intent: 'test' });
    const probed = async () => {
      const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
      return { supported: row.toolsSupported, baseUrl: row.toolsProbedBaseUrl, model: row.toolsProbedModel, apiKey: row.apiKey };
    };
    expect(await probed()).toMatchObject({ supported: true, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat' });

    const before = await probed();
    expect((await saveEmbedding(admin)).status).toBe(302);
    expect(await probed()).toEqual(before);
    expect((await admin.post('/model-provider', { intent: 'embedding_reset' })).status).toBe(302);
    const after = await probed();
    expect(after).toMatchObject({ supported: true, baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat' });
    expect(after.apiKey).toBe(before.apiKey);
  });
});

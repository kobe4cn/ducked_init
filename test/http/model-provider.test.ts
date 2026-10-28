// test/http/model-provider.test.ts —— 「模型服务」页的 HTTP 接缝：管理员在 /model-provider 保存端点、模型名与 API Key（Key 不回显、加密入库、留空沿用），
// 测试连通性与工具调用探测（假 fetch 经 app.setLlmFetch 注入，结果看页面与 platform.llm_calls），恢复平台默认后 resolveProvider 回到环境变量；
// 开关发送脱敏样本（默认关、记审计）；非管理员 403
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, modelProviders } from '../../app/.server/db/schema';
import { resolveProvider } from '../../app/.server/llm';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const KEY = 'sk-tenant-secret-1234';
const NEW_KEY = 'sk-tenant-rotated-5678';

const save = (admin: Client, apiKey = KEY) =>
  admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1/', model: 'deepseek-chat', apiKey });

/** 假 fetch：记下请求头，返回 respond 构造的 Response */
function fakeFetch(respond: () => Response) {
  const authorizations: (string | null)[] = [];
  app.setLlmFetch((async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return respond();
  }) as typeof fetch);
  return authorizations;
}

const ok = () => Response.json({ choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });

const connectivityCalls = (tenantId: string) =>
  getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, tenantId), eq(llmCalls.purpose, 'connectivity')));

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

  it('测试连通性：成功显示模型名与耗时，失败显示抹掉 Key 的错误；每次都记一条 connectivity', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);

    const authorizations = fakeFetch(ok);
    const passed = await admin.post('/model-provider', { intent: 'test' });
    expect(passed.status).toBe(200);
    const okPage = await passed.text();
    expect(okPage).toContain('data-connectivity="ok"');
    expect(okPage).toContain('data-model="deepseek-chat"');
    expect(okPage).toMatch(/data-duration-ms="\d+"/);
    expect(authorizations).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]); // 连通性与工具调用探测各一次

    fakeFetch(() => new Response(`invalid api key ${KEY}`, { status: 401 }));
    const failedPage = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(failedPage).toContain('data-connectivity="failed"');
    expect(failedPage).toContain('HTTP 401');
    expect(failedPage).not.toContain(KEY);

    const calls = await connectivityCalls(acme);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.error === null).sort()).toEqual([false, true]);
  });

  it('测试连通性时一并探测工具调用：返回 tool_calls 显示支持，只回文本或 400 提示不支持，连通结果照旧；每次记一条 tool_probe', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);
    const toolCall = () => Response.json({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }],
    });
    /** 第一次请求（连通性）照常返回，第二次（探测）由 respond 构造；记下第二次的请求体 */
    const probeWith = (respond: () => Response) => {
      const bodies: Record<string, unknown>[] = [];
      app.setLlmFetch((async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string));
        return bodies.length === 1 ? ok() : respond();
      }) as typeof fetch);
      return bodies;
    };

    const bodies = probeWith(toolCall);
    const supported = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(supported).toContain('data-connectivity="ok"');
    expect(supported).toContain('data-tools="yes"');
    expect(supported).toContain('支持工具调用');
    expect(bodies[1]).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'ping' } }] });
    expect(bodies[1]).not.toHaveProperty('response_format');

    for (const unsupported of [() => Response.json({ choices: [{ message: { content: '好的' } }] }), () => new Response('tools not supported', { status: 400 })]) {
      probeWith(unsupported);
      const page = await (await admin.post('/model-provider', { intent: 'test' })).text();
      expect(page).toContain('data-connectivity="ok"');
      expect(page).toContain('data-tools="no"');
      expect(page).toContain('该模型服务不支持工具调用，AI 助手无法使用');
    }

    const probeCalls = await getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, acme), eq(llmCalls.purpose, 'tool_probe')));
    expect(probeCalls).toHaveLength(3);
    expect(probeCalls.filter(c => c.error !== null)).toHaveLength(1); // 只回文本的那次调用本身是成功的
    expect(await connectivityCalls(acme)).toHaveLength(3);
  });

  it('恢复平台默认清空本租户的端点、模型名与 Key，之后用环境变量的配置；本来没配置时不记审计', async () => {
    vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
    vi.stubEnv('LLM_MODEL', 'qwen-plus');
    vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
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
    for (const intent of ['save', 'reset', 'test', 'samples']) {
      expect((await engineer.post('/model-provider', { intent, baseUrl: 'https://x.example.com', model: 'm', apiKey: KEY, allowSamples: 'on' })).status).toBe(403);
    }
    expect(await getDb().select().from(modelProviders)).toHaveLength(0);
    expect(await connectivityCalls(acme)).toHaveLength(0);
  });
});

// test/http/model-provider.test.ts —— 「模型服务」页的 HTTP 接缝：管理员在 /model-provider 保存端点、模型名与 API Key（Key 不回显、加密入库、留空沿用），
// 测试连通性（假 fetch 经 app.setLlmFetch 注入，结果看页面与 platform.llm_calls），恢复平台默认后 resolveProvider 回到环境变量；非管理员 403
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
    expect(authorizations).toEqual([`Bearer ${KEY}`]);

    fakeFetch(() => new Response(`invalid api key ${KEY}`, { status: 401 }));
    const failedPage = await (await admin.post('/model-provider', { intent: 'test' })).text();
    expect(failedPage).toContain('data-connectivity="failed"');
    expect(failedPage).toContain('HTTP 401');
    expect(failedPage).not.toContain(KEY);

    const calls = await connectivityCalls(acme);
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.error === null).sort()).toEqual([false, true]);
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

  it('数据工程师看不到入口，页面与提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get('/')).text()).not.toContain('href="/model-provider"');
    const page = await engineer.get('/model-provider');
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('配置模型服务');
    for (const intent of ['save', 'reset', 'test']) {
      expect((await engineer.post('/model-provider', { intent, baseUrl: 'https://x.example.com', model: 'm', apiKey: KEY })).status).toBe(403);
    }
    expect(await getDb().select().from(modelProviders)).toHaveLength(0);
    expect(await connectivityCalls(acme)).toHaveLength(0);
  });
});

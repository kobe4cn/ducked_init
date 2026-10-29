// test/http/assistant.test.ts —— AI 助手资源路由 /assistant 的 HTTP 接缝（ADR-0043）：GET 返回是否配置了模型服务、工具调用探测结果与成员可用的工具名，
// POST JSON { message, page } 跑一轮问答（假 fetch 经 app.setLlmFetch 注入）；模型服务不支持工具调用时返回提示而不是 500；
// 「测试连通性」探测为不支持时 POST 422 且不发请求，临时故障不存，改了端点或模型、恢复平台默认后探测结果作废；
// 顶栏有「AI 助手」按钮；未登录跳转登录页
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

function platformDefault() {
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
}

const ask = (client: Client, body: unknown) =>
  client.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const TURN = { message: '有哪些实体？', page: { path: '/lineage', title: '数据地图' } };

describe('AI 助手', () => {
  it('查看者 GET 只列目录工具；POST 一轮拿到答复与用过的工具，不回传工具原文；页面顶栏有「AI 助手」按钮', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    expect(await (await viewer.get('/assistant')).json()).toEqual({ configured: false, toolSupport: null, tools: ['catalog_overview', 'catalog_expand', 'catalog_search'], mine: [], shared: [] });
    expect(await (await viewer.get('/')).text()).toContain('AI 助手');

    platformDefault();
    expect(await (await viewer.get('/assistant')).json()).toMatchObject({ configured: true });
    let n = 0;
    app.setLlmFetch((async () => ++n === 1
      ? Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'catalog_overview', arguments: '{}' } }] } }] })
      : Response.json({ choices: [{ message: { content: '有客户、订单等实体' } }] })) as typeof fetch);
    const res = await ask(viewer, TURN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: expect.any(String), reply: '有客户、订单等实体', toolsUsed: ['catalog_overview'] });
  });

  it('模型服务返回 400 时提示不支持工具调用而不是 500；没配置 409；问题为空或超长 400', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    const unconfigured = await ask(viewer, TURN);
    expect(unconfigured.status).toBe(409);
    expect((await unconfigured.json()).error).toContain('模型服务');

    platformDefault();
    app.setLlmFetch((async () => new Response('tools not supported', { status: 400 })) as typeof fetch);
    const failed = await ask(viewer, TURN);
    expect(failed.status).toBe(422);
    expect((await failed.json()).error).toContain('不支持工具调用');

    expect((await ask(viewer, { message: ' ', page: TURN.page })).status).toBe(400);
    expect((await ask(viewer, { message: 'x'.repeat(4001), page: TURN.page })).status).toBe(400);
    expect((await viewer.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })).status).toBe(400);
  });

  it('探测结果按租户存下并带端点与模型：不支持时 GET 为 false、POST 422 不发请求；改了模型、恢复平台默认、平台默认换了模型后作废', async () => {
    platformDefault();
    const acme = await newTenant('acme');
    await newTenant('globex');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const admin = await loginAs(app, 'admin@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const globex = await loginAs(app, 'admin@globex.com');
    const support = async (client = viewer) => (await (await client.get('/assistant')).json()).toolSupport;
    /** 连通性请求回 JSON，探测请求按 tools 决定回不回 tool_calls；记下请求数 */
    const probe = async (tools: boolean) => {
      app.setLlmFetch((async (_url: string | URL | Request, init?: RequestInit) => JSON.parse(init?.body as string).tools && tools
        ? Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'p', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }] })
        : Response.json({ choices: [{ message: { content: '{"ok": true}' } }] })) as typeof fetch);
      expect(await (await admin.post('/model-provider', { intent: 'test' })).text()).toContain(`data-tools="${tools ? 'yes' : 'no'}"`);
    };

    expect(await support()).toBeNull();
    // 探测时临时故障（503）：页面照旧提示不支持，但不存，助手照常可用
    app.setLlmFetch((async (_url: string | URL | Request, init?: RequestInit) => JSON.parse(init?.body as string).tools
      ? new Response('busy', { status: 503 })
      : Response.json({ choices: [{ message: { content: '{"ok": true}' } }] })) as typeof fetch);
    expect(await (await admin.post('/model-provider', { intent: 'test' })).text()).toContain('data-tools="no"');
    expect(await support()).toBeNull();
    await probe(false);
    expect(await support()).toBe(false);
    expect(await support(globex)).toBeNull(); // 别的租户不受影响
    let requests = 0;
    app.setLlmFetch((async () => { requests++; return Response.json({ choices: [{ message: { content: '假装查过了' } }] }); }) as typeof fetch);
    const refused = await ask(viewer, TURN);
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toContain('该模型服务不支持工具调用');
    expect(requests).toBe(0);

    await probe(true);
    expect(await support()).toBe(true);
    vi.stubEnv('LLM_MODEL', 'qwen-max'); // 平台默认换了模型
    expect(await support()).toBeNull();
    vi.stubEnv('LLM_MODEL', 'qwen-plus');

    const saveTenant = (model: string) =>
      admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1', model, apiKey: 'sk-tenant-secret' });
    await saveTenant('deepseek-chat');
    expect(await support()).toBeNull();
    await probe(false);
    expect(await support()).toBe(false);
    await saveTenant('deepseek-chat'); // 只是重存、端点与模型没变，结果仍有效
    expect(await support()).toBe(false);
    await saveTenant('deepseek-v3');
    expect(await support()).toBeNull();
    await probe(false);
    await admin.post('/model-provider', { intent: 'reset' });
    expect(await support()).toBeNull();
  });

  it('未登录跳转登录页', async () => {
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await admin.post('/logout', {});
    const res = await ask(admin, TURN);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});

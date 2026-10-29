// test/http/assistant.test.ts —— AI 助手资源路由 /assistant 的 HTTP 接缝（ADR-0043）：GET 返回是否配置了模型服务、工具调用探测结果与成员可用的工具名，
// POST JSON { message, page } 跑一轮问答（假 fetch 经 app.setLlmFetch 注入）；模型服务不支持工具调用时返回提示而不是 500；
// 「测试连通性」探测为不支持时 POST 422 且不发请求，临时故障不存，改了端点或模型、恢复平台默认后探测结果作废；
// 顶栏有「AI 助手」按钮；未登录跳转登录页
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { fakeLlm, json, platformDefault, text, toolCalls } from '../pipeline/llm-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const setLlm = (f: typeof fetch | undefined) => app.setLlmFetch(f);

const ask = (client: Client, body: unknown) =>
  client.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const TURN = { message: '有哪些实体？', page: { path: '/lineage', title: '数据地图' } };

describe('AI 助手', () => {
  it('查看者 GET 只列目录工具；POST 一轮拿到答复与用过的工具，不回传工具原文；页面顶栏有「AI 助手」按钮', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');

    expect(await (await viewer.get('/assistant')).json()).toEqual({ configured: false, toolSupport: null, canManageProvider: false, tools: ['catalog_overview', 'catalog_expand', 'catalog_search'], mine: [], shared: [] });
    expect(await (await viewer.get('/')).text()).toContain('AI 助手');

    platformDefault();
    expect(await (await viewer.get('/assistant')).json()).toMatchObject({ configured: true });
    fakeLlm(setLlm, n => n === 1 ? toolCalls({ id: 'c1', name: 'catalog_overview', args: {} }) : text('有客户、订单等实体'));
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
    fakeLlm(setLlm, () => new Response('tools not supported', { status: 400 }));
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
    /** 连通性请求回 JSON，探测请求（带 tools）由 respond 决定怎么回；返回页面上的 data-tools */
    const probeWith = async (respond: () => Response) => {
      fakeLlm(setLlm, (_n, body) => body.tools ? respond() : json({ ok: true }));
      return /data-tools="(\w+)"/.exec(await (await admin.post('/model-provider', { intent: 'test' })).text())?.[1];
    };
    /** 支持：回 tool_calls；不支持：拒绝带 tools 的请求（400） */
    const probe = async (tools: boolean) => expect(await probeWith(tools
      ? () => toolCalls({ id: 'p', name: 'ping', args: {} })
      : () => new Response('tools not supported', { status: 400 }))).toBe(tools ? 'yes' : 'no');

    expect(await (await admin.get('/assistant')).json()).toMatchObject({ canManageProvider: true }); // 侧栏只给能管理模型服务的成员「模型服务」页链接
    expect(await support()).toBeNull();
    // 探测时临时故障（503）或模型只回了文本（tool_choice 是 auto，支持的模型也可能不调用）：页面提示没能确认，不存，助手照常可用
    expect(await probeWith(() => new Response('busy', { status: 503 }))).toBe('unknown');
    expect(await support()).toBeNull();
    expect(await probeWith(() => text('好的'))).toBe('unknown');
    expect(await support()).toBeNull();
    await probe(true);
    expect(await probeWith(() => text('好的'))).toBe('unknown');
    expect(await support()).toBe(true); // 不确定的结果不覆盖上一次的
    await probe(false);
    expect(await support()).toBe(false);
    expect(await support(globex)).toBeNull(); // 别的租户不受影响
    const { received } = fakeLlm(setLlm, () => text('假装查过了'));
    const refused = await ask(viewer, TURN);
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toContain('该模型服务不支持工具调用');
    expect(received.length).toBe(0);

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

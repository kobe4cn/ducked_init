// test/http/assistant.test.ts —— AI 助手资源路由 /assistant 的 HTTP 接缝（ADR-0043）：GET 返回是否配置了模型服务、工具调用探测结果与成员可用的工具名，
// POST JSON { message, page } 跑一轮问答（假 fetch 经 app.setLlmFetch 注入）；模型服务不支持工具调用时返回提示而不是 500；
// 同一成员同时只能有一轮（#1249）：上一轮进行中再提交 429 且不发模型请求，别的成员互不影响；上一轮不管怎么结束（400/409/422、客户端中止）占位都释放；
// 「测试连通性」探测为不支持时 POST 422 且不发请求，临时故障不存，改了端点或模型、恢复平台默认后探测结果作废；
// 顶栏有「AI 助手」按钮；未登录跳转登录页
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, llmCalls } from '../../app/.server/db/schema';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { fakeLlm, json, platformDefault, platformTier, text, toolCalls } from '../pipeline/llm-fixtures';
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

    expect(await (await viewer.get('/assistant')).json()).toEqual({ configured: false, toolSupport: null, canManageProvider: false, tools: ['catalog_overview', 'catalog_expand', 'catalog_search', 'validate_plan'], mine: [], shared: [] });
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

  it('客户端中止请求即取消这一轮：第 2 次模型请求的 fetch 被中止，这轮不写对话（#1248）', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    platformDefault();
    // 第 1 次回 catalog_search 工具调用；第 2 次挂起并遵守 init.signal：客户端中止时 reject
    const signals: (AbortSignal | undefined)[] = [];
    app.setLlmFetch(((url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined);
      return signals.length === 1
        ? Promise.resolve(toolCalls({ id: 'c1', name: 'catalog_search', args: { query: '客户' } }))
        : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', function aborted(this: AbortSignal) { reject(this.reason); }));
    }) as unknown as typeof fetch);
    const controller = new AbortController();
    const pending = viewer.request('/assistant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN), signal: controller.signal,
    }).then(r => r.status, () => 'aborted');
    // 等第 2 次模型请求挂起后再中止（监听器挂到已中止的 signal 上不会回放）
    await expect.poll(() => signals.length).toBe(2);
    controller.abort();
    // react-router 在请求中止后丢弃本轮的答复（客户端已走，看到的无关紧要），动作本身照常跑完才返回
    await pending;
    await expect.poll(() => signals[1]?.aborted).toBe(true);
    // 中止的这轮不调用 appendTurn：对话表里没有新行；被中止的那次请求记一行带 error 的 llm_calls
    expect(await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme))).toHaveLength(0);
    const logged = await getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, acme));
    expect(logged).toHaveLength(2);
    expect(logged.at(-1)!.error).toBe('请求已取消');
  }, 30_000);

  it('同一成员同时只能有一轮：第一轮挂起时再提交 429 且不多发模型请求；别的成员互不影响；结束后可立刻再提交（#1249）', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const analyst = await loginAs(app, 'analyst@acme.com');
    platformDefault();
    // 第 1 次模型请求挂起到放行为止（viewer 的第一轮进行中），之后的请求直接给文字答复
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    app.setLlmFetch((async () => {
      calls++;
      if (calls === 1) await gate;
      return text('有客户、订单等实体');
    }) as unknown as typeof fetch);
    const first = ask(viewer, TURN);
    await expect.poll(() => calls).toBe(1);
    // 上一轮进行中同一成员再提交：429、文案，并且不再发模型请求
    const busy = await ask(viewer, { message: '还有哪些实体？', page: TURN.page });
    expect(busy.status).toBe(429);
    expect((await busy.json()).error).toBe('你已有一轮助手在进行，请等它结束后再试');
    expect(calls).toBe(1);
    // 另一位成员同一时刻提交不受影响：照常跑完一轮
    expect((await ask(analyst, TURN)).status).toBe(200);
    // 放行第一轮后返回 200；占位已释放，同一成员可以立刻再提交
    release();
    expect((await first).status).toBe(200);
    expect((await ask(viewer, { message: '还有哪些实体？', page: TURN.page })).status).toBe(200);
  }, 30_000);

  it('上一轮不管怎么结束占位都释放：空问题 400、未配置 409、不支持工具调用 422、客户端中止后，马上再提交都不是 429（#1249）', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    // 前置校验在占位之前：空问题 400 根本不占；未配置 409 的这轮占过又释放，再提交还是 409 而不是 429
    expect((await ask(viewer, { message: ' ', page: TURN.page })).status).toBe(400);
    expect((await ask(viewer, TURN)).status).toBe(409);
    expect((await ask(viewer, TURN)).status).toBe(409);
    // 跑进模型服务后的 422：这轮结束后占位立刻归还（再提交还是 422，不是 429）
    platformDefault();
    fakeLlm(setLlm, () => new Response('tools not supported', { status: 400 }));
    expect((await ask(viewer, TURN)).status).toBe(422);
    expect((await ask(viewer, TURN)).status).toBe(422);
    // 客户端中止的一轮（写法照 #1248 的用例）：先 await 被中止的那次请求（react-router 等动作跑完才返回），再提交不是 429
    const signals: (AbortSignal | undefined)[] = [];
    app.setLlmFetch(((url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal | undefined);
      return signals.length === 1
        ? Promise.resolve(toolCalls({ id: 'c1', name: 'catalog_search', args: { query: '客户' } }))
        : new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', function aborted(this: AbortSignal) { reject(this.reason); }));
    }) as unknown as typeof fetch);
    const controller = new AbortController();
    const pending = viewer.request('/assistant', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(TURN), signal: controller.signal,
    }).then(r => r.status, () => 'aborted');
    await expect.poll(() => signals.length).toBe(2);
    controller.abort();
    await pending;
    await expect.poll(() => signals[1]?.aborted).toBe(true);
    fakeLlm(setLlm, () => text('有客户、订单等实体'));
    expect((await ask(viewer, TURN)).status).toBe(200);
  }, 30_000);

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

  it('reasoning 档位绑定不同模型时：toolSupport 按档位那一套比对（没探测过为 null，不误报不支持）；测试连通性会多探测一次档位模型，结果按档位存', async () => {
    platformDefault();
    const acme = await newTenant('acme');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const admin = await loginAs(app, 'admin@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');
    const support = async () => (await (await viewer.get('/assistant')).json()).toolSupport;
    /** 连通性请求回 JSON、默认模型（qwen-plus）的探测回 tool_calls，档位模型（qwen-max）的探测由 tierRespond 决定；返回页面上的 data-tools */
    const probeTier = async (tierRespond: () => Response) => {
      const { received } = fakeLlm(setLlm, (_n, body) => body.tools
        ? (body.model === 'qwen-max' ? tierRespond() : toolCalls({ id: 'p', name: 'ping', args: {} }))
        : json({ ok: true }));
      const tools = /data-tools="(\w+)"/.exec(await (await admin.post('/model-provider', { intent: 'test' })).text())?.[1];
      return { tools, received };
    };

    // 没设档位时探测过、得到 true；设了档位（只换模型名）以后 GET 为 null：档位模型没探测过，不算「不支持」
    expect((await probeTier(() => text('好的'))).tools).toBe('yes');
    expect(await support()).toBe(true);
    platformTier('reasoning', 'qwen-max');
    expect(await support()).toBeNull();

    // 管理员「测试连通性」发 4 次请求：connectivity、默认模型的 tool_probe、档位模型的 tool_probe，再给 reasoning 档位测一次 JSON（#1213）；
    // 存进三列的是档位那一套的结果
    const probed = await probeTier(() => toolCalls({ id: 'p', name: 'ping', args: {} }));
    expect(probed.received.map(({ body }) => [body.model, Boolean(body.tools)])).toEqual([
      ['qwen-plus', false], ['qwen-plus', true], ['qwen-max', true], ['qwen-max', false],
    ]);
    expect(await support()).toBe(true);
    const probes = await getDb().select().from(llmCalls).where(and(eq(llmCalls.tenantId, acme), eq(llmCalls.purpose, 'tool_probe')));
    expect(probes).toHaveLength(3);
    expect(probes.filter(c => c.route === 'reasoning')).toHaveLength(1);

    // 档位探测返回 400：结果按档位存为 false，GET 为 false、POST 422 不发请求；默认探测仍是支持的，页面 data-tools 不变
    expect((await probeTier(() => new Response('tools not supported', { status: 400 }))).tools).toBe('yes');
    expect(await support()).toBe(false);
    const { received } = fakeLlm(setLlm, () => text('假装查过了'));
    const refused = await ask(viewer, TURN);
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toContain('该模型服务不支持工具调用');
    expect(received.length).toBe(0);
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

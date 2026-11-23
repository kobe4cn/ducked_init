// test/http/model-provider.test.ts —— 「模型服务」页的 HTTP 接缝：管理员在 /model-provider 保存端点、模型名与 API Key（Key 不回显、加密入库、留空沿用），
// 测试连通性与工具调用探测（假 fetch 经 app.setLlmFetch 注入，结果看页面与 platform.llm_calls），恢复平台默认后 resolveProvider 回到环境变量；
// 开关发送脱敏样本（默认关、记审计）；embedding 三项（ADR-0049）自成一张卡，与 chat 互不影响（不动 chat 配置与探测结果）；
// fast / reasoning 档位（ADR-0055 路由③a）一张卡：只填模型名时沿用租户端点与 Key，没有自己的模型服务 400，恢复只清该档三列；非管理员 403；
// 服务商参数（#1170）：chat 与档位表单的 chatExtra 存原文、回显，不带该字段不动已存值，非法 JSON / 平台字段 400，恢复默认后清空；
// 向量存储（ADR-0058，#848）一张卡：选系统自带还是外部 pgvector，连接串加密不回显（假替身经 app.setPgvectorConnect 注入，不连真实地址），
// 保存时先测连通失败不保存，审计只记 from / to / urlRotated，切回系统自带时已存的连接串保留
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, modelProviders, tasks, tenants } from '../../app/.server/db/schema';
import { resolveEmbeddingProvider, resolveProvider } from '../../app/.server/llm';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, text, toolCalls } from '../pipeline/llm-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { app.setLlmFetch(undefined); app.setPgvectorConnect(undefined); vi.unstubAllEnvs(); });

const KEY = 'sk-tenant-secret-1234';
const NEW_KEY = 'sk-tenant-rotated-5678';
const EKEY = 'sk-embed-tenant-1234';
const NEW_EKEY = 'sk-embed-rotated-5678';
const TKEY = 'sk-tier-fast-1234';
const NEW_TKEY = 'sk-tier-rotated-5678';

/** chatExtra 不传就不放进表单（后端「不传不动列」） */
const save = (admin: Client, apiKey = KEY, chatExtra?: string) =>
  admin.post('/model-provider', { intent: 'save', baseUrl: 'https://tenant.example.com/v1/', model: 'deepseek-chat', apiKey, ...(chatExtra === undefined ? {} : { chatExtra }) });

const saveEmbedding = (admin: Client, apiKey = EKEY, baseUrl = 'https://embed-tenant.example.com/v1/') =>
  admin.post('/model-provider', { intent: 'embedding_save', embeddingBaseUrl: baseUrl, embeddingModel: 'bge-m3', embeddingApiKey: apiKey });

const tierSave = (admin: Client, tier: 'fast' | 'reasoning', model: string, baseUrl = '', apiKey = '', chatExtra?: string) =>
  admin.post('/model-provider', { intent: 'tier_save', tier, model, baseUrl, apiKey, ...(chatExtra === undefined ? {} : { chatExtra }) });

const tierReset = (admin: Client, tier: 'fast' | 'reasoning') => admin.post('/model-provider', { intent: 'tier_reset', tier });

const PURL = 'postgres://vector:sec%40ret@pg.example.com:5432/vectors';
const PURL2 = 'postgres://vector:rotated@pg2.example.com:5432/vectors';

const saveVectorStore = (admin: Client, kind: string, url = '') =>
  admin.post('/model-provider', { intent: 'vector_store_save', vectorStore: kind, vectorStoreUrl: url });

/** 注入外部 pgvector 建连替身（不连真实地址）：不传 fail 时全部成功；返回收到的连接串（断言「没有配置就不发起连接」） */
const pgvectorStub = (fail?: (url: string) => Error) => {
  const urls: string[] = [];
  app.setPgvectorConnect(url => {
    urls.push(url);
    return fail
      ? { query: () => Promise.reject(fail(url)) }
      : { query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) };
  });
  return urls;
};

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

  it('保存 embedding 配置时开了混合检索的租户提前排补算任务，没开的不排（#824）', async () => {
    // 没开混合检索：保存配置不排任务
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await saveEmbedding(admin)).status).toBe(302);
    const catalogTasks = () => getDb().select().from(tasks).where(eq(tasks.tenantId, acme));
    expect((await catalogTasks()).filter(t => t.kind.startsWith('catalog.'))).toHaveLength(0);

    // 打开混合检索（直接改库即可，开关入口的 HTTP 行为由 ops 测试覆盖）再保存：提前排上补算
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    expect((await saveEmbedding(admin, NEW_EKEY)).status).toBe(302);
    expect((await catalogTasks()).filter(t => t.kind.startsWith('catalog.')).map(t => `${t.kind}/${t.status}`))
      .toEqual(['catalog.embed/queued']);
  });

  it('管理员保存档位：没有自己的模型服务 400；只填模型名时端点与 Key 存 null；填端点按现有规则要 Key、Key 加密不回显；审计写明是哪一档', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');

    // 本租户还没有自己的模型服务（chat 三项）时保存档位 400
    const noChat = await tierSave(admin, 'reasoning', 'qwen-max');
    expect(noChat.status).toBe(400);
    expect(await noChat.text()).toContain('先保存本租户的模型服务');

    await save(admin);
    // 只填模型名：档位的端点和 Key 都存 null
    expect((await tierSave(admin, 'reasoning', 'qwen-max')).status).toBe(302);
    let [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ reasoningModel: 'qwen-max', reasoningBaseUrl: null, reasoningApiKey: null, fastModel: null });
    let page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-tier-reasoning="tenant"');
    expect(page).toContain('data-tier-fast="default"');
    expect(page).toContain('qwen-max');
    expect(page).toContain('端点沿用本租户默认');
    expect(page).toContain('使用默认');

    // 填了端点：第一次必须填 Key，端点不是 http(s) 400；填 Key 不填端点、模型名为空、tier 不合法都 400
    expect((await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1', '')).status).toBe(400);
    expect((await tierSave(admin, 'fast', 'qwen-flash', 'ftp://x', TKEY)).status).toBe(400);
    expect((await tierSave(admin, 'fast', 'qwen-flash', '', TKEY)).status).toBe(400);
    expect((await tierSave(admin, 'fast', ' ', '', '')).status).toBe(400);
    expect((await admin.post('/model-provider', { intent: 'tier_save', tier: 'slow', model: 'm', baseUrl: '', apiKey: '' })).status).toBe(400);

    expect((await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1/', TKEY)).status).toBe(302);
    [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ fastModel: 'qwen-flash', fastBaseUrl: 'https://fast.example.com/v1' });
    expect(row.fastApiKey).toBeTruthy();
    expect(row.fastApiKey).not.toContain(TKEY);
    page = await (await admin.get('/model-provider')).text();
    expect(page).not.toContain(TKEY);
    expect(page).toContain('data-tier-fast="tenant"');
    expect(page).toContain('value="qwen-flash"');
    expect(page).toContain('value="https://fast.example.com/v1"');
    expect(page).toMatch(/<input[^>]*id="fast-api-key"[^>]*placeholder="已设置，留空不修改"/);

    // 留空沿用；改了端点必须重填 Key；填新值记轮换
    expect((await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1', '')).status).toBe(302);
    const moved = await tierSave(admin, 'fast', 'qwen-flash', 'https://attacker.example.com/v1', '');
    expect(moved.status).toBe(400);
    expect(await moved.text()).toContain('改了端点须重新填写 API Key');
    expect((await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1', NEW_TKEY)).status).toBe(302);

    // 审计：detail 带 tier，摘要写明是哪一档，没有 Key 明文
    const logs = (await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.updated')).orderBy(auditLogs.createdAt))
      .filter(l => l.detail.tier);
    expect(logs.map(l => l.detail.tier)).toEqual(['reasoning', 'fast', 'fast', 'fast']);
    expect(logs.map(l => l.detail.credentialsRotated)).toEqual([false, true, false, true]);
    expect(logs[0].detail).toMatchObject({ tier: 'reasoning', model: 'qwen-max', baseUrl: null });
    expect(JSON.stringify(logs)).not.toContain(TKEY);
    expect(JSON.stringify(logs)).not.toContain(NEW_TKEY);
    const audit = await (await admin.get('/audit')).text();
    expect(audit).toContain('reasoning 档 沿用默认端点，模型 qwen-max');
    expect(audit).toContain('fast 档 https://fast.example.com/v1，模型 qwen-flash');
  });

  it('服务商参数（#1170）：chat 与档位卡片保存后入库并回显，不带该字段的保存不动它；非法 JSON 与平台字段 400 且报错显示在页面上；恢复默认后清空', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    const EXTRA = '{"enable_thinking": false}';
    // React 转义 textarea 里的引号；placeholder 也是同一个示例，所以按 textarea 的内容（后跟闭合标签）断言
    const ESCAPED = '{&quot;enable_thinking&quot;: false}</textarea>';
    const row = async () => (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    const page = async () => (await admin.get('/model-provider')).text();
    expect(await page()).toContain('服务商参数（可选）');

    await save(admin);
    expect((await save(admin, '', EXTRA)).status).toBe(302);
    expect((await row()).chatExtra).toBe(EXTRA);
    expect(await page()).toContain(ESCAPED);
    // 不带 chatExtra 字段的保存不清掉已存的值
    expect((await save(admin, '')).status).toBe(302);
    expect((await row()).chatExtra).toBe(EXTRA);

    // 档位只填模型名加服务商参数能保存
    expect((await tierSave(admin, 'fast', 'qwen-flash', '', '', '{"top_k": 20}')).status).toBe(302);
    expect(await row()).toMatchObject({ fastModel: 'qwen-flash', fastChatExtra: '{"top_k": 20}', reasoningChatExtra: null });
    expect(await page()).toContain('{&quot;top_k&quot;: 20}</textarea>');

    // 非法 JSON 与受保护键 400，错误显示在页面上，库里的值不变（用户输入不丢靠表单 key 不变、不重挂载，HTTP 测不到，见浏览器验收）
    const bad = await save(admin, '', 'not json');
    expect(bad.status).toBe(400);
    const badPage = await bad.text();
    expect(badPage).toContain('服务商参数须是 JSON 对象');
    const protectedKey = await tierSave(admin, 'reasoning', 'qwen-max', '', '', '{"model": "x"}');
    expect(protectedKey.status).toBe(400);
    expect(await protectedKey.text()).toContain('服务商参数不能包含平台字段');
    expect((await row()).chatExtra).toBe(EXTRA);

    // 恢复默认之后清空
    expect((await tierReset(admin, 'fast')).status).toBe(302);
    expect((await row()).fastChatExtra).toBeNull();
    expect((await admin.post('/model-provider', { intent: 'reset' })).status).toBe(302);
    expect((await row()).chatExtra).toBeNull();
    const after = await page();
    expect(after).not.toContain(ESCAPED);
    expect(after).not.toContain('{&quot;top_k&quot;: 20}</textarea>');
  });

  it('保存档位不清探测结果、不改 chat 与 embedding；恢复档位只清该档三列：另一档、chat 与 embedding 的配置、工具调用探测结果都不动；本来没绑定时不记审计；chat 的恢复不动档位列', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    await save(admin);
    await saveEmbedding(admin);
    await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1', TKEY);
    await tierSave(admin, 'reasoning', 'qwen-max');
    fakeLlm(setLlm, n => n === 1 ? ok() : toolCalls({ name: 'ping', args: {} }));
    await admin.post('/model-provider', { intent: 'test' });
    const probed = async () => {
      const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
      return { supported: row.toolsSupported, baseUrl: row.toolsProbedBaseUrl, model: row.toolsProbedModel };
    };
    // 路由③b（#606）后租户的 reasoning 档位也生效：探测按档位再探一次，三列存的是助手实际要用的那一套（qwen-max，沿用租户端点）
    expect(await probed()).toMatchObject({ supported: true, baseUrl: 'https://tenant.example.com/v1', model: 'qwen-max' });

    // 探测之后再保存档位：探测结果、chat 与 embedding 的配置都不动
    const chatAndEmbedding = (r: typeof modelProviders.$inferSelect) => ({
      baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey,
      embeddingBaseUrl: r.embeddingBaseUrl, embeddingModel: r.embeddingModel, embeddingApiKey: r.embeddingApiKey,
    });
    let [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    const beforeTierSave = chatAndEmbedding(row);
    expect((await tierSave(admin, 'reasoning', 'qwen-max-2')).status).toBe(302);
    expect((await tierSave(admin, 'fast', 'qwen-flash', 'https://fast.example.com/v1', NEW_TKEY)).status).toBe(302);
    expect(await probed()).toEqual({ supported: true, baseUrl: 'https://tenant.example.com/v1', model: 'qwen-max' });
    [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(chatAndEmbedding(row)).toEqual(beforeTierSave);
    expect(row).toMatchObject({ baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat', embeddingModel: 'bge-m3', reasoningModel: 'qwen-max-2' });

    expect((await tierReset(admin, 'fast')).status).toBe(302);
    [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ fastModel: null, fastBaseUrl: null, fastApiKey: null, reasoningModel: 'qwen-max-2' });
    expect(row).toMatchObject({ baseUrl: 'https://tenant.example.com/v1', model: 'deepseek-chat', embeddingModel: 'bge-m3' });
    expect(await probed()).toMatchObject({ supported: true, baseUrl: 'https://tenant.example.com/v1', model: 'qwen-max' });
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-tier-fast="default"');
    expect(page).toContain('使用默认');
    expect(page).toContain('data-tier-reasoning="tenant"');

    const resets = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'));
    expect(resets).toHaveLength(1);
    expect(resets[0].detail).toEqual({ tier: 'fast' });
    expect(await (await admin.get('/audit')).text()).toContain('清空 fast 档的模型、端点与 API Key');

    // 本来就没绑定时再恢复：不记审计
    expect((await tierReset(admin, 'fast')).status).toBe(302);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.reset'))).toHaveLength(1);

    // 恢复 chat 的平台默认不动档位列（与档位恢复互不影响）
    expect((await admin.post('/model-provider', { intent: 'reset' })).status).toBe(302);
    [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme));
    expect(row).toMatchObject({ baseUrl: null, model: null, apiKey: null, reasoningModel: 'qwen-max-2', embeddingModel: 'bge-m3' });
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

    const { received } = fakeLlm(setLlm, (_n, body) => embeddings(body.input.map(() => [0.1, 0.2, 0.3]), { prompt_tokens: 5 }));
    const passed = await admin.post('/model-provider', { intent: 'embedding_test' });
    expect(passed.status).toBe(200);
    const okPage = await passed.text();
    expect(okPage).toContain('data-embedding-test="ok"');
    expect(okPage).toContain('data-embedding-model="bge-m3"');
    expect(okPage).toContain('data-embedding-dimensions="3"');
    expect(okPage).toMatch(/data-embedding-duration-ms="\d+"/);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('https://embed-tenant.example.com/v1/embeddings');
    expect(received[0].body.model).toBe('bge-m3');
    expect(received[0].body.input).toHaveLength(10); // 一次发满一批（默认 10 条），批大小超限在测试时就暴露
    expect(new Set(received[0].body.input).size).toBe(10);
    expect(received[0].headers.get('authorization')).toBe(`Bearer ${EKEY}`);
    const [call] = await embeddingCalls(acme);
    expect(call).toMatchObject({ model: 'bge-m3', inputCount: 10, promptTokens: 5, error: null });

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

  it('测试 embedding 发的条数等于批大小：LLM_EMBEDDING_BATCH_SIZE=5 时发 5 条；服务商拒绝批大小时页面显示服务商的报错', async () => {
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    platformEmbedding();

    vi.stubEnv('LLM_EMBEDDING_BATCH_SIZE', '5');
    const { received } = fakeLlm(setLlm, (_n, body) => embeddings(body.input.map(() => [0.1, 0.2])));
    const okPage = await (await admin.post('/model-provider', { intent: 'embedding_test' })).text();
    expect(okPage).toContain('data-embedding-test="ok"');
    expect(okPage).toContain('data-embedding-dimensions="2"');
    expect(received).toHaveLength(1);
    expect(received[0].body.input).toHaveLength(5);
    expect(new Set(received[0].body.input).size).toBe(5);

    vi.stubEnv('LLM_EMBEDDING_BATCH_SIZE', '64');
    const rejected = fakeLlm(setLlm, (_n, body) => (body.input.length > 10
      ? new Response('{"code":"InvalidParameter","message":"batch size is invalid, it should not be larger than 10.: input.contents"}', { status: 400 })
      : embeddings(body.input.map(() => [0.1, 0.2]))));
    const failedPage = await (await admin.post('/model-provider', { intent: 'embedding_test' })).text();
    expect(rejected.received[0].body.input).toHaveLength(64);
    expect(failedPage).toContain('data-embedding-test="failed"');
    expect(failedPage).toContain('batch size is invalid, it should not be larger than 10.');
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
    for (const intent of ['save', 'reset', 'test', 'samples', 'embedding_save', 'embedding_reset', 'embedding_test', 'tier_save', 'tier_reset', 'vector_store_save', 'vector_store_test']) {
      expect((await engineer.post('/model-provider', {
        intent, baseUrl: 'https://x.example.com', model: 'm', apiKey: KEY, allowSamples: 'on', tier: 'fast',
        embeddingBaseUrl: 'https://x.example.com', embeddingModel: 'm', embeddingApiKey: KEY, vectorStore: 'pgvector', vectorStoreUrl: PURL,
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

  it('管理员保存外部 pgvector：页面选中且不回显连接串，库里是密文、checked_at 非空，审计只记 from / to / urlRotated；协议不对 / 不是 URL / 第一次不填 400，留空沿用', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/model-provider')).text()).toContain('data-vector-store-kind="platform"');

    expect((await saveVectorStore(admin, 'pgvector', 'mysql://u:p@h/db')).status).toBe(400);
    expect((await saveVectorStore(admin, 'pgvector', '不是地址')).status).toBe(400);
    expect((await saveVectorStore(admin, 'pgvector')).status).toBe(400); // 第一次选外部 pgvector 须填连接串
    expect((await saveVectorStore(admin, 'sqlite', PURL)).status).toBe(400); // kind 不合法
    expect(await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme))).toHaveLength(0);

    pgvectorStub();
    const saved = await saveVectorStore(admin, 'pgvector', PURL);
    expect(saved.status).toBe(200); // 不重定向：结果在这次响应里展示
    expect(await saved.text()).toContain('data-vector-store-test="ok"');
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-vector-store-kind="pgvector"');
    expect(page).toContain('data-vector-store-status="ok"');
    expect(page).toContain('已设置，留空不修改');
    expect(page).not.toContain(PURL);
    expect(page).not.toContain('sec%40ret');

    const row = async () => (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    const saved1 = await row();
    expect(saved1.vectorStore).toBe('pgvector');
    expect(saved1.vectorStoreUrl).toBeTruthy();
    expect(saved1.vectorStoreUrl).not.toContain(PURL); // 密文，不是明文
    expect(saved1.vectorStoreCheckedAt).toBeTruthy();
    expect(saved1.vectorStoreError).toBeNull();

    const storeLogs = () => getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated'));
    let logs = await storeLogs();
    expect(logs.map(l => l.detail)).toEqual([{ from: 'platform', to: 'pgvector', urlRotated: true }]);
    expect(JSON.stringify(logs)).not.toContain(PURL);
    expect(await (await admin.get('/audit')).text()).toContain('向量存储 platform → pgvector（换了连接串）');

    // 留空沿用：密文不变、存储没换连接串没换，不记审计
    expect((await saveVectorStore(admin, 'pgvector')).status).toBe(200);
    expect((await row()).vectorStoreUrl).toBe(saved1.vectorStoreUrl);
    expect(await storeLogs()).toHaveLength(1);

    // 填新连接串：换主机只能通过填新串，from === to 但 urlRotated 仍记审计
    expect((await saveVectorStore(admin, 'pgvector', PURL2)).status).toBe(200);
    const saved2 = await row();
    expect(saved2.vectorStoreUrl).not.toBe(saved1.vectorStoreUrl);
    logs = await storeLogs();
    expect(logs.map(l => l.detail)).toEqual([
      { from: 'platform', to: 'pgvector', urlRotated: true },
      { from: 'pgvector', to: 'pgvector', urlRotated: true },
    ]);
    expect((await (await admin.get('/model-provider')).text())).not.toContain(PURL2);
  });

  it('保存外部 pgvector 时连不上：不写库、页面显示抹掉凭据的错误；「测试连接」写 checked_at 与 error、不记审计，还没配置时不发起连接', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    // 还没配置连接串就「测试连接」：直接失败，不调 preparePgvector
    const urls = pgvectorStub();
    const noUrl = await admin.post('/model-provider', { intent: 'vector_store_test' });
    expect(await noUrl.text()).toContain('还没有配置外部 pgvector 连接串');
    expect(urls).toEqual([]);

    // 替身抛带密码与整串连接串的错误：页面与库里都没有明文
    pgvectorStub(url => new Error(`password authentication failed for user "vector" (sec@ret) at ${url}`));
    const failed = await saveVectorStore(admin, 'pgvector', PURL);
    const failedPage = await failed.text();
    expect(failedPage).toContain('data-vector-store-test="failed"');
    expect(failedPage).toContain('准备 pgvector 向量库失败');
    expect(failedPage).not.toContain('sec%40ret');
    expect(failedPage).not.toContain('sec@ret');
    expect(failedPage).not.toContain(PURL);
    // 失败不保存：本来就没有配置行，失败的保存连行都不写，仍是默认的 platform
    expect(await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme))).toHaveLength(0);
    expect(await (await admin.get('/model-provider')).text()).toContain('data-vector-store-kind="platform"');
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated'))).toHaveLength(0);

    // 配好之后「测试连接」失败：写 checked_at 与 error，不记审计
    pgvectorStub();
    await saveVectorStore(admin, 'pgvector', PURL);
    pgvectorStub(url => new Error(`password authentication failed for user "vector" (sec@ret) at ${url}`));
    const tested = await admin.post('/model-provider', { intent: 'vector_store_test' });
    expect(await tested.text()).toContain('data-vector-store-test="failed"');
    const afterFail = async () => (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    let state = await afterFail();
    expect(state.vectorStoreCheckedAt).toBeTruthy();
    expect(state.vectorStoreError).toContain('准备 pgvector 向量库失败');
    expect(state.vectorStoreError).not.toContain('sec@ret');
    expect(state.vectorStoreError).not.toContain(PURL);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated'))).toHaveLength(1); // 只有保存那条

    // 再测一次成功：清掉 error，页面显示上次检查时间与状态
    pgvectorStub();
    const okTest = await admin.post('/model-provider', { intent: 'vector_store_test' });
    expect(await okTest.text()).toContain('data-vector-store-test="ok"');
    state = await afterFail();
    expect(state.vectorStoreError).toBeNull();
    expect(state.vectorStoreCheckedAt).toBeTruthy();
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toMatch(/data-vector-store-checked="2\d{3}-/);
    expect(page).toContain('连接正常');
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated'))).toHaveLength(1);
  });

  it('切回系统自带：不测连通、忽略表单里的连接串，已存的密文与检查结果保留，记一条审计；本来就没换过时保存不写库也不记审计', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await saveVectorStore(admin, 'platform')).status).toBe(302); // 什么都没变：不写库不记审计
    expect(await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme))).toHaveLength(0);

    const urls = pgvectorStub(); // 留着数调用：切回 platform 不该发起连接
    expect((await saveVectorStore(admin, 'pgvector', PURL)).status).toBe(200);
    const before = (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];

    const back = await saveVectorStore(admin, 'platform', 'mysql://连不上的串也会被忽略');
    expect(back.status).toBe(302); // 切回系统自带不测连通，照别的保存一样重定向
    const after = (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    expect(after.vectorStore).toBe('platform');
    expect(after.vectorStoreUrl).toBe(before.vectorStoreUrl); // 密文保留，方便撤回
    expect(after.vectorStoreCheckedAt).toEqual(before.vectorStoreCheckedAt);
    expect(urls).toHaveLength(1); // 只有保存 pgvector 那次测过
    const page = await (await admin.get('/model-provider')).text();
    expect(page).toContain('data-vector-store-kind="platform"');
    expect(page).not.toContain(PURL);

    const logs = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated')).orderBy(auditLogs.createdAt);
    expect(logs.map(l => l.detail)).toEqual([
      { from: 'platform', to: 'pgvector', urlRotated: true },
      { from: 'pgvector', to: 'platform', urlRotated: false },
    ]);

    // 再切回 pgvector：连接串留空沿用，第三条审计 urlRotated: false
    expect((await saveVectorStore(admin, 'pgvector')).status).toBe(200);
    const again = (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, acme)))[0];
    expect(again.vectorStoreUrl).toBe(before.vectorStoreUrl);
    const allLogs = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'model_provider.vector_store_updated')).orderBy(auditLogs.createdAt);
    expect(allLogs.map(l => l.detail)).toEqual([
      { from: 'platform', to: 'pgvector', urlRotated: true },
      { from: 'pgvector', to: 'platform', urlRotated: false },
      { from: 'platform', to: 'pgvector', urlRotated: false },
    ]);
  });
});

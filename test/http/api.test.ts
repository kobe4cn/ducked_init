// test/http/api.test.ts —— 外部系统接口的 HTTP 接缝：管理员在「API Key」页创建（明文只展示一次）、吊销；外部系统带 Bearer Key 调 /api/v1/catalog。
// 非管理员看不到页面；没有 Key、Key 错误、已吊销、租户已暂停一律同样的 401，成员的 cookie 不算数；A 租户管理员吊销不了 B 的 Key，各自的 Key 只看到本租户的目录。
// 目录条目在 YAML 的 description 之外带业务知识里当前的业务说明（note，#968）：最新一版、保存即生效，没写或清空为 null。
// 点查 /api/v1/consumers/:id：数据由身份打通夹具、RFM 与已发布的指标、标签跑出快照，调度器自动生成服务库；?snapshot= 只读查湖里那张快照表。
// 成功的点查按天记入 api_key_usage（ADR-0059，401/404/503/?snapshot= 不记），计数按租户隔离。
// 点查还按 Key 的数据范围（data_scope，ADR-0061「数据范围」，#975）裁剪：范围外的标签、指标与 RFM 不出现，范围外的快照 404。
// Bearer Key 打不开成员页面，也没有通往标准层、沙箱的接口；成员存下（并分享出去）的沙箱表不进服务库，也不出现在目录接口里
import { randomUUID } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopeOfPath } from '../../app/.server/api-auth';
import { sha256 } from '../../app/.server/auth';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { closeDb, getDb } from '../../app/.server/db/client';
import { apiKeyUsage, apiKeys, auditLogs, snapshots as snapshotsTable, sources as sourcesTable, spaces as spacesTable, tasks } from '../../app/.server/db/schema';
import type { ApiDataScope } from '../../app/lib/api-data-scope';
import { API_ENDPOINTS } from '../../app/lib/api-docs';
import { createDefinition, deleteDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { lakeRow } from '../../app/.server/lake';
import { servingPath } from '../../app/.server/pipeline/serving-engine';
import { tenantServingKey } from '../../app/.server/secrets';
import { currentServingStore, enqueueServingBuild } from '../../app/.server/serving-store';
import { listSnapshots } from '../../app/.server/snapshots';
import { suspendTenant } from '../../app/.server/tenants';
import { saveAsSandbox, shareSandboxTable } from '../../app/.server/workbench';
import { drain, memberOf, newTenant, onLake, runTask } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
const fresh = async () => { await resetDb(); app.outbox.length = 0; };

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';
const BUYER = 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n';

/** 管理员在页面上创建一把 Key，返回明文与创建那次响应的 HTML；scope 是勾选的接口范围，默认三类全勾（与页面表单一致） */
async function createKey(admin: Client, name: string, scopes: string[] = ['catalog', 'consumers', 'exports']) {
  const res = await admin.post('/api-keys', { intent: 'create', name, scope: scopes });
  expect(res.status).toBe(200);
  const html = await res.text();
  const key = html.match(/data-api-key="[^"]*"[^>]*>([^<]+)</)?.[1];
  if (!key) throw new Error('创建后的页面没有展示 Key');
  return { key, html };
}

/** 页面上某个名称对应的 Key ID */
async function keyIdOf(admin: Client, name: string) {
  const html = await (await admin.get('/api-keys')).text();
  const row = html.split('<tr').find(r => r.includes(`>${name}<`));
  const id = row?.match(/data-api-key-id="([\w-]+)"/)?.[1];
  if (!id) throw new Error(`API Key 页没有「${name}」`);
  return id;
}

const call = (path: string, key?: string, browser: Client = app.client()) =>
  browser.request(path, { headers: key === undefined ? {} : { Authorization: `Bearer ${key}` } });

describe('API Key 页', () => {
  beforeEach(fresh);

  it('管理员创建后只展示一次明文，列表只有名称、前缀、接口、创建人与时间，库里只存哈希；吊销后审计有记录', async () => {
    await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/')).text()).toContain('href="/api-keys"');

    const { key, html } = await createKey(admin, '营销自动化');
    expect(html).toContain('只展示这一次');

    const list = await (await admin.get('/api-keys')).text();
    expect(list).not.toContain(key);
    expect(list).toContain('营销自动化');
    expect(list).toContain(`${key.slice(0, 8)}…`);
    expect(list).toContain('admin@acme.com');
    expect(list).toContain('从未使用');

    const [row] = await getDb().select().from(apiKeys);
    expect(row.tokenHash).toBe(sha256(key));
    expect(row.prefix).toBe(key.slice(0, 8));
    expect(JSON.stringify(row)).not.toContain(key);

    const id = await keyIdOf(admin, '营销自动化');
    const revoked = await admin.post('/api-keys', { intent: 'revoke', keyId: id });
    expect(revoked.status).toBe(302);
    expect(await (await admin.get('/api-keys')).text()).toContain('已吊销');
    expect((await admin.post('/api-keys', { intent: 'revoke', keyId: id })).status).toBe(404);

    const audit = await (await admin.get('/audit')).text();
    const actions = [...audit.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1]);
    expect(actions.slice(0, 2)).toEqual(['吊销 API Key', '创建 API Key']);
    expect(audit).toContain(`「营销自动化」（${key.slice(0, 8)}…）`);
    const details = await getDb().select({ detail: auditLogs.detail }).from(auditLogs);
    expect(JSON.stringify(details)).not.toContain(key);

    expect((await admin.post('/api-keys', { intent: 'create', name: '  ' })).status).toBe(400);
  });

  it('创建时勾选接口范围：三个复选框默认全勾；只勾点查的列表「接口」列只显示点查；一类都不勾报错不创建；审计 detail 带 scopes', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');

    // 表单是三个默认勾选的复选框（目录 / 点查 / 导出），值是三类接口
    const page = await (await admin.get('/api-keys')).text();
    const scopeInputs = [...page.matchAll(/<input[^>]*name="scope"[^>]*>/g)].map(m => m[0]);
    expect(scopeInputs.map(t => t.match(/value="(\w+)"/)?.[1]).sort()).toEqual(['catalog', 'consumers', 'exports']);
    expect(scopeInputs.every(t => t.includes('checked'))).toBe(true);
    for (const label of ['目录', '点查', '导出']) expect(page).toContain(label);

    // 默认提交三类；乱序、重复的勾选去重后按固定顺序存
    const { key } = await createKey(admin, '三类全开');
    const [full] = await getDb().select().from(apiKeys).where(eq(apiKeys.tokenHash, sha256(key)));
    expect(full.scopes).toEqual(['catalog', 'consumers', 'exports']);
    const { key: messy } = await createKey(admin, '乱序', ['exports', 'consumers', 'exports']);
    expect((await getDb().select({ scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.tokenHash, sha256(messy))))[0].scopes)
      .toEqual(['consumers', 'exports']);

    // 列表多一列「接口」：只点查的那行只显示点查，三类全开的那行三类都在
    const { key: onlyKey } = await createKey(admin, '只点查', ['consumers']);
    const list = await (await admin.get('/api-keys')).text();
    expect(list).toMatch(/<th[^>]*>接口<\/th>/);
    const rowOf = (name: string) => list.split('<tr').find(r => r.includes(`>${name}<`)) ?? '';
    expect(rowOf('只点查')).toContain('>点查<');
    expect(rowOf('只点查')).not.toContain('目录');
    expect(rowOf('只点查')).not.toContain('导出');
    expect(rowOf('三类全开')).toContain('目录、点查、导出');

    // 一类都不勾：报错不创建，列表与库里都没有这把 Key
    const none = await admin.post('/api-keys', { intent: 'create', name: '都不勾' });
    expect(none.status).toBe(400);
    expect(await none.text()).toContain('请至少勾选一类接口');
    expect(await (await admin.get('/api-keys')).text()).not.toContain('都不勾');
    expect(await getDb().select().from(apiKeys)).toHaveLength(3);

    // 审计 detail 带 scopes（只存勾选的类，不含 Key 明文）
    const created = await getDb().select({ detail: auditLogs.detail }).from(auditLogs).where(eq(auditLogs.action, 'api_key.created')).orderBy(auditLogs.createdAt);
    expect(created.map(d => d.detail)).toEqual([
      { name: '三类全开', prefix: key.slice(0, 8), scopes: ['catalog', 'consumers', 'exports'] },
      { name: '乱序', prefix: messy.slice(0, 8), scopes: ['consumers', 'exports'] },
      { name: '只点查', prefix: onlyKey.slice(0, 8), scopes: ['consumers'] },
    ]);
  });

  it('「接口说明」标签页按登记表列出全部外部接口；页面只有占位符，没有 Key 前缀、哈希或创建者；无权限成员 403；Key 列表照旧', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const admin = await loginAs(app, 'admin@acme.com');
    const { key } = await createKey(admin, '营销自动化');
    const [row] = await getDb().select().from(apiKeys);
    expect(row.prefix).toBe(key.slice(0, 8));

    const res = await admin.get('/api-keys?tab=docs');
    expect(res.status).toBe(200);
    const docs = await res.text();
    // JSX 会把 < > 转义成 &lt; &gt;，断言页面上可见的文字时先按同样规则转义
    const asHtml = (text: string) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 登记表里每个接口的方法和路径都在页面上，一张卡片一个接口
    expect([...docs.matchAll(/data-endpoint="([^"]+)"/g)].map(m => m[1])).toEqual(API_ENDPOINTS.map(e => e.route));
    for (const e of API_ENDPOINTS) {
      expect(docs, e.route).toContain(asHtml(e.path));
      expect(docs, e.route).toContain(e.method);
    }
    // 示例一律是占位符（JSX 会把 < > 转义，HTML 里是 &lt;你的 API Key&gt;）
    expect(docs).toContain('&lt;你的 API Key&gt;');
    expect(docs).toContain('&lt;平台地址&gt;');
    // 页面上没有这把 Key 的任何真实信息，也不渲染 Key 列表的内容（顶栏里登录者自己的邮箱不算）
    expect(docs).not.toContain(key);
    expect(docs).not.toContain(row.prefix);
    expect(docs).not.toContain(row.tokenHash);
    expect(docs).not.toContain('营销自动化');
    expect(docs).not.toContain('创建 API Key');
    expect(docs).not.toContain('data-api-key-id');

    const engineer = await loginAs(app, 'de@acme.com');
    expect((await engineer.get('/api-keys?tab=docs')).status).toBe(403);

    // 不带 tab 仍是原来的 Key 列表标签页
    const keys = await (await admin.get('/api-keys')).text();
    expect(keys).toContain('营销自动化');
    expect(keys).toContain(`${key.slice(0, 8)}…`);
    expect(keys).toContain('href="/api-keys?tab=docs"');
  });

  it('非管理员看不到入口、打不开页面，提交 403', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const engineer = await loginAs(app, 'de@acme.com');
    expect(await (await engineer.get('/')).text()).not.toContain('href="/api-keys"');
    const page = await engineer.get('/api-keys');
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('仅管理员可以管理外部系统 API Key');
    expect((await engineer.post('/api-keys', { intent: 'create', name: 'x' })).status).toBe(403);
    expect(await getDb().select().from(apiKeys)).toHaveLength(0);
  });
});

describe('Bearer 认证', () => {
  beforeEach(fresh);

  it('没有 Key、Key 错误、已吊销、租户已暂停一律同样的 401；成员的 cookie 不算数', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    const { key } = await createKey(admin, '营销自动化');
    const { key: other } = await createKey(admin, '客服系统');

    const ok = await call('/api/v1/catalog', key);
    expect(ok.status).toBe(200);
    const [used] = await getDb().select().from(apiKeys).where(eq(apiKeys.tokenHash, sha256(key)));
    expect(used.lastUsedAt).not.toBeNull();
    // 一分钟内再调用不再写最近使用时间
    expect((await call('/api/v1/catalog', key)).status).toBe(200);
    const [again] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, used.id));
    expect(again.lastUsedAt).toEqual(used.lastUsedAt);

    await admin.post('/api-keys', { intent: 'revoke', keyId: await keyIdOf(admin, '营销自动化') });

    const failures = [
      await call('/api/v1/catalog'),
      await call('/api/v1/catalog', 'not-a-key'),
      await call('/api/v1/catalog', key),
      // 成员已登录的浏览器不带 Key：不读 cookie
      await call('/api/v1/catalog', undefined, admin),
    ];
    expect((await call('/api/v1/catalog', other)).status).toBe(200);
    await suspendTenant(null, acme, '欠费');
    failures.push(await call('/api/v1/catalog', other));

    const bodies: string[] = [];
    for (const res of failures) {
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toHaveProperty('error');
  });

  it('只开点查的 Key：点查接口照常，目录与导出 403；先认证后判范围，401 的情形仍是 401', async () => {
    const acme = await newTenant('acme');
    const admin = await loginAs(app, 'admin@acme.com');
    const { key } = await createKey(admin, '只点查', ['consumers']);

    // 点查照常：还没有服务库与数据，落在平时的 503 / 404 上，而不是 403；这些是真实的使用，记下最近使用时间
    expect((await call('/api/v1/consumers/c1', key)).status).toBe(503);
    expect((await call('/api/v1/consumers/by-source/shop/c1', key)).status).toBe(404);
    const [used] = await getDb().select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.tokenHash, sha256(key)));
    expect(used.lastUsedAt).not.toBeNull();

    // 目录与导出（发起与查状态）都 403；文案只说是哪一类，不含 Key 前缀或租户信息
    const catalog = await call('/api/v1/catalog', key);
    expect(catalog.status).toBe(403);
    expect(await catalog.json()).toEqual({ error: '这把 Key 没有目录接口的权限' });
    for (const res of [
      await app.client().request('/api/v1/exports', { method: 'POST', headers: { Authorization: `Bearer ${key}` } }),
      await call(`/api/v1/exports/${randomUUID()}`, key),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: '这把 Key 没有导出接口的权限' });
    }
    // 路径大小写、结尾的 /、百分号编码绕不过范围：路由匹配逐段解码、不区分大小写、接受结尾 /，范围判定也一样
    for (const res of [
      await call('/api/v1/catalog/', key),
      await call('/api/v1/Catalog', key),
      await call('/api/v1/%63atalog', key),
      await call(`/api/v1/EXPORTS/${randomUUID()}`, key),
      await app.client().request('/api/v1/Exports', { method: 'POST', headers: { Authorization: `Bearer ${key}` } }),
    ]) expect(res.status).toBe(403);
    const body = JSON.stringify(await (await call('/api/v1/catalog', key)).json());
    expect(body).not.toContain(key.slice(0, 8));
    expect(body).not.toContain('acme');

    // 403 不算一次使用，不更新最近使用时间
    const [after] = await getDb().select({ lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.tokenHash, sha256(key)));
    expect(after.lastUsedAt).toEqual(used.lastUsedAt);

    // 先认证后判范围：没有 Key、Key 错误、已吊销在范围外的接口上仍是原来的 401
    expect((await call('/api/v1/catalog')).status).toBe(401);
    expect((await call('/api/v1/catalog', 'not-a-key')).status).toBe(401);
    await admin.post('/api-keys', { intent: 'revoke', keyId: await keyIdOf(admin, '只点查') });
    expect((await call('/api/v1/catalog', key)).status).toBe(401);
  });

  it('每个走 Bearer Key 的端点都登记了接口范围（新增接口忘了登记会失败）；判定逐段解码、不区分大小写、忽略结尾 /，不会把相似前缀算进来', () => {
    const bearer = API_ENDPOINTS.filter(e => e.auth.startsWith('Authorization: Bearer'));
    expect(bearer.length).toBeGreaterThan(0);
    for (const e of bearer) {
      const path = e.path.split('?')[0].replace(/<[^>]+>/g, 'x');
      expect(scopeOfPath(path), e.path).not.toBeNull();
    }
    expect(scopeOfPath('/api/v1/catalog/')).toBe('catalog');
    expect(scopeOfPath('/API/V1/Consumers/x')).toBe('consumers');
    expect(scopeOfPath('/api/v1/exports')).toBe('exports');
    expect(scopeOfPath('/api/v1/%63atalog')).toBe('catalog');
    expect(scopeOfPath('/api/v1/%E5')).toBeNull();
    expect(scopeOfPath('/api/v1/consumersx')).toBeNull();
    expect(scopeOfPath('/api/v1/exports-other')).toBeNull();
  });

  it('迁移默认：迁移前就有的 Key（插入时不带 scopes）三类全开，行为不变', async () => {
    const acme = await newTenant('acme');
    await loginAs(app, 'admin@acme.com');
    // 直接插一行不带 scopes：靠列默认补齐，等同迁移加列时已有 Key 拿到的取值
    await getDb().insert(apiKeys).values({
      tenantId: acme, name: '老 Key', prefix: 'legacyab', tokenHash: sha256('legacy-key-token'), createdByEmail: 'admin@acme.com',
    });
    const [legacy] = await getDb().select().from(apiKeys);
    expect(legacy.scopes).toEqual(['catalog', 'consumers', 'exports']);

    // 三类接口都过范围判定，行为与迁移前一致：目录 200、点查 503（还没有服务库）、导出发起走到请求体校验的 400
    expect((await call('/api/v1/catalog', 'legacy-key-token')).status).toBe(200);
    expect((await call('/api/v1/consumers/c1', 'legacy-key-token')).status).toBe(503);
    const exportCall = await app.client().request('/api/v1/exports', { method: 'POST', headers: { Authorization: 'Bearer legacy-key-token' } });
    expect(exportCall.status).toBe(400);
    expect(await exportCall.json()).toEqual({ error: '请求体必须是 JSON' });
  });
});

describe('目录接口', () => {
  beforeEach(fresh);

  it('返回本租户已发布的指标与标签的种类、键、当前版本、说明与发布时间；说明取当前版本的，没写为 null，草稿不列出，别的租户看不到', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com', 'data_engineer');
    await createDefinition(analyst, 'metric', 'revenue', `description: 旧说明\n${REVENUE}`);
    await publishDefinition(engineer, 'metric', 'revenue', 1);
    await saveDslDraft(analyst, 'metric', 'revenue', `description: 累计消费金额\n${REVENUE.replace('sum', 'avg')}`);
    await publishDefinition(engineer, 'metric', 'revenue', 2);
    await saveDslDraft(analyst, 'metric', 'revenue', `description: 草稿里的说明\n${REVENUE}`);
    await expect(saveDslDraft(analyst, 'metric', 'revenue', `description: ${'说'.repeat(501)}\n${REVENUE}`)).rejects.toMatchObject({ status: 400, issues: [expect.objectContaining({ path: 'description', message: '不能超过 500 字' })] });
    await createDefinition(analyst, 'tag', 'buyer', BUYER);
    await publishDefinition(engineer, 'tag', 'buyer', 1);
    await createDefinition(analyst, 'metric', 'draft_only', REVENUE);

    const globex = await newTenant('globex');
    await createDefinition(await memberOf(globex, 'analyst@globex.com', 'analyst'), 'metric', 'secret', REVENUE);
    await publishDefinition(await memberOf(globex, 'de@globex.com', 'data_engineer'), 'metric', 'secret', 1);

    const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
    const { key: globexKey } = await createKey(await loginAs(app, 'admin@globex.com'), '环球');

    const res = await call('/api/v1/catalog', key);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const { definitions } = await res.json();
    expect(definitions.map((d: { kind: string; key: string; version: number; description: string | null }) => [d.kind, d.key, d.version, d.description]))
      .toEqual([['metric', 'revenue', 2, '累计消费金额'], ['tag', 'buyer', 1, null]]);
    for (const d of definitions) expect(new Date(d.publishedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const theirs = await (await call('/api/v1/catalog', globexKey)).json();
    expect(theirs.definitions.map((d: { key: string }) => d.key)).toEqual(['secret']);
  });

  it('条目带业务知识里当前的业务说明（note）：取最新一版、没写或清空为 null、description 仍取 YAML；同名指标各自的说明只在本租户的目录里', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com', 'data_engineer');
    await createDefinition(analyst, 'metric', 'revenue', `description: 累计消费金额\n${REVENUE}`);
    await publishDefinition(engineer, 'metric', 'revenue', 1);
    await createDefinition(analyst, 'tag', 'buyer', BUYER);
    await publishDefinition(engineer, 'tag', 'buyer', 1);
    await createDefinition(analyst, 'metric', 'points', REVENUE);
    await publishDefinition(engineer, 'metric', 'points', 1);
    await saveBusinessNote(analyst, { targetId: 'metric:revenue', note: '旧版说明' });
    await saveBusinessNote(analyst, { targetId: 'metric:revenue', note: '财务口径：只算已支付' });
    await saveBusinessNote(analyst, { targetId: 'tag:buyer', note: '下过单的都算买家' });

    const globex = await newTenant('globex');
    const globexAnalyst = await memberOf(globex, 'analyst@globex.com', 'analyst');
    await createDefinition(globexAnalyst, 'metric', 'revenue', REVENUE);
    await publishDefinition(await memberOf(globex, 'de@globex.com', 'data_engineer'), 'metric', 'revenue', 1);
    await saveBusinessNote(globexAnalyst, { targetId: 'metric:revenue', note: '环球自己的口径' });

    const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
    const { key: globexKey } = await createKey(await loginAs(app, 'admin@globex.com'), '环球');
    const byTarget = async (k: string) => new Map<string, { description: string | null; note: string | null }>(
      (await (await call('/api/v1/catalog', k)).json()).definitions.map((d: { kind: string; key: string; description: string | null; note: string | null }) => [`${d.kind}:${d.key}`, d]));

    const acme1 = await byTarget(key);
    expect(acme1.get('metric:revenue')).toMatchObject({ description: '累计消费金额', note: '财务口径：只算已支付' });
    expect(acme1.get('tag:buyer')).toMatchObject({ description: null, note: '下过单的都算买家' });
    expect(acme1.get('metric:points')).toMatchObject({ note: null }); // 没写过说明的条目

    // 清空（空串）后 note 为 null，description 不受影响
    await saveBusinessNote(analyst, { targetId: 'metric:revenue', note: '' });
    const acme2 = await byTarget(key);
    expect(acme2.get('metric:revenue')).toMatchObject({ description: '累计消费金额', note: null });

    const theirs = await byTarget(globexKey);
    expect([...theirs.keys()]).toEqual(['metric:revenue']);
    expect(theirs.get('metric:revenue')).toMatchObject({ note: '环球自己的口径' });
  });

  it('A 租户管理员吊销不了 B 租户的 Key，B 的 Key 照常可用', async () => {
    await newTenant('acme');
    await newTenant('globex');
    const adminB = await loginAs(app, 'admin@globex.com');
    const { key } = await createKey(adminB, '环球');
    const id = await keyIdOf(adminB, '环球');

    const adminA = await loginAs(app, 'admin@acme.com');
    expect((await adminA.post('/api-keys', { intent: 'revoke', keyId: id })).status).toBe(404);
    expect(await (await adminA.get('/api-keys')).text()).not.toContain('环球');
    expect((await call('/api/v1/catalog', key)).status).toBe(200);
  });
});

/**
 * 身份打通与订单映射已发布，跑出 RFM 快照，双人发布指标 revenue、带城市维度的 revenue_by_city 与标签 value_tier，调度器跑空（服务库已生成）；
 * 返回租户、作者、数据源 ID（crm、loyalty、tracking，登记名 CRM、会员、埋点）、快照、当前服务库指针、一个有标签的消费者、夹具里那次合并的退役 ID 与现在的 ID，以及管理员创建的 Key
 */
async function servedTenant() {
  const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
  expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'succeeded' });
  // 映射合并已自动启用一张当天 asOf 的 rfm 快照（窗口里没有订单，是空表），服务库按统计日会选它；标记过期，让服务库与 of('rfm') 用上面这张有数据的
  await getDb().update(snapshotsTable).set({ expiredAt: new Date() }).where(and(eq(snapshotsTable.tenantId, acme), eq(snapshotsTable.template, 'rfm'),
    sql`${snapshotsTable.params}->>'asOf' <> '2024-07-01'`));
  await createDefinition(author, 'metric', 'revenue', REVENUE);
  await createDefinition(author, 'metric', 'revenue_by_city', `${REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`);
  await publishDefinition(reviewer, 'metric', 'revenue', 1);
  await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
  await drain();
  await createDefinition(author, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
  await publishDefinition(reviewer, 'tag', 'value_tier', 1);
  await drain();
  const snapshots = await listSnapshots(acme);
  const of = (template: string) => snapshots.find(s => s.template === template && !s.expiredAt)!;
  const table = (template: string) => `gold."${of(template).table.slice('gold.'.length)}"`;
  const [{ consumer_id: consumer }] = await onLake<{ consumer_id: string }>(acme,
    `SELECT t.consumer_id FROM ${table('tag:value_tier')} t JOIN ${table('rfm')} r USING (consumer_id) ORDER BY 1 LIMIT 1`);
  const [merged] = await onLake<{ old_id: string; new_id: string }>(acme, `SELECT old_id, new_id FROM silver._consumer_id_changes WHERE reason = 'merge'`);
  const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
  return { acme, author, sources, of, store: (await currentServingStore(acme))!, consumer, merged: merged!, key };
}

/**
 * 开通另一个租户（默认 globex）：结果层一张 RFM 表，里面只有一个与 acme 的消费者同 ID 的人（人群 globex_only），登记成快照并生成服务库；返回租户、快照 ID 与它的 Key
 */
async function otherTenant(consumer: string, slug = 'globex') {
  const globex = await newTenant(slug);
  const id = randomUUID();
  const table = `gold.rfm__${id}`;
  await onLake(globex, `CREATE TABLE gold."rfm__${id}" AS SELECT '${consumer}' AS consumer_id, 'globex_only' AS segment,
    1 AS r, 1 AS f, 1 AS m, 30 AS recency_days, 1::BIGINT AS frequency, 9.90::DECIMAL(18, 2) AS monetary`);
  const task = await runTask(globex, 'serving.build', {
    version: 1, target: servingPath((await lakeRow(globex))!.dataPath, 1), snapshots: [{ id, template: 'rfm', table }],
  });
  expect(task).toMatchObject({ status: 'succeeded' });
  await getDb().insert(snapshotsTable).values({
    id, tenantId: globex, template: 'rfm', taskId: task!.id, table, params: {}, rowCount: 1, expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { key } = await createKey(await loginAs(app, `admin@${slug}.com`), '环球');
  return { tenantId: globex, snapshot: id, key };
}

const lookup = async (path: string, key: string) => {
  const res = await call(path, key);
  return { status: res.status, body: await res.json() };
};

describe('点查接口', () => {
  beforeEach(fresh);

  it('还没有服务库时 503', async () => {
    await newTenant('acme');
    const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
    expect(await lookup('/api/v1/consumers/anyone', key)).toEqual({ status: 503, body: { error: expect.any(String) } });
  });

  it('?snapshot= 只返回那张快照表里的结果；过期、不存在的快照与快照里没有的人 404', async () => {
    const { acme, of, consumer, key } = await servedTenant();
    const rfm = await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, key);
    expect(rfm.status).toBe(200);
    expect(rfm.body).toMatchObject({ consumer_id: consumer, requested_id: consumer, serving_version: null, tags: {}, metrics: {}, rfm: { segment: expect.any(String) } });
    expect(rfm.body.snapshots).toEqual([{
      id: of('rfm').id, template: 'rfm', definitionVersion: of('rfm').definitionVersion, createdAt: of('rfm').createdAt.toISOString(), incomplete: false,
    }]);
    const served = (await lookup(`/api/v1/consumers/${consumer}`, key)).body;
    expect(rfm.body.rfm).toEqual(served.rfm);

    const tag = await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('tag:value_tier').id}`, key);
    expect(tag.body).toMatchObject({ tags: served.tags, metrics: {}, rfm: null });
    const metric = await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('metric:revenue_by_city').id}`, key);
    expect(metric.body).toMatchObject({ tags: {}, metrics: { revenue_by_city: served.metrics.revenue_by_city }, rfm: null });

    expect((await lookup(`/api/v1/consumers/nobody?snapshot=${of('rfm').id}`, key)).status).toBe(404);
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=00000000-0000-0000-0000-000000000000`, key)).status).toBe(404);
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=not-a-uuid`, key)).status).toBe(404);
    await getDb().update(snapshotsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(snapshotsTable.id, of('rfm').id));
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, key)).status).toBe(404);
    await getDb().update(snapshotsTable).set({ expiredAt: new Date() }).where(and(eq(snapshotsTable.tenantId, acme), eq(snapshotsTable.id, of('tag:value_tier').id)));
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('tag:value_tier').id}`, key)).status).toBe(404);
  });

  it('新版本切换时每个响应只读一个版本：版本号与内容一致，之后都读新版', async () => {
    const { acme, author, store, consumer, key } = await servedTenant();
    expect((await lookup(`/api/v1/consumers/${consumer}`, key)).body.serving_version).toBe(store.version);
    // 删掉标签定义后重建：新版没有标签
    await deleteDefinition(author, 'tag', 'value_tier');
    expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'succeeded' });
    await drain();
    const next = (await currentServingStore(acme))!;
    expect(next.version).toBeGreaterThan(store.version);

    // 新版本下载期间并发的请求：读旧版的有标签，读新版的没有
    const burst = await Promise.all(Array.from({ length: 20 }, () => lookup(`/api/v1/consumers/${consumer}`, key)));
    for (const { status, body } of burst) {
      expect(status).toBe(200);
      expect([store.version, next.version]).toContain(body.serving_version);
      expect(Object.keys(body.tags)).toEqual(body.serving_version === store.version ? ['value_tier'] : []);
      expect(body.snapshots.some((s: { template: string }) => s.template === 'tag:value_tier')).toBe(body.serving_version === store.version);
    }
    await expect.poll(async () => (await lookup(`/api/v1/consumers/${consumer}`, key)).body.serving_version).toBe(next.version);
  });
});

/** 这个消费者在会员数据源里的一个源端 ID */
const loyaltyIdOf = async (tenantId: string, loyalty: string, consumer: string) => (await onLake<{ customer_id: string }>(tenantId,
  `SELECT customer_id FROM silver._identities WHERE _source = '${loyalty}' AND consumer_id = '${consumer}' ORDER BY 1 LIMIT 1`))[0]!.customer_id;

const bySource = (source: string, customerId: string) => `/api/v1/consumers/by-source/${encodeURIComponent(source)}/${encodeURIComponent(customerId)}`;

describe('按数据源点查', () => {
  beforeEach(fresh);

  it('按数据源登记名 + 源端 ID 查，结果与按统一消费者 ID 查的逐字段相同；被合并退役的源记录拿到现在的 ID；源端 ID 带 / 与空格时编码后能查到', async () => {
    const { acme, sources, consumer, merged, key } = await servedTenant();
    const own = await loyaltyIdOf(acme, sources.loyalty, consumer);
    const byId = await lookup(`/api/v1/consumers/${consumer}`, key);
    expect(await lookup(bySource('会员', own), key)).toEqual({ status: 200, body: { ...byId.body, requested_id: own } });

    // 退役 ID 合并前的源记录：现在属于合并后的人
    const [member] = await onLake<{ _source: string; customer_id: string }>(acme,
      `SELECT _source, customer_id FROM silver._consumer_id_members WHERE consumer_id = '${merged.old_id}' ORDER BY ALL LIMIT 1`);
    const [{ name }] = await getDb().select({ name: sourcesTable.name }).from(sourcesTable).where(eq(sourcesTable.id, member!._source));
    const retired = await lookup(bySource(name, member!.customer_id), key);
    expect(retired).toMatchObject({ status: 200, body: { consumer_id: merged.new_id, requested_id: member!.customer_id } });
    expect(retired.body).toEqual({ ...(await lookup(`/api/v1/consumers/${merged.new_id}`, key)).body, requested_id: member!.customer_id });

    await onLake(acme, `INSERT INTO silver._identities VALUES ('${sources.crm}', 'M/1 2', '${consumer}'), ('${sources.crm}', 'ghost', 'no-results')`);
    await enqueueServingBuild(acme);
    await drain();
    // 等新版生效（下载完之前仍读旧版）
    await expect.poll(async () => (await lookup(bySource('CRM', 'M/1 2'), key)).status).toBe(200);
    expect((await lookup(bySource('CRM', 'M/1 2'), key)).body).toMatchObject({ consumer_id: consumer, requested_id: 'M/1 2' });
    // 查到人但标签、指标、RFM 都没有：404，提示与数据源、源端 ID 不存在都不同
    const empty = await lookup(bySource('CRM', 'ghost'), key);
    expect(empty).toEqual({ status: 404, body: { error: expect.any(String) } });
    expect([(await lookup(bySource('没有', 'ghost'), key)).body.error, (await lookup(bySource('CRM', 'nobody'), key)).body.error]).not.toContain(empty.body.error);
  });
});

describe('点查的隔离', () => {
  beforeEach(fresh);

  it('A、B 两个租户有同名数据源、同一个源端 ID 时各自只查到本租户的人；A 的 Key 用只在 B 存在的数据源名 404', async () => {
    const { acme, sources, consumer, key } = await servedTenant();
    const own = await loyaltyIdOf(acme, sources.loyalty, consumer);
    const globex = await otherTenant('globex-person');
    const { tenantId } = globex;
    const [space] = await getDb().select({ id: spacesTable.id }).from(spacesTable).where(and(eq(spacesTable.tenantId, tenantId), eq(spacesTable.isDefault, true)));
    const [loyalty, only] = await getDb().insert(sourcesTable).values(['会员', '环球专属'].map(name => ({
      tenantId, spaceId: space!.id, name, kind: 'postgres' as const, config: {}, credentials: '',
    }))).returning({ id: sourcesTable.id }).then(r => r.map(x => x.id));
    await onLake(tenantId, `CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      INSERT INTO silver._identities VALUES ('${loyalty}', '${own}', 'globex-person'), ('${only}', 'g1', 'globex-person')`);
    expect(await runTask(tenantId, 'serving.build', {
      version: 2, target: servingPath((await lakeRow(tenantId))!.dataPath, 2), snapshots: [{ id: globex.snapshot, template: 'rfm', table: `gold.rfm__${globex.snapshot}` }],
    })).toMatchObject({ status: 'succeeded' });

    expect((await lookup(bySource('会员', own), key)).body).toMatchObject({ consumer_id: consumer });
    expect((await lookup(bySource('会员', own), globex.key)).body).toMatchObject({ consumer_id: 'globex-person', rfm: { segment: 'globex_only' } });
    expect((await lookup(bySource('环球专属', 'g1'), globex.key)).status).toBe(200);
    expect(await lookup(bySource('环球专属', 'g1'), key)).toEqual({ status: 404, body: { error: expect.any(String) } });
  });

  it('Bearer Key 打不开成员页面（跳登录），也没有通往标准层、原始层或沙箱的接口', async () => {
    const acme = await newTenant('acme');
    const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
    for (const path of ['/', '/mappings', '/model', '/lineage', '/sources', '/entities', '/analytics', '/quality', '/api-keys', '/audit', '/pii/reveal']) {
      const res = await call(path, key);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('Location'), path).toMatch(/^\/login/);
    }
    for (const path of ['/api/v1/silver/customer', '/api/v1/bronze', '/api/v1/sandbox', '/api/v1/consumers', '/api/v1/consumers/x/raw']) {
      expect((await call(path, key)).status, path).toBe(404);
    }
    expect(await getDb().select().from(tasks).where(eq(tasks.tenantId, acme))).toEqual([]);
  });

  it('有沙箱表（分享出去的也一样）时，重建的服务库与目录接口里都没有它', async () => {
    const { acme, store, key } = await servedTenant();
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await memberOf(acme, 'de2@acme.com', 'data_engineer');
    await saveAsSandbox(analyst, 'leak_probe', "SELECT 'sandbox_only' AS segment");
    await shareSandboxTable(analyst, 'leak_probe', 'de2@acme.com');
    await enqueueServingBuild(acme);
    await drain();

    const next = (await currentServingStore(acme))!;
    expect(next.version).toBeGreaterThan(store.version);
    const builds = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'serving.build')));
    expect(JSON.stringify(builds.map(t => t.params))).not.toMatch(/sandbox|leak_probe/);
    expect(JSON.stringify(next.snapshots)).not.toMatch(/sandbox|leak_probe/);

    const instance = await DuckDBInstance.create(':memory:');
    const con = await instance.connect();
    try {
      await con.run(`ATTACH '${next.path}' AS s (READ_ONLY, ENCRYPTION_KEY '${await tenantServingKey(acme)}')`);
      const tables = (await con.runAndReadAll(`SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_catalog = 's'`))
        .getRowObjectsJson().map(r => String(r.t));
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.filter(t => /sandbox|leak_probe/.test(t))).toEqual([]);
      const segments = (await con.runAndReadAll(`SELECT count(*) AS n FROM s.rfm WHERE segment = 'sandbox_only'`)).getRowObjectsJson();
      expect(segments).toEqual([{ n: '0' }]);
    } finally {
      con.closeSync();
      instance.closeSync();
    }

    const catalog = await call('/api/v1/catalog', key);
    expect(catalog.status).toBe(200);
    expect(await catalog.text()).not.toMatch(/sandbox|leak_probe/);
  });
});

// 点查用例共用一次 servedTenant()：这三组并列写在文件末尾、中间没有每用例清库的组。哪一组先跑（-t 单独跑时就是那一组），
// 它的 beforeAll 清库并造数据，其余组 await 同一个 Promise。用例只查接口；改数据源名的那个在 finally 里改回原名，
// 查隔离的那个另开租户 globex（不碰 acme）；所以组里的用例不要断言 globex 不存在或租户数
let servedOnce: ReturnType<typeof servedTenant> | undefined;
const sharedServed = () => (servedOnce ??= fresh().then(servedTenant));
type ServedFixture = Awaited<ReturnType<typeof servedTenant>>;

describe('点查接口', () => {
  let shared: ServedFixture;
  beforeAll(async () => { shared = await sharedServed(); }, 180_000); // 共用的点查夹具（打通、RFM、发布指标与标签、生成服务库），并行跑满时超过默认 hookTimeout 60 s

  it('从当前服务库返回标签、指标（带维度）、RFM 与快照信息；退役的旧 ID 换成现在的 ID；没有这个人 404；没有明文', async () => {
    const { store, consumer, merged, key } = shared;
    const { status, body } = await lookup(`/api/v1/consumers/${consumer}`, key);
    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(['consumer_id', 'requested_id', 'serving_version', 'tags', 'metrics', 'rfm', 'snapshots']);
    expect(body).toMatchObject({ consumer_id: consumer, requested_id: consumer, serving_version: store.version });
    expect(body.tags).toEqual({ value_tier: expect.stringMatching(/^(high|low)$/) });
    expect(body.metrics.revenue).toEqual([{ dims: {}, value: expect.any(Number) }]);
    expect(body.metrics.revenue_by_city).toEqual([{ dims: { city: expect.any(String) }, value: expect.any(Number) }]);
    expect(body.rfm).toEqual({
      segment: expect.any(String), r: expect.any(Number), f: expect.any(Number), m: expect.any(Number),
      recency_days: expect.any(Number), frequency: expect.any(Number), monetary: expect.stringMatching(/^\d+\.\d{2}$/),
    });
    expect(body.snapshots).toEqual(store.snapshots);
    // 手机号前后不能紧挨数字或字母，免得哈希、UUID 里的数字串误报
    expect(JSON.stringify(body)).not.toMatch(/@|(?<![0-9a-z])1[3-9]\d{9}(?![0-9a-z])/i);

    const retired = await lookup(`/api/v1/consumers/${merged.old_id}`, key);
    expect(retired).toMatchObject({ status: 200, body: { consumer_id: merged.new_id, requested_id: merged.old_id, serving_version: store.version } });
    expect(retired.body).toEqual({ ...(await lookup(`/api/v1/consumers/${merged.new_id}`, key)).body, requested_id: merged.old_id });

    expect(await lookup('/api/v1/consumers/nobody', key)).toEqual({ status: 404, body: { error: expect.any(String) } });
    expect((await call(`/api/v1/consumers/${consumer}`)).status).toBe(401);
  });

  it('成功的点查按天记入 api_key_usage：byId 与 bySource 各自加 1、重复调用同一行累加；404、?snapshot=、by-source 带 snapshot 400、没有 Key 401 都不记', async () => {
    const { acme, of, sources, consumer, key } = shared;
    const keyId = await keyIdOf(await loginAs(app, 'admin@acme.com'), '营销自动化');
    const own = await loyaltyIdOf(acme, sources.loyalty, consumer);
    // 共用夹具会被同组的其他用例调用，计数有累计：一律断言前后差值
    const sumsOf = async () => {
      const rows = await getDb().select({ endpoint: apiKeyUsage.endpoint, calls: apiKeyUsage.calls }).from(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, keyId));
      const sums: Record<string, number> = {};
      for (const r of rows) sums[r.endpoint] = (sums[r.endpoint] ?? 0) + r.calls;
      return sums;
    };
    const rowsOf = (endpoint: string) => getDb().select({ day: apiKeyUsage.day, calls: apiKeyUsage.calls }).from(apiKeyUsage)
      .where(and(eq(apiKeyUsage.apiKeyId, keyId), eq(apiKeyUsage.endpoint, endpoint)));
    const before = await sumsOf();
    const beforeById = await rowsOf('consumers.byId');
    const today = new Date().toISOString().slice(0, 10); // day 用 UTC 日期

    expect((await lookup(`/api/v1/consumers/${consumer}`, key)).status).toBe(200);
    expect((await lookup(bySource('会员', own), key)).status).toBe(200);
    expect((await lookup('/api/v1/consumers/nobody', key)).status).toBe(404);
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, key)).status).toBe(200);
    expect((await lookup(`${bySource('会员', own)}?snapshot=${of('rfm').id}`, key)).status).toBe(400);
    expect((await call(`/api/v1/consumers/${consumer}`)).status).toBe(401);
    expect((await lookup(`/api/v1/consumers/${consumer}`, key)).status).toBe(200); // 同一个 Key 再调一次

    const after = await sumsOf();
    expect((after['consumers.byId'] ?? 0) - (before['consumers.byId'] ?? 0)).toBe(2);
    expect((after['consumers.bySource'] ?? 0) - (before['consumers.bySource'] ?? 0)).toBe(1);
    const afterById = await rowsOf('consumers.byId');
    expect(afterById.find(r => r.day === today)).toEqual({ day: today, calls: (beforeById.find(r => r.day === today)?.calls ?? 0) + 2 });
    expect(afterById).toHaveLength(beforeById.length + (beforeById.some(r => r.day === today) ? 0 : 1)); // 同一行累加，不另开行
  });
});

describe('按数据源点查', () => {
  let shared: ServedFixture;
  beforeAll(async () => { shared = await sharedServed(); }, 180_000); // 共用的点查夹具（打通、RFM、发布指标与标签、生成服务库），并行跑满时超过默认 hookTimeout 60 s

  it('数据源名不存在、源端 ID 不存在一律 404 且提示不同；改名后旧名 404、新名立刻可查（不重建）；带 ?snapshot= 时 400', async () => {
    const { acme, of, sources, consumer, key } = shared;
    const own = await loyaltyIdOf(acme, sources.loyalty, consumer);
    const noSource = await lookup(bySource('没有', own), key);
    const noConsumer = await lookup(bySource('会员', 'nobody'), key);
    expect(noSource).toEqual({ status: 404, body: { error: expect.any(String) } });
    expect(noConsumer).toEqual({ status: 404, body: { error: expect.any(String) } });
    expect(noSource.body.error).not.toBe(noConsumer.body.error);
    // 按原样比较，不忽略大小写
    expect((await lookup(bySource('crm', own), key)).body).toEqual(noSource.body);
    expect(await lookup(bySource('会员', 'x'.repeat(257)), key)).toEqual(noConsumer);

    const version = (await currentServingStore(acme))!.version;
    const rename = (name: string) => getDb().update(sourcesTable).set({ name }).where(eq(sourcesTable.id, sources.loyalty));
    await rename('会员中心');
    try {
      expect((await lookup(bySource('会员', own), key)).body).toEqual(noSource.body);
      expect(await lookup(bySource('会员中心', own), key)).toMatchObject({ status: 200, body: { consumer_id: consumer, serving_version: version } });

      expect(await lookup(`${bySource('会员中心', own)}?snapshot=${of('rfm').id}`, key)).toEqual({ status: 400, body: { error: expect.any(String) } });
      expect((await call(bySource('会员中心', own))).status).toBe(401);
    } finally {
      await rename('会员'); // 共用夹具：断言失败也改回原名
    }
  });
});

describe('点查的隔离', () => {
  let shared: ServedFixture;
  beforeAll(async () => { shared = await sharedServed(); }, 180_000); // 共用的点查夹具（打通、RFM、发布指标与标签、生成服务库），并行跑满时超过默认 hookTimeout 60 s

  it('A 租户的 Key 查不到 B 租户的消费者与快照，B 的 Key 也查不到 A 的：同一个 ID 各自只读到本租户的数据', async () => {
    const { of, consumer, key } = shared;
    const globex = await otherTenant(consumer);
    const ours = await lookup(`/api/v1/consumers/${consumer}`, key);
    expect(ours.status).toBe(200);
    expect(ours.body.rfm.segment).not.toBe('globex_only');
    const theirs = await lookup(`/api/v1/consumers/${consumer}`, globex.key);
    expect(theirs).toMatchObject({ status: 200, body: { tags: {}, metrics: {}, rfm: { segment: 'globex_only' }, serving_version: 1 } });
    expect(theirs.body.snapshots.map((s: { id: string }) => s.id)).toEqual([globex.snapshot]);

    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, globex.key)).status).toBe(404);
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${globex.snapshot}`, key)).status).toBe(404);
    expect((await lookup(`/api/v1/consumers/${consumer}?snapshot=${globex.snapshot}`, globex.key)).body.rfm.segment).toBe('globex_only');
  });

  it('计数按租户隔离：A、B 两个租户的 Key 各自调用后，api_key_usage 里每个 keyId 的行都属于它自己的租户', async () => {
    const { acme, consumer, key } = shared;
    const other = await otherTenant(consumer, 'initech'); // 另开一个租户，不碰 acme；globex 已被上面的用例占用
    const acmeKeyId = await keyIdOf(await loginAs(app, 'admin@acme.com'), '营销自动化');
    const otherKeyId = await keyIdOf(await loginAs(app, 'admin@initech.com'), '环球');
    expect((await lookup(`/api/v1/consumers/${consumer}`, key)).status).toBe(200);
    expect((await lookup(`/api/v1/consumers/${consumer}`, other.key)).status).toBe(200);

    const rows = await getDb().select({ tenantId: apiKeyUsage.tenantId, apiKeyId: apiKeyUsage.apiKeyId }).from(apiKeyUsage);
    const ours = rows.filter(r => r.apiKeyId === acmeKeyId);
    const theirs = rows.filter(r => r.apiKeyId === otherKeyId);
    expect(ours.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(new Set(ours.map(r => r.tenantId))).toEqual(new Set([acme]));
    expect(new Set(theirs.map(r => r.tenantId))).toEqual(new Set([other.tenantId]));
  });
});

// 数据范围（ADR-0061「数据范围」，#975）：Key 带 data_scope，点查响应裁到范围内；组里另建自己的 Key 再改它的 data_scope，
// 不动共用夹具的 key（计数、隔离用例按名字找它），改完不用恢复
describe('点查的数据范围', () => {
  let shared: ServedFixture;
  beforeAll(async () => { shared = await sharedServed(); }, 180_000); // 共用的点查夹具（打通、RFM、发布指标与标签、生成服务库），并行跑满时超过默认 hookTimeout 60 s

  it('默认 {"all":true}（迁移默认值）行为不变；收窄后按 ID / 按源只返回范围内的标签、指标与 RFM、快照只列范围内的；范围内什么都没有时 200 空对象；计数照旧', async () => {
    const { acme, sources, consumer, key } = shared;
    const admin = await loginAs(app, 'admin@acme.com');
    // 共用夹具的 key 是页面创建的（不带 data_scope）：迁移默认值应是 {"all":true}
    expect(await getDb().select({ dataScope: apiKeys.dataScope }).from(apiKeys).where(eq(apiKeys.tokenHash, sha256(key))))
      .toEqual([{ dataScope: { all: true } }]);
    const { key: scoped } = await createKey(admin, '数据范围');
    const scopeOf = (dataScope: ApiDataScope) => getDb().update(apiKeys).set({ dataScope }).where(eq(apiKeys.tokenHash, sha256(scoped)));
    await scopeOf({ all: false, tags: ['value_tier'], metrics: ['revenue'], rfm: false });

    const full = (await lookup(`/api/v1/consumers/${consumer}`, key)).body; // 默认 Key 的全量返回，与上面用例逐字段断言的相同（验收 1）
    const r = await lookup(`/api/v1/consumers/${consumer}`, scoped);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ...full,
      metrics: { revenue: full.metrics.revenue }, // revenue_by_city 不在范围里，消失
      rfm: null, // rfm: false
      snapshots: full.snapshots.filter((s: { template: string }) => ['tag:value_tier', 'metric:revenue'].includes(s.template)),
    });

    // 按数据源查同一个结果：与按 ID 查的逐字段相同（requested_id 是源端 ID）
    const own = await loyaltyIdOf(acme, sources.loyalty, consumer);
    expect(await lookup(bySource('会员', own), scoped)).toEqual({ status: 200, body: { ...r.body, requested_id: own } });

    // 范围内什么都没有（人在服务库里）：200 与空的 tags / metrics，不是 404，不暴露范围外有数据
    await scopeOf({ all: false, tags: ['nope'], metrics: [], rfm: false });
    expect(await lookup(`/api/v1/consumers/${consumer}`, scoped)).toEqual({
      status: 200,
      body: { consumer_id: consumer, requested_id: consumer, serving_version: full.serving_version, tags: {}, metrics: {}, rfm: null, snapshots: [] },
    });

    // 调用计数照旧：这把 Key 只有本用例用过，byId 两次、bySource 一次
    const keyId = await keyIdOf(admin, '数据范围');
    const rows = await getDb().select({ endpoint: apiKeyUsage.endpoint, calls: apiKeyUsage.calls }).from(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, keyId));
    const sums: Record<string, number> = {};
    for (const row of rows) sums[row.endpoint] = (sums[row.endpoint] ?? 0) + row.calls;
    expect(sums).toEqual({ 'consumers.byId': 2, 'consumers.bySource': 1 });
  });

  it('?snapshot= 指向范围外的快照 404 且文案与真不存在相同（不会先报「没有这个消费者」）；范围内的照常只读那张表', async () => {
    const { of, consumer } = shared;
    const admin = await loginAs(app, 'admin@acme.com');
    const { key: scoped } = await createKey(admin, '数据范围快照');
    const scopeOf = (dataScope: ApiDataScope) => getDb().update(apiKeys).set({ dataScope }).where(eq(apiKeys.tokenHash, sha256(scoped)));
    await scopeOf({ all: false, tags: ['value_tier'], metrics: [], rfm: false });

    // 范围内的照常：只读那张快照表（snapshots 也只剩这一张）
    const served = (await lookup(`/api/v1/consumers/${consumer}`, scoped)).body;
    const tag = await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('tag:value_tier').id}`, scoped);
    expect(tag.status).toBe(200);
    expect(tag.body).toMatchObject({ consumer_id: consumer, serving_version: null, tags: served.tags, metrics: {}, rfm: null });
    expect(tag.body.snapshots.map((s: { id: string }) => s.id)).toEqual([of('tag:value_tier').id]);

    // 范围外的定义（metric 不在范围）与 rfm:false 时的 RFM 快照：404，文案与真不存在的快照相同
    const missing = await lookup(`/api/v1/consumers/${consumer}?snapshot=00000000-0000-0000-0000-000000000000`, scoped);
    expect(missing).toEqual({ status: 404, body: { error: '快照不存在或已过期' } });
    expect(await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('metric:revenue').id}`, scoped)).toEqual(missing);
    expect(await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, scoped)).toEqual(missing);
    // 范围外的快照即使查一个不在表里的人也报同样的 404（判定在 lookupSnapshot 之前），不会先报「没有这个消费者」
    expect(await lookup(`/api/v1/consumers/nobody?snapshot=${of('rfm').id}`, scoped)).toEqual(missing);
    // 对照：范围内的快照查一个不在表里的人，报的是「没有这个消费者」，与范围外的不同
    expect((await lookup(`/api/v1/consumers/nobody?snapshot=${of('tag:value_tier').id}`, scoped)).body.error).not.toBe(missing.body.error);

    // rfm 开着时 RFM 快照照常可查
    await scopeOf({ all: false, tags: [], metrics: [], rfm: true });
    const rfm = await lookup(`/api/v1/consumers/${consumer}?snapshot=${of('rfm').id}`, scoped);
    expect(rfm.status).toBe(200);
    expect(rfm.body.rfm).not.toBeNull();
    expect(rfm.body.rfm).toEqual((await lookup(`/api/v1/consumers/${consumer}`, scoped)).body.rfm); // 服务库里的 rfm 与 RFM 快照里的一致（上面用例也断言过）
  });
});

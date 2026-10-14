// test/http/api.test.ts —— 外部系统接口的 HTTP 接缝：管理员在「API Key」页创建（明文只展示一次）、吊销；外部系统带 Bearer Key 调 /api/v1/catalog。
// 非管理员看不到页面；没有 Key、Key 错误、已吊销、租户已暂停一律同样的 401，成员的 cookie 不算数；A 租户管理员吊销不了 B 的 Key，各自的 Key 只看到本租户的目录
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { apiKeys, auditLogs } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { suspendTenant } from '../../app/.server/tenants';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';
const BUYER = 'metric: revenue\nrules:\n  - { value: high, when: { gte: 1 } }\ndefault: low\n';

/** 管理员在页面上创建一把 Key，返回明文与创建那次响应的 HTML */
async function createKey(admin: Client, name: string) {
  const res = await admin.post('/api-keys', { intent: 'create', name });
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
  it('管理员创建后只展示一次明文，列表只有名称、前缀、创建人与时间，库里只存哈希；吊销后审计有记录', async () => {
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
});

describe('目录接口', () => {
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

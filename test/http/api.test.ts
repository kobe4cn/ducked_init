// test/http/api.test.ts —— 外部系统接口的 HTTP 接缝：管理员在「API Key」页创建（明文只展示一次）、吊销；外部系统带 Bearer Key 调 /api/v1/catalog。
// 非管理员看不到页面；没有 Key、Key 错误、已吊销、租户已暂停一律同样的 401，成员的 cookie 不算数；A 租户管理员吊销不了 B 的 Key，各自的 Key 只看到本租户的目录。
// 点查 /api/v1/consumers/:id：数据由身份打通夹具、RFM 与已发布的指标、标签跑出快照，调度器自动生成服务库；?snapshot= 只读查湖里那张快照表。
// Bearer Key 打不开成员页面，也没有通往标准层、沙箱的接口；成员存下（并分享出去）的沙箱表不进服务库，也不出现在目录接口里
import { randomUUID } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { apiKeys, auditLogs, snapshots as snapshotsTable, sources as sourcesTable, spaces as spacesTable, tasks } from '../../app/.server/db/schema';
import { createDefinition, deleteDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { lakeRow } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { servingPath } from '../../app/.server/pipeline/serving-engine';
import { tenantServingKey } from '../../app/.server/secrets';
import { currentServingStore, enqueueServingBuild } from '../../app/.server/serving-store';
import { listSnapshots } from '../../app/.server/snapshots';
import { suspendTenant } from '../../app/.server/tenants';
import { saveAsSandbox, shareSandboxTable } from '../../app/.server/workbench';
import { memberOf, newTenant, onLake, runTask } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
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

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/**
 * 身份打通与订单映射已发布，跑出 RFM 快照，双人发布指标 revenue、带城市维度的 revenue_by_city 与标签 value_tier，调度器跑空（服务库已生成）；
 * 返回租户、作者、数据源 ID（crm、loyalty、tracking，登记名 CRM、会员、埋点）、快照、当前服务库指针、一个有标签的消费者、夹具里那次合并的退役 ID 与现在的 ID，以及管理员创建的 Key
 */
async function servedTenant() {
  const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
  expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'succeeded' });
  await createDefinition(author, 'metric', 'revenue', REVENUE);
  await createDefinition(author, 'metric', 'revenue_by_city', `${REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`);
  await publishDefinition(reviewer, 'metric', 'revenue', 1);
  await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
  await drain();
  await createDefinition(author, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
  await publishDefinition(reviewer, 'tag', 'value_tier', 1);
  await drain();
  const snapshots = await listSnapshots(acme);
  const of = (template: string) => snapshots.find(s => s.template === template)!;
  const table = (template: string) => `gold."${of(template).table.slice('gold.'.length)}"`;
  const [{ consumer_id: consumer }] = await onLake<{ consumer_id: string }>(acme,
    `SELECT t.consumer_id FROM ${table('tag:value_tier')} t JOIN ${table('rfm')} r USING (consumer_id) ORDER BY 1 LIMIT 1`);
  const [merged] = await onLake<{ old_id: string; new_id: string }>(acme, `SELECT old_id, new_id FROM silver._consumer_id_changes WHERE reason = 'merge'`);
  const { key } = await createKey(await loginAs(app, 'admin@acme.com'), '营销自动化');
  return { acme, author, sources, of, store: (await currentServingStore(acme))!, consumer, merged: merged!, key };
}

/**
 * 开通租户 globex：结果层一张 RFM 表，里面只有一个与 acme 的消费者同 ID 的人（人群 globex_only），登记成快照并生成服务库；返回租户、快照 ID 与它的 Key
 */
async function otherTenant(consumer: string) {
  const globex = await newTenant('globex');
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
  const { key } = await createKey(await loginAs(app, 'admin@globex.com'), '环球');
  return { tenantId: globex, snapshot: id, key };
}

const lookup = async (path: string, key: string) => {
  const res = await call(path, key);
  return { status: res.status, body: await res.json() };
};

describe('点查接口', () => {
  it('从当前服务库返回标签、指标（带维度）、RFM 与快照信息；退役的旧 ID 换成现在的 ID；没有这个人 404；没有明文', async () => {
    const { store, consumer, merged, key } = await servedTenant();
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

  it('数据源名不存在、源端 ID 不存在一律 404 且提示不同；改名后旧名 404、新名立刻可查（不重建）；带 ?snapshot= 时 400', async () => {
    const { acme, of, sources, consumer, key } = await servedTenant();
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
    await getDb().update(sourcesTable).set({ name: '会员中心' }).where(eq(sourcesTable.id, sources.loyalty));
    expect((await lookup(bySource('会员', own), key)).body).toEqual(noSource.body);
    expect(await lookup(bySource('会员中心', own), key)).toMatchObject({ status: 200, body: { consumer_id: consumer, serving_version: version } });

    expect(await lookup(`${bySource('会员中心', own)}?snapshot=${of('rfm').id}`, key)).toEqual({ status: 400, body: { error: expect.any(String) } });
    expect((await call(bySource('会员中心', own))).status).toBe(401);
  });
});

describe('点查的隔离', () => {
  it('A 租户的 Key 查不到 B 租户的消费者与快照，B 的 Key 也查不到 A 的：同一个 ID 各自只读到本租户的数据', async () => {
    const { of, consumer, key } = await servedTenant();
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

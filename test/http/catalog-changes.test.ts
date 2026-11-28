// test/http/catalog-changes.test.ts —— 目录变更记录的 HTTP 接缝（ADR-0041）：成员从数据地图页头进入 /catalog/changes，按版本倒序看到各版的原因与条目差异，?since=N 只看 N 之后的版本；
// 查看者看不到 source: / table: 条目，数据源相关原因（含源视图发布与删除数据源）的版本只显示「数据源结构变化」、不列明细（ADR-0005）；还没有版本时显示空状态
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_ACTIONS } from '../../app/.server/catalog/tx';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogVersions, sources, sourceTables, tasks } from '../../app/.server/db/schema';
import { defaultSpaceOf, memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const versionsOf = (html: string) => [...html.matchAll(/data-catalog-version="(\d+)"/g)].map(m => Number(m[1]));

describe('目录变更记录', () => {
  it('管理员从数据地图进入，按版本倒序看到原因与条目差异；查看者看不到源表条目与数据源相关明细；?since 只看之后的版本', async () => {
    const { acme } = await publishedIdentitySources();
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post('/lineage?node=event', { intent: 'note', entity: 'event', field: 'event_type', note: 'login 是登录' })).status).toBe(302);

    expect(await (await admin.get('/lineage')).text()).toContain('href="/catalog/changes"');

    const res = await admin.get('/catalog/changes');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('目录变更记录');
    const versions = versionsOf(html);
    expect(versions.length).toBeGreaterThan(1);
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
    expect(html).toContain(`当前目录版本 ${versions[0]}`);
    // 最新一版是业务说明，改动 field:event.event_type 的 note
    const latest = html.slice(html.indexOf(`data-catalog-version="${versions[0]}"`), html.indexOf(`data-catalog-version="${versions[1]}"`));
    expect(latest).toContain('data-reason="business_note.updated"');
    expect(latest).toContain('修改业务说明');
    expect(latest).toMatch(/data-diff-id="field:event\.event_type"[^>]*data-diff-change="changed"/);
    expect(latest).toContain('变了：note');
    expect(html).toContain('data-diff-id="table:');
    expect(html).toContain('data-diff-id="source:');

    const since = await (await admin.get(`/catalog/changes?since=${versions[1]}`)).text();
    expect(versionsOf(since)).toEqual([versions[0]]);

    await memberOf(acme, 'analyst@acme.com', 'analyst');
    expect(await (await (await loginAs(app, 'analyst@acme.com')).get('/catalog/changes')).text()).toContain('data-diff-id="table:');

    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewerHtml = await (await (await loginAs(app, 'viewer@acme.com')).get('/catalog/changes')).text();
    expect(versionsOf(viewerHtml)).toEqual(versions);
    expect(viewerHtml).not.toContain('data-diff-id="table:');
    expect(viewerHtml).not.toContain('data-diff-id="source:');
    expect(viewerHtml).toContain('数据源结构变化');
    expect(viewerHtml).not.toContain('data-reason="source.');
    expect(viewerHtml).toContain('data-diff-id="field:event.event_type"');
  });

  it('最多列出最新的 50 个版本；源视图发布的版本对查看者只显示「数据源结构变化」', async () => {
    const beta = await newTenant('beta');
    const item = { id: 'entity:order', kind: 'entity' as const, name: '订单' };
    await getDb().insert(catalogVersions).values(Array.from({ length: 55 }, (_, i) => ({
      tenantId: beta, version: i + 1, snapshot: [],
      reason: i + 1 === 54 ? 'source_view.published' : 'definition.published',
      diff: { added: [], removed: [], changed: [{ ...item, keys: ['description'] }] },
    })));

    const admin = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    expect(versionsOf(admin)).toEqual(Array.from({ length: 50 }, (_, i) => 55 - i));
    expect(admin).toContain('当前目录版本 55');
    expect(admin).toContain('data-reason="source_view.published"');

    await memberOf(beta, 'viewer@beta.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'viewer@beta.com')).get('/catalog/changes')).text();
    const v54 = viewer.slice(viewer.indexOf('data-catalog-version="54"'), viewer.indexOf('data-catalog-version="53"'));
    expect(v54).toContain('data-reason="sources"');
    expect(v54).toContain('数据源结构变化');
    expect(v54).not.toContain('data-diff-id=');
    expect(viewer).not.toContain('源视图发布');
  });

  it('查看者看不到只有 tables 变了的实体改动；tables 与其他键一起变时只显示其他键', async () => {
    const gamma = await newTenant('gamma');
    await getDb().insert(catalogVersions).values([
      { tenantId: gamma, version: 1, snapshot: [], reason: 'mapping.published',
        diff: { added: [], removed: [], changed: [{ id: 'entity:order', kind: 'entity' as const, name: '订单', keys: ['tables'] }] } },
      { tenantId: gamma, version: 2, snapshot: [], reason: 'mapping.published',
        diff: { added: [], removed: [], changed: [{ id: 'entity:customer', kind: 'entity' as const, name: '客户', keys: ['tables', 'description'] }] } },
    ]);

    const admin = await (await (await loginAs(app, 'admin@gamma.com')).get('/catalog/changes')).text();
    expect(admin).toContain('data-diff-id="entity:order"');
    expect(admin).toContain('变了：tables');

    await memberOf(gamma, 'viewer@gamma.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'viewer@gamma.com')).get('/catalog/changes')).text();
    expect(viewer).not.toContain('data-diff-id="entity:order"');
    expect(viewer).toContain('data-diff-id="entity:customer"');
    expect(viewer).toContain('变了：description');
    expect(viewer).not.toContain('变了：tables');
  });

  it('删除数据源的版本显示「数据源删除」，查看者只看到「数据源结构变化」、不列明细', async () => {
    const beta = await newTenant('beta');
    await getDb().insert(catalogVersions).values({
      tenantId: beta, version: 1, snapshot: [], reason: 'source.deleted',
      diff: { added: [], removed: [{ id: 'source:CRM', kind: 'source', name: 'CRM' }, { id: 'table:CRM/orders', kind: 'table', name: 'CRM/orders' }], changed: [] },
    });

    const admin = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    expect(admin).toContain('data-reason="source.deleted"');
    expect(admin).toContain('数据源删除');
    expect(admin).toMatch(/data-diff-id="source:CRM"[^>]*data-diff-change="removed"/);

    await memberOf(beta, 'viewer@beta.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'viewer@beta.com')).get('/catalog/changes')).text();
    expect(viewer).toContain('data-reason="sources"');
    expect(viewer).toContain('数据源结构变化');
    expect(viewer).not.toContain('数据源删除');
    expect(viewer).not.toContain('data-diff-id=');
  });

  it('源表加列、删列的改动条目显示列级明细；查看者那一版不列条目（ADR-0005）', async () => {
    const beta = await newTenant('beta');
    await getDb().insert(catalogVersions).values({
      tenantId: beta, version: 1, snapshot: [], reason: 'source.profiled',
      diff: {
        added: [], removed: [],
        changed: [
          { id: 'table:CRM/orders', kind: 'table' as const, name: 'CRM/orders', keys: ['columns'], columns: { added: ['coupon', 'channel'], removed: ['paid_at'] } },
          { id: 'table:CRM/customers', kind: 'table' as const, name: 'CRM/customers', keys: ['columns'] },
        ],
      },
    });

    const admin = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    const row = admin.slice(admin.indexOf('data-diff-id="table:CRM/orders"'));
    expect(row).toContain('data-diff-columns-added="coupon,channel"');
    expect(row).toContain('data-diff-columns-removed="paid_at"');
    expect(row).toContain('新增列：coupon、channel');
    expect(row).toContain('删除列：paid_at');
    // 只有类型变化的表条目没有明细（旧数据也没有，读取时容忍缺失）
    const customers = admin.slice(admin.indexOf('data-diff-id="table:CRM/customers"'));
    expect(customers).toContain('变了：columns');
    expect(customers).not.toContain('data-diff-columns-added');

    await memberOf(beta, 'viewer@beta.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'viewer@beta.com')).get('/catalog/changes')).text();
    expect(viewer).toContain('data-reason="sources"');
    expect(viewer).toContain('数据源结构变化');
    expect(viewer).not.toContain('data-diff-id=');
    expect(viewer).not.toContain('新增列');
  });

  it('规则不再列出的列显示「不再列出」，源端真删了的列仍显示「删除列」；查看者整条打码看不到列名（#1334）', async () => {
    const delta = await newTenant('delta');
    // 不走真实登记与采集：loadCatalogInput 读的就是这三张表，直接写数据源、同步范围内的表与最近一次成功采集（列未经敏感列过滤）
    const [src] = await getDb().insert(sources).values({
      tenantId: delta, spaceId: await defaultSpaceOf(delta), name: 'SCANS', kind: 'postgres' as const, config: {}, credentials: '',
    }).returning({ id: sources.id });
    await getDb().insert(sourceTables).values({ sourceId: src!.id, tableName: 'scan_users', inScope: true });
    await getDb().insert(tasks).values({
      tenantId: delta, kind: 'source.profile', status: 'succeeded', finishedAt: new Date(), params: { sourceId: src!.id },
      result: { tables: [{ name: 'scan_users', columns: [{ name: 'openid', type: 'text' }, { name: 'nickname', type: 'text' }] }] },
    });
    // #1212 上线后第一次同步记的版本：openid 改按敏感列处理、从目录条目里消失，记在了 removed 名下；legacy_id 是源端真删了的列
    await getDb().insert(catalogVersions).values({
      tenantId: delta, version: 1, snapshot: [], reason: 'source.synced',
      diff: {
        added: [], removed: [],
        changed: [{ id: 'table:SCANS/scan_users', kind: 'table' as const, name: 'SCANS/scan_users', keys: ['columns'], columns: { added: [], removed: ['legacy_id', 'openid'] } }],
      },
    });

    const admin = await (await (await loginAs(app, 'admin@delta.com')).get('/catalog/changes')).text();
    const row = admin.slice(admin.indexOf('data-diff-id="table:SCANS/scan_users"'));
    // 采集里还在的 openid 是规则不再列出，不在「删除列」里；采集里没有的 legacy_id 照旧是「删除列」
    expect(row).toContain('data-diff-columns-unlisted="openid"');
    expect(row).toContain('不再列出（源端仍在，按平台规则不展示）：openid');
    expect(row).toContain('data-diff-columns-removed="legacy_id"');
    expect(row).toContain('删除列：legacy_id');
    expect(row).not.toContain('data-diff-columns-removed="legacy_id,openid"');
    expect(row).not.toContain('删除列：openid');

    await memberOf(delta, 'viewer@delta.com', 'viewer');
    const viewer = await (await (await loginAs(app, 'viewer@delta.com')).get('/catalog/changes')).text();
    expect(viewer).toContain('数据源结构变化');
    expect(viewer).not.toContain('openid');
    expect(viewer).not.toContain('不再列出');
  });

  it('CATALOG_ACTIONS 的每个动作都显示中文原因：REASON_LABELS 没有的知识动作回落到审计 label（#1333）', async () => {
    const beta = await newTenant('beta');
    const item = { id: 'entity:order', kind: 'entity' as const, name: '订单' };
    const actions = [...CATALOG_ACTIONS];
    await getDb().insert(catalogVersions).values(actions.map((reason, i) => ({
      tenantId: beta, version: i + 1, snapshot: [], reason,
      diff: { added: [], removed: [], changed: [{ ...item, keys: ['description'] }] },
    })));

    const admin = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    const labels = new Map<string, string>();
    for (const [i, action] of actions.entries()) {
      // 版本倒序列出：一段从本版的 data-catalog-version 到小 1 的那一版为止，最老的一版（version 1 找不到 version 0）切到末尾；
      // 原因文字是那一段里第一个 font-medium span
      const version = i + 1;
      const start = admin.indexOf(`data-catalog-version="${version}"`);
      const next = admin.indexOf(`data-catalog-version="${version - 1}"`);
      const section = admin.slice(start, next === -1 ? undefined : next);
      const label = section.match(/<span class="font-medium">([^<]+)<\/span>/)?.[1] ?? '';
      labels.set(action, label);
      expect(label, action).not.toBe(action);
      expect(label, action).toMatch(/[一-鿿]/);
    }
    expect(labels.get('semantic_claim.saved')).toBe('保存口径声明');
    expect(labels.get('alias.added')).toBe('添加别名');
    expect(labels.get('analysis_subject.renamed')).toBe('修改分析主题名');
    expect(labels.get('term_default.set')).toBe('设置词的默认指向');
  });

  it('还没有任何版本时显示空状态', async () => {
    await newTenant('beta');
    const html = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    expect(html).toContain('还没有目录版本');
    expect(html).not.toContain('data-catalog-version=');
  });
});

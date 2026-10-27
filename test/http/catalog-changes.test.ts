// test/http/catalog-changes.test.ts —— 目录变更记录的 HTTP 接缝（ADR-0041）：成员从数据地图页头进入 /catalog/changes，按版本倒序看到各版的原因与条目差异，?since=N 只看 N 之后的版本；
// 查看者看不到 source: / table: 条目，数据源相关原因的版本只显示「数据源结构变化」、不列明细（ADR-0005）；还没有版本时显示空状态
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
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

  it('还没有任何版本时显示空状态', async () => {
    await newTenant('beta');
    const html = await (await (await loginAs(app, 'admin@beta.com')).get('/catalog/changes')).text();
    expect(html).toContain('还没有目录版本');
    expect(html).not.toContain('data-catalog-version=');
  });
});

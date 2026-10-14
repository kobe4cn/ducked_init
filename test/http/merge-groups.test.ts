// test/http/merge-groups.test.ts —— 合并组的 HTTP 接缝（ADR-0032）：数据工程师从映射页进合并组页，给 order 的两个已发布映射排优先级、选存活规则保存草稿（不合格时页面给出原因，什么也不存），
// 最后保存的人发布不了，另一位成员发布；再改是新的一版草稿，可丢弃回到已发布版本。分析师只读，查看者 403
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mergeGroups } from '../../app/.server/db/schema';
import { memberOf } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

describe('合并组页', () => {
  it('数据工程师给 order 建合并组，不合格时页面给出原因；最后保存的人发布不了，另一位成员发布后再改是新的一版草稿，可以丢弃', async () => {
    const { acme, mappings, orderMappings } = await publishedIdentitySources({ orders: true });
    const { crm, loyalty } = orderMappings!;
    const author = await loginAs(app, 'de@acme.com');
    expect(await (await author.get('/mappings')).text()).toContain('href="/merge-groups"');
    const page = await (await author.get('/merge-groups')).text();
    expect(page).toContain('data-entity="order"');
    expect(page).toContain('「CRM」orders → order');
    expect(page).toContain('「会员」orders → order');
    expect(page).not.toContain('data-entity="customer"');

    const form = { intent: 'save', entity: 'order', candidate: [crm, loyalty], rank: ['2', '1'], rule: 'latest', latestField: 'updated_at' };
    const rejected = await author.post('/merge-groups', { ...form, latestField: 'nope' });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('order 没有字段 nope');
    expect(await (await author.post('/merge-groups', { ...form, rank: ['1', ''] })).text()).toContain('合并组至少要有 2 个映射');
    expect(await (await author.post('/merge-groups', { ...form, rank: ['1', '1'] })).text()).toContain('每个映射的优先级要各不相同');
    expect(await (await author.post('/merge-groups', { ...form, rank: ['0', '1.5'] })).text()).toContain('优先级要填正整数');
    const customer = await author.post('/merge-groups', { ...form, entity: 'customer', candidate: [mappings.crm, mappings.loyalty], rule: 'priority' });
    expect(await customer.text()).toContain('不能建合并组');
    expect(await getDb().select().from(mergeGroups)).toEqual([]);

    const saved = await author.post('/merge-groups', form);
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/merge-groups?entity=order');
    const draft = await (await author.get('/merge-groups?entity=order')).text();
    expect(draft).toContain('「会员」orders → order &gt; 「CRM」orders → order，取最新（updated_at）');
    expect(draft).toContain('你最后改了这一版草稿');
    expect((await author.post('/merge-groups?entity=order', { intent: 'publish', version: '1' })).status).toBe(403);

    const reviewer = await loginAs(app, 'de2@acme.com');
    expect(await (await reviewer.get('/merge-groups')).text()).toContain('发布 v1');
    expect((await reviewer.post('/merge-groups?entity=order', { intent: 'publish', version: '1' })).status).toBe(302);
    expect(await (await author.get('/merge-groups')).text()).toContain('已发布 v1（de2@acme.com，');

    expect((await author.post('/merge-groups', { ...form, rule: 'coalesce' })).status).toBe(302);
    expect(await (await author.get('/merge-groups')).text()).toContain('逐字段补齐（最后保存 de@acme.com）');
    expect((await author.post('/merge-groups?entity=order', { intent: 'discard' })).status).toBe(302);
    const back = await (await author.get('/merge-groups')).text();
    expect(back).not.toContain('data-draft');
    expect(back).toContain('已发布 v1');

    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    const analystBrowser = await loginAs(app, analyst.email);
    expect(await (await analystBrowser.get('/merge-groups')).text()).toContain('只读。');
    expect((await analystBrowser.post('/merge-groups', form)).status).toBe(403);
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    expect((await (await loginAs(app, 'viewer@acme.com')).get('/merge-groups')).status).toBe(403);
  });
});

// test/pipeline/merge-groups.test.ts —— 合并组的接缝（ADR-0032；保存 / 发布 / 丢弃经 publishing.ts 接入 ADR-0051，发布流程本身的用例见 publishing.test.ts）：
// 发布后入队带 rebuild 的合并（组员改了时取新旧组员的并集，被移出组的映射也重建）、更新草稿不写审计、已有合并在运行时发布被拒并回滚；
// publishedMergeGroups 给出每个实体最新的已发布组；checkMergeGroup 是保存与发布共用的纯函数校验
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { mergeGroups, mergeGroupVersions, tasks } from '../../app/.server/db/schema';
import { confirmDisable, enqueueMerge, publishMapping, requestDisable, saveDraft } from '../../app/.server/mappings';
import {
  checkMergeGroup, discardMergeGroupDraft, listMergeGroups, type MergeCandidate, publishedMergeGroups, publishMergeGroup, saveMergeGroupDraft,
} from '../../app/.server/merge-groups';
import { resetDb } from '../http/harness';
import { drain, memberOf, publish } from './fixtures';
import { LOYALTY_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { mergedMappings } from './mapping-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 发布了两个订单映射的租户；orders 按 CRM、会员排 */
async function withOrders() {
  const fixture = await publishedIdentitySources({ orders: true });
  return { ...fixture, orders: [fixture.orderMappings!.crm, fixture.orderMappings!.loyalty] };
}

describe('合并组发布', () => {
  it('发布合并组：只给最新已发布版本、页面列出候选与发布不了的原因，发布后入队带 rebuild 的合并（新旧组员的并集），更新草稿不写审计', async () => {
    const { acme, author, reviewer, orders, sources } = await withOrders();
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    // 入口权限：分析师不能起草与发布
    await expect(saveMergeGroupDraft(analyst, 'order', { members: orders, rule: { kind: 'priority' } })).rejects.toMatchObject({ init: { status: 403 } });
    expect(await saveMergeGroupDraft(author, 'order', { members: orders, rule: { kind: 'priority' } })).toBe(1);
    await expect(publishMergeGroup(analyst, 'order', 1)).rejects.toMatchObject({ init: { status: 403 } });
    // 草稿不算已发布
    expect(await publishedMergeGroups(getDb(), acme)).toEqual(new Map());

    const queued = await publishMergeGroup(reviewer, 'order', 1);
    expect(mergedMappings(queued!)).toEqual([...orders].sort());
    expect((queued!.params.mappings as { rebuild: boolean }[]).every(m => m.rebuild)).toBe(true);
    await drain();
    const [group] = await getDb().select().from(mergeGroups).where(eq(mergeGroups.tenantId, acme));
    expect(await publishedMergeGroups(getDb(), acme)).toEqual(new Map([['order', { id: group.id, version: 1, members: orders, rule: { kind: 'priority' } }]]));

    const reordered = [orders[1], orders[0]];
    expect(await saveMergeGroupDraft(reviewer, 'order', { members: reordered, rule: { kind: 'latest', field: 'updated_at' } })).toBe(2);
    // 另一个人保存同一版草稿是更新，不写审计
    expect(await saveMergeGroupDraft(author, 'order', { members: reordered, rule: { kind: 'coalesce' } })).toBe(2);
    const [page] = await listMergeGroups(author);
    expect(page).toMatchObject({ entity: 'order', candidates: [{ name: '「会员」orders → order' }, { name: '「CRM」orders → order' }] });
    expect(page.versions).toMatchObject([
      { version: 2, status: 'draft', members: reordered, rule: { kind: 'coalesce' }, authors: ['de2@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com', publishBlocker: expect.stringContaining('你最后改了') },
      { version: 1, status: 'published', publishedByEmail: 'de2@acme.com' },
    ]);
    // 草稿不影响已发布的组
    expect((await publishedMergeGroups(getDb(), acme)).get('order')).toMatchObject({ version: 1, members: orders });

    expect(await discardMergeGroupDraft(author, 'order')).toEqual({ kept: true });
    expect((await listMergeGroups(author))[0].versions.map(v => v.version)).toEqual([1]);
    // 只在新建版本时写「保存合并组草稿」：第二次保存 v2 是更新草稿，不再写
    expect((await listAuditLogs(acme)).filter(l => l.action.includes('合并组')).map(l => l.action))
      .toEqual(['丢弃合并组草稿', '保存合并组草稿', '发布合并组', '保存合并组草稿']);

    // 发布组员改了的一版：v2 去掉 CRM 订单、加入第三个订单映射（CRM 的 customers 表写成 A1..A7）；
    // 入队的任务带 rebuild，组员是新旧组员的并集，含被移出组的 CRM 订单
    const third = await publish(author, reviewer, sources.crm, "model: 1\nentity: order\ntable: customers\nfields:\n  order_id: concat('A', string(id))\n");
    await drain();
    const [crmOrders, loyaltyOrders] = orders;
    expect(await saveMergeGroupDraft(author, 'order', { members: [loyaltyOrders, third], rule: { kind: 'coalesce' } })).toBe(2);
    const rebuilt = await publishMergeGroup(reviewer, 'order', 2);
    expect(mergedMappings(rebuilt!)).toEqual([crmOrders, loyaltyOrders, third].sort());
    expect((rebuilt!.params.mappings as { rebuild: boolean }[]).every(m => m.rebuild)).toBe(true);
  });

  it('已有合并在运行时发布被拒并回滚', async () => {
    const { acme, author, reviewer, orders } = await withOrders();
    await saveMergeGroupDraft(author, 'order', { members: orders, rule: { kind: 'priority' } });
    const pending = await getDb().transaction(tx => enqueueMerge(tx, acme));
    await getDb().update(tasks).set({ status: 'running' }).where(eq(tasks.id, pending!.id));
    await expect(publishMergeGroup(reviewer, 'order', 1)).rejects.toThrow('已有一次合并在运行');
    // 事务回滚：v1 仍是草稿、没有已发布的组，也没有「发布合并组」审计
    expect(await getDb().select({ version: mergeGroupVersions.version, status: mergeGroupVersions.status }).from(mergeGroupVersions))
      .toEqual([{ version: 1, status: 'draft' }]);
    expect(await publishedMergeGroups(getDb(), acme)).toEqual(new Map());
    expect((await listAuditLogs(acme)).filter(l => l.action === '发布合并组')).toEqual([]);
  });
});

describe('合并组校验', () => {
  it('组员不足 2 个、不属于该实体、已停用、键空间不一致、实体是 customer、latest 字段不存在时保存报错，什么也不存', async () => {
    const { acme, author, reviewer, orders, mappings } = await withOrders();
    const save = (entity: string, members: string[], rule: Parameters<typeof saveMergeGroupDraft>[2]['rule'] = { kind: 'priority' }) =>
      saveMergeGroupDraft(author, entity, { members, rule });

    await expect(save('order', [orders[0]])).rejects.toThrow('合并组至少要有 2 个映射');
    await expect(save('order', [orders[0], mappings.crm])).rejects.toThrow('不是写入 order 的映射：「CRM」customers → customer');
    await expect(save('customer', [mappings.crm, mappings.loyalty])).rejects.toThrow('消费者（customer）按属性取舍合并多个来源（ADR-0027），不能建合并组');
    await expect(save('order', orders, { kind: 'latest', field: 'nope' })).rejects.toThrow('order 没有字段 nope');
    await expect(save('order', orders, { kind: 'latest', field: '' })).rejects.toThrow('取最新要选比较哪个字段');

    await publishMapping(reviewer, orders[1], await saveDraft(author, orders[1], `${LOYALTY_ORDERS}key_space: mem\n`));
    await drain();
    await expect(save('order', orders)).rejects.toThrow('组员的键空间要一致：「CRM」orders → order（没写键空间）、「会员」orders → order（key_space: mem）');

    await requestDisable(author, orders[0]);
    await confirmDisable(reviewer, orders[0]);
    await drain();
    await expect(save('order', orders)).rejects.toThrow('已停用的映射不能加进合并组：「CRM」orders → order');
    expect(await getDb().select().from(mergeGroups)).toEqual([]);
    expect(await getDb().select().from(mergeGroupVersions)).toEqual([]);
    // 可用的订单映射只剩一个，页面不再列出 order
    expect(await listMergeGroups(author)).toEqual([]);
  });

  it('保存后组员被停用，发布时再校验一次', async () => {
    const { author, reviewer, orders } = await withOrders();
    await saveMergeGroupDraft(author, 'order', { members: orders, rule: { kind: 'priority' } });
    await requestDisable(author, orders[1]);
    await confirmDisable(reviewer, orders[1]);
    await drain();
    await expect(publishMergeGroup(reviewer, 'order', 1)).rejects.toThrow('已停用的映射不能加进合并组：「会员」orders → order');
  });

  it('checkMergeGroup：没发布的映射、重复的组员、只在同一数据源内唯一的实体与没有主键的实体', () => {
    const m = (id: string, more: Partial<MergeCandidate> = {}): [string, MergeCandidate] =>
      [id, { id, entity: 'order', name: id, published: true, disabled: false, columns: ['order_id'], ...more }];
    const ctx = {
      mappings: new Map([m('a'), m('b'), m('c', { published: false }), m('d', { entity: 'consent' })]),
      unique: new Map([['order', { key: ['order_id'], bySource: false }], ['consent', { key: ['customer_id', 'channel'], bySource: true }]]),
      fields: () => ['order_id', 'updated_at'],
    };
    expect(checkMergeGroup('order', { members: ['a', 'b'], rule: { kind: 'latest', field: 'updated_at' } }, ctx)).toEqual([]);
    expect(checkMergeGroup('order', { members: ['a', 'b', 'c'], rule: { kind: 'priority' } }, ctx)).toEqual(['还没发布的映射不能加进合并组：c']);
    expect(checkMergeGroup('order', { members: ['a', 'a'], rule: { kind: 'priority' } }, ctx)).toEqual(['合并组至少要有 2 个映射', '每个映射在组里只能出现一次：a']);
    expect(checkMergeGroup('consent', { members: ['d', 'd'], rule: { kind: 'priority' } }, ctx))
      .toEqual(['consent 的主键含指向消费者的字段，只在同一个数据源内唯一，不能建合并组']);
    expect(checkMergeGroup('custom_x', { members: ['a', 'b'], rule: { kind: 'priority' } }, ctx)).toEqual(['custom_x 不是有主键的实体，不能建合并组']);
  });
});

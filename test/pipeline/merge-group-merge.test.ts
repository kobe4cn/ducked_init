// test/pipeline/merge-group-merge.test.ts —— 按合并组合并的流水线接缝（ADR-0032）：publishMergeGroup / 发布组员映射 → 调度器派发合并 →
// 标准层 silver.order 里组内同一主键只有一行，字段按存活规则取值；组外的映射撞键仍按独占失败
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { getMapping, publishMapping, saveDraft } from '../../app/.server/mappings';
import { publishMergeGroup, saveMergeGroupDraft } from '../../app/.server/merge-groups';
import { runAssertions } from '../../app/.server/pipeline/assertions';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import type { MergeMappingParam } from '../../app/.server/pipeline/merge-engine';
import { listTasks } from '../../app/.server/tasks';
import type { MergeRule } from '../../app/lib/merge-groups';
import { resetDb } from '../http/harness';
import { publish, silver } from './fixtures';
import { LOYALTY_ORDERS, publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 会员订单的 order_id 写成 A<id>，与 CRM 的 A1..A5 重叠（A6 只在 CRM，会员没有 paid_at）；replace 再替换掉别的行（原文 → 新文） */
const overlapping = (replace: Record<string, string> = {}) => Object.entries({ 'order_id: string(id)': "order_id: concat('A', string(id))", ...replace })
  .reduce((yaml, [from, to]) => yaml.replace(from, to), LOYALTY_ORDERS);

/** 发布了两个订单映射的租户；crm、loyalty 是两个订单映射的 ID */
async function withOrders() {
  const fixture = await publishedIdentitySources({ orders: true });
  const { crm, loyalty } = fixture.orderMappings!;
  return { ...fixture, crm, loyalty };
}

type Fixture = Awaited<ReturnType<typeof withOrders>>;

/** 起草并由另一位成员发布 order 的合并组，跑完入队的合并 */
async function group({ author, reviewer }: Fixture, members: string[], rule: MergeRule) {
  const version = await saveMergeGroupDraft(author, 'order', { members, rule });
  await publishMergeGroup(reviewer, 'order', version);
  await drain();
}

/** 发布会员订单映射的新版本，跑完合并 */
async function republishLoyalty({ author, reviewer, loyalty }: Fixture, yaml: string) {
  await publishMapping(reviewer, loyalty, await saveDraft(author, loyalty, yaml));
  await drain();
}

/** 标准层的订单：主键、金额、更新时间、付款时间、下单人与它的数据源，以及整行胜出的映射与数据源 */
async function orders(tenantId: string) {
  return (await silver(tenantId, 'order', 'order_id')).map(o => ({
    id: o.order_id, amount: o.amount, updated_at: o.updated_at, paid_at: o.paid_at, customer_id: o.customer_id,
    customer_source: o._customer_source, mapping: o._mapping, source: o._source,
  }));
}

describe('按合并组合并', () => {
  it('priority：同一订单号只有一行，整行取优先级最高、有这个主键的映射', async () => {
    const fixture = await withOrders();
    const { acme, crm, loyalty, sources } = fixture;
    await group(fixture, [loyalty, crm], { kind: 'priority' });
    await republishLoyalty(fixture, overlapping());

    expect((await getMapping(fixture.author, loyalty)).merge.history[0]).not.toHaveProperty('error');
    const rows = await orders(acme);
    expect(rows.map(r => r.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    // 会员优先：A1..A5 整行取会员（没有 paid_at），A6 只有 CRM
    expect(rows.slice(0, 5).every(r => r.mapping === loyalty && r.source === sources.loyalty && r.paid_at === null)).toBe(true);
    expect(rows[0]).toMatchObject({ amount: '400.00', customer_id: '1', customer_source: sources.loyalty });
    expect(rows[5]).toMatchObject({ id: 'A6', mapping: crm, source: sources.crm, amount: '150.00' });
  });

  it('latest：整行取 updated_at 最新的一边，一样新时按优先级', async () => {
    const fixture = await withOrders();
    const { acme, crm, loyalty, sources } = fixture;
    await group(fixture, [crm, loyalty], { kind: 'latest', field: 'updated_at' });
    await republishLoyalty(fixture, overlapping());

    const rows = await orders(acme);
    expect(rows.map(r => [r.id, r.mapping])).toEqual([['A1', crm], ['A2', crm], ['A3', crm], ['A4', crm], ['A5', loyalty], ['A6', crm]]);
    // 会员的 5 号订单 7 月 2 日更新，比 CRM 的 A5 新
    expect(rows[4]).toMatchObject({ amount: '500.00', customer_id: '6', customer_source: sources.loyalty, source: sources.loyalty });
    expect(rows[0]).toMatchObject({ amount: '100.00', paid_at: '2024-06-30 09:00:00+00' });
  });

  it('coalesce：逐字段按优先级取第一个非空值，下单人的数据源跟随下单人取值的映射', async () => {
    const fixture = await withOrders();
    const { acme, crm, loyalty, sources } = fixture;
    await group(fixture, [loyalty, crm], { kind: 'coalesce' });
    // 会员的 1 号订单没有下单人
    await republishLoyalty(fixture, overlapping({ 'customer_id: string(member_id)': "customer_id: nullif(string(member_id), '1')" }));

    const rows = await orders(acme);
    expect(rows).toHaveLength(6);
    // 整行记有这个主键的最高优先级映射；金额取会员的，会员没有的 paid_at 由 CRM 补齐
    expect(rows[0]).toEqual({
      id: 'A1', amount: '400.00', updated_at: '2024-06-30 00:00:00+00', paid_at: '2024-06-30 09:00:00+00',
      customer_id: '1', customer_source: sources.crm, mapping: loyalty, source: sources.loyalty,
    });
    expect(rows[1]).toMatchObject({ id: 'A2', amount: '200.00', paid_at: '2024-05-01 10:00:00+00', customer_id: '5', customer_source: sources.loyalty });
    expect(rows[5]).toMatchObject({ id: 'A6', mapping: crm, customer_source: sources.crm });
  });

  it('组外的映射撞键仍按独占失败，标准层不变', async () => {
    const fixture = await withOrders();
    const { acme, author, reviewer, crm, loyalty, sources } = fixture;
    await group(fixture, [crm, loyalty], { kind: 'priority' });
    await republishLoyalty(fixture, overlapping());
    const before = await silver(acme, 'order', 'order_id');

    // CRM 的 customers 表 id 1..7 写成 A1..A7，与组内的订单重叠
    const outsider = await publish(author, reviewer, sources.crm, "model: 1\nentity: order\ntable: customers\nfields:\n  order_id: concat('A', string(id))\n");
    expect((await getMapping(author, outsider)).merge.history[0]).toMatchObject({
      error: expect.stringMatching(/^主键 order_id 跨映射重复：A1（映射 /),
    });
    expect(await silver(acme, 'order', 'order_id')).toEqual(before);
  });

  it('先撞键失败的两个订单映射，发布合并组后重新合并成每个订单号一行，主键唯一检查通过', async () => {
    const fixture = await withOrders();
    const { acme, author, crm, loyalty, sources } = fixture;
    await republishLoyalty(fixture, overlapping());
    expect((await getMapping(author, loyalty)).merge.history[0]).toMatchObject({ error: expect.stringContaining('主键 order_id 跨映射重复') });

    await group(fixture, [loyalty, crm], { kind: 'priority' });
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('succeeded');
    const params = merge.params.mappings as MergeMappingParam[];
    expect(params.map(p => [p.mapping, p.rebuild, p.group?.members.map(m => m.mapping)]).sort())
      .toEqual([[crm, true, [loyalty, crm]], [loyalty, true, [loyalty, crm]]].sort());

    const rows = await orders(acme);
    expect(rows.map(r => [r.id, r.source])).toEqual([
      ['A1', sources.loyalty], ['A2', sources.loyalty], ['A3', sources.loyalty], ['A4', sources.loyalty], ['A5', sources.loyalty], ['A6', sources.crm],
    ]);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      const results = await runAssertions(session.con, ['order'], merge.id);
      expect(results.find(r => r.name === 'primary_key_unique')).toMatchObject({ failed: 0 });
    } finally {
      session.close();
    }
  });
});

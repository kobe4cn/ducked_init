// test/pipeline/merge-group-merge.test.ts —— 按合并组合并的流水线接缝（ADR-0032）：publishMergeGroup / 发布组员映射 → 调度器派发合并 →
// 标准层 silver.order 里组内同一主键只有一行，字段按存活规则取值，合并记录写下重叠与不一致；组外的映射撞键仍按独占失败；
// 同步后的增量合并只重算受影响的主键；停用、恢复组员时整组重算，组失效后各自一行
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { confirmDisable, getMapping, publishMapping, requestDisable, restoreMapping, saveDraft } from '../../app/.server/mappings';
import { publishMergeGroup, saveMergeGroupDraft } from '../../app/.server/merge-groups';
import { runAssertions } from '../../app/.server/pipeline/assertions';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import type { GroupStat, MergeMappingParam, MergeRecord } from '../../app/.server/pipeline/merge-engine';
import { syncSource } from '../../app/.server/source-sync';
import { listTasks } from '../../app/.server/tasks';
import type { MergeRule } from '../../app/lib/merge-groups';
import { resetDb } from '../http/harness';
import { onLake, publish, silver } from './fixtures';
import { CRM_ORDERS, LOYALTY_ORDERS, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

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

/** 本租户最近一次合并任务（listTasks 按入队时间倒序） */
const lastMerge = async (tenantId: string) => (await listTasks(tenantId)).find(t => t.kind === 'silver.merge')!;

/** 在 fn 执行期间设置环境变量（调度器派发的工作进程继承它） */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 标准层每个订单号的合并时间 */
async function mergedAt(tenantId: string) {
  const rows = await onLake<{ order_id: string; t: string }>(tenantId, 'SELECT order_id, _merged_at::VARCHAR AS t FROM silver."order" ORDER BY order_id');
  return Object.fromEntries(rows.map(r => [r.order_id, r.t]));
}

/** 停用一个映射（提议与确认分别由两位成员），跑完入队的合并 */
async function disable({ author, reviewer }: Fixture, mapping: string) {
  await requestDisable(author, mapping);
  await confirmDisable(reviewer, mapping);
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

  it('合并记录写下组内重叠的订单号数与各字段不一致的订单号，敏感字段只计数', async () => {
    const fixture = await withOrders();
    const { author, reviewer, crm, loyalty } = fixture;
    await group(fixture, [loyalty, crm], { kind: 'priority' });
    const buyer = (expr: string) => `extensions:\n  x_buyer: { type: string, expr: '${expr}', sensitive: true }\n`;
    await republishLoyalty(fixture, `${overlapping()}${buyer('string(member_id)')}`);
    await publishMapping(reviewer, crm, await saveDraft(author, crm, `${CRM_ORDERS}${buyer('string(customer)')}`));
    await drain();

    const [record] = (await getMapping(author, crm)).merge.history;
    expect(record).toMatchObject({ mode: 'rebuild' });
    const stat = (record as { group: GroupStat }).group;
    expect(stat.overlap).toBe(5);
    // A1..A5 两边都有：金额、下单时间全不同，下单人只有 A1 一样，状态只有 A4（refunded / completed），更新时间只有 A5；会员没有 paid_at，不算不一致
    expect([...stat.conflicts].sort((a, b) => a.field.localeCompare(b.field))).toEqual([
      { field: 'amount', count: 5, samples: ['A1', 'A2', 'A3', 'A4', 'A5'] },
      { field: 'created_at', count: 5, samples: ['A1', 'A2', 'A3', 'A4', 'A5'] },
      { field: 'customer_id', count: 4, samples: ['A2', 'A3', 'A4', 'A5'] },
      { field: 'status', count: 1, samples: ['A4'] },
      { field: 'updated_at', count: 1, samples: ['A5'] },
      { field: 'x_buyer', count: 4, samples: [] },
    ]);
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

  it('增量合并只重算受影响的订单号：其余订单号的合并时间不变，会员删掉的订单回落到 CRM 的那一行', async () => {
    const fixture = await withOrders();
    const { acme, author, crm, loyalty, sources } = fixture;
    await group(fixture, [loyalty, crm], { kind: 'priority' });
    await republishLoyalty(fixture, overlapping());
    const before = await mergedAt(acme);

    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      await grantOnSource(`
        UPDATE crm.orders SET amount = 160, updated_at = '2024-07-05' WHERE order_no = 'A6';
        DELETE FROM loyalty.orders WHERE id = 1;`);
      await syncSource(author, sources.crm);
      await drain();
      await syncSource(author, sources.loyalty);
      await drain();
    });

    for (const id of [crm, loyalty]) {
      // 只统计重算的订单号：A6 只在 CRM，会员删掉 1 号后 A1 也只剩 CRM
      expect((await getMapping(author, id)).merge.history[0]).toMatchObject({ mode: 'incremental', group: { overlap: 0, conflicts: [] } });
    }
    const rows = await orders(acme);
    expect(rows.map(r => r.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(rows[0]).toMatchObject({ amount: '100.00', mapping: crm, source: sources.crm, paid_at: '2024-06-30 09:00:00+00' });
    expect(rows[1]).toMatchObject({ amount: '200.00', mapping: loyalty });
    expect(rows[5]).toMatchObject({ amount: '160.00', mapping: crm });
    const after = await mergedAt(acme);
    for (const id of ['A2', 'A3', 'A4', 'A5']) expect(after[id]).toBe(before[id]);
    for (const id of ['A1', 'A6']) expect(after[id]).not.toBe(before[id]);
  });

  it('去重键不是订单号时，增量合并也重算同一去重键下回落到的另一笔订单', async () => {
    const fixture = await withOrders();
    const { acme, author, crm, loyalty, sources } = fixture;
    await group(fixture, [loyalty, crm], { kind: 'priority' });
    // 会员每人只留最新的一笔：6 号会员的 4、5 号订单只留 7 月 2 日的 5 号
    await republishLoyalty(fixture, `${overlapping()}dedupe:\n  key: [customer_id]\n  latest: updated_at\n`);
    expect((await orders(acme)).slice(3, 5)).toMatchObject([{ id: 'A4', mapping: crm }, { id: 'A5', mapping: loyalty }]);

    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      await grantOnSource('DELETE FROM loyalty.orders WHERE id = 5;');
      await syncSource(author, sources.loyalty);
      await drain();
    });

    expect((await getMapping(author, loyalty)).merge.history[0]).toMatchObject({ mode: 'incremental' });
    // 没改动的 4 号订单重新成为 6 号会员最新的一笔，A4 改由会员给出；A5 回落到 CRM
    expect((await orders(acme)).slice(3, 5)).toMatchObject([
      { id: 'A4', mapping: loyalty, amount: '1000.00' }, { id: 'A5', mapping: crm, amount: '50.00' },
    ]);
  });

  it('停用组员后由其余组员按规则给出同一订单号；只剩一个组员时组失效、各自一行；恢复后整组重建', async () => {
    const fixture = await withOrders();
    const { acme, author, reviewer, crm, loyalty, sources } = fixture;
    // CRM 的 customers 表 id 1..7 写成 A1..A7，只有订单号
    const extra = await publish(author, reviewer, sources.crm, "model: 1\nentity: order\ntable: customers\nfields:\n  order_id: concat('A', string(id))\n");
    await republishLoyalty(fixture, overlapping());
    await group(fixture, [loyalty, extra, crm], { kind: 'coalesce' });
    expect((await orders(acme)).slice(0, 2)).toMatchObject([{ id: 'A1', amount: '400.00', mapping: loyalty }, { id: 'A2', amount: '200.00', mapping: loyalty }]);

    await disable(fixture, loyalty);
    const merge = await lastMerge(acme);
    expect(merge.status).toBe('succeeded');
    expect((merge.params.mappings as MergeMappingParam[]).map(p => [p.mapping, p.rebuild, p.group?.members.map(m => m.mapping)]).sort())
      .toEqual([[crm, true, [extra, crm]], [extra, true, [extra, crm]]].sort());
    let rows = await orders(acme);
    // 会员的行不再出现：A1..A7 整行记 customers 映射，金额与付款时间由 CRM 补齐
    expect(rows.map(r => [r.id, r.mapping, r.amount])).toEqual([
      ['A1', extra, '100.00'], ['A2', extra, '300.00'], ['A3', extra, '200.00'], ['A4', extra, '999.00'], ['A5', extra, '50.00'], ['A6', extra, '150.00'], ['A7', extra, null],
    ]);
    expect(rows[0]).toMatchObject({ paid_at: '2024-06-30 09:00:00+00', customer_id: '1', customer_source: sources.crm });

    // 可用组员只剩 CRM 订单：组失效，它的行拆回自己的行，组外照常独占
    await disable(fixture, extra);
    const ungrouped = await lastMerge(acme);
    expect(ungrouped.status).toBe('succeeded');
    expect(ungrouped.params.mappings).toEqual([expect.objectContaining({ mapping: crm, rebuild: true })]);
    expect(ungrouped.params.mappings).toEqual([expect.not.objectContaining({ group: expect.anything() })]);
    rows = await orders(acme);
    expect(rows.map(r => [r.id, r.mapping, r.amount])).toEqual([
      ['A1', crm, '100.00'], ['A2', crm, '300.00'], ['A3', crm, '200.00'], ['A4', crm, '999.00'], ['A5', crm, '50.00'], ['A6', crm, '150.00'],
    ]);

    // 恢复会员订单：会员与 CRM 两个可用组员，整组重建
    await restoreMapping(reviewer, loyalty);
    await drain();
    const restored = await lastMerge(acme);
    expect(restored.status).toBe('succeeded');
    expect((restored.params.mappings as MergeMappingParam[]).map(p => [p.mapping, p.rebuild]).sort()).toEqual([[crm, true], [loyalty, true]].sort());
    expect(((restored.result as { mappings: MergeRecord[] }).mappings).every(r => !('error' in r))).toBe(true);
    rows = await orders(acme);
    expect(rows.map(r => [r.id, r.mapping, r.amount])).toEqual([
      ['A1', loyalty, '400.00'], ['A2', loyalty, '200.00'], ['A3', loyalty, '80.00'], ['A4', loyalty, '1000.00'], ['A5', loyalty, '500.00'], ['A6', crm, '150.00'],
    ]);
  });
});

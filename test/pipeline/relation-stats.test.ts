// test/pipeline/relation-stats.test.ts —— 关系孤儿比例的流水线接缝（ADR-0019）：身份打通数据源与订单映射发布 → 调度器派发合并（入队时带上全部已发布关系）→
// 合并任务结果 relations 里每条关系的起点有值行数、孤儿数与样例键；敏感起点不给样例键，两端还没合并的标 unmerged。
// 终点是 customer 时按起点的数据源列（跨源引用的目标数据源，ADR-0030）找，老湖没有这一列时退回 _source
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { entityRelationStats, listMappings, publishMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { relationStats } from '../../app/.server/pipeline/merge-engine';
import { type RelationStat, relationText } from '../../app/lib/canonical-model';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { publish } from './fixtures';
import { publishedIdentitySources, TRACKING_EVENTS } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 最近一次合并任务的参数与结果里的关系，按「起点 → 终点」取 */
async function lastMerge(tenantId: string) {
  const [merge] = (await listTasks(tenantId)).filter(t => t.kind === 'silver.merge');
  const of = (list: unknown) => (text: string) => (list as RelationStat[]).find(r => relationText(r) === text);
  return { merge, param: of(merge.params.relations), stat: of(merge.result?.relations) };
}

describe('关系孤儿比例', () => {
  it('合并后统计全部已发布关系：有孤儿时给样例键，没有孤儿时为 0；敏感起点不给样例键；两端没合并的标 unmerged', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    // 会员卡：主键 customer_id 登记为敏感；核销：customer_id 登记为敏感，指向会员卡，两端在标准层里都是哈希
    const sensitiveKey = { name: 'customer_id', type: 'string' as const, description: '', sensitive: true };
    await publishCustomEntity(reviewer, await createCustomEntity(author, {
      name: 'custom_card', label: '会员卡', kind: 'dimension', primaryKey: ['customer_id'], fields: [sensitiveKey],
    }), 1);
    await publishCustomEntity(reviewer, await createCustomEntity(author, {
      name: 'custom_redeem', label: '核销', kind: 'fact', primaryKey: ['redeem_id'],
      fields: [{ name: 'redeem_id', type: 'string', description: '', sensitive: false }, sensitiveKey],
      relations: [{ from: { entity: '', field: 'customer_id' }, ref: { entity: 'custom_card', field: 'customer_id' } }],
    }), 1);
    await publish(author, reviewer, sources.crm,
      'model: 1\nentity: custom_card\ntable: customers\nextensions:\n  customer_id: { type: string, expr: string(id) }\ndedupe: { key: [customer_id] }\n');
    await publish(author, reviewer, sources.crm,
      'model: 1\nentity: custom_redeem\ntable: orders\nextensions:\n  redeem_id: { type: string, expr: order_no }\n  customer_id: { type: string, expr: string(customer) }\ndedupe: { key: [redeem_id] }\n');

    const { merge, param, stat } = await lastMerge(acme);
    // 这次只合并核销映射，关系照样带全，包括内置关系
    expect(merge.params.mappings).toHaveLength(1);
    expect(param('custom_redeem.customer_id → custom_card.customer_id')).toMatchObject({ sensitive: true });
    expect(param('order.customer_id → customer.customer_id')).toMatchObject({ sensitive: false });

    // crm 的订单 A5 下单人 99 不存在；按数据源找消费者，会员订单都找得到
    expect(stat('order.customer_id → customer.customer_id')).toMatchObject({ withValue: 11, orphans: 1, samples: ['99'] });
    // 匿名事件不算有值
    expect(stat('event.customer_id → customer.customer_id')).toMatchObject({ withValue: 5, orphans: 0, samples: [] });
    // 两端都是哈希照样关联得上（下单人 99 不是会员）；敏感起点不给样例键
    expect(stat('custom_redeem.customer_id → custom_card.customer_id')).toMatchObject({ withValue: 6, orphans: 1, samples: [] });
    expect(stat('order_item.order_id → order.order_id')).toMatchObject({ status: 'unmerged' });
    expect(merge.status).toBe('succeeded');

    // 实体页：只有起点或终点是这个实体的关系
    const { at, relations } = await entityRelationStats(acme, 'custom_redeem');
    expect(at).toBeTruthy();
    expect(relations).toEqual([expect.objectContaining({ from: { entity: 'custom_redeem', field: 'customer_id' }, orphans: 1 })]);
  });

  it('事件声明 customer_source 指向 CRM 后，event → customer 只在 CRM 里找；起点没有数据源列的老湖退回 _source', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources();
    expect((await lastMerge(acme)).stat('event.customer_id → customer.customer_id')).toMatchObject({ withValue: 5, orphans: 0 });

    const events = (await listMappings(author)).mappings.find(m => m.entity === 'event')!;
    await publishMapping(reviewer, events.id, await saveDraft(author, events.id,
      TRACKING_EVENTS.replace('  customer_id: user_id\n', '  customer_id: { expr: user_id, customer_source: CRM }\n')));
    await drain();
    // u1、u2、u9 是埋点的用户，在 CRM 里找不到
    expect((await lastMerge(acme)).stat('event.customer_id → customer.customer_id')).toMatchObject({ withValue: 5, orphans: 5, samples: ['u1', 'u2', 'u9'] });

    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run('ALTER TABLE silver.event DROP COLUMN _customer_source');
      const ends = { from: { entity: 'event', field: 'customer_id' }, ref: { entity: 'customer', field: 'customer_id' } };
      expect(await relationStats(session.con, [{ ...ends, sensitive: false }], m => m)).toEqual([{ ...ends, withValue: 5, orphans: 0, samples: [] }]);
    } finally {
      session.close();
    }
  });
});

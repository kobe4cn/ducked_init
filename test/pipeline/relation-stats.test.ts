// test/pipeline/relation-stats.test.ts —— 关系孤儿比例的流水线接缝（ADR-0019）：身份打通数据源与订单映射发布 → 调度器派发合并（入队时带上全部已发布关系）→
// 合并任务结果 relations 里每条关系的起点有值行数、孤儿数与样例键；敏感起点不给样例键，两端还没合并的标 unmerged
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { closeDb } from '../../app/.server/db/client';
import { entityRelationStats } from '../../app/.server/mappings';
import { type RelationStat, relationText } from '../../app/lib/canonical-model';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { publish } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 最近一次合并任务的参数与结果里的关系，按「起点 → 终点」取 */
async function lastMerge(tenantId: string) {
  const [merge] = (await listTasks(tenantId)).filter(t => t.kind === 'silver.merge');
  const of = (list: unknown) => (text: string) => (list as RelationStat[]).find(r => relationText(r) === text);
  return { merge, param: of(merge.params.relations), stat: of(merge.result?.relations) };
}

describe('关系孤儿比例', () => {
  it('合并后统计全部已发布关系：有孤儿时给样例键，没有孤儿时为 0；敏感起点不给样例键；两端没合并的标 unmerged', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    // 核销：customer_id 登记为敏感，标准层里是哈希
    await publishCustomEntity(reviewer, await createCustomEntity(author, {
      name: 'custom_redeem', label: '核销', kind: 'fact', primaryKey: ['redeem_id'],
      fields: [{ name: 'redeem_id', type: 'string', description: '', sensitive: false }, { name: 'customer_id', type: 'string', description: '', sensitive: true }],
      relations: [{ from: { entity: '', field: 'customer_id' }, ref: { entity: 'customer', field: 'customer_id' } }],
    }), 1);
    await publish(author, reviewer, sources.crm,
      'model: 1\nentity: custom_redeem\ntable: orders\nextensions:\n  redeem_id: { type: string, expr: order_no }\n  customer_id: { type: string, expr: string(customer) }\ndedupe: { key: [redeem_id] }\n');

    const { merge, param, stat } = await lastMerge(acme);
    // 这次只合并核销映射，关系照样带全，包括内置关系
    expect(merge.params.mappings).toHaveLength(1);
    expect(param('custom_redeem.customer_id → customer.customer_id')).toMatchObject({ sensitive: true });
    expect(param('order.customer_id → customer.customer_id')).toMatchObject({ sensitive: false });

    // crm 的订单 A5 下单人 99 不存在；按数据源找消费者，会员订单都找得到
    expect(stat('order.customer_id → customer.customer_id')).toMatchObject({ withValue: 11, orphans: 1, samples: ['99'] });
    // 匿名事件不算有值
    expect(stat('event.customer_id → customer.customer_id')).toMatchObject({ withValue: 5, orphans: 0, samples: [] });
    // 敏感起点是哈希，找不到，也不给样例键
    expect(stat('custom_redeem.customer_id → customer.customer_id')).toMatchObject({ withValue: 6, orphans: 6, samples: [] });
    expect(stat('order_item.order_id → order.order_id')).toMatchObject({ status: 'unmerged' });
    expect(merge.status).toBe('succeeded');

    // 实体页：只有起点或终点是这个实体的关系
    const { at, relations } = await entityRelationStats(acme, 'custom_redeem');
    expect(at).toBeTruthy();
    expect(relations).toEqual([expect.objectContaining({ from: { entity: 'custom_redeem', field: 'customer_id' }, orphans: 6 })]);
  });
});

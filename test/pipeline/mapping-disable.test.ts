// test/pipeline/mapping-disable.test.ts —— 映射停用与恢复的流水线接缝：停用要两人确认，停用后同步后的合并与定时检查都不再算它，确认停用时入队的合并撤下它写进标准层的行；
// 恢复由一人确认，重跑发布时的检查后入队重建合并（ADR-0031）
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import type { CurrentMember } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { tasks } from '../../app/.server/db/schema';
import {
  confirmDisable, createMapping, enqueueDueMerges, enqueueMerge, getMapping, listMappings, mergeAfterSync, publishedPlans, disableImpact, requestDisable, restoreMapping,
} from '../../app/.server/mappings';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, mergeUnchecked, publish, silver } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';
import { drain, syncedSource, CUSTOMERS, ORDERS, ORDER_LOG_MAPPING, mergedMappings } from './mapping-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('停用映射', () => {
  it('提议停用后由另一位有发布权限的成员确认才生效，提议人自己确认被拒；再次提议覆盖提议人；审计记下提议与停用', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, CUSTOMERS);
    const draftOnly = await createMapping(author, id, ORDERS);
    const third = await memberOf(acme, 'admin@acme.com', 'admin');
    await expect(requestDisable(await memberOf(acme, 'v@acme.com', 'viewer'), mapping)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(requestDisable(author, draftOnly.id)).rejects.toThrow('这个映射还没有发布');
    await expect(confirmDisable(reviewer, mapping)).rejects.toThrow('还没有人提议停用这个映射');

    await requestDisable(author, mapping);
    await expect(confirmDisable(author, mapping)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('另一位') });
    // 再次提议覆盖提议人：原提议人现在可以确认
    await requestDisable(reviewer, mapping);
    expect(await getMapping(author, mapping)).toMatchObject({ disableRequestedByEmail: 'de2@acme.com', disabledAt: null });
    await expect(confirmDisable(reviewer, mapping)).rejects.toMatchObject({ status: 403 });
    await confirmDisable(author, mapping);
    expect(await getMapping(author, mapping)).toMatchObject({ disabledAt: expect.any(Date), disabledByEmail: 'de2@acme.com', disableRequestedByEmail: null });
    expect((await listMappings(author)).mappings.find(m => m.id === mapping)).toMatchObject({ disabledAt: expect.any(Date), disabledByEmail: 'de2@acme.com' });
    await expect(requestDisable(third, mapping)).rejects.toThrow('映射已停用');
    await expect(confirmDisable(third, mapping)).rejects.toThrow('映射已停用');

    const audit = (await listAuditLogs(acme)).filter(l => l.action.includes('停用')).map(l => `${l.actor} ${l.action} ${l.summary}`);
    expect(audit).toEqual([
      'de@acme.com 停用映射 「电商库」customers → 消费者，提议人 de2@acme.com、确认人 de@acme.com',
      'de2@acme.com 提议停用映射 「电商库」customers → 消费者',
      'de@acme.com 提议停用映射 「电商库」customers → 消费者',
    ]);
  });

  it('停用后已发布映射的读取方都不再算它：publishedPlans、同步后的合并、定时检查都跳过，别的映射照常', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const merges = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge').length;
    expect((await publishedPlans(getDb(), acme)).map(p => p.mapping).sort()).toEqual([customers, orders].sort());

    await requestDisable(author, customers);
    // 只是提议时照常算
    expect((await publishedPlans(getDb(), acme)).map(p => p.mapping)).toContain(customers);
    await confirmDisable(reviewer, customers);
    expect((await publishedPlans(getDb(), acme)).map(p => p.mapping)).toEqual([orders]);
    expect(await publishedPlans(getDb(), acme, [customers])).toEqual([]);

    // 停用的映射的源表写入变更：同步后不合并，定时检查也不补
    const before = await merges();
    await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
    await syncSource(author, id);
    await drain();
    const [sync] = (await listTasks(acme)).filter(t => t.kind === 'source.sync');
    expect(await mergeAfterSync(acme, sync.id)).toBeNull();
    expect(await merges()).toBe(before);
    expect(await enqueueDueMerges()).toEqual([]);

    // 别的映射照常：订单表写入变更后同步合并只带订单映射
    await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
    await syncSource(author, id);
    await drain();
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(mergedMappings(merge)).toEqual([orders]);
    expect(await enqueueDueMerges()).toEqual([]);
  });

  /** 本租户最近入队的一次合并（listTasks 按入队时间倒序） */
  const lastMerge = async (acme: string) => (await listTasks(acme)).find(t => t.kind === 'silver.merge')!;

  it('order_id 重叠、后发布的映射合并失败；停用它后自动入队的合并撤下它的行、带上其余订单映射，合并成功，标准层与只发布前一个时一致', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    const clash = await publish(author, reviewer, id, 'model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\n');
    expect((await getMapping(author, clash)).merge.history[0]).toHaveProperty('error');
    // 模拟独占检查上线前已写进标准层的重叠
    expect((await mergeUnchecked(acme, [clash])).status).toBe('succeeded');
    expect((await silver(acme, 'order', 'order_id::INT')).filter(o => o._mapping === clash)).toHaveLength(40);

    await requestDisable(author, clash);
    await confirmDisable(reviewer, clash);
    const queued = await lastMerge(acme);
    expect(mergedMappings(queued)).toEqual([orders]);
    expect(queued.params.drop).toEqual([{ mapping: clash, entity: 'order' }]);
    await drain();
    const merge = (await listTasks(acme)).find(t => t.id === queued.id)!;
    expect(merge.status).toBe('succeeded');
    expect(merge.result).toMatchObject({ dropped: [{ mapping: clash, entity: 'order', deleted: 40 }] });
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);
  });

  it('order_id 重叠时停用先发布的映射：自动入队的合并带上原先失败的映射，它补进标准层', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const clash = await publish(author, reviewer, id, 'model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\n');
    expect((await getMapping(author, clash)).merge.history[0]).toHaveProperty('error');

    await requestDisable(author, orders);
    await confirmDisable(reviewer, orders);
    expect(mergedMappings(await lastMerge(acme))).toEqual([clash]);
    await drain();
    expect((await lastMerge(acme)).status).toBe('succeeded');
    const rows = await silver(acme, 'order', 'order_id::INT');
    expect(new Set(rows.map(o => o._mapping))).toEqual(new Set([clash]));
    expect(rows).toHaveLength(40);
  });

  it('停用 customer 映射后合并重算身份打通，统一消费者里不再有它的源记录', async () => {
    const { acme, author, reviewer, sources, mappings: { loyalty } } = await publishedIdentitySources();
    const identitySources = async () => {
      const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
      try {
        return ((await session.con.runAndReadAll('SELECT DISTINCT _source FROM silver._identities ORDER BY _source')).getRowObjectsJson() as { _source: string }[])
          .map(r => r._source);
      } finally {
        session.close();
      }
    };
    expect(await identitySources()).toContain(sources.loyalty);

    await requestDisable(author, loyalty);
    await confirmDisable(reviewer, loyalty);
    const queued = await lastMerge(acme);
    // 停掉的是这个数据源唯一的 customer 映射：其余 customer 映射照样带上
    expect(mergedMappings(queued)).not.toContain(loyalty);
    // 只靠 drop 触发重算：去掉入队时（匹配规则或名次变了）可能置上的强制标记
    await getDb().update(tasks).set({ params: { ...queued.params, identityForce: false } }).where(eq(tasks.id, queued.id));
    await drain();
    const merge = (await listTasks(acme)).find(t => t.id === queued.id)!;
    expect(merge.status).toBe('succeeded');
    expect((merge.result as { identities: object }).identities).not.toHaveProperty('skipped');
    expect(await identitySources()).toEqual([sources.crm, sources.tracking].sort());
    expect((await silver(acme, 'customer', '_source, customer_id')).some(c => c._mapping === loyalty)).toBe(false);
  });

  it('停用时排队中的合并带着这个映射：从它的映射里剔除、并入 drop，那次合并不再写入它的行', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const orderLog = await publish(author, reviewer, id, ORDER_LOG_MAPPING);
    expect((await silver(acme, 'order', 'order_id')).some(o => o._mapping === orderLog)).toBe(true);
    const pending = await getDb().transaction(tx => enqueueMerge(tx, acme, undefined, { rebuild: true }));
    expect(mergedMappings(pending!)).toEqual([orders, orderLog].sort());

    await requestDisable(author, orderLog);
    await confirmDisable(reviewer, orderLog);
    const [queued] = await getDb().select().from(tasks).where(eq(tasks.id, pending!.id));
    expect(queued.status).toBe('queued');
    expect(mergedMappings(queued)).toEqual([orders]);
    expect(queued.params.drop).toEqual([{ mapping: orderLog, entity: 'order' }]);
    await drain();
    expect((await listTasks(acme)).find(t => t.id === pending!.id)!.status).toBe('succeeded');
    const rows = await silver(acme, 'order', 'order_id');
    expect(new Set(rows.map(o => o._mapping))).toEqual(new Set([orders]));
    expect(rows).toHaveLength(100);
  });

  it('已有合并在运行时不能确认停用', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const pending = await getDb().transaction(tx => enqueueMerge(tx, acme));
    await getDb().update(tasks).set({ status: 'running' }).where(eq(tasks.id, pending!.id));
    await requestDisable(author, orders);
    await expect(confirmDisable(reviewer, orders)).rejects.toThrow('已有一次合并在运行');
    expect(await getMapping(author, orders)).toMatchObject({ disabledAt: null });
  });

  /** 提议并确认停用，跑完撤下它的合并 */
  const disable = async (author: CurrentMember, reviewer: CurrentMember, mapping: string) => {
    await requestDisable(author, mapping);
    await confirmDisable(reviewer, mapping);
    await drain();
  };

  it('停用再恢复订单映射：一人即可恢复，入队带 rebuild 的合并，合并后标准层与停用前一致；审计记下恢复映射；没停用的、查看者被拒', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    await expect(restoreMapping(author, orders)).rejects.toThrow('映射没有停用');

    await disable(author, reviewer, orders);
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual([]);
    await expect(restoreMapping(await memberOf(acme, 'v@acme.com', 'viewer'), orders)).rejects.toMatchObject({ init: { status: 403 } });
    // 提议停用的人自己就能恢复
    await restoreMapping(author, orders);
    expect(await getMapping(author, orders)).toMatchObject({ disabledAt: null, disabledByEmail: null });
    expect((await publishedPlans(getDb(), acme)).map(p => p.mapping)).toContain(orders);
    const queued = await lastMerge(acme);
    expect(queued.params.mappings).toEqual([expect.objectContaining({ mapping: orders, rebuild: true })]);
    await drain();
    expect((await lastMerge(acme)).status).toBe('succeeded');
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);
    await expect(restoreMapping(reviewer, orders)).rejects.toThrow('映射没有停用');

    const audit = (await listAuditLogs(acme)).filter(l => l.action === '恢复映射').map(l => `${l.actor} ${l.summary}`);
    expect(audit).toEqual(['de@acme.com 「电商库」orders → 订单，第 1 版']);
  });

  it('停用期间别的映射发布后占了它的 order_id：恢复后的重建合并失败，报出与发布冲突映射时一样的主键冲突，标准层不变', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    await disable(author, reviewer, orders);
    const clash = await publish(author, reviewer, id, 'model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\n');
    const before = await silver(acme, 'order', 'order_id::INT');
    expect(new Set(before.map(o => o._mapping))).toEqual(new Set([clash]));

    await restoreMapping(author, orders);
    await drain();
    expect((await getMapping(author, orders)).merge.history[0]).toMatchObject({ error: expect.stringMatching(/^主键 order_id 跨映射重复：/) });
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);
  });

  it('恢复时重跑发布时的检查：停用期间别的订单映射把 x_amount_fen 发布成文本后恢复被拒，映射仍停用', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    await disable(author, reviewer, orders);
    await publish(author, reviewer, id, `${ORDER_LOG_MAPPING}extensions:\n  x_amount_fen: { type: string, expr: string(amount_fen) }\n`);
    const merges = (await listTasks(acme)).filter(t => t.kind === 'silver.merge').length;

    await expect(restoreMapping(author, orders)).rejects.toThrow(/字段 x_amount_fen 在已发布的映射里是 string，这里是 integer/);
    expect(await getMapping(author, orders)).toMatchObject({ disabledAt: expect.any(Date) });
    expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge')).toHaveLength(merges);
  });

  it('停用期间源表可以移出同步范围；移出后恢复被拒、提示先选回，选回后能恢复', async () => {
    const { author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    await expect(setSyncScope(author, id, { remove: ['orders'] })).rejects.toThrow(/已被已发布的映射引用/);
    await disable(author, reviewer, orders);
    await setSyncScope(author, id, { remove: ['orders'] });

    await expect(restoreMapping(author, orders)).rejects.toThrow('源表 orders 不在同步范围内，先把它选回同步范围再恢复');
    await setSyncScope(author, id, { add: ['orders'] });
    await restoreMapping(author, orders);
    expect(await getMapping(author, orders)).toMatchObject({ disabledAt: null });
  });

  it('确认停用后撤下它的合并还在排队时恢复：那次合并同时带 drop 与它的重建，先撤下再重建，标准层与停用前一致', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    await requestDisable(author, orders);
    await confirmDisable(reviewer, orders);
    await restoreMapping(author, orders);
    const queued = await lastMerge(acme);
    expect(queued.params.drop).toEqual([{ mapping: orders, entity: 'order' }]);
    expect(queued.params.mappings).toEqual([expect.objectContaining({ mapping: orders, rebuild: true })]);
    await drain();
    expect((await lastMerge(acme)).status).toBe('succeeded');
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);
  });

  it('已有合并在运行时不能恢复', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    await publish(author, reviewer, id, CUSTOMERS);
    await disable(author, reviewer, orders);
    const pending = await getDb().transaction(tx => enqueueMerge(tx, acme));
    await getDb().update(tasks).set({ status: 'running' }).where(eq(tasks.id, pending!.id));
    await expect(restoreMapping(author, orders)).rejects.toThrow('已有一次合并在运行');
    expect(await getMapping(author, orders)).toMatchObject({ disabledAt: expect.any(Date) });
  });

  it('停用前列出受影响的已发布指标与引用它们的已发布标签：只算这次停用让实体再没有映射的；同实体还有别的映射时为空，草稿不算', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const log = await publish(author, reviewer, id, ORDER_LOG_MAPPING);
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    await createDefinition(author, 'metric', 'fen_total', 'base: order\nmeasure: { agg: sum, field: x_amount_fen }\n');
    await publishDefinition(reviewer, 'metric', 'fen_total', 1);
    await createDefinition(author, 'metric', 'order_count', 'base: order\nmeasure: { agg: count }\n');
    await drain();
    await createDefinition(author, 'tag', 'fen_tier', 'metric: fen_total\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
    await publishDefinition(reviewer, 'tag', 'fen_tier', 1);
    await drain();

    expect(await disableImpact(getDb(), acme, orders)).toEqual({ metrics: [], tags: [] });
    expect(await disableImpact(getDb(), acme, customers)).toEqual({ metrics: [], tags: [] });
    await disable(author, reviewer, log);
    expect(await disableImpact(getDb(), acme, orders)).toEqual({ metrics: [{ key: 'fen_total' }], tags: [{ key: 'fen_tier' }] });
    // order 本来就没有映射时，停用别的实体的映射不列出引用 order 的指标
    await disable(author, reviewer, orders);
    expect(await disableImpact(getDb(), acme, customers)).toEqual({ metrics: [], tags: [] });
  });
});

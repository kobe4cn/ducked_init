// test/pipeline/mapping-rules.test.ts —— 映射与标准层合并的流水线接缝（键空间、兜底与发布规则）：键空间与 _customer_source，值字典的兜底值与通知，
// 两人发布、同步范围与扩展字段的保护，哪些同步与发布触发合并、只带受影响的映射，重建合并补上标准层缺的列（ADR-0024、0032）
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { createDefinition, deleteDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { mappingFallbackValues, mappings, mappingVersions, tasks, tenants } from '../../app/.server/db/schema';
import { setMailer, type Mail } from '../../app/.server/mailer';
import {
  createMapping, enqueueDueMerges, getMapping, MappingError, mergeAfterSync, mergeMapping, mergeNow, publishMapping, rebuildEntity, referenceTables, saveDraft,
} from '../../app/.server/mappings';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { PublishError } from '../../app/.server/publishing';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { ensureLakeSchemas } from '../../app/.server/pipeline/lake-schemas';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, publish, silver } from './fixtures';
import { grantOnSource } from './source-fixtures';
import { ORDER_ITEMS, syncedSource, CUSTOMERS, ORDERS, ORDER_LOG_MAPPING, mergedMappings, withEnv, events } from './mapping-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('发布映射并合并到标准层', () => {
  it('两个映射的主键原值重叠、其中一个声明了键空间时照常合并：标准层比较的是带前缀的主键', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const fromOrders = await publish(author, reviewer, id, events('orders', 'order_id'));
    const fromCustomers = await publish(author, reviewer, id, events('customers', 'customer_id', 'key_space: crm\n'));
    expect((await getMapping(author, fromCustomers)).merge.history[0]).not.toHaveProperty('error');
    const rows = await silver(acme, 'event', 'event_id');
    expect(rows).toHaveLength(140);
    expect(rows.filter(e => e.event_id === '1' || e.event_id === 'crm:1').map(e => e._mapping).sort()).toEqual([fromOrders, fromCustomers].sort());
  });

  it('映射声明键空间：标准层的主键带前缀并记下 _key_space；同源订单明细的 order_id 写了同一键空间，两边关联得上', async () => {
    const { acme, author, reviewer, id } = await syncedSource(ORDER_ITEMS);
    await publish(author, reviewer, id, `${ORDERS}key_space: pos\n`);
    await publish(author, reviewer, id, 'model: 1\nentity: order_item\ntable: order_items\nfields:\n'
      + '  order_item_id: item_no\n  order_id: { expr: string(order_id), key_space: pos }\n  quantity: qty\n');

    const orders = await silver(acme, 'order', 'order_id');
    expect(orders.find(o => o.order_id === 'pos:1')).toMatchObject({ customer_id: expect.not.stringContaining(':'), _key_space: 'pos' });
    expect(orders.every(o => /^pos:\d+$/.test(String(o.order_id)) && o._key_space === 'pos')).toBe(true);
    // 明细的映射没声明键空间：自己的主键照原值，_key_space 为空
    const items = await silver(acme, 'order_item', 'order_item_id');
    expect(items.map(i => [i.order_item_id, i.order_id, i._key_space])).toEqual([['I1', 'pos:1', null], ['I2', 'pos:1', null], ['I3', 'pos:2', null]]);
    const ids = new Set(orders.map(o => o.order_id));
    expect(items.every(i => ids.has(i.order_id))).toBe(true);
  });

  it('标准层的 customer_id 旁边落 _customer_source：没声明跨源引用时就是行自己的 _source', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    await publish(author, reviewer, id, ORDERS);
    for (const entity of ['customer', 'order']) {
      const rows = await silver(acme, entity, 'customer_id');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r._source === id && r._customer_source === id)).toBe(true);
    }
  });

  it('老湖里有 customer_id 却没有 _customer_source 的表，lake:ensure 与合并时补上这一列并按 _source 回填，不整表重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const dropColumn = () => session.con.run('ALTER TABLE silver."order" DROP COLUMN _customer_source');
    try {
      await dropColumn();
      await ensureLakeSchemas(session.con);
      expect((await silver(acme, 'order', 'order_id')).every(r => r._customer_source === id)).toBe(true);
      await dropColumn();
    } finally {
      session.close();
    }

    await mergeMapping(author, orders);
    await drain();
    expect((await silver(acme, 'order', 'order_id')).every(r => r._customer_source === id)).toBe(true);
    expect((await getMapping(author, orders)).merge.history[0]).not.toMatchObject({ mode: 'rebuild' });
  });

  /** 订单明细的映射，orderId 是 order_id 一行的右边 */
  const orderItems = (orderId: string) =>
    `model: 1\nentity: order_item\ntable: order_items\nfields:\n  order_item_id: item_no\n  order_id: ${orderId}\n  quantity: qty\n`;

  it('同源订单映射声明了键空间 pos：对照的每张源表带上 order → pos（表单据此预填）；订单明细的 order_id 没写或写了别的键空间时发布被拒，列出字段与应写的 pos；写了 pos 照常发布', async () => {
    const { author, reviewer, id } = await syncedSource(ORDER_ITEMS);
    expect((await referenceTables(author, id)).every(t => JSON.stringify(t.keySpaces) === '{}')).toBe(true);
    await publish(author, reviewer, id, `${ORDERS}key_space: pos\n`);
    const tables = await referenceTables(author, id);
    expect(tables.find(t => t.name === 'order_items')!.keySpaces).toEqual({ order: 'pos' });
    expect(tables.every(t => t.keySpaces.order === 'pos')).toBe(true);
    const items = await createMapping(author, id, orderItems('string(order_id)'));
    await expect(publishMapping(reviewer, items.id, 1)).rejects.toThrow(new MappingError('引用字段要写上目标实体在同一数据源里声明的键空间：order_id 应写 key_space: pos'));
    // 还没发布过：草稿原地改，仍是第 1 版
    expect(await saveDraft(author, items.id, orderItems('{ expr: string(order_id), key_space: web }'))).toBe(1);
    await expect(publishMapping(reviewer, items.id, 1)).rejects.toThrow('order_id 应写 key_space: pos');
    expect(await saveDraft(author, items.id, orderItems('{ expr: string(order_id), key_space: pos }'))).toBe(1);
    await publishMapping(reviewer, items.id, 1);
    expect((await getMapping(author, items.id)).versions.find(v => v.version === 1)).toMatchObject({ status: 'published' });
  });

  it('同源订单映射没声明键空间时，订单明细的 order_id 写不写键空间都照常发布；别的数据源的订单映射声明了键空间也不参与检查', async () => {
    const { author, reviewer, id, input } = await syncedSource(ORDER_ITEMS);
    await publish(author, reviewer, id, ORDERS);
    const other = await registerSource(author, { ...input, name: '电商库副本' });
    await setSyncScope(author, other.id, { add: ['orders'] });
    await drain();
    await confirmWatermark(author, other.id, 'orders', 'order_id');
    await syncSource(author, other.id);
    await drain();
    await publish(author, reviewer, other.id, `${ORDERS}key_space: web\n`);
    expect((await referenceTables(author, id)).find(t => t.name === 'order_items')!.keySpaces).toEqual({});
    expect((await referenceTables(author, other.id)).find(t => t.name === 'orders')!.keySpaces).toEqual({ order: 'web' });

    const items = await createMapping(author, id, orderItems('string(order_id)'));
    await publishMapping(reviewer, items.id, 1);
    expect(await saveDraft(author, items.id, orderItems('{ expr: string(order_id), key_space: pos }'))).toBe(2);
    await publishMapping(reviewer, items.id, 2);
    expect((await getMapping(author, items.id)).versions.find(v => v.version === 2)).toMatchObject({ status: 'published' });
  });

  it('对照的每张源表带上有已发布 customer 映射的其他数据源（表单据此列出跨源引用的所属数据源），不含本源与只有草稿的数据源', async () => {
    const { author, reviewer, id, input } = await syncedSource();
    for (const t of await referenceTables(author, id)) expect(t.customerSources).toEqual([]);
    const other = await registerSource(author, { ...input, name: '电商库副本' });
    await setSyncScope(author, other.id, { add: ['customers'] });
    await drain();
    await confirmWatermark(author, other.id, 'customers', 'updated_at');
    await syncSource(author, other.id);
    await drain();
    const draft = await createMapping(author, other.id, CUSTOMERS);
    expect((await referenceTables(author, id))[0].customerSources).toEqual([]);
    await publishMapping(reviewer, draft.id, 1);
    for (const t of await referenceTables(author, id)) expect(t.customerSources).toEqual([{ id: other.id, name: '电商库副本' }]);
    await publish(author, reviewer, id, CUSTOMERS);
    expect((await referenceTables(author, other.id))[0].customerSources).toEqual([{ id, name: input.name }]);
  });

  it('订单映射的草稿把键空间由 pos 改成 store：发布区列出同源已发布、order_id 仍写 pos 的订单明细映射与字段，提示一起改；这一版照常能发布', async () => {
    const { author, reviewer, id } = await syncedSource(ORDER_ITEMS);
    const orders = await publish(author, reviewer, id, `${ORDERS}key_space: pos\n`);
    const items = await publish(author, reviewer, id, orderItems('{ expr: string(order_id), key_space: pos }'));
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual([]);

    expect(await saveDraft(author, orders, `${ORDERS}key_space: store\n`)).toBe(2);
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual([{ mapping: items, entity: 'order_item', table: 'order_items', fields: ['order_id'] }]);
    await publishMapping(reviewer, orders, 2);
    expect((await getMapping(author, orders)).versions.find(v => v.version === 2)).toMatchObject({ status: 'published' });
  });

  it('订单映射第一次声明键空间 pos 时列出 order_id 没写键空间的订单明细映射；删掉键空间时列出写了 pos 的', async () => {
    const { author, reviewer, id } = await syncedSource(ORDER_ITEMS);
    const orders = await publish(author, reviewer, id, ORDERS);
    const items = await publish(author, reviewer, id, orderItems('string(order_id)'));
    const followers = [{ mapping: items, entity: 'order_item', table: 'order_items', fields: ['order_id'] }];

    // 订单明细的草稿已写 pos 不算，比较的是它的已发布版本
    expect(await saveDraft(author, items, orderItems('{ expr: string(order_id), key_space: pos }'))).toBe(2);
    expect(await saveDraft(author, orders, `${ORDERS}key_space: pos\n`)).toBe(2);
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual(followers);
    await publishMapping(reviewer, orders, 2);
    await publishMapping(reviewer, items, 2);

    expect(await saveDraft(author, orders, ORDERS)).toBe(3);
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual(followers);
  });

  it('键空间没变、同源引用映射已写了新的键空间、或引用映射在别的数据源时不列出', async () => {
    const { author, reviewer, id, input } = await syncedSource(ORDER_ITEMS);
    const orders = await publish(author, reviewer, id, ORDERS);
    await publish(author, reviewer, id, orderItems('{ expr: string(order_id), key_space: pos }'));
    const other = await registerSource(author, { ...input, name: '电商库副本' });
    await setSyncScope(author, other.id, { add: ['order_items'] });
    await drain();
    await syncSource(author, other.id);
    await drain();
    await publish(author, reviewer, other.id, orderItems('string(order_id)'));

    // 键空间没变：都没声明
    expect(await saveDraft(author, orders, ORDERS.replace('fields:\n', 'fields:\n  # 只改注释\n'))).toBe(2);
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual([]);
    // 改成 pos：同源订单明细已写 pos，别的数据源里没写键空间的订单明细不算
    expect(await saveDraft(author, orders, `${ORDERS}key_space: pos\n`)).toBe(2);
    expect((await getMapping(author, orders)).keySpaceFollowers).toEqual([]);
  });

  it('写了兜底值时值字典里没有的取值写成兜底值，合并照常完成，并记下落入兜底的取值与行数', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, ORDER_LOG_MAPPING
      .replace(', 已退款: refunded', '')
      .replace('    expr: trim(status)\n', '    expr: trim(status)\n    otherwise: cancelled\n'));

    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('succeeded');
    expect((await silver(acme, 'order', 'order_id')).map(o => [o.order_id, o.status])).toEqual([['A1', 'cancelled'], ['A2', 'paid']]);
    // 统计的是源表里的行（A1 的两行已支付是重复行，各计一次），不是标准层的行
    expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({
      fallback: [{ column: 'status', values: [{ value: '已退款', rows: 1 }], distinct: 1, rows: 1 }],
    });
  });

  it('增量合并只统计本次变更的记录落入兜底的取值；没有新批次时不带统计', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await publish(author, reviewer, id, ORDER_LOG_MAPPING
      .replace(', 已退款: refunded', '')
      .replace('    expr: trim(status)\n', '    expr: trim(status)\n    otherwise: null\n'));

    // 新增的两种取值：已关闭是两行完全相同的重复行；之前落入兜底的已退款没有变化，不再计入
    await grantOnSource(`INSERT INTO shop.order_log VALUES
      ('A3', '已关闭', 100, '2024-06-04 10:00'), ('A3', '已关闭', 100, '2024-06-04 10:00'), ('A4', '待审核', 200, '2024-06-05 10:00');`);
    await syncSource(author, id);
    await drain();
    const incremental = (await getMapping(author, mapping)).merge.history[0];
    expect(incremental).toMatchObject({ mode: 'incremental' });
    expect(incremental).toHaveProperty('fallback', [
      { column: 'status', values: [{ value: '已关闭', rows: 2 }, { value: '待审核', rows: 1 }], distinct: 2, rows: 3 },
    ]);
    expect((await silver(acme, 'order', 'order_id')).map(o => [o.order_id, o.status])).toEqual([['A1', null], ['A2', 'paid'], ['A3', null], ['A4', null]]);

    await mergeNow(author);
    await drain();
    const idle = (await getMapping(author, mapping)).merge.history[0];
    expect(idle).toMatchObject({ mode: 'incremental', batchFrom: (incremental as { batchTo: number }).batchTo });
    expect(idle).not.toHaveProperty('fallback');
  });

  it('写了兜底值时第一次落入兜底的取值通知能改映射的成员并记审计；之后的增量合并与重建只出现旧取值时不再通知，出现新取值时再通知', async () => {
    const outbox: Mail[] = [];
    setMailer({ async send(m) { outbox.push(m); } });
    try {
      const { acme, author, reviewer, id } = await syncedSource();
      const mapping = await publish(author, reviewer, id, ORDER_LOG_MAPPING
        .replace(', 已退款: refunded', '')
        .replace('    expr: trim(status)\n', '    expr: trim(status)\n    otherwise: cancelled\n'));
      const alerts = () => outbox.filter(m => m.subject.startsWith('新的兜底取值'));

      // 第一次合并：已退款是新取值。邮件只写列与个数，不写取值
      expect(alerts().map(m => m.to).sort()).toEqual(['admin@acme.com', 'de2@acme.com', 'de@acme.com']);
      expect(alerts()[0].text).toContain(`order_log → 订单（映射 ${mapping}）：status 有 1 个新取值 /mappings/${mapping}`);
      expect(alerts()[0].text).not.toContain('已退款');
      expect((await listAuditLogs(acme)).filter(l => l.action === '出现新的兜底取值').map(l => l.actor + l.summary))
        .toEqual([expect.stringMatching(/^平台.*：order_log → 订单 的 status 1 个新取值落入兜底$/)]);

      // 增量合并又出现已退款、重建合并再报一遍：都是通知过的取值
      outbox.length = 0;
      await grantOnSource(`INSERT INTO shop.order_log VALUES ('A3', '已退款', 100, '2024-06-04 10:00');`);
      await syncSource(author, id);
      await drain();
      expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'incremental', fallback: [{ column: 'status', values: [{ value: '已退款', rows: 1 }] }] });
      await rebuildEntity(author, 'order');
      await drain();
      expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'rebuild', fallback: [{ column: 'status', values: [{ value: '已退款' }] }] });
      expect(alerts()).toEqual([]);

      // 新取值待审核与已关闭：再通知一次，个数只算新的
      await grantOnSource(`INSERT INTO shop.order_log VALUES ('A4', '待审核', 200, '2024-06-05 10:00'), ('A5', '已关闭', 300, '2024-06-05 10:00'), ('A6', '已退款', 1, '2024-06-05 10:00');`);
      await syncSource(author, id);
      await drain();
      expect(alerts()).toHaveLength(3);
      expect(alerts()[0].text).toContain('status 有 2 个新取值');
      expect(await getDb().select().from(mappingFallbackValues).where(eq(mappingFallbackValues.mappingId, mapping)).then(r => r.map(v => v.value).sort()))
        .toEqual(['已关闭', '已退款', '待审核'].sort());
    } finally {
      setMailer(undefined);
    }
  });

  it('草稿作者不能自己发布；发布后版本锁定，再改是新的一版草稿，发布新版本后按新版本重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    await expect(publishMapping(author, mapping.id, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('另一位') });
    // 最后保存草稿的成员不能发布
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    // 双人 403 由 publishing.ts 抛（PublishError，ADR-0051），不再是 MappingError
    await expect(publishMapping(reviewer, mapping.id, 1)).rejects.toBeInstanceOf(PublishError);
    const third = await memberOf(acme, 'admin@acme.com', 'admin');
    await publishMapping(third, mapping.id, 1);
    await drain();
    await expect(publishMapping(third, mapping.id, 1)).rejects.toThrow(/已锁定/);

    expect(await saveDraft(author, mapping.id, CUSTOMERS.replace('city: city', "city: concat(city, '市')"))).toBe(2);
    const detail = await getMapping(author, mapping.id);
    expect(detail.versions.map(v => [v.version, v.status])).toEqual([[2, 'draft'], [1, 'published']]);
    expect(detail.versions[1].yaml).toContain('upper(city)');
    // 草稿不影响标准层
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).toMatchObject({ city: '上海', _version: 1 });

    await publishMapping(reviewer, mapping.id, 2);
    await drain();
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).toMatchObject({ city: '上海市', _version: 2 });
    expect((await getMapping(author, mapping.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', version: 2, rows: 40 });
  });

  it('发布者不能是最后保存草稿的人：A 起草、B 修改后 A 能发布，作者仍记下两人', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    // A 再保存后作者顺序不变，最后保存的人换回 A
    await saveDraft(author, mapping.id, CUSTOMERS.replace('city: city', 'city: lower(city)'));
    await expect(publishMapping(author, mapping.id, 1)).rejects.toMatchObject({ status: 403 });
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    await publishMapping(author, mapping.id, 1);
    expect((await getMapping(author, mapping.id)).versions[0]).toMatchObject({ status: 'published', authors: [author.email, reviewer.email], lastEditor: reviewer.email });
  });

  it('发布等锁期间草稿被丢弃时，发布被拒绝并提示刷新', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    let publishing!: Promise<unknown>;
    await getDb().transaction(async tx => {
      await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mapping.id)).for('update');
      publishing = publishMapping(reviewer, mapping.id, 1).then(() => null, (e: unknown) => e);
      // 等发布阻塞在映射行的锁上，再像丢弃草稿那样删掉草稿
      for (let i = 0; i < 100; i++) {
        const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (rows[0].n > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      await tx.delete(mappingVersions).where(eq(mappingVersions.mappingId, mapping.id));
    });
    // 提交后发布才拿到锁
    const error = await publishing;
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).message).toMatch(/请刷新/);
  });

  it('已被已发布映射引用的表不能移出同步范围；映射引用的字段在源表里没有时不能保存；扩展字段不能换类型', async () => {
    const { author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    await expect(setSyncScope(author, id, { remove: ['customers'] })).rejects.toThrow(/已被已发布的映射引用/);
    await setSyncScope(author, id, { remove: ['regions'] });

    const error = await createMapping(author, id, ORDERS.replace('amount: amount', 'amount: pay_amount')).catch(e => e);
    expect(error).toBeInstanceOf(MappingError);
    expect(error.issues).toEqual([expect.objectContaining({ line: 7, path: 'fields.amount', message: '源表 orders 中没有字段 pay_amount' })]);
    await expect(createMapping(author, id, CUSTOMERS)).rejects.toThrow(/已有到 消费者 的映射/);

    // 扩展字段建好后不改类型：新版本换了类型时不能发布
    const orders = await publish(author, reviewer, id, ORDERS);
    await saveDraft(author, orders, ORDERS.replace('type: integer, expr: amount * 100', 'type: string, expr: string(amount)'));
    await expect(publishMapping(reviewer, orders, 2)).rejects.toThrow(/字段 x_amount_fen 在已发布的映射里是 integer，这里是 string/);
  });

  it('新版本去掉被已发布指标引用的扩展字段时拒绝发布，报出指标的键与字段；指标草稿里的引用不算', async () => {
    const { author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    await createDefinition(author, 'metric', 'fen_total', 'base: order\nmeasure: { agg: sum, field: x_amount_fen }\n');
    await publishDefinition(reviewer, 'metric', 'fen_total', 1);
    await saveDraft(author, orders, ORDERS.replace(/extensions:[^]*$/, ''));
    await expect(publishMapping(reviewer, orders, 2)).rejects.toMatchObject({
      message: '发布后 order 的已发布映射里不再有已发布指标引用的扩展字段，不能发布：指标 fen_total 的 x_amount_fen',
    });

    await deleteDefinition(reviewer, 'metric', 'fen_total');
    await createDefinition(author, 'metric', 'fen_total', 'base: order\nmeasure: { agg: sum, field: x_amount_fen }\n');
    await publishMapping(reviewer, orders, 2);
  });

  it('只有映射引用的表同步写入了变更才合并：别的表、别的数据源、没有变更的同步都不合并，定时检查也不补；发布只合并一次', async () => {
    const { acme, author, reviewer, id, input } = await syncedSource();
    const merges = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge').length;
    const mapping = await publish(author, reviewer, id, CUSTOMERS);
    // 发布后合并一次，定时检查不再补
    expect(await merges()).toBe(1);
    expect(await enqueueDueMerges()).toEqual([]);

    // 只改了映射没引用的表
    await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
    await syncSource(author, id);
    await drain();
    // 同步没有写入变更
    await syncSource(author, id);
    await drain();
    // 另一个数据源的同名表写入了变更
    const other = await registerSource(author, { ...input, name: '电商库副本' });
    await setSyncScope(author, other.id, { add: ['customers'] });
    await drain();
    await confirmWatermark(author, other.id, 'customers', 'updated_at');
    await syncSource(author, other.id);
    await drain();
    // 第 2、4 次同步确实写入了变更（任务按新到旧排列）
    const changed = (t: { result: unknown }, table: string) =>
      ((t.result as { tables: { table: string; rows?: number }[] }).tables).some(r => r.table === table && r.rows! > 0);
    const syncs = (await listTasks(acme)).filter(t => t.kind === 'source.sync');
    expect(syncs).toHaveLength(4);
    expect([changed(syncs[0], 'customers'), changed(syncs[1], 'customers') || changed(syncs[1], 'orders'), changed(syncs[2], 'orders')]).toEqual([true, false, true]);
    expect(await merges()).toBe(1);
    expect(await enqueueDueMerges()).toEqual([]);

    // 映射引用的表写入了变更：同步后合并一次
    await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
    await syncSource(author, id);
    await drain();
    expect(await merges()).toBe(2);
    expect(await enqueueDueMerges()).toEqual([]);
    expect((await getMapping(author, mapping)).merge.history[0]).toMatchObject({ mode: 'incremental', updated: 1 });

    // 发布时已有合并在排队：新发布的映射补进排队中的那个合并，定时检查不再补
    const queued = await mergeNow(author);
    const orders = await createMapping(author, id, ORDERS);
    const extended = await publishMapping(reviewer, orders.id, 1);
    expect(extended?.id).toBe(queued.id);
    expect(mergedMappings(extended!)).toEqual([mapping, orders.id].sort());
    await drain();
    expect(await merges()).toBe(3);
    expect(await enqueueDueMerges()).toEqual([]);
    expect((await getMapping(author, orders.id)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 101 });
  });

  it('合并只带受影响的映射：发布只带刚发布的映射，同步只带源表写入了变更的映射，别的映射不新增合并记录', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const mergeTasks = async () => (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);
      // 发布订单映射时只合并订单映射
      expect((await mergeTasks()).map(mergedMappings)).toEqual([[orders], [customers]]);
      expect((await getMapping(author, customers)).merge.history).toHaveLength(1);

      await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
      await syncSource(author, id);
      await drain();
      const [latest] = await mergeTasks();
      expect(mergedMappings(latest)).toEqual([orders]);
      expect((await getMapping(author, orders)).merge.history[0]).toMatchObject({ mode: 'incremental', inserted: 1 });
      expect((await getMapping(author, customers)).merge.history).toHaveLength(1);
      expect(await enqueueDueMerges()).toEqual([]);

      // 订单映射发布新版本、合并还在排队时，又一次同步给消费者表写入了变更：消费者映射补进同一个合并
      await saveDraft(author, orders, ORDERS.replace('customer_id: string(customer_id)', 'customer_id: trim(string(customer_id))'));
      const queued = await publishMapping(reviewer, orders, 2);
      expect(mergedMappings(queued!)).toEqual([orders]);
      // 首次同步给全部表写入了变更
      const [firstSync] = (await listTasks(acme)).filter(t => t.kind === 'source.sync').slice(-1);
      const extended = await mergeAfterSync(acme, firstSync.id);
      expect(extended?.id).toBe(queued!.id);
      expect((extended!.params as { mappings: { mapping: string; version: number }[] }).mappings.map(m => [m.mapping, m.version]))
        .toEqual([[customers, 1], [orders, 2]].sort());

      // 手动合并仍带全部映射
      await drain();
      expect(mergedMappings(await mergeNow(author))).toEqual([customers, orders].sort());
    });
  });

  it('合并运行期间同步写入的变更，在它结束后由定时检查补上，只带变更了的映射', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);
      // 让同步能与“运行中”的合并同时进行
      await getDb().update(tenants).set({ maxConcurrentTasks: 2 }).where(eq(tenants.id, acme));
      // 模拟一次正在运行的合并（领取后还没结束）
      const running = await mergeNow(author);
      await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, running.id));

      await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;`);
      await syncSource(author, id);
      await drain();
      // 合并在运行，同步后不入队
      expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge' && t.status === 'queued')).toEqual([]);
      expect(await enqueueDueMerges()).toEqual([]);

      await getDb().update(tasks).set({ status: 'succeeded', finishedAt: sql`now()`, result: { mappings: [] } }).where(eq(tasks.id, running.id));
      expect(await enqueueDueMerges()).toEqual([acme]);
      const [due] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
      expect(mergedMappings(due)).toEqual([customers]);
      await drain();
      expect((await getMapping(author, customers)).merge.history[0]).toMatchObject({ mode: 'incremental', updated: 1 });
      expect((await getMapping(author, orders)).merge.history).toHaveLength(1);
      expect(await enqueueDueMerges()).toEqual([]);
    });
  });

  it('详情页只合并这一个映射：任务只带它、只有它新增合并记录；已有合并在排队时并进去，在运行时提示由定时检查补上', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customers = await publish(author, reviewer, id, CUSTOMERS);
      const orders = await publish(author, reviewer, id, ORDERS);

      const task = await mergeMapping(author, customers);
      expect(mergedMappings(task)).toEqual([customers]);
      await drain();
      expect((await getMapping(author, customers)).merge.history).toHaveLength(2);
      expect((await getMapping(author, orders)).merge.history).toHaveLength(1);

      // 已有合并在排队：并进同一个任务
      const queued = await mergeMapping(author, customers);
      const extended = await mergeMapping(author, orders);
      expect(extended.id).toBe(queued.id);
      expect(mergedMappings(extended)).toEqual([customers, orders].sort());

      // 合并在运行：不入队，提示稍后补上
      await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, queued.id));
      await expect(mergeMapping(author, orders)).rejects.toThrow('已有一次合并在运行');
      expect((await listTasks(acme)).filter(t => t.kind === 'silver.merge' && t.status === 'queued')).toEqual([]);

      // 只有草稿的映射、别的租户的映射
      const draft = await createMapping(author, id, ORDER_LOG_MAPPING);
      await expect(mergeMapping(author, draft.id)).rejects.toThrow('这个映射还没有已发布的版本');
      const other = await memberOf(await newTenant('globex'), 'de@globex.com');
      await expect(mergeMapping(other, customers)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('重建合并补上标准层缺的列：只带写入这个实体的映射并都带强制重建标记，行数不变；不带标记的合并补不上；已有合并在排队或运行、没有映射、查看者都被拒', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const customers = await publish(author, reviewer, id, CUSTOMERS);
    await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'customer', 'customer_id::INT');
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run('ALTER TABLE silver.customer DROP COLUMN city');
    } finally {
      session.close();
    }

    // 没有新批次的普通合并提前返回，缺的列补不上
    await mergeMapping(author, customers);
    await drain();
    expect((await silver(acme, 'customer', 'customer_id::INT'))[0]).not.toHaveProperty('city');

    const task = await rebuildEntity(author, 'customer');
    expect(mergedMappings(task)).toEqual([customers]);
    expect((task.params as { mappings: { rebuild?: boolean }[] }).mappings.every(m => m.rebuild === true)).toBe(true);
    await drain();
    const rebuilt = await silver(acme, 'customer', 'customer_id::INT');
    expect(before[0]).toMatchObject({ customer_id: '1', city: '上海' });
    expect(rebuilt).toEqual(before);

    // 合并在排队或运行、没有映射写入的实体、查看者
    const queued = await rebuildEntity(author, 'customer');
    await expect(rebuildEntity(author, 'customer')).rejects.toThrow('已有一次合并在排队或运行中');
    await getDb().update(tasks).set({ status: 'running', startedAt: sql`now()`, heartbeatAt: sql`now()` }).where(eq(tasks.id, queued.id));
    await expect(rebuildEntity(author, 'customer')).rejects.toThrow('已有一次合并在排队或运行中');
    await expect(rebuildEntity(author, 'coupon')).rejects.toThrow('没有已发布的映射写入');
    await expect(rebuildEntity(await memberOf(acme, 'v@acme.com', 'viewer'), 'customer')).rejects.toMatchObject({ init: { status: 403 } });
  });

  it('强制重建的统计：再次重建全算更新；标准层里本映射多出的行（含重复键与空键）算删除，重建后换掉', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const orders = await publish(author, reviewer, id, ORDERS);
    const before = await silver(acme, 'order', 'order_id::INT');
    const latest = async () => (await getMapping(author, orders)).merge.history[0];
    expect(await latest()).toMatchObject({ mode: 'rebuild', inserted: 100, updated: 0, deleted: 0, rows: 100 });

    await rebuildEntity(author, 'order');
    await drain();
    expect(await latest()).toMatchObject({ mode: 'rebuild', inserted: 0, updated: 100, deleted: 0, rows: 100 });

    // 标准层里本映射多出两个源端没有的键、一行重复键与一行空键：重复键只算一次更新，空键连不上任何键算删除
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`INSERT INTO silver."order" SELECT * REPLACE (CASE order_id WHEN '2' THEN 'X1' WHEN '3' THEN 'X2' WHEN '4' THEN NULL ELSE order_id END AS order_id)
        FROM silver."order" WHERE order_id IN ('1', '2', '3', '4')`);
    } finally {
      session.close();
    }
    await rebuildEntity(author, 'order');
    await drain();
    expect(await latest()).toMatchObject({ mode: 'rebuild', inserted: 0, updated: 100, deleted: 3, rows: 100 });
    expect(await silver(acme, 'order', 'order_id::INT')).toEqual(before);
  });
});

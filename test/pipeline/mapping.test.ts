// 映射与标准层合并的流水线接缝：同步到原始层 → 编写映射草稿 → 另一位成员发布 → 调度器派发合并 → 标准层；
// 之后源端的新增、更新与删除随同步后的合并进入标准层，去重键与取最新规则让源端的重复行只计一次
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createMapping, getMapping, MappingError, mergeNow, publishMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 读取本租户标准层某个实体的表（时间按 UTC 文本、金额按文本显示） */
async function silver(tenantId: string, entity: string, orderBy: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    const columns = (await session.con.runAndReadAll(`DESCRIBE silver."${entity}"`)).getRowObjectsJson() as { column_name: string; column_type: string }[];
    // 带时区的时间在会话里按 UTC 转成文本（不交给客户端按本机时区换算）
    const times = columns.filter(c => c.column_type === 'TIMESTAMP WITH TIME ZONE' && c.column_name !== '_merged_at').map(c => `"${c.column_name}"::VARCHAR AS "${c.column_name}"`);
    const reader = await session.con.runAndReadAll(`SELECT * EXCLUDE (_merged_at) REPLACE (_version::INT AS _version${times.map(t => `, ${t}`).join('')})
      FROM silver."${entity}" ORDER BY ${orderBy}`);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    session.close();
  }
}

/**
 * 没有主键的订单流水：同一订单的多个版本（含完全相同的重复行），状态是中文
 */
const ORDER_LOG = `
  CREATE TABLE shop.order_log (order_no text NOT NULL, status text NOT NULL, amount_fen int NOT NULL, updated_at timestamp NOT NULL);
  INSERT INTO shop.order_log VALUES
    ('A1', '已支付', 1990, '2024-06-01 10:00'), ('A1', '已支付', 1990, '2024-06-01 10:00'),
    ('A1', '已退款', 1990, '2024-06-03 10:00'), ('A2', '已支付', 500, '2024-06-02 10:00');
  GRANT SELECT ON shop.order_log TO ${READER.user};`;

/** 两位数据工程师：一位起草、一位发布。登记数据源、选入全部表、确认水位线并同步一次 */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const input = await pgSourceInput(READER);
  await grantOnSource(ORDER_LOG);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
  await confirmWatermark(author, id, 'order_log', 'updated_at');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id };
}

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  city: city
  registered_at: from_timezone(created_at, 'Asia/Shanghai')
  updated_at: updated_at
`;

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
extensions:
  x_amount_fen: { type: integer, expr: amount * 100 }
`;

const ORDER_LOG_MAPPING = `model: 1
entity: order
table: order_log
fields:
  order_id: order_no
  amount: amount_fen / 100
  updated_at: updated_at
  status:
    expr: trim(status)
    dictionary: { 已支付: paid, 已退款: refunded }
dedupe:
  key: [order_id]
  latest: updated_at
`;

/** 起草并由另一位成员发布，让调度器跑完合并 */
async function publish(author: Awaited<ReturnType<typeof memberOf>>, reviewer: typeof author, sourceId: string, yaml: string) {
  const mapping = await createMapping(author, sourceId, yaml);
  await publishMapping(reviewer, mapping.id, 1);
  await drain();
  return mapping.id;
}

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

describe('发布映射并合并到标准层', () => {
  it('已发布的映射把原始层合并成标准实体：表达式、值字典、时区转换与扩展字段都生效', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const orders = await createMapping(author, id, ORDERS);
    await publishMapping(reviewer, orders.id, 1);
    await drain();

    const customers = await silver(acme, 'customer', 'customer_id::INT');
    expect(customers).toHaveLength(40);
    expect(customers[0]).toMatchObject({
      customer_id: '1', name: '消费者1', email: 'user1@example.com', city: '上海', _source: id, _version: 1,
      // 源端 2024-01-02 00:00 是北京时间
      registered_at: '2024-01-01 16:00:00+00', updated_at: '2024-06-01 01:00:00+00',
      // 没映射的标准字段为空
      phone: null, gender: null,
    });
    const order = await silver(acme, 'order', 'order_id::INT');
    expect(order).toHaveLength(100);
    expect(order[0]).toMatchObject({ order_id: '1', customer_id: '2', amount: '11.00', status: 'refunded', x_amount_fen: '1100' });
    expect(new Set(order.map(o => o.status))).toEqual(new Set(['paid', 'refunded']));
  });

  it('同步后的合并把源端的新增、更新与删除带进标准层；没有新批次时合并不改动', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      const customerMapping = await publish(author, reviewer, id, CUSTOMERS);
      const orderMapping = await publish(author, reviewer, id, ORDERS);

      await grantOnSource(`
        UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;
        DELETE FROM shop.customers WHERE customer_id = 7;
        DELETE FROM shop.orders WHERE order_id = 3;
        INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01');`);
      await syncSource(author, id);
      // 同步结束后调度器随即入队合并
      await drain();

      const customers = await silver(acme, 'customer', 'customer_id::INT');
      expect(customers).toHaveLength(39);
      expect(customers.find(c => c.customer_id === '5')).toMatchObject({ city: '成都', updated_at: '2024-07-01 10:00:00+00' });
      expect(customers.find(c => c.customer_id === '7')).toBeUndefined();
      const orders = await silver(acme, 'order', 'order_id::INT');
      expect(orders.map(o => o.order_id)).not.toContain('3');
      expect(orders.find(o => o.order_id === '101')).toMatchObject({ customer_id: '5', amount: '99.00', status: 'paid' });
      expect(orders).toHaveLength(100);

      const [latest] = (await getMapping(author, customerMapping)).merge.history;
      expect(latest).toMatchObject({ mode: 'incremental', batchFrom: 1, updated: 1, deleted: 1, inserted: 0, rows: 39 });
      expect((await getMapping(author, orderMapping)).merge.history[0]).toMatchObject({ inserted: 1, deleted: 1, updated: 0, rows: 100 });

      // 没有新的变更批次：合并什么都不改
      await mergeNow(author);
      await drain();
      expect((await getMapping(author, customerMapping)).merge.history[0]).toMatchObject({ inserted: 0, updated: 0, deleted: 0, rows: 39 });
      expect(await silver(acme, 'customer', 'customer_id::INT')).toEqual(customers);
    });
  });

  it('去重键与取最新规则：源端的重复行只计一次，删除最新的一行后回落到剩下的一行', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, author, reviewer, id } = await syncedSource();
      await publish(author, reviewer, id, ORDER_LOG_MAPPING);
      const rows = () => silver(acme, 'order', 'order_id').then(r => r.map(o => [o.order_id, o.status, o.amount, o.updated_at]));
      expect(await rows()).toEqual([
        ['A1', 'refunded', '19.90', '2024-06-03 10:00:00+00'],
        ['A2', 'paid', '5.00', '2024-06-02 10:00:00+00'],
      ]);

      await grantOnSource(`DELETE FROM shop.order_log WHERE status = '已退款'; DELETE FROM shop.order_log WHERE order_no = 'A2';`);
      await syncSource(author, id);
      await drain();
      expect(await rows()).toEqual([['A1', 'paid', '19.90', '2024-06-01 10:00:00+00']]);
    });
  });

  it('值字典里没有的取值让这个映射合并失败（不悄悄写入），其他映射照常合并', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    const broken = await createMapping(author, id, ORDER_LOG_MAPPING.replace(', 已退款: refunded', ''));
    await publishMapping(reviewer, broken.id, 1);
    await drain();

    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('failed');
    expect(merge.error).toMatch(/字段 status 有值字典里没有的取值：'已退款'（1 行）/);
    expect((await getMapping(author, broken.id)).merge.history[0]).toMatchObject({ error: expect.stringContaining('已退款') });
    expect(await silver(acme, 'customer', 'customer_id::INT')).toHaveLength(40);
  });

  it('草稿作者不能自己发布；发布后版本锁定，再改是新的一版草稿，发布新版本后按新版本重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    const mapping = await createMapping(author, id, CUSTOMERS);
    await expect(publishMapping(author, mapping.id, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('另一位') });
    // 改过草稿的成员都算作者
    await saveDraft(reviewer, mapping.id, CUSTOMERS.replace('city: city', 'city: upper(city)'));
    await expect(publishMapping(reviewer, mapping.id, 1)).rejects.toBeInstanceOf(MappingError);
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
});

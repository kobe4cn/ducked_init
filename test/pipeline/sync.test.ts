// 水位线增量同步的流水线接缝：确认水位线 → 手动触发或按周期入队同步任务 → 调度器派发 → 变更批次追加到原始层 → 查看每张表的同步历史
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { enqueueDueSyncs, getSyncStatus, syncSource } from '../../app/.server/source-sync';
import { confirmKey, confirmWatermark, getSource, registerSource, SourceError } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdbSourceFile, grantOnSource, MONGO_USERS, pgSourceInput, READER, s3SourceFiles, seedMongoSource, seedMysqlSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 读取本租户数据湖里某个数据源某张表的原始层（按批次与主键排序）；时间按 UTC 显示 */
async function bronze(tenantId: string, sourceId: string, table: string, orderBy: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    const reader = await session.con.runAndReadAll(`SELECT * REPLACE (_batch::INT AS _batch, _commit_ts::VARCHAR AS _commit_ts, _synced_at::VARCHAR AS _synced_at)
      FROM "${bronzeSchema(sourceId)}"."${table}" ORDER BY _batch, ${orderBy}`);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    session.close();
  }
}

/** 登记 PostgreSQL 数据源、采集，并确认 customers 按更新时间、orders 按自增主键同步。prepare 在登记前对源库执行 */
async function pgSourceWithWatermarks(prepare?: string) {
  const acme = await newTenant('acme');
  const engineer = await memberOf(acme, 'de@acme.com');
  const input = await pgSourceInput(READER);
  if (prepare) await grantOnSource(prepare);
  const { id } = await registerSource(engineer, input);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await confirmWatermark(engineer, id, 'orders', 'order_id');
  return { acme, engineer, id };
}

const historyOf = async (engineer: Parameters<typeof getSource>[0], id: string, table: string) =>
  (await getSyncStatus(engineer, id)).history[table] ?? [];

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

const sync = async (engineer: Parameters<typeof getSource>[0], id: string) => { await syncSource(engineer, id); await drain(); };

describe('水位线增量同步到原始层', () => {
  it('首次同步为全量；之后按水位线增量，源端的新增与更新都以变更批次追加到原始层', async () => {
    const { acme, engineer, id } = await pgSourceWithWatermarks();
    await syncSource(engineer, id);
    await drain();

    const first = await bronze(acme, id, 'customers', 'customer_id');
    expect(first).toHaveLength(40);
    expect(new Set(first.map(r => `${r._op}/${r._batch}`))).toEqual(new Set(['insert/1']));
    // 更新时间水位线：源端提交时间取自该字段
    expect(first[0]).toMatchObject({ customer_id: 1, name: '消费者1', _commit_ts: '2024-06-01 01:00:00+00' });
    expect(await bronze(acme, id, 'orders', 'order_id')).toHaveLength(100);
    // 没有确认水位线的表本次不同步
    expect(await historyOf(engineer, id, 'regions')).toEqual([]);

    await grantOnSource(`
      INSERT INTO shop.customers (name, email, phone, city, created_at, updated_at)
        VALUES ('新客', 'new@example.com', '13900000041', '杭州', '2024-07-01', '2024-07-01 09:00:00');
      UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01 10:00:00' WHERE customer_id = 5;
      INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (5, 99, 'paid', '2024-07-01'), (41, 5, 'paid', '2024-07-01');`);
    await syncSource(engineer, id);
    await drain();

    const customers = await bronze(acme, id, 'customers', 'customer_id');
    const second = customers.filter(r => r._batch === 2);
    expect(second.map(r => [r.customer_id, r._op, r.city])).toEqual([[5, 'update', '成都'], [41, 'insert', '杭州']]);
    // 历史批次保留：按批次回放、每个主键取最后一版即为源表当前状态
    expect(customers.filter(r => r.customer_id === 5).map(r => [r._batch, r.city])).toEqual([[1, '上海'], [2, '成都']]);
    const orders = (await bronze(acme, id, 'orders', 'order_id')).filter(r => r._batch === 2);
    expect(orders.map(r => [r.order_id, r._op])).toEqual([['101', 'insert'], ['102', 'insert']]);

    const history = await historyOf(engineer, id, 'customers');
    expect(history.map(({ table: _t, taskId: _id, startedAt: _s, durationMs: _d, ...h }) => h)).toMatchObject([
      { batch: 2, mode: 'incremental', rows: 2, inserted: 1, updated: 1 },
      { batch: 1, mode: 'full', rows: 40, inserted: 40, updated: 0 },
    ]);
    expect(history[1]).toMatchObject({ watermarkColumn: 'updated_at', watermarkFrom: null, watermarkTo: '2024-06-02 16:00:00' });
    expect(history[0]).toMatchObject({ watermarkFrom: '2024-06-02 16:00:00', watermarkTo: '2024-07-01 10:00:00' });
    expect(history[0].durationMs).toBeGreaterThanOrEqual(0);
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ batch: 2, rows: 2, watermarkFrom: '100', watermarkTo: '102' });
  });

  it('没有变化时产出空批次，水位线不变；与水位线相同时刻后到的行不会漏，已同步的不会重复', async () => {
    const { acme, engineer, id } = await pgSourceWithWatermarks();
    await syncSource(engineer, id);
    await drain();
    await syncSource(engineer, id);
    await drain();
    expect((await historyOf(engineer, id, 'customers'))[0]).toMatchObject({
      batch: 2, rows: 0, watermarkFrom: '2024-06-02 16:00:00', watermarkTo: '2024-06-02 16:00:00',
    });

    await grantOnSource(`INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('同一时刻', '2024-06-02', '2024-06-02 16:00:00')`);
    await syncSource(engineer, id);
    await drain();
    const third = (await bronze(acme, id, 'customers', 'customer_id')).filter(r => r._batch === 3);
    expect(third.map(r => [r.customer_id, r._op])).toEqual([[41, 'insert']]);
  });

  it('从水位线往回多读一个回看窗口：长事务晚提交的行、晚提交的小自增主键不会漏，回看范围内没变的行不重复写入', async () => {
    // 95 号订单“分配在前、提交在后”：首次同步时源端还没有它
    const { acme, engineer, id } = await pgSourceWithWatermarks('DELETE FROM shop.orders WHERE order_id = 95');
    await sync(engineer, id);
    await grantOnSource(`
      INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('晚提交', '2024-06-02', '2024-06-02 15:50:00');
      INSERT INTO shop.orders (order_id, customer_id, amount, status, created_at) OVERRIDING SYSTEM VALUE VALUES (95, 1, 1, 'paid', '2024-05-01');`);
    await sync(engineer, id);

    const customers = (await bronze(acme, id, 'customers', 'customer_id')).filter(r => r._batch === 2);
    expect(customers.map(r => [r.name, r._op])).toEqual([['晚提交', 'insert']]);
    expect((await historyOf(engineer, id, 'customers'))[0]).toMatchObject({
      batch: 2, mode: 'incremental', rows: 1, watermarkFrom: '2024-06-02 16:00:00', readFrom: '2024-06-02 15:45:00', watermarkTo: '2024-06-02 16:00:00',
    });
    const orders = (await bronze(acme, id, 'orders', 'order_id')).filter(r => r._batch === 2);
    expect(orders.map(r => [r.order_id, r._op])).toEqual([['95', 'insert']]);
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ rows: 1, watermarkFrom: '100', readFrom: '0', watermarkTo: '100' });
  });

  it('到了比对周期时比对主键全集：源端删除的主键记为删除，水位线漏掉的行补为新增；之后的更新照常识别', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, engineer, id } = await pgSourceWithWatermarks();
      await sync(engineer, id);
      // 更新时间早于回看窗口的新行（如直接改库补录的历史数据）增量读不到
      await grantOnSource(`
        DELETE FROM shop.customers WHERE customer_id = 7;
        INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('补录', '2024-01-01', '2024-01-01');
        DELETE FROM shop.orders WHERE order_id = 3;`);
      await sync(engineer, id);

      const history = await historyOf(engineer, id, 'customers');
      expect(history.map(h => 'batch' in h && [h.batch, h.mode, h.rows])).toEqual([[3, 'reconcile', 2], [2, 'incremental', 0], [1, 'full', 40]]);
      expect(history[0]).toMatchObject({ inserted: 1, deleted: 1, watermarkTo: '2024-06-02 16:00:00' });
      const reconciled = (await bronze(acme, id, 'customers', 'customer_id')).filter(r => r._batch === 3);
      // 删除记录只带主键
      expect(reconciled.map(r => [r.customer_id, r._op, r.name])).toEqual([[7, 'delete', null], [41, 'insert', '补录']]);
      const orders = (await bronze(acme, id, 'orders', 'order_id')).filter(r => r._batch === 3);
      expect(orders.map(r => [r.order_id, r._op])).toEqual([['3', 'delete']]);

      await grantOnSource(`UPDATE shop.customers SET city = '成都', updated_at = '2024-07-01' WHERE customer_id = 41`);
      await sync(engineer, id);
      const later = (await bronze(acme, id, 'customers', 'customer_id')).filter(r => Number(r._batch) >= 4);
      expect(later.map(r => [r._batch, r.customer_id, r._op])).toEqual([[4, 41, 'update']]);
    });
  });

  it('没有主键的表可以确认业务主键：据此区分新增与更新、发现删除；主键不唯一时这张表同步失败', async () => {
    await withEnv({ SOURCE_RECONCILE_HOURS: '0' }, async () => {
      const { acme, engineer, id } = await pgSourceWithWatermarks(`
        CREATE TABLE shop.subscriptions (email text NOT NULL, plan text NOT NULL, updated_at timestamp NOT NULL);
        INSERT INTO shop.subscriptions SELECT 'user' || i || '@example.com', 'basic', TIMESTAMP '2024-06-01' + i * INTERVAL '1 hour' FROM generate_series(1, 10) i;
        GRANT SELECT ON shop.subscriptions TO ${READER.user};`);
      const table = (await getSource(engineer, id)).tables.find(t => t.name === 'subscriptions')!;
      expect(table).toMatchObject({ primaryKey: [], keyCandidates: ['email'], key: null });
      await expect(confirmKey(engineer, id, 'subscriptions', 'plan')).rejects.toBeInstanceOf(SourceError);
      await expect(confirmKey(engineer, id, 'customers', 'email')).rejects.toThrow(/已有主键/);
      await confirmWatermark(engineer, id, 'subscriptions', 'updated_at');
      await confirmKey(engineer, id, 'subscriptions', 'email');
      await sync(engineer, id);

      await grantOnSource(`
        UPDATE shop.subscriptions SET plan = 'pro', updated_at = '2024-07-01' WHERE email = 'user2@example.com';
        DELETE FROM shop.subscriptions WHERE email = 'user3@example.com';`);
      await sync(engineer, id);
      const rows = (await bronze(acme, id, 'subscriptions', 'email')).filter(r => Number(r._batch) > 1);
      expect(rows.map(r => [r._batch, r.email, r._op])).toEqual([[2, 'user2@example.com', 'update'], [3, 'user3@example.com', 'delete']]);

      await grantOnSource(`INSERT INTO shop.subscriptions VALUES ('user2@example.com', 'basic', '2024-07-02')`);
      await syncSource(engineer, id);
      await drain();
      const [failed] = (await getSyncStatus(engineer, id)).history.subscriptions;
      expect(failed).toMatchObject({ error: expect.stringContaining('不唯一') });
    });
  });

  it('源表新增字段后照常同步，原始层随之加列', async () => {
    const { acme, engineer, id } = await pgSourceWithWatermarks();
    await syncSource(engineer, id);
    await drain();
    await grantOnSource(`
      ALTER TABLE shop.customers ADD COLUMN level text;
      UPDATE shop.customers SET level = 'gold', updated_at = '2024-07-01' WHERE customer_id = 1;`);
    await syncSource(engineer, id);
    await drain();
    const rows = await bronze(acme, id, 'customers', 'customer_id');
    expect(rows.filter(r => r._batch === 2).map(r => [r.customer_id, r._op, r.level])).toEqual([[1, 'update', 'gold']]);
    expect(rows[0].level).toBeNull();
  });

  it('DuckDB 文件数据源按自增主键增量同步', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    await duckdbSourceFile(acme);
    const { id } = await registerSource(engineer, { kind: 'duckdb', name: '会员文件', path: 'shop.duckdb' });
    await drain();
    await confirmWatermark(engineer, id, 'members', 'member_id');
    await syncSource(engineer, id);
    await drain();
    const [record] = await historyOf(engineer, id, 'members');
    expect(record).toMatchObject({ batch: 1, mode: 'full', rows: 30, watermarkTo: '30' });
    // 自增主键水位线拿不到源端提交时间，用同步时间代替
    const [row] = await bronze(acme, id, 'members', 'member_id');
    expect(row._commit_ts).toBe(row._synced_at);
  });
});

describe('手动触发同步', () => {
  it('数据工程师可以触发；已有同步在排队时不重复提交；没有确认水位线的数据源不能同步；分析师不能触发', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await drain();
    await expect(syncSource(engineer, id)).rejects.toThrow(/没有已确认水位线的表/);

    await confirmWatermark(engineer, id, 'orders', 'order_id');
    const task = await syncSource(engineer, id);
    expect(task.params).toEqual({ sourceId: id, tables: [{ name: 'orders', column: 'order_id', kind: 'increment' }] });
    await expect(syncSource(engineer, id)).rejects.toBeInstanceOf(SourceError);
    expect(await getSyncStatus(engineer, id)).toMatchObject({ status: 'queued' });

    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await expect(syncSource(analyst, id)).rejects.toMatchObject({ init: { status: 403 } });
  });

  it('某张表同步失败时其余表照常同步，任务记为失败并说明失败的表', async () => {
    const { engineer, id } = await pgSourceWithWatermarks();
    await grantOnSource(`REVOKE SELECT ON shop.orders FROM ${READER.user}`);
    await syncSource(engineer, id);
    await drain();

    const sync = await getSyncStatus(engineer, id);
    expect(sync).toMatchObject({ status: 'failed', error: expect.stringContaining('orders') });
    expect(sync.history.customers[0]).toMatchObject({ batch: 1, rows: 40 });
    expect(sync.history.orders[0]).toMatchObject({ error: expect.stringContaining('读权限') });
  });
});

describe('按周期同步', () => {
  it('确认了水位线的数据源每个周期入队一次同步，周期内不重复入队', async () => {
    const { acme, id } = await pgSourceWithWatermarks();
    const other = await newTenant('globex');
    await registerSource(await memberOf(other, 'de@globex.com'), await pgSourceInput(READER));
    await drain();

    expect(await enqueueDueSyncs()).toEqual([id]);
    expect(await enqueueDueSyncs()).toEqual([]);
    await drain();
    expect(await enqueueDueSyncs()).toEqual([]);
    expect((await listTasks(acme)).filter(t => t.kind === 'source.sync').map(t => t.status)).toEqual(['succeeded']);
    // 周期过去之后再次入队
    expect(await enqueueDueSyncs(new Date(Date.now() + 61 * 60_000))).toEqual([id]);
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL 数据源同步', () => {
  it('按更新时间增量同步，条件在源端执行', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, { ...(await seedMysqlSource()), name: '订单库', ...READER });
    await drain();
    await confirmWatermark(engineer, id, 'orders', 'updated_at');
    await syncSource(engineer, id);
    await drain();
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ batch: 1, rows: 3, watermarkTo: '2024-06-03 10:00:00' });
  });
});

describe.skipIf(!process.env.TEST_MONGO_URL)('MongoDB 数据源同步', () => {
  it('按更新时间与 ObjectId 增量同步；嵌套字段展开成列，已有 _id 的文档记为更新', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, { ...(await seedMongoSource()), name: '商城', ...MONGO_USERS.reader });
    await drain();
    await confirmWatermark(engineer, id, 'customers', 'updated_at');
    await confirmWatermark(engineer, id, 'orders', '_id');
    await syncSource(engineer, id);
    await drain();
    expect((await historyOf(engineer, id, 'customers'))[0]).toMatchObject({ batch: 1, rows: 40 });
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ batch: 1, rows: 100 });

    const client = new MongoClient(process.env.TEST_MONGO_URL!);
    try {
      const db = client.db();
      await db.collection('customers').updateOne({ name: '消费者3' }, { $set: { 'address.city': '成都', updated_at: new Date(Date.UTC(2024, 6, 1)) } });
      await db.collection('orders').insertOne({ customer: 3, amount: 1, status: 'paid' });
    } finally {
      await client.close();
    }
    await syncSource(engineer, id);
    await drain();
    const customers = (await bronze(acme, id, 'customers', 'name')).filter(r => r._batch === 2);
    expect(customers.map(r => [r.name, r._op, r.address_city])).toEqual([['消费者3', 'update', '成都']]);
    const orders = (await bronze(acme, id, 'orders', '_id')).filter(r => r._batch === 2);
    expect(orders.map(r => [r.customer, r._op])).toEqual([['3', 'insert']]);
  });
});

describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储上的数据源与数据湖', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('源文件与数据湖都在对象存储上时各用各的账号；没有主键的表增量行一律记为新增', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const files = await s3SourceFiles(acme);
    try {
      const { id } = await registerSource(engineer, { ...files.base, name: '文件', ...files.reader });
      await drain();
      await confirmWatermark(engineer, id, 'customers', 'updated_at');
      await syncSource(engineer, id);
      await drain();
      expect((await historyOf(engineer, id, 'customers'))[0]).toMatchObject({ batch: 1, rows: 20, watermarkTo: '2024-06-01 19:00:00' });

      // 源端重写文件：0 号更新、新增 20 号
      const c = { key: process.env.S3_ACCESS_KEY!, secret: process.env.S3_SECRET_KEY! };
      const instance = await DuckDBInstance.create(':memory:');
      const con = await instance.connect();
      await con.run(`INSTALL httpfs; LOAD httpfs;
        CREATE SECRET (TYPE s3, KEY_ID '${c.key}', SECRET '${c.secret}', REGION '${files.base.region}', ENDPOINT '${files.base.endpoint}', URL_STYLE 'path', USE_SSL false);
        COPY (SELECT i AS customer_id, 'user' || i || '@example.com' AS email,
                     CASE WHEN i = 0 THEN TIMESTAMP '2024-07-01' ELSE TIMESTAMP '2024-06-01' + to_hours(i) END AS updated_at
              FROM range(21) t(i)) TO '${files.base.path}customers.parquet';`);
      con.closeSync();
      instance.closeSync();
      await syncSource(engineer, id);
      await drain();
      const second = (await bronze(acme, id, 'customers', 'customer_id')).filter(r => r._batch === 2);
      expect(second.map(r => [r.customer_id, r._op])).toEqual([['0', 'insert'], ['20', 'insert']]);
    } finally {
      await files.cleanup();
    }
  });
});

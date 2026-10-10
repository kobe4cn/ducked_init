// 湖中数据核对的流水线接缝：同步 → 成员触发或调度器入队 source.verify → 调度器派发 → 核对结果（覆盖、位置、文件、结构、数据量）存于任务结果。
// 核对只读：全程不修改湖中数据与目录
import { copyFile, rm } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { platformS3 } from '../../app/.server/s3-accounts';
import { deleteObject } from '../../app/.server/s3-client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { getSyncStatus, syncSource } from '../../app/.server/source-sync';
import { enqueueDueVerifies, getVerifyStatus, verifySource } from '../../app/.server/source-verify';
import { confirmKey, confirmWatermark, registerSource, SourceError, setSyncScope } from '../../app/.server/sources';
import { listTasks } from '../../app/.server/tasks';
import { suspendTenant } from '../../app/.server/tenants';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { duckdbSourceFile, grantOnSource, MONGO_USERS, pgSourceInput, READER, seedMongoSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 在本租户数据湖里执行 SQL（测试里模拟湖被意外改动、查看快照） */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

/** 登记 PostgreSQL 数据源、全部选入同步范围并确认水位线，同步一次。prepare 在登记前对源库执行 */
async function syncedPgSource(prepare?: string) {
  const acme = await newTenant('acme');
  const engineer = await memberOf(acme, 'de@acme.com');
  const input = await pgSourceInput(READER);
  if (prepare) await grantOnSource(prepare);
  const { id } = await registerSource(engineer, input);
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await confirmWatermark(engineer, id, 'orders', 'order_id');
  await syncSource(engineer, id);
  await drain();
  return { acme, engineer, id };
}

const verify = async (engineer: Parameters<typeof verifySource>[0], id: string) => {
  await verifySource(engineer, id);
  await drain();
  return getVerifyStatus(engineer, id);
};

describe('核对同步过的数据源', () => {
  it('每张表给出位置，文件、结构与数据量都一致；核对不修改湖中数据与目录', async () => {
    const { acme, engineer, id } = await syncedPgSource();
    const [before] = await onLake<{ n: string }>(acme, `SELECT max(snapshot_id)::VARCHAR AS n FROM ducklake_snapshots('lake')`);

    const report = await verify(engineer, id);
    expect(report).toMatchObject({ status: 'succeeded', differences: 0 });
    const customers = report.tables.find(t => t.table === 'customers')!;
    expect(customers).toMatchObject({
      coverage: 'in_lake',
      sourceRows: 40,
      ok: true,
      location: { schema: bronzeSchema(id), table: 'customers', state: `${bronzeSchema(id)}_keys.customers` },
      files: { ok: true, missing: [], orphans: [] },
      structure: { ok: true, missingInLake: [], extraInLake: [], typeChanged: [] },
      data: { keyed: true, ok: true, sourceRows: 40, lakeRows: 40, missing: 0, pendingSync: 0, extra: 0 },
    });
    expect(customers.location!.prefix).toMatch(new RegExp(`/${bronzeSchema(id)}/customers/$`));
    expect(report.tables.find(t => t.table === 'regions')).toMatchObject({
      coverage: 'in_lake', ok: true, data: { keyed: false, sourceRows: 2, lakeRows: 2 },
    });

    const [after] = await onLake<{ n: string }>(acme, `SELECT max(snapshot_id)::VARCHAR AS n FROM ducklake_snapshots('lake')`);
    expect(after.n).toBe(before.n);
  });
});

/** 某张表的核对结果 */
const tableOf = (report: Awaited<ReturnType<typeof getVerifyStatus>>, name: string) => report.tables.find(t => t.table === name)!;

describe('覆盖：从源端的全部表出发', () => {
  it('源端有、从未同步过的表也在结果里，标为未进湖并说明原因与源端行数', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    // secrets：账号读不了；regions 声明了不唯一的业务主键，同步失败
    await grantOnSource(`CREATE TABLE shop.secrets (k text); INSERT INTO shop.regions VALUES ('N', '北方二')`);
    const { id } = await registerSource(engineer, input);
    await setSyncScope(engineer, id, { add: ['customers', 'orders', 'regions'] });
    await drain();
    await confirmWatermark(engineer, id, 'orders', 'order_id');
    await grantOnSource(`DELETE FROM shop.regions WHERE name = '北方二'`);
    await confirmKey(engineer, id, 'regions', ['code']);
    await drain();
    await grantOnSource(`INSERT INTO shop.regions VALUES ('N', '北方二')`);
    await syncSource(engineer, id);
    await drain();
    expect((await getSyncStatus(engineer, id)).history.regions[0]).toMatchObject({ error: expect.stringContaining('不唯一') });

    const report = await verify(engineer, id);
    expect(report.tables.map(t => [t.table, t.coverage, t.sourceRows])).toEqual([
      ['customers', 'needs_watermark', 40],
      ['events', 'out_of_scope', 1500],
      ['orders', 'in_lake', 100],
      ['regions', 'sync_failed', 3],
      ['secrets', 'unreadable', null],
    ]);
    expect(report.differences).toBe(0);
  });

  it('源端删除一张已同步的表后，报告「源端已删除」并给出它在湖里的位置', async () => {
    const { engineer, id } = await syncedPgSource();
    await grantOnSource('DROP TABLE shop.regions');
    const regions = tableOf(await verify(engineer, id), 'regions');
    expect(regions).toMatchObject({ coverage: 'gone', sourceRows: null, ok: true, location: { schema: bronzeSchema(id), table: 'regions' } });
    // 源端已删除不算差异，但湖中文件的问题照样计入
    const [file] = await onLake<{ path: string }>(engineer.tenant.id, `SELECT data_file AS path FROM ducklake_list_files('lake', 'events', schema => '${bronzeSchema(id)}')`);
    await grantOnSource('DROP TABLE shop.events');
    await rm(file.path);
    const report = await verify(engineer, id);
    expect(tableOf(report, 'events')).toMatchObject({ coverage: 'gone', ok: false, files: { missing: [file.path] } });
    expect(report.differences).toBe(1);
  });
});

describe('文件', () => {
  it('删除对象存储上的一个数据文件后报告该文件缺失', async () => {
    const { acme, engineer, id } = await syncedPgSource();
    expect(tableOf(await verify(engineer, id), 'customers')).toMatchObject({ files: { current: 1, fileRows: 40, inlinedRows: 0 } });
    const [file] = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', 'customers', schema => '${bronzeSchema(id)}')`);
    await rm(file.path);

    const report = await verify(engineer, id);
    const customers = tableOf(report, 'customers');
    expect(customers).toMatchObject({ ok: false, files: { ok: false, missing: [file.path] }, data: { ok: false, error: expect.any(String) } });
    expect(report.differences).toBe(1);
  });

  it('存储上放入一个未登记的 parquet 文件后报告孤儿文件；待删除清单中的文件不报', async () => {
    const { acme, engineer, id } = await syncedPgSource();
    const schema = bronzeSchema(id);
    // 制造一个只被过期快照引用的文件：写入后整批删掉，再让快照过期，它就进了待删除清单（文件还在存储上）
    await onLake(acme, `
      INSERT INTO "${schema}".customers SELECT * REPLACE (999 AS _batch) FROM "${schema}".customers;
      DELETE FROM "${schema}".customers WHERE _batch = 999;
      CALL ducklake_expire_snapshots('lake', older_than => now());`);
    const { catalogSchema } = (await lakeRow(acme))!;
    const scheduled = await onLake(acme, `SELECT * FROM __ducklake_metadata_lake."${catalogSchema}".ducklake_files_scheduled_for_deletion`);
    expect(scheduled.length).toBeGreaterThan(0);
    const [file] = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', 'customers', schema => '${schema}')`);
    const orphan = file.path.replace(/[^/]+$/, 'stray.parquet');
    await copyFile(file.path, orphan);

    const customers = tableOf(await verify(engineer, id), 'customers');
    expect(customers).toMatchObject({ ok: false, files: { ok: false, missing: [], orphans: [orphan] }, data: { ok: true } });
  });
});

describe('结构', () => {
  it('以源表实时结构为基准：新增一列报告湖中缺列，删除一列报告湖中多出，类型变化区分放宽与不兼容', async () => {
    const { engineer, id } = await syncedPgSource();
    await grantOnSource(`
      ALTER TABLE shop.customers ADD COLUMN level text;
      ALTER TABLE shop.customers DROP COLUMN email;
      ALTER TABLE shop.orders ALTER COLUMN customer_id TYPE bigint;
      ALTER TABLE shop.orders ALTER COLUMN order_id TYPE int;`);
    const report = await verify(engineer, id);
    expect(tableOf(report, 'customers')).toMatchObject({
      ok: false,
      structure: { ok: false, missingInLake: [{ name: 'level', type: 'VARCHAR' }], extraInLake: [{ name: 'email', type: 'VARCHAR' }], typeChanged: [] },
    });
    expect(tableOf(report, 'orders')).toMatchObject({
      structure: {
        missingInLake: [],
        typeChanged: [
          { name: 'order_id', lake: 'BIGINT', source: 'INTEGER', widened: false },
          { name: 'customer_id', lake: 'INTEGER', source: 'BIGINT', widened: true },
        ],
      },
    });
  });

  it('只在湖中多出列（源端删除字段，保留旧列属预期）不算差异', async () => {
    const { engineer, id } = await syncedPgSource();
    await grantOnSource('ALTER TABLE shop.customers DROP COLUMN email');
    expect(tableOf(await verify(engineer, id), 'customers')).toMatchObject({ ok: true, structure: { ok: true, extraInLake: [{ name: 'email' }] } });
  });
});

describe('数据量', () => {
  it('有主键的表：源端物理删除的行报告为湖中多出并给出主键；同步后新插入的行是「同步后新增，待下次同步」，不计为错误', async () => {
    const { engineer, id } = await syncedPgSource();
    await grantOnSource(`
      DELETE FROM shop.customers WHERE customer_id = 7;
      INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('新客', '2024-07-01', '2024-07-01');`);
    const customers = tableOf(await verify(engineer, id), 'customers');
    expect(customers).toMatchObject({
      ok: false,
      data: {
        keyed: true, keys: ['customer_id'], sourceRows: 40, lakeRows: 40, missing: 0, pendingSync: 1, extra: 1,
        syncedThrough: '2024-06-02 16:00:00', samples: { missing: [], pendingSync: ['41'], extra: ['7'] },
      },
    });
  });

  it('水位线漏掉的行报告为湖中缺失；「立即主键比对」排队一次带主键比对的同步，完成后再次核对一致', async () => {
    const { engineer, id } = await syncedPgSource();
    // 更新时间早于水位线的补录行增量读不到
    await grantOnSource(`
      INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('补录', '2024-01-01', '2024-01-01');
      DELETE FROM shop.orders WHERE order_id = 3;`);
    const report = await verify(engineer, id);
    expect(tableOf(report, 'customers')).toMatchObject({ data: { missing: 1, pendingSync: 0, samples: { missing: ['41'] } } });
    expect(tableOf(report, 'orders')).toMatchObject({ data: { extra: 1, samples: { extra: ['3'] } } });
    expect(report.differences).toBe(2);

    const task = await syncSource(engineer, id, { reconcile: true });
    expect(task.params).toMatchObject({ sourceId: id, reconcile: true });
    await drain();
    const history = (await getSyncStatus(engineer, id)).history;
    expect(history.customers[0]).toMatchObject({ mode: 'reconcile', inserted: 1 });
    expect(history.orders[0]).toMatchObject({ mode: 'reconcile', deleted: 1 });

    const again = await verify(engineer, id);
    expect(again.differences).toBe(0);
    expect(tableOf(again, 'customers')).toMatchObject({ ok: true, data: { sourceRows: 41, lakeRows: 41 } });
  });

  it('没有主键的表按行数比较', async () => {
    const { engineer, id } = await syncedPgSource();
    expect(tableOf(await verify(engineer, id), 'events')).toMatchObject({ ok: true, data: { keyed: false, sourceRows: 1500, lakeRows: 1500 } });
    await grantOnSource(`INSERT INTO shop.regions VALUES ('W', '西部')`);
    expect(tableOf(await verify(engineer, id), 'regions')).toMatchObject({ ok: false, sourceRows: 3, data: { keyed: false, ok: false, sourceRows: 3, lakeRows: 2 } });
  });

  it('已移出同步范围的表只核对位置与文件，湖中数据不再更新不算差异', async () => {
    const { engineer, id } = await syncedPgSource();
    await setSyncScope(engineer, id, { remove: ['regions'] });
    await grantOnSource(`INSERT INTO shop.regions VALUES ('W', '西部')`);
    const regions = tableOf(await verify(engineer, id), 'regions');
    expect(regions).toMatchObject({ coverage: 'in_lake', outOfScope: true, ok: true, sourceRows: 3 });
    expect(regions.data).toBeUndefined();
  });
});

describe('触发与互斥', () => {
  it('同一数据源已有同步在排队或运行时不能入队核对，反之亦然；分析师不能触发', async () => {
    const { engineer, id } = await syncedPgSource();
    await syncSource(engineer, id);
    await expect(verifySource(engineer, id)).rejects.toThrow('已有一次同步在排队或运行中');
    await drain();
    await verifySource(engineer, id);
    await expect(syncSource(engineer, id)).rejects.toThrow('已有一次核对在排队或运行中');
    await expect(syncSource(engineer, id, { reconcile: true })).rejects.toBeInstanceOf(SourceError);
    await expect(verifySource(engineer, id)).rejects.toThrow('已有一次核对在排队或运行中');
    expect(await getVerifyStatus(engineer, id)).toMatchObject({ status: 'queued', tables: [], verifiedAt: null });

    const analyst = await memberOf(engineer.tenant.id, 'an@acme.com', 'analyst');
    await expect(verifySource(analyst, id)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(syncSource(analyst, id, { reconcile: true })).rejects.toMatchObject({ init: { status: 403 } });
    expect((await getVerifyStatus(analyst, id)).status).toBe('queued');
  });

  it('调度器每天为有同步表的数据源入队一次核对；停用租户不入队；有同步在排队时等下一次', async () => {
    const { acme, id } = await syncedPgSource();
    const other = await newTenant('globex');
    const otherEngineer = await memberOf(other, 'de@globex.com');
    const { id: otherId } = await registerSource(otherEngineer, await pgSourceInput(READER, '另一个库'));
    await selectAllTables(otherEngineer, otherId);
    await drain();
    // 未选表的数据源没有要同步的表，不核对
    const idle = await newTenant('initech');
    await registerSource(await memberOf(idle, 'de@initech.com'), await pgSourceInput(READER, '空库'));
    await suspendTenant(null, other, '欠费');

    expect(await enqueueDueVerifies()).toEqual([id]);
    expect(await enqueueDueVerifies()).toEqual([]);
    await drain();
    expect((await listTasks(acme)).filter(t => t.kind === 'source.verify').map(t => t.status)).toEqual(['succeeded']);
    const day = 24 * 3_600_000;
    expect(await enqueueDueVerifies(new Date(Date.now() + 0.5 * day))).toEqual([]);
    await syncSource(await memberOf(acme, 'de@acme.com'), id);
    expect(await enqueueDueVerifies(new Date(Date.now() + 1.1 * day))).toEqual([]);
    await drain();
    expect(await enqueueDueVerifies(new Date(Date.now() + 1.1 * day))).toEqual([id]);
  });
});

describe('其他数据源', () => {
  it('DuckDB 文件：源端删除一行后报告湖中多出', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const path = await duckdbSourceFile(acme);
    const { id } = await registerSource(engineer, { kind: 'duckdb', name: '会员文件', path: 'shop.duckdb' });
    await selectAllTables(engineer, id);
    await drain();
    await confirmWatermark(engineer, id, 'members', 'member_id');
    await syncSource(engineer, id);
    await drain();
    expect(tableOf(await verify(engineer, id), 'members')).toMatchObject({ coverage: 'in_lake', ok: true, sourceRows: 30 });

    const instance = await DuckDBInstance.create(path);
    const con = await instance.connect();
    await con.run('DELETE FROM members WHERE member_id = 4');
    con.closeSync();
    instance.closeSync();
    expect(tableOf(await verify(engineer, id), 'members')).toMatchObject({ ok: false, data: { extra: 1, samples: { extra: ['4'] } } });
  });

  it.skipIf(!process.env.TEST_MONGO_URL)('MongoDB：按 _id 比对，源端删除的文档报告湖中多出', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, { ...(await seedMongoSource()), name: '商城', ...MONGO_USERS.reader });
    await selectAllTables(engineer, id);
    await drain();
    await confirmWatermark(engineer, id, 'customers', 'updated_at');
    await confirmWatermark(engineer, id, 'orders', '_id');
    await syncSource(engineer, id);
    await drain();
    const report = await verify(engineer, id);
    expect(report.tables.map(t => [t.table, t.coverage, t.sourceRows, t.ok])).toEqual([
      ['customers', 'in_lake', 40, true], ['events', 'in_lake', 1500, true], ['orders', 'in_lake', 100, true],
    ]);

    const client = new MongoClient(process.env.TEST_MONGO_URL!);
    let removed: string;
    try {
      const orders = client.db().collection('orders');
      const doc = (await orders.findOne({ amount: 10 }))!;
      removed = doc._id.toHexString();
      await orders.deleteOne({ _id: doc._id });
    } finally {
      await client.close();
    }
    expect(tableOf(await verify(engineer, id), 'orders')).toMatchObject({ ok: false, sourceRows: 99, data: { keys: ['_id'], extra: 1, samples: { extra: [removed] } } });
  });
});

describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储上的数据湖', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('用租户的对象存储账号列出与核对文件；删除对象存储上的一个数据文件后报告该文件缺失', async () => {
    const { acme, engineer, id } = await syncedPgSource();
    const report = await verify(engineer, id);
    expect(report.differences).toBe(0);
    const customers = tableOf(report, 'customers');
    expect(customers.location!.prefix).toMatch(new RegExp(`^${process.env.TEST_S3_LAKE_URI}/tenants/${acme}/${bronzeSchema(id)}/customers/$`));

    const [file] = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', 'customers', schema => '${bronzeSchema(id)}')`);
    await deleteObject(platformS3(), file.path);
    expect(tableOf(await verify(engineer, id), 'customers')).toMatchObject({ ok: false, files: { missing: [file.path] } });
  });
});

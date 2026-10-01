// 同步范围的流水线接缝：登记数据源后列出表（不读行）→ 成员逐张选表 → 只采集、只同步范围内的表；
// 移出与重新选回、源端删表、新表提示、迁移回填（ADR-0013）
import { readFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { enqueueDueSyncs, getSyncStatus, syncSource } from '../../app/.server/source-sync';
import {
  confirmWatermark, getSource, registerSource, relistSource, setSyncScope, syncTables,
} from '../../app/.server/sources';
import { enqueueTask, listTasks } from '../../app/.server/tasks';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { duckdbSourceFile, grantOnSource, MONGO_USERS, pgSourceInput, READER, seedMongoSource, seedMysqlSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

type Member = Parameters<typeof getSource>[0];

/** 数据源的采集任务（新的在前） */
const profileTasks = async (tenantId: string) => (await listTasks(tenantId)).filter(t => t.kind === 'source.profile');

const listingOf = async (member: Member, id: string) => Object.fromEntries((await getSource(member, id)).listing.map(t => [t.name, t]));

const historyOf = async (member: Member, id: string, table: string) => (await getSyncStatus(member, id)).history[table] ?? [];

async function pgSource(prepare?: string) {
  const acme = await newTenant('acme');
  const engineer = await memberOf(acme, 'de@acme.com');
  const input = await pgSourceInput(READER);
  if (prepare) await grantOnSource(prepare);
  const { id } = await registerSource(engineer, input);
  return { acme, engineer, id };
}

describe('列出表', () => {
  it('新登记的数据源列出表后所有表都不在范围内：不采集列统计、不同步', async () => {
    const { acme, engineer, id } = await pgSource();
    expect(await profileTasks(acme)).toEqual([]);
    const source = await getSource(engineer, id);
    expect(source.listing.map(t => [t.name, t.inScope])).toEqual([
      ['customers', false], ['events', false], ['orders', false], ['regions', false],
    ]);
    expect(source.tables).toEqual([]);
    expect(source.newTables).toBe(4);
    await expect(syncSource(engineer, id)).rejects.toThrow(/没有可同步的表/);
    expect(await enqueueDueSyncs()).toEqual([]);
  });

  it('PostgreSQL 列出表不读取源表的任何行，估算行数取自统计信息', async () => {
    // 读取 trap 的任何一行都会报错；customers 有统计信息之后又插入的行不计入估算
    const { engineer, id } = await pgSource(`
      CREATE FUNCTION shop.trap() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trap was read'; END $$;
      CREATE VIEW shop.trap AS SELECT shop.trap() AS x;
      GRANT SELECT ON shop.trap TO ${READER.user};
      ANALYZE shop.customers;
      INSERT INTO shop.customers (name, created_at, updated_at) VALUES ('统计之后', '2024-07-01', '2024-07-01');`);
    const listing = await listingOf(engineer, id);
    expect(listing.customers).toMatchObject({ schema: 'shop', readable: true, estimatedRows: 40 });
    expect(listing.trap).toMatchObject({ readable: true, estimatedRows: null });
    // 没有统计信息的表不给估算
    expect(listing.regions.estimatedRows).toBeNull();

    await relistSource(engineer, id);
    expect((await listingOf(engineer, id)).trap).toMatchObject({ gone: false });
  });
});

describe('选表与采集', () => {
  it('选入后自动入队采集，只采集范围内的表；任务结果里没有范围外表的列统计。分析师可以查看但不能修改，修改记入审计', async () => {
    const { acme, engineer, id } = await pgSource();
    await setSyncScope(engineer, id, { add: ['customers', 'regions'] });
    const [task] = await profileTasks(acme);
    expect(task.params).toEqual({ sourceId: id, tables: ['customers', 'regions'] });
    await drain();

    const [done] = await profileTasks(acme);
    expect(done.status).toBe('succeeded');
    expect((done.result!.tables as { name: string }[]).map(t => t.name)).toEqual(['customers', 'regions']);
    expect(JSON.stringify(done.result)).not.toContain('order_id');

    const source = await getSource(engineer, id);
    expect(source.tables.map(t => t.name)).toEqual(['customers', 'regions']);
    expect(source.listing.find(t => t.name === 'customers')).toMatchObject({ inScope: true, scopedBy: 'de@acme.com' });
    expect(source.newTables).toBe(0);

    // 之后再选一张：只为它入队采集，已有的列统计保留
    await setSyncScope(engineer, id, { add: ['orders'] });
    expect((await profileTasks(acme))[0].params).toEqual({ sourceId: id, tables: ['orders'] });
    await drain();
    expect((await getSource(engineer, id)).tables.map(t => t.name)).toEqual(['customers', 'orders', 'regions']);

    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    expect((await getSource(analyst, id)).listing).toHaveLength(4);
    await expect(setSyncScope(analyst, id, { add: ['events'] })).rejects.toMatchObject({ init: { status: 403 } });

    const audit = (await listAuditLogs(acme)).filter(a => a.action === '修改同步范围');
    expect(audit.map(a => [a.actor, a.summary])).toEqual([
      ['de@acme.com', '「电商库」，选入 orders'],
      ['de@acme.com', '「电商库」，选入 customers、regions'],
    ]);
  });

  it('不能选入源端没有或账号读不了的表；重复选入不再入队采集', async () => {
    const { acme, engineer, id } = await pgSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);
    await expect(setSyncScope(engineer, id, { add: ['nope'] })).rejects.toThrow(/没有表 nope/);
    await expect(setSyncScope(engineer, id, { add: ['events'] })).rejects.toThrow(/读权限/);
    await setSyncScope(engineer, id, { add: ['regions'] });
    await setSyncScope(engineer, id, { add: ['regions'] });
    expect(await profileTasks(acme)).toHaveLength(1);
  });
});

describe('只同步范围内的表', () => {
  it('同步只包含范围内的表；范围内未确认水位线的表不同步，标为待确认水位线；没有候选的直接全量比对', async () => {
    const { engineer, id, acme } = await pgSource();
    await setSyncScope(engineer, id, { add: ['customers', 'regions'] });
    await drain();
    const customers = (await getSource(engineer, id)).tables.find(t => t.name === 'customers')!;
    expect(customers.syncMode).toBe('needs_confirmation');

    expect((await syncTables(acme, id)).map(t => t.param)).toEqual([{ name: 'regions' }]);
    await syncSource(engineer, id);
    await drain();
    const history = (await getSyncStatus(engineer, id)).history;
    expect(Object.keys(history)).toEqual(['regions']);
  });

  it('移出范围后不再采集与同步，原始层数据保留；重新选回后水位线表从上次的位置继续，不重复写入已有批次', async () => {
    const { acme, engineer, id } = await pgSource();
    await setSyncScope(engineer, id, { add: ['orders', 'regions'] });
    await drain();
    await confirmWatermark(engineer, id, 'orders', 'order_id');
    await syncSource(engineer, id);
    await drain();
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ batch: 1, rows: 100, watermarkTo: '100' });

    await setSyncScope(engineer, id, { remove: ['orders'] });
    expect((await getSource(engineer, id)).tables.map(t => t.name)).toEqual(['regions']);
    expect((await syncTables(acme, id)).map(t => t.param.name)).toEqual(['regions']);
    await grantOnSource(`INSERT INTO shop.orders (customer_id, amount, status, created_at) VALUES (1, 9, 'paid', '2024-07-01')`);
    await syncSource(engineer, id);
    await drain();
    expect(await historyOf(engineer, id, 'orders')).toHaveLength(1);

    await setSyncScope(engineer, id, { add: ['orders'] });
    await drain();
    // 水位线确认保留
    expect((await getSource(engineer, id)).tables.find(t => t.name === 'orders')).toMatchObject({ watermark: 'order_id', syncMode: 'watermark' });
    await syncSource(engineer, id);
    await drain();
    expect((await historyOf(engineer, id, 'orders'))[0]).toMatchObject({ batch: 2, mode: 'incremental', inserted: 1, watermarkFrom: '100', watermarkTo: '101' });
  });

  it('源端删掉范围内的表：重新列出后标为源端已不存在，不自动移出范围，同步跳过它照常成功', async () => {
    const { acme, engineer, id } = await pgSource();
    await setSyncScope(engineer, id, { add: ['regions', 'events'] });
    await drain();
    await grantOnSource('DROP TABLE shop.regions');

    // 还没重新列出时同步：这张表跳过并记下源端已不存在，任务不因它失败
    await syncSource(engineer, id);
    await drain();
    expect(await getSyncStatus(engineer, id)).toMatchObject({ status: 'succeeded' });
    expect((await historyOf(engineer, id, 'regions'))[0]).toMatchObject({ gone: true });

    await relistSource(engineer, id);
    await drain();
    const regions = (await getSource(engineer, id)).listing.find(t => t.name === 'regions')!;
    expect(regions).toMatchObject({ inScope: true, gone: true });
    expect((await profileTasks(acme))[0].params).toEqual({ sourceId: id, tables: ['events'] });
    expect((await syncTables(acme, id)).map(t => t.param.name)).toEqual(['events']);

    // 成员可以手动移出；移出后不再列出（不能再选入）
    await setSyncScope(engineer, id, { remove: ['regions'] });
    expect((await getSource(engineer, id)).listing.map(t => t.name)).toEqual(['customers', 'events', 'orders']);
    await expect(setSyncScope(engineer, id, { add: ['regions'] })).rejects.toThrow(/没有表 regions/);
  });

  it('重新列出表时新出现的表默认不在范围内，数据源页提示有几张新表未选', async () => {
    const { engineer, id } = await pgSource();
    await setSyncScope(engineer, id, { add: ['regions'] });
    expect((await getSource(engineer, id)).newTables).toBe(0);
    await grantOnSource(`
      CREATE TABLE shop.coupons (code text PRIMARY KEY); CREATE TABLE shop.stores (id int PRIMARY KEY);
      GRANT SELECT ON shop.coupons, shop.stores TO ${READER.user};`);
    await relistSource(engineer, id);
    const source = await getSource(engineer, id);
    expect(source.newTables).toBe(2);
    expect(source.listing.filter(t => t.isNew).map(t => t.name)).toEqual(['coupons', 'stores']);
    expect(source.listing.find(t => t.name === 'coupons')).toMatchObject({ inScope: false });

    // 保存一次范围（即便只改了别的表）即表示看过了这些新表
    await setSyncScope(engineer, id, { add: ['stores'] });
    expect((await getSource(engineer, id)).newTables).toBe(0);
  });
});

describe('迁移回填同步范围', () => {
  it('已有数据源中已进湖的表回填为在范围内，其余不在；同步的表与迁移前一致', async () => {
    const { acme, engineer, id } = await pgSource();
    await setSyncScope(engineer, id, { add: ['orders', 'regions'] });
    await drain();
    await confirmWatermark(engineer, id, 'orders', 'order_id');
    await syncSource(engineer, id);
    await drain();
    const before = (await syncTables(acme, id)).map(t => t.param);

    // 退回迁移前的样子：没有表清单与同步范围，只有确认过的设置；最近一次采集覆盖全部表
    const db = getDb();
    await db.execute(sql`DELETE FROM platform.source_tables WHERE source_id = ${id} AND watermark_column IS NULL`);
    await db.execute(sql`UPDATE platform.source_tables SET in_scope = false, scoped_at = NULL, scoped_by_email = NULL,
      table_schema = '', estimated_rows = NULL WHERE source_id = ${id}`);
    await refreshAllTablesProfile(acme, id);
    const migration = await readFile(new URL('../../drizzle/20261001014729_sync_scope/migration.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').filter(s => !/^\s*ALTER TABLE/.test(s))) {
      await db.execute(sql.raw(statement));
    }

    const listing = await listingOf(engineer, id);
    expect(Object.values(listing).map(t => [t.name, t.inScope, t.schema])).toEqual([
      ['customers', false, 'shop'], ['events', false, 'shop'], ['orders', true, 'shop'], ['regions', true, 'shop'],
    ]);
    expect(listing.customers.estimatedRows).toBe(40);
    expect((await syncTables(acme, id)).map(t => t.param)).toEqual(before);
  });
});

/** 迁移前的采集：一次采集全部可读的表（直接入队带全部表名的采集任务） */
async function refreshAllTablesProfile(tenantId: string, sourceId: string) {
  await enqueueTask(tenantId, 'source.profile', { sourceId, tables: ['customers', 'events', 'orders', 'regions'] });
  await drain();
}

describe('DuckDB 文件数据源', () => {
  it('列出表不给估算行数；选入后只采集选中的表', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const path = await duckdbSourceFile(acme);
    const instance = await DuckDBInstance.create(path);
    const con = await instance.connect();
    await con.run('CREATE SCHEMA crm; CREATE TABLE crm.notes AS SELECT 1 AS id');
    con.closeSync();
    instance.closeSync();

    const { id } = await registerSource(engineer, { kind: 'duckdb', name: '会员文件', path: 'shop.duckdb' });
    const listing = await listingOf(engineer, id);
    expect(Object.values(listing).map(t => [t.name, t.schema, t.estimatedRows, t.inScope])).toEqual([
      ['crm.notes', 'crm', null, false], ['members', 'main', null, false],
    ]);
    await setSyncScope(engineer, id, { add: ['members'] });
    await drain();
    const [task] = await profileTasks(acme);
    expect((task.result!.tables as { name: string }[]).map(t => t.name)).toEqual(['members']);
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL 数据源', () => {
  it('列出表给出估算行数；选入后才采集', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, { ...(await seedMysqlSource()), name: '订单库', ...READER });
    const { orders } = await listingOf(engineer, id);
    expect(orders).toMatchObject({ inScope: false, readable: true, estimatedRows: expect.any(Number) });
    expect(await profileTasks(acme)).toEqual([]);
    await setSyncScope(engineer, id, { add: ['orders'] });
    await drain();
    expect((await getSource(engineer, id)).tables.map(t => [t.name, t.rows])).toEqual([['orders', 3]]);
  });
});

describe.skipIf(!process.env.TEST_MONGO_URL)('MongoDB 数据源', () => {
  it('列出集合不给估算行数；只采集与同步选中的集合', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, { ...(await seedMongoSource()), name: '商城', ...MONGO_USERS.reader });
    expect(Object.values(await listingOf(engineer, id)).map(t => [t.name, t.estimatedRows, t.inScope])).toEqual([
      ['customers', null, false], ['events', null, false], ['orders', null, false],
    ]);
    await setSyncScope(engineer, id, { add: ['events'] });
    await drain();
    const [task] = await profileTasks(acme);
    expect((task.result!.tables as { name: string }[]).map(t => t.name)).toEqual(['events']);
    await syncSource(engineer, id);
    await drain();
    expect(Object.keys((await getSyncStatus(engineer, id)).history)).toEqual(['events']);
  });
});

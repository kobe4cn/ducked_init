// 数据源登记的流水线接缝：成员登记数据源（领域函数）→ 平台探测只读、加密保存凭据、列出表 → 选入同步范围后调度器派发采集任务 → 查看列统计与水位线候选
import { rm, symlink } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openSource } from '../../app/.server/pipeline/source-engine';
import { loadSourceSpec } from '../../app/.server/source-config';
import { confirmWatermark, getSource, registerSource, SourceError, testSource } from '../../app/.server/sources';
import { claimNextTask, finishTask } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { duckdbSourceFile, grantOnSource, MONGO_USERS, pgSourceInput, READER, s3SourceFiles, seedMongoSource, seedMysqlSource, WRITER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('登记时校验账号只读', () => {
  it('PostgreSQL 账号对源表可写时拒绝登记，并说明哪些对象可写', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');

    const err = await registerSource(engineer, await pgSourceInput(WRITER)).catch(e => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toContain('可写');
    expect(err.message).toContain('shop.orders');
    expect(err.message).toMatch(/INSERT/);
  });

  it('账号读不了任何源表（缺 schema USAGE）时拒绝登记，并说明缺哪些权限', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`REVOKE USAGE ON SCHEMA shop FROM ${READER.user}`);

    const err = await registerSource(engineer, input).catch(e => e);
    expect(err).toBeInstanceOf(SourceError);
    expect(err.message).toContain('没有读权限');
    expect(err.message).toContain('GRANT USAGE ON SCHEMA shop');
  });

  it('部分源表不可读时照常登记，列出不可读的表；采集跳过这些表', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);

    const { id, tables, unreadable } = await registerSource(engineer, input);
    await selectAllTables(engineer, id);
    expect(tables).not.toContain('events');
    expect(unreadable).toEqual(['events']);
    expect(await testSource(engineer, id)).toMatchObject({ unreadable: ['events'] });

    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const source = await getSource(engineer, id);
    expect(source.profile.status).toBe('succeeded');
    expect(source.profile.unreadable).toEqual(['events']);
    expect(source.tables.map(t => t.name).sort()).toEqual(['customers', 'orders', 'regions']);
  });

  it('只读账号可以登记', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const source = await registerSource(engineer, await pgSourceInput(READER));
    expect(source.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('凭据加密保存', () => {
  it('平台库与任务记录里都没有明文凭据；换到其他租户或其他数据源上解不开', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const db = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
    await db.connect();
    try {
      const dump = JSON.stringify((await db.query(`
        SELECT (SELECT json_agg(s) FROM platform.sources s) AS sources, (SELECT json_agg(t) FROM platform.tasks t) AS tasks,
               (SELECT json_agg(a) FROM platform.audit_logs a) AS audit`)).rows);
      expect(dump).toContain(READER.user);
      expect(dump).not.toContain(READER.password);
      expect(dump).not.toContain(JSON.stringify(READER.password).slice(1, -1));
    } finally {
      await db.end();
    }
    const spec = await loadSourceSpec(acme, id);
    expect(spec).toMatchObject({ kind: 'postgres', user: READER.user, password: READER.password });
    await expect(loadSourceSpec(await newTenant('globex'), id)).rejects.toThrow('数据源不存在');
  });
});

describe('采集表清单、列统计与水位线候选', () => {
  it('选入同步范围后采集：每张表的行数、列统计，以及更新时间 / 自增主键候选', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const source = await getSource(engineer, id);
    expect(source.profile.status).toBe('succeeded');
    const byName = Object.fromEntries(source.tables.map(t => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['customers', 'events', 'orders', 'regions']);

    const customers = byName.customers;
    expect(customers.rows).toBe(40);
    const col = Object.fromEntries(customers.columns.map(c => [c.name, c]));
    expect(col.customer_id).toMatchObject({ type: 'INTEGER', nullRate: 0, distinct: 40, min: '1', max: '40' });
    expect(col.email.nullRate).toBe(0.25);
    expect(col.email.formats).toEqual([{ format: 'email', share: 1 }]);
    expect(col.phone.formats?.[0]).toEqual({ format: 'mobile', share: 1 });
    expect(col.phone.length).toEqual({ min: 11, max: 11 });
    // 文本列不给取值，只给长度范围：取值可能是手机号等敏感信息
    expect(col.phone.min).toBeNull();
    expect(col.city.distinct).toBe(4);
    expect(col.updated_at.min).toBe('2024-06-01 01:00:00');
    expect(customers.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['updated_at', 'updated_at'], ['customer_id', 'increment']]);
    expect(customers.syncMode).toBe('needs_confirmation');

    expect(byName.orders.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['order_id', 'increment']]);
    expect(byName.regions).toMatchObject({ rows: 2, watermarkCandidates: [], syncMode: 'full_compare' });
    expect(byName.events).toMatchObject({ rows: 1500, watermarkCandidates: [], syncMode: 'full_compare' });
    expect(byName.events.syncModeNote).toContain('（大表）：每天全量比对一次');
    expect(byName.regions.syncModeNote).toBe('没有更新时间或自增主键：每小时全量比对一次');
  });

  it('低基数、不像敏感信息的文本列保存最常见的取值与样本行数；像手机号、邮箱或列名像敏感信息的列不保存', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`
      CREATE TABLE shop.contacts (channel text, note text, contact_tel text, backup text, extra text);
      INSERT INTO shop.contacts SELECT
        CASE WHEN i % 3 = 0 THEN 'web' ELSE 'app' END,
        repeat('长', 200 + i % 2),
        '021-' || (i % 5),
        CASE WHEN i % 4 = 0 THEN '1380000000' || (i % 10) ELSE 'none' END,
        CASE WHEN i % 10 = 0 THEN 'u' || i || '@acme.com' ELSE 'none' END
      FROM generate_series(1, 30) i;
      GRANT SELECT ON shop.contacts TO ${READER.user};`);
    const { id } = await registerSource(engineer, input);
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const source = await getSource(engineer, id);
    const columnsOf = (table: string) => Object.fromEntries(source.tables.find(t => t.name === table)!.columns.map(c => [c.name, c]));
    const customers = columnsOf('customers');
    expect(customers.city.top).toHaveLength(4);
    expect(customers.city.top).toEqual(expect.arrayContaining(['北京', '上海', '广州', '深圳'].map(value => ({ value, rows: 10 }))));
    // 取值不进 min/max
    expect(customers.city.min).toBeNull();
    for (const c of ['name', 'email', 'phone']) expect(customers[c].top).toBeUndefined();
    expect(columnsOf('orders').status.top).toEqual([{ value: 'paid', rows: 50 }, { value: 'refunded', rows: 50 }]);

    const contacts = columnsOf('contacts');
    expect(contacts.channel.top).toEqual([{ value: 'app', rows: 20 }, { value: 'web', rows: 10 }]);
    // 取值过长、列名像电话、样本里混有手机号或邮箱的列都不保存取值
    expect(contacts.note.top).toBeUndefined();
    expect(contacts.contact_tel.top).toBeUndefined();
    expect(contacts.backup.top).toBeUndefined();
    expect(contacts.extra.top).toBeUndefined();
  });

  it('成员从候选中确认水位线字段；不在候选中的字段被拒绝', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    await expect(confirmWatermark(engineer, id, 'customers', 'created_at')).rejects.toThrow('不是');
    await confirmWatermark(engineer, id, 'customers', 'updated_at');
    const customers = (await getSource(engineer, id)).tables.find(t => t.name === 'customers')!;
    expect(customers).toMatchObject({ watermark: 'updated_at', syncMode: 'watermark' });

    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    expect((await getSource(analyst, id)).tables.length).toBe(4);
    await expect(confirmWatermark(analyst, id, 'orders', 'order_id')).rejects.toMatchObject({ init: { status: 403 } });
  });
});

describe('任务运行时的数据源连接', () => {
  it('凭据由调度器解密后经内存交给工作进程，以临时 secret 注入；源端只读挂载，不能向源端执行语句，也不能再挂载其他库', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, id);
    const task = (await claimNextTask())!;
    expect(task.params).toEqual({ sourceId: id, tables: ['customers', 'events', 'orders', 'regions'] });
    expect(task.source).toMatchObject({ kind: 'postgres', user: READER.user, password: READER.password });

    const session = await openSource(task.source!, task.limits);
    const attempt = (sql: string) => session.con.run(sql).then(() => 'allowed', e => (e as Error).message);
    try {
      const secrets = (await session.con.runAndReadAll('SELECT persistent, storage FROM duckdb_secrets()')).getRowObjectsJson();
      expect(secrets).toEqual([{ persistent: false, storage: 'memory' }]);
      expect(await attempt(`INSERT INTO src.shop.regions VALUES ('W', '西方')`)).toMatch(/read-only/);
      expect(await attempt(`CALL postgres_execute('src', 'DELETE FROM shop.regions')`)).toMatch(/read-only transaction/);
      expect(await attempt(`ATTACH 'dbname=crm_platform_test' AS platform_db (TYPE postgres)`)).toMatch(/Permission Error/);
      expect(await attempt(`SELECT * FROM read_csv('/etc/hosts')`)).toMatch(/Permission Error/);
      expect(await attempt('SET enable_external_access = true')).toMatch(/locked/);
      expect((await session.tables()).map(t => t.name).sort()).toEqual(['customers', 'events', 'orders', 'regions']);
    } finally {
      session.close();
      await finishTask(task.id, { result: {} });
    }
  });

  it('登记后账号又被授予写权限时，采集任务拒绝运行', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const { id } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, id);
    await grantOnSource(`GRANT DELETE ON shop.regions TO ${READER.user}`);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const { profile } = await getSource(engineer, id);
    expect(profile.status).toBe('failed');
    expect(profile.error).toContain('shop.regions');
    expect(profile.error).not.toContain(READER.password);
  });
});

describe('DuckDB 文件数据源', () => {
  it('本租户源文件目录里的 DuckDB 文件只读挂载后采集，自增主键与更新时间都是水位线候选', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    await duckdbSourceFile(acme);
    const { id, tables } = await registerSource(engineer, { kind: 'duckdb', name: '会员文件', path: 'shop.duckdb' });
    await selectAllTables(engineer, id);
    expect(tables).toEqual(['members']);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const [members] = (await getSource(engineer, id)).tables;
    expect(members).toMatchObject({ name: 'members', rows: 30, syncMode: 'needs_confirmation' });
    expect(members.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['modified_at', 'updated_at'], ['member_id', 'increment']]);
    expect(members.columns.find(c => c.name === 'mobile')!.formats).toEqual([{ format: 'mobile', share: 1 }, { format: 'integer', share: 1 }]);
  });

  it('登记后文件被换成指向目录之外的符号链接时，测试连接与采集都被拒绝', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const engineer = await memberOf(acme, 'de@acme.com');
    const path = await duckdbSourceFile(acme);
    const { id } = await registerSource(engineer, { kind: 'duckdb', name: '会员文件', path: 'shop.duckdb' });
    await selectAllTables(engineer, id);
    await rm(path);
    await symlink(await duckdbSourceFile(globex), path);

    await expect(testSource(engineer, id)).rejects.toThrow('本租户的源文件目录');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect((await getSource(engineer, id)).profile).toMatchObject({ status: 'failed', error: expect.stringContaining('本租户的源文件目录') });
  });

  it('不能登记其他租户目录里（或目录之外）的文件', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const engineer = await memberOf(acme, 'de@acme.com');
    const other = await duckdbSourceFile(globex);
    for (const path of [other, `../${globex}/shop.duckdb`, '/etc/hosts']) {
      await expect(registerSource(engineer, { kind: 'duckdb', name: '越权', path })).rejects.toThrow(/本租户的源文件目录|找不到/);
    }
  });
});

describe.skipIf(!process.env.TEST_S3_LAKE_URI)('对象存储文件数据源', () => {
  it('可写的对象存储账号被拒绝；只读账号登记后，每个子目录或顶层文件是一张表', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const files = await s3SourceFiles(acme);
    try {
      await expect(registerSource(engineer, { ...files.base, name: '文件', ...files.writer })).rejects.toThrow(/可写[\s\S]*（PutObject）/);
      await expect(registerSource(engineer, { ...files.base, name: '文件', ...files.deleter })).rejects.toThrow(/可写[\s\S]*（DeleteObject）/);
      const { id, tables } = await registerSource(engineer, { ...files.base, name: '文件', ...files.reader });
      await selectAllTables(engineer, id);
      expect(tables).toEqual(['customers', 'orders']);
      await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

      const source = await getSource(engineer, id);
      expect(source.profile).toMatchObject({ status: 'succeeded' });
      const byName = Object.fromEntries(source.tables.map(t => [t.name, t]));
      expect(byName.customers).toMatchObject({ rows: 20, syncMode: 'needs_confirmation' });
      expect(byName.customers.watermarkCandidates.map(c => c.column)).toEqual(['updated_at']);
      expect(byName.orders).toMatchObject({ rows: 25, syncMode: 'full_compare' });
    } finally {
      await files.cleanup();
    }
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL 数据源', () => {
  it('可写账号被拒绝；只读账号登记后采集，自增主键与更新时间都是水位线候选', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const base = await seedMysqlSource();
    await expect(registerSource(engineer, { ...base, name: '订单库', ...WRITER })).rejects.toThrow(/可写[\s\S]*orders[\s\S]*INSERT/);
    const { id, tables } = await registerSource(engineer, { ...base, name: '订单库', ...READER });
    await selectAllTables(engineer, id);
    expect(tables).toEqual(['orders']);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const [orders] = (await getSource(engineer, id)).tables;
    expect(orders).toMatchObject({ name: 'orders', rows: 3 });
    expect(orders.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['updated_at', 'updated_at'], ['order_id', 'increment']]);
  });
});

describe.skipIf(!process.env.TEST_MONGO_URL)('MongoDB 数据源', () => {
  it('可写账号被拒绝；对源库没有读权限时拒绝并给出授权语句；只读账号登记后每个集合是一张表，嵌套字段展开成列', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const base = await seedMongoSource();
    await expect(registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.writer }))
      .rejects.toThrow(/可写[\s\S]*库 crm_source_test（[^）]*insert/);
    await expect(registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.stranger }))
      .rejects.toThrow(/没有库 crm_source_test 的读权限[\s\S]*grantRolesToUser\('crm_src_stranger', \[\{ role: 'read', db: 'crm_source_test' \}\]\)/);
    await expect(registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.reader, password: 'wrong' })).rejects.toThrow(/无法连接数据源/);

    const { id, tables } = await registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.reader });
    await selectAllTables(engineer, id);
    expect(tables).toEqual(['customers', 'events', 'orders']);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const source = await getSource(engineer, id);
    expect(source.profile).toMatchObject({ status: 'succeeded' });
    const byName = Object.fromEntries(source.tables.map(t => [t.name, t]));
    expect(byName.customers).toMatchObject({ rows: 40, syncMode: 'needs_confirmation' });
    expect(byName.customers.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['updated_at', 'updated_at'], ['_id', 'increment']]);
    expect(byName.customers.columns.map(c => c.name)).toEqual(expect.arrayContaining(['address_city', 'tags']));
    expect(byName.orders.watermarkCandidates.map(c => [c.column, c.kind])).toEqual([['_id', 'increment']]);
    expect(byName.events).toMatchObject({ rows: 1500, syncMode: 'full_compare', watermarkCandidates: [] });
    expect(byName.events.syncModeNote).toMatch(/（大表）：每天全量比对一次/);
  });

  it('账号只能读部分集合时照常登记，列出读不了的集合，采集跳过它们', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const base = await seedMongoSource();
    const { id, tables, unreadable } = await registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.partial });
    await selectAllTables(engineer, id);
    expect({ tables, unreadable }).toEqual({ tables: ['customers'], unreadable: ['events', 'orders'] });
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const source = await getSource(engineer, id);
    expect(source.tables.map(t => t.name)).toEqual(['customers']);
    expect(source.profile.unreadable).toEqual(['events', 'orders']);
  });

  it('只读挂载：不能向源端写入', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const base = await seedMongoSource();
    // 用可写账号直接挂载（绕过登记时的探测），验证挂载本身也拦住写入
    const { id } = await registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.reader });
    await selectAllTables(engineer, id);
    const spec = await loadSourceSpec(acme, id);
    const session = await openSource({ ...spec, ...MONGO_USERS.writer } as typeof spec, { memoryLimitMb: 256, threads: 1 });
    try {
      await expect(session.con.run(`INSERT INTO src.crm_source_test.orders (customer) VALUES (1)`)).rejects.toThrow(/read-only/);
      await expect(session.con.run(`SELECT * FROM mongo_scan('mongodb://localhost:27017', 'admin', 'system.users')`)).rejects.toThrow(/Direct mongo_scan is disabled/);
    } finally {
      session.close();
    }
  });
});

// 数据源登记的流水线接缝：成员登记数据源（领域函数）→ 平台探测只读、加密保存凭据、列出表 → 选入同步范围后调度器派发采集任务 → 查看列统计与水位线候选
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { sources, tasks } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openSource } from '../../app/.server/pipeline/source-engine';
import { loadSourceSpec, parseUploadOptions } from '../../app/.server/source-config';
import { confirmWatermark, getSource, registerSource, SourceError, testSource, updateSource } from '../../app/.server/sources';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { syncSource } from '../../app/.server/source-sync';
import { tenantPiiSalt } from '../../app/.server/secrets';
import { claimNextTask, enqueueTask, finishTask } from '../../app/.server/tasks';
import { decodeUpload, previewUpload, storeUpload, UPLOAD_TABLE_RULE } from '../../app/.server/uploads';
import { resetDb } from '../http/harness';
import { dbNameOf } from '../setup-env';
import { memberOf, newTenant, onLake, publish, selectAllTables, silver } from './fixtures';
import { duckdbSourceFile, ensurePgAccounts, GBK_SIGNUPS_CSV, grantOnSource, MONGO_USERS, pgSourceInput, READER, s3SourceFiles, seedMongoSource, seedMysqlSource, SOURCE_DB_URL, WRITER } from './source-fixtures';

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

  it('并发建源端账号不报错', async () => {
    // 集群级角色会被跨运行的同名 worker 同时建 / 改（#439）：8 个连接各循环 10 次 ensurePgAccounts，
    // 靠按账号名的 advisory lock 串行化，不再报 tuple concurrently updated
    const url = Object.assign(new URL(SOURCE_DB_URL), { pathname: '/postgres' }).toString();
    await Promise.all(Array.from({ length: 8 }, async () => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        for (let i = 0; i < 10; i++) await ensurePgAccounts(c);
      } finally {
        await c.end();
      }
    }));
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
      expect(await attempt(`ATTACH 'dbname=${dbNameOf(process.env.PLATFORM_DATABASE_URL!)}' AS platform_db (TYPE postgres)`)).toMatch(/Permission Error/);
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

  it('领取时照契约声明的 needs 准备：没声明源连接的不管参数里的 sourceId，盐只给合并任务，别的任务什么都不拿', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');

    // 参数里带 sourceId 但契约没有声明源连接（source.drop，数据源已删）：领取时不读凭据，任务照常派发。
    // sourceId 是 source.drop 的多余字段、过不了入队校验，这里裸插
    const [dropTask] = await getDb().insert(tasks).values({ tenantId: acme, kind: 'source.drop', params: { schema: `bronze_${'0'.repeat(32)}`, sourceId: randomUUID() } }).returning();
    const dropId = dropTask.id;
    const drop = (await claimNextTask())!;
    expect(drop.id).toBe(dropId);
    expect(drop.source).toBeUndefined();
    await finishTask(dropId, { result: {} });

    // 声明了源连接的采集任务照常解密凭据
    const { id: sourceId } = await registerSource(engineer, await pgSourceInput(READER));
    await selectAllTables(engineer, sourceId);
    const profile = (await claimNextTask())!;
    expect(profile.kind).toBe('source.profile');
    expect(profile.source).toMatchObject({ kind: 'postgres', user: READER.user, password: READER.password });
    await finishTask(profile.id, { result: {} });

    // 合并任务领取时拿到租户的敏感信息盐（64 位十六进制）；参数只要过得了契约（只撤下停用映射，不跑工作进程）
    const { id: mergeId } = await enqueueTask(acme, 'silver.merge', { mappings: [], drop: [{ mapping: 'm1', entity: 'customer' }] });
    const merge = (await claimNextTask())!;
    expect(merge.id).toBe(mergeId);
    expect(merge.piiSalt).toMatch(/^[0-9a-f]{64}$/);
    await finishTask(mergeId, { result: {} });

    // 没声明的任务（盘点数据湖）领取时源连接、盐、密钥都不准备
    const { id: inventoryId } = await enqueueTask(acme, 'lake.inventory', {});
    const inventory = (await claimNextTask())!;
    expect(inventory.id).toBe(inventoryId);
    expect(inventory.source).toBeUndefined();
    expect(inventory.piiSalt).toBeUndefined();
    expect(inventory.servingKey).toBeUndefined();
    await finishTask(inventoryId, { result: {} });
  });
});

describe('文件上传数据源', () => {
  it('上传的 UTF-8 CSV 登记后采集不算水位线候选、表不待确认，同步后原始层有这些行', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const dir = randomUUID();
    await storeUpload(acme, dir, 'signups', 'id,name,updated_at\n1,张三,2026-10-01 08:00:00\n2,李四,2026-10-02 09:30:00\n3,王五,2026-10-03 10:00:00\n');
    const { id, tables } = await registerSource(engineer, { kind: 'upload', name: '活动报名', dir, table: 'signups' });
    expect(tables).toEqual(['signups']);
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    const [signups] = (await getSource(engineer, id)).tables;
    expect(signups).toMatchObject({ name: 'signups', rows: 3, syncMode: 'full_compare', watermarkCandidates: [] });
    expect(signups.columns.find(c => c.name === 'updated_at')!.type).toMatch(/^TIMESTAMP/);

    await syncSource(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const rows = await onLake<{ id: string; name: string }>(acme, `SELECT id::VARCHAR AS id, name FROM "${bronzeSchema(id)}"."signups" ORDER BY id`);
    expect(rows).toEqual([{ id: '1', name: '张三' }, { id: '2', name: '李四' }, { id: '3', name: '王五' }]);
  });

  it('上传前预览识别 GBK 编码、分隔符、表头行与每列类型，返回前 20 行；用完的临时目录即删（ADR-0037）', async () => {
    const preview = await previewUpload(GBK_SIGNUPS_CSV, 'signups');
    expect(preview.encoding).toBe('gbk');
    expect(preview.delim).toBe(',');
    expect(preview.header).toBe(true);
    expect(preview.skip).toBe(0);
    expect(preview.columns).toEqual([
      { name: '报名编号', type: 'BIGINT' },
      { name: '姓名', type: 'VARCHAR' },
      { name: '手机', type: 'BIGINT' },
      { name: '活动', type: 'VARCHAR' },
      { name: '报名时间', type: 'TIMESTAMP' },
      { name: '是否到场', type: 'VARCHAR' },
    ]);
    // 前端把每个值按字符串显示（null 保持 null），识别成的时间列也是格式化后的文本
    expect(preview.rows).toEqual([
      ['1', '张三', '13800000001', '秋季发布会', '2026-09-01 14:05:00', '是'],
      ['2', '李四', '13800000002', '秋季发布会', '2026-09-01 14:06:00', '否'],
      ['3', '王五', '13800000003', '客户答谢会', '2026-09-02 09:10:00', '是'],
    ]);
    // 预览不落盘到湖：临时目录在 tmpdir() 下，用完必须删干净
    expect((await readdir(tmpdir())).filter(n => n.startsWith('crm-preview-'))).toEqual([]);

    // 表名拼进临时文件路径，先校验再用（防路径穿越）
    await expect(previewUpload(GBK_SIGNUPS_CSV, '../escape')).rejects.toThrow(UPLOAD_TABLE_RULE);
  });

  it('预览按改过的分隔符、表头行与列类型读；按预览确认的选项登记后，原始层的列类型与预览一致', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const bytes = new TextEncoder().encode('线下活动报名（导出于 2026-10-31）\nid;amount;name\n001;12.50;张三\n002;7.00;李四\n003;99.99;王五\n');

    // 不带选项预览：识别出分号分隔、表头前跳过 1 行（说明行），编号带前导零按 VARCHAR 读
    const auto = await previewUpload(bytes, 'signups');
    expect(auto).toMatchObject({ encoding: 'utf-8', delim: ';', header: true, skip: 1 });
    expect(auto.columns).toEqual([
      { name: 'id', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
      { name: 'name', type: 'VARCHAR' },
    ]);
    expect(auto.rows).toEqual([['001', '12.5', '张三'], ['002', '7', '李四'], ['003', '99.99', '王五']]);

    // 改分隔符为逗号再预览：整行是一个字段，只剩一列（表头被识别成第一行的导出说明）
    const comma = await previewUpload(bytes, 'signups', { delim: ',' });
    expect(comma.columns).toEqual([{ name: '线下活动报名（导出于 2026-10-31）', type: 'VARCHAR' }]);
    expect(comma.rows[0]).toEqual(['id;amount;name']);

    // 改列类型再预览：金额按 DECIMAL(10,2)、编号仍 VARCHAR，返回的类型随之改变
    const typed = await previewUpload(bytes, 'signups', {
      delim: ';', header: true, skip: 1, columns: { id: 'VARCHAR', amount: 'DECIMAL(10,2)', name: 'VARCHAR' },
    });
    expect(typed.columns).toEqual([
      { name: 'id', type: 'VARCHAR' },
      { name: 'amount', type: 'DECIMAL(10,2)' },
      { name: 'name', type: 'VARCHAR' },
    ]);
    expect(typed.rows[0]).toEqual(['001', '12.50', '张三']);

    // 确认登记时把预览确认的选项随表单提交（服务端存进 config.options，ADR-0037）：同步出的原始层列类型与预览一致
    const options = JSON.stringify({
      signups: { encoding: 'utf-8', delim: ';', header: true, skip: 1, columns: Object.fromEntries(typed.columns.map(c => [c.name, c.type])) },
    });
    const dir = randomUUID();
    await storeUpload(acme, dir, 'signups', new TextDecoder().decode(bytes));
    const { id } = await registerSource(engineer, { kind: 'upload', name: '活动报名', dir, table: 'signups', options });
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    await syncSource(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const cols = await onLake<{ column_name: string; column_type: string }>(acme, `DESCRIBE "${bronzeSchema(id)}"."signups"`);
    // 原始层在源列之后还有 _op / _commit_ts 等平台列，只比源列
    expect(cols.slice(0, typed.columns.length).map(c => ({ name: c.column_name, type: c.column_type }))).toEqual(typed.columns);
  });

  it('GBK 编码的 CSV 登记时自动识别转成 UTF-8 存湖、审计记 gbk，发布映射后标准层有这些客户', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const reviewer = await memberOf(acme, 'de2@acme.com');
    const { text, encoding } = decodeUpload(GBK_SIGNUPS_CSV);
    expect(encoding).toBe('gbk');
    expect(text).toContain('报名编号,姓名,手机,活动,报名时间,是否到场');
    // 短的纯 ASCII 文件两种编码都合法，按 UTF-8 判定
    expect(decodeUpload(Buffer.from('id,name\n1,zhang\n'))).toEqual({ text: 'id,name\n1,zhang\n', encoding: 'utf-8' });
    const dir = randomUUID();
    await storeUpload(acme, dir, 'signups', text);
    const { id, tables } = await registerSource(author, { kind: 'upload', name: '活动报名', dir, table: 'signups' },
      { table: 'signups', file: '活动报名.csv', bytes: GBK_SIGNUPS_CSV.length, encoding });
    expect(tables).toEqual(['signups']);
    await selectAllTables(author, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    await syncSource(author, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const rows = await onLake<{ id: string; name: string }>(acme, `SELECT "报名编号"::VARCHAR AS id, "姓名" AS name FROM "${bronzeSchema(id)}"."signups" ORDER BY id`);
    expect(rows).toEqual([{ id: '1', name: '张三' }, { id: '2', name: '李四' }, { id: '3', name: '王五' }]);

    await publish(author, reviewer, id, `model: 1
entity: customer
table: signups
fields:
  customer_id: 报名编号
  name: 姓名
  phone: string(手机)
  registered_at: from_timezone(报名时间, 'Asia/Shanghai')
`);
    // 姓名与手机是敏感列，标准层只存加盐哈希（ADR-0005）：哈希对得上，说明 GBK 解出的正是这些字
    const salt = await tenantPiiSalt(acme);
    const hash = (v: string) => createHash('sha256').update(salt + v).digest('hex');
    const customers = await silver(acme, 'customer', 'customer_id::INT');
    expect(customers.map(c => ({ id: c.customer_id, name: c.name, phone: c.phone }))).toEqual([
      { id: '1', name: hash('张三'), phone: hash('13800000001') },
      { id: '2', name: hash('李四'), phone: hash('13800000002') },
      { id: '3', name: hash('王五'), phone: hash('13800000003') },
    ]);
  });

  it('登记时带读取选项（分隔符、表头、跳过行、列类型）：采集与原始层的列类型与选项一致，改名称后选项保留', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const dir = randomUUID();
    // 第一行是导出说明，第二行才是表头；分号分隔，编号带前导零（按 VARCHAR 读才保得住）
    await storeUpload(acme, dir, 'signups', '线下活动报名（导出于 2026-10-31）\nid;amount;name\n001;12.50;张三\n002;7.00;李四\n003;99.99;王五\n');
    const options = JSON.stringify({ signups: { delim: ';', header: true, skip: 1, columns: { id: 'VARCHAR', amount: 'DECIMAL(10,2)', name: 'VARCHAR' } } });
    const { id, tables } = await registerSource(engineer, { kind: 'upload', name: '活动报名', dir, table: 'signups', options });
    expect(tables).toEqual(['signups']);
    await selectAllTables(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    // 采集出的列统计按选项读：跳过了说明行、分号分隔、列类型与选项一致
    const [signups] = (await getSource(engineer, id)).tables;
    expect(signups).toMatchObject({ name: 'signups', rows: 3, syncMode: 'full_compare' });
    const typeOf = (name: string) => signups.columns.find(c => c.name === name)!.type;
    expect(typeOf('id')).toBe('VARCHAR');
    expect(typeOf('amount')).toBe('DECIMAL(10,2)');
    expect(typeOf('name')).toBe('VARCHAR');

    // 同步出的原始层表也是这些列类型（ADR-0037）
    await syncSource(engineer, id);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const cols = await onLake<{ column_name: string; column_type: string }>(acme, `DESCRIBE "${bronzeSchema(id)}"."signups"`);
    expect(Object.fromEntries(cols.map(c => [c.column_name, c.column_type]))).toMatchObject({ id: 'VARCHAR', amount: 'DECIMAL(10,2)', name: 'VARCHAR' });
    const rows = await onLake<{ id: string; amount: string; name: string }>(acme,
      `SELECT id, amount::VARCHAR AS amount, name FROM "${bronzeSchema(id)}"."signups" ORDER BY id`);
    expect(rows).toEqual([
      { id: '001', amount: '12.50', name: '张三' },
      { id: '002', amount: '7.00', name: '李四' },
      { id: '003', amount: '99.99', name: '王五' },
    ]);

    // 修改（改名称）后选项原样保留，登记的重新探测也照选项读（ADR-0037）
    await updateSource(engineer, id, { name: '活动报名（2026 秋）' });
    const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(row.config.options).toBe(options);
    expect(row.name).toBe('活动报名（2026 秋）');
  });

  it('读取选项不合法（JSON 不合法、键不是本表、分隔符不是单个字符、skip 不是非负整数、列类型不在白名单）时不登记，抛 400', () => {
    // 空串 / 未给没有选项；合法的存成规范化后的形状（列类型大写）
    expect(parseUploadOptions(undefined, 'signups')).toBeUndefined();
    expect(parseUploadOptions('  ', 'signups')).toBeUndefined();
    expect(parseUploadOptions('{"signups":{"delim":";"}}', 'signups')).toEqual({ signups: { delim: ';' } });
    expect(parseUploadOptions('{"signups":{"columns":{"amount":"decimal(10,2)","at":"TIMESTAMP"}}}', 'signups'))
      .toEqual({ signups: { columns: { amount: 'DECIMAL(10,2)', at: 'TIMESTAMP' } } });

    const rejects = (json: string) => {
      try {
        parseUploadOptions(json, 'signups');
      } catch (e) {
        return e;
      }
      return null;
    };
    for (const [json, message] of [
      ['{', '不是合法的 JSON'],
      ['[]', '形式的对象'],
      ['{}', '表名'],
      ['{"signups":1}', '必须是对象'],
      ['{"signups":{"delim":";;"}}', '分隔符必须是单个字符'],
      ['{"signups":{"delim":"\\n"}}', '分隔符必须是单个字符'],
      ['{"signups":{"delim":"\\""}}', '分隔符必须是单个字符'],
      ['{"signups":{"skip":-1}}', 'skip'],
      ['{"signups":{"skip":1.5}}', 'skip'],
      ['{"signups":{"skip":1001}}', 'skip'],
      ['{"signups":{"skip":"2"}}', 'skip'],
      ['{"signups":{"header":"yes"}}', 'header'],
      ['{"signups":{"encoding":"utf-16"}}', '编码'],
      ['{"signups":{"columns":{"id":"BLOB"}}}', '列类型'],
      ['{"signups":{"columns":{"d":"DECIMAL(40,2)"}}}', '列类型'],
      ['{"signups":{"columns":{"d":"DECIMAL(4,5)"}}}', '列类型'],
      ['{"signups":{"columns":{"":"VARCHAR"}}}', '列名不能为空'],
      ['{"signups":{"columns":{"a":"VARCHAR"," a":"BIGINT"}}}', '列名重复'],
      ['{"signups":{"quotechar":"x"}}', '不支持的读取选项'],
    ] as const) {
      const err = rejects(json);
      expect(err, json).toBeInstanceOf(SourceError);
      expect((err as SourceError).status, json).toBe(400);
      expect((err as Error).message, json).toContain(message);
    }
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
      .rejects.toThrow(new RegExp(`可写[\\s\\S]*库 ${base.database}（[^）]*insert`));
    await expect(registerSource(engineer, { ...base, name: '商城', ...MONGO_USERS.stranger }))
      .rejects.toThrow(new RegExp(`没有库 ${base.database} 的读权限[\\s\\S]*grantRolesToUser\\('${MONGO_USERS.stranger.user}', \\[\\{ role: 'read', db: '${base.database}' \\}\\]\\)`));
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
      await expect(session.con.run(`INSERT INTO src.${base.database}.orders (customer) VALUES (1)`)).rejects.toThrow(/read-only/);
      await expect(session.con.run(`SELECT * FROM mongo_scan('mongodb://localhost:27017', 'admin', 'system.users')`)).rejects.toThrow(/Direct mongo_scan is disabled/);
    } finally {
      session.close();
    }
  });
});

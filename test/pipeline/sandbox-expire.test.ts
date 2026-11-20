// test/pipeline/sandbox-expire.test.ts —— 沙箱表过期的流水线接缝：saveAsSandbox 存下的沙箱表到期（直接把 expiresAt 改到过去）→ enqueueDueSandboxExpiries →
// 调度器派发 sandbox.expire → 湖里的表、parquet 文件与内联在 catalog 的行、平台元数据里的 expiredAt 与分享、工作台的列表与查询。
// 主人提前删除（dropSandboxTable）把湖表改名成保留名 _d<8hex> 再按改名后的名字入队：任务排队时同名保存马上成功，新表不会被删
import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, sandboxTables, tasks } from '../../app/.server/db/schema';
import { lakeRow } from '../../app/.server/lake';
import { enqueueDueSandboxExpiries, lockForSave } from '../../app/.server/sandbox';
import { enqueueTask } from '../../app/.server/tasks';
import { dropSandboxTable, listCatalog, listSandboxTables, listSharedWithMe, runQuery, sandboxSchema, saveAsSandbox, shareSandboxTable } from '../../app/.server/workbench';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, onLake, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
const ROWS = 'SELECT * FROM (VALUES (1, \'a\'), (2, \'b\'), (3, \'c\')) t(id, label)';
/** 比 ROWS 多一行：删除后同名再保存的新表用它，行数能和旧表区分 */
const ROWS4 = 'SELECT * FROM (VALUES (1, \'a\'), (2, \'b\'), (3, \'c\'), (4, \'d\')) t(id, label)';
/** 删除中的沙箱表在湖里改成的保留名：原名加 _d 与 8 位十六进制 */
const DROPPED = /_d[0-9a-f]{8}$/;

/** 把成员的这张沙箱表登记为已到期 */
const expire = (memberId: string, name: string) => getDb().update(sandboxTables).set({ expiresAt: new Date(Date.now() - 60_000) })
  .where(and(eq(sandboxTables.memberId, memberId), eq(sandboxTables.name, name)));

describe('沙箱表过期', () => {
  it('到期的沙箱表经 enqueueDueSandboxExpiries → sandbox.expire 删表、清掉 parquet 文件与内联在 catalog 的行，标记 expiredAt；未到期的不受影响，不重复入队，重复执行不报错', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    const mine = sandboxSchema(analyst.memberId);
    const m = `__ducklake_metadata_lake."${(await lakeRow(acme))!.catalogSchema}"`;

    // filed 关掉内联、写成 parquet 文件；inlined 只有 3 行，按默认内联在 catalog 里；fresh 与别人的同名表不到期
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 0)`);
    await saveAsSandbox(analyst, 'filed', ROWS);
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 10)`);
    await saveAsSandbox(analyst, 'inlined', ROWS);
    await saveAsSandbox(analyst, 'fresh', ROWS);
    await saveAsSandbox(engineer, 'filed', ROWS);
    const files = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', 'filed', schema => '${mine}')`);
    expect(files.length).toBeGreaterThan(0);
    const inlinedData = () => onLake(acme, `
      SELECT i.table_name FROM ${m}.ducklake_inlined_data_tables i JOIN ${m}.ducklake_table t USING (table_id)
      JOIN ${m}.ducklake_schema s USING (schema_id) WHERE s.schema_name = '${mine}' AND t.table_name = 'inlined'`);
    expect(await inlinedData()).toHaveLength(1);
    await shareSandboxTable(analyst, 'filed', 'de@acme.com');
    await shareSandboxTable(analyst, 'fresh', 'de@acme.com');

    await expire(analyst.memberId, 'filed');
    await expire(analyst.memberId, 'inlined');
    expect(await enqueueDueSandboxExpiries()).toEqual([acme]);
    expect(await enqueueDueSandboxExpiries()).toEqual([]); // 已有过期任务在排队，不重复入队
    await drain();

    const rows = await getDb().select().from(sandboxTables).where(eq(sandboxTables.tenantId, acme));
    const expiredAt = (memberId: string, name: string) => rows.find(r => r.memberId === memberId && r.name === name)?.expiredAt;
    expect(expiredAt(analyst.memberId, 'filed')).toEqual(expect.any(Date));
    expect(expiredAt(analyst.memberId, 'inlined')).toEqual(expect.any(Date));
    expect(expiredAt(analyst.memberId, 'fresh')).toBeNull();
    expect(expiredAt(engineer.memberId, 'filed')).toBeNull();

    const tables = await onLake<{ schema: string; name: string }>(acme, `
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema LIKE 'sandbox_%' ORDER BY ALL`);
    expect(tables).toHaveLength(2);
    expect(tables).toEqual(expect.arrayContaining([{ schema: sandboxSchema(engineer.memberId), name: 'filed' }, { schema: mine, name: 'fresh' }]));
    expect(files.filter(f => existsSync(f.path))).toEqual([]);
    expect(await inlinedData()).toEqual([]);

    // 工作台列表与查询里都不再出现
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['fresh']);
    expect((await listSandboxTables(engineer)).map(t => t.name)).toEqual(['filed']);
    await expect(runQuery(analyst, `SELECT * FROM ${mine}.filed`)).rejects.toThrow();
    expect((await runQuery(analyst, `SELECT count(*) AS n FROM ${mine}.fresh`)).rows).toEqual([['3']]);
    // 过期的表的分享一并删掉
    expect((await listSharedWithMe(engineer)).map(t => t.name)).toEqual(['fresh']);

    expect(await enqueueDueSandboxExpiries()).toEqual([]);
    expect(await runTask(acme, 'sandbox.expire', { tables: [`${mine}.filed`] })).toMatchObject({ status: 'succeeded' });

    // 过期后同名再保存：重新列出
    await saveAsSandbox(analyst, 'filed', ROWS);
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['filed', 'fresh']);
    // 同名再保存的是新表，不沿用过期前的分享
    expect((await listSharedWithMe(engineer)).map(t => t.name)).toEqual(['fresh']);
    await expect(runQuery(engineer, `SELECT * FROM ${mine}.filed`)).rejects.toThrow('不存在或没有权限');
  });

  it('过期任务排队时同名保存被拒（别的表名、别的成员照常），清理后可以再存；正在保存的表不入队，保存提交后才入队', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    await saveAsSandbox(analyst, 'old', ROWS);
    await saveAsSandbox(engineer, 'old', ROWS);
    await expire(analyst.memberId, 'old');
    expect(await enqueueDueSandboxExpiries()).toEqual([acme]);

    await expect(saveAsSandbox(analyst, 'old', ROWS)).rejects.toThrow('这张沙箱表正在删除或清理');
    await saveAsSandbox(analyst, 'other', ROWS);
    await saveAsSandbox(engineer, 'old', ROWS);
    await drain();
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['other']);
    await saveAsSandbox(analyst, 'old', ROWS);
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['old', 'other']);

    // 成员保存期间（lockForSave 锁着登记行）调度器检查：跳过这一行；保存的事务结束后才入队
    await getDb().delete(tasks).where(eq(tasks.tenantId, acme));
    await expire(analyst.memberId, 'old');
    let release!: () => void;
    const locked = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>(resolve => { held = resolve; });
    const saving = getDb().transaction(async tx => {
      expect(await lockForSave(tx, acme, analyst.memberId, 'old')).toBe(true);
      held();
      await locked;
    });
    await holding;
    expect(await enqueueDueSandboxExpiries()).toEqual([]);
    release();
    await saving;
    expect(await enqueueDueSandboxExpiries()).toEqual([acme]);
  });

  it('主人提前删除（dropSandboxTable）：列表与被分享人的「分享给我的」立刻看不到，湖表改名成保留名后 SHOW TABLES、目录树不列出、查它报不存在、保留名不能保存；删除任务排队时同名保存马上成功，任务跑完新表还在（新行数、新过期时间、无旧分享）、旧表与 parquet 文件被清掉；别人的表 404，已删的再删 404、不重复入队，别的成员同名表不受影响', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    const mine = sandboxSchema(analyst.memberId);
    await onLake(acme, `CALL lake.set_option('data_inlining_row_limit', 0)`);
    await saveAsSandbox(analyst, 'filed', ROWS);
    await saveAsSandbox(analyst, 'keep', ROWS);
    await saveAsSandbox(engineer, 'filed', ROWS);
    const files = await onLake<{ path: string }>(acme, `SELECT data_file AS path FROM ducklake_list_files('lake', 'filed', schema => '${mine}')`);
    expect(files.length).toBeGreaterThan(0);
    await shareSandboxTable(analyst, 'filed', 'de@acme.com');

    await dropSandboxTable(analyst, 'filed');

    // 不等任务跑完：我的沙箱表与被分享人的「分享给我的」都不再列出，登记行标记 expiredAt（验收标准 1、3）
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['keep']);
    expect(await listSharedWithMe(engineer)).toEqual([]);
    const [dropped] = await getDb().select().from(sandboxTables)
      .where(and(eq(sandboxTables.tenantId, acme), eq(sandboxTables.memberId, analyst.memberId), eq(sandboxTables.name, 'filed')));
    expect(dropped.expiredAt).toEqual(expect.any(Date));
    // 已删的再删 404，不重复入队（验收标准 3）
    await expect(dropSandboxTable(analyst, 'filed')).rejects.toMatchObject({ status: 404, message: '没有沙箱表 filed' });
    expect(await getDb().select({ id: tasks.id }).from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'sandbox.expire')))).toHaveLength(1);

    // 湖里的表已改名成保留名：主人的 SHOW TABLES、目录树都不列出，直接查它报「不存在或没有权限」（验收标准 3）
    const renamedTables = await onLake<{ name: string }>(acme, `
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema = '${mine}' AND table_name ~ '^filed_d[0-9a-f]{8}$'`);
    expect(renamedTables).toHaveLength(1);
    const shown = (await runQuery(analyst, 'SHOW TABLES')).rows.map(r => String(r[1]));
    expect(shown.filter(n => DROPPED.test(n))).toEqual([]);
    expect(shown).toContain('keep');
    expect((await listCatalog(analyst)).mine.map(t => t.name)).toEqual(['keep']);
    await expect(runQuery(analyst, `SELECT * FROM ${mine}."${renamedTables[0]!.name}"`)).rejects.toThrow('不存在或没有权限');
    // 以 _d 加 8 位十六进制结尾的名字是保留名，不能保存
    await expect(saveAsSandbox(analyst, 'keep_d1234abcd', ROWS)).rejects.toThrow('保留名');

    // 删除任务还排着队（不调 drain）：同名保存马上成功，得到一张新表（验收标准 1）
    await saveAsSandbox(analyst, 'filed', ROWS4);
    await saveAsSandbox(analyst, 'other', ROWS);
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['filed', 'keep', 'other']);

    await drain();

    // 任务跑完：新表还在、能读，行数是新的（4 行）；改名后的旧表与 parquet 文件被清掉（验收标准 2）
    expect((await runQuery(analyst, `SELECT count(*) AS n FROM ${mine}.filed`)).rows).toEqual([['4']]);
    const lakeTables = await onLake<{ schema: string; name: string }>(acme, `
      SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema LIKE 'sandbox_%' ORDER BY ALL`);
    expect(lakeTables).toHaveLength(4);
    expect(lakeTables).toEqual(expect.arrayContaining([
      { schema: sandboxSchema(engineer.memberId), name: 'filed' }, { schema: mine, name: 'keep' },
      { schema: mine, name: 'other' }, { schema: mine, name: 'filed' },
    ]));
    expect(lakeTables.filter(t => DROPPED.test(t.name))).toEqual([]);
    expect(files.filter(f => existsSync(f.path))).toEqual([]);
    // 新登记：expiredAt 为空、过期时间重新约 7 天后，没有旧分享（验收标准 1）
    const [resaved] = await getDb().select().from(sandboxTables)
      .where(and(eq(sandboxTables.tenantId, acme), eq(sandboxTables.memberId, analyst.memberId), eq(sandboxTables.name, 'filed')));
    expect(resaved!.expiredAt).toBeNull();
    expect(resaved!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await listSharedWithMe(engineer)).toEqual([]);

    // 只有主人能删：别人的表（哪怕是同名的）404（验收标准 3）
    await expect(dropSandboxTable(engineer, 'keep')).rejects.toMatchObject({ status: 404, message: '没有沙箱表 keep' });
    // 表还在时正常删除，已删的再删 404
    await dropSandboxTable(analyst, 'keep');
    await expect(dropSandboxTable(analyst, 'keep')).rejects.toMatchObject({ status: 404 });
    const expireTasks = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, acme), eq(tasks.kind, 'sandbox.expire')));
    expect(expireTasks).toHaveLength(2);
    const drops = await getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'sandbox.dropped')));
    expect(drops.map(d => (d.detail as { name: string }).name).sort()).toEqual(['filed', 'keep']);
    // 别的成员同名的表不受影响
    expect((await listSandboxTables(engineer)).map(t => t.name)).toEqual(['filed']);
    expect((await runQuery(engineer, `SELECT count(*) AS n FROM ${sandboxSchema(engineer.memberId)}.filed`)).rows).toEqual([['3']]);
  });

  it('sandbox.expire 只认沙箱 schema 里的表名', async () => {
    const acme = await newTenant('acme');
    const schema = sandboxSchema((await memberOf(acme, 'analyst@acme.com', 'analyst')).memberId);
    for (const table of ['gold.rfm__x', 'silver.customer', 'sandbox_abc.t', `${schema}.T`, `${schema}."t"`, `${schema}.t; DROP SCHEMA silver`, schema, `${schema}.t.u`]) {
      await expect(enqueueTask(acme, 'sandbox.expire', { tables: [table] }), table)
        .rejects.toThrow('参数 tables 必须是非空的沙箱表名列表');
    }
    await expect(enqueueTask(acme, 'sandbox.expire', { tables: [] })).rejects.toThrow('参数 tables 必须是非空的沙箱表名列表');
    expect(await runTask(acme, 'sandbox.expire', { tables: [`${schema}.never_saved`] })).toMatchObject({ status: 'succeeded' });
  });
});

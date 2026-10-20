// test/pipeline/sandbox-expire.test.ts —— 沙箱表过期的流水线接缝：saveAsSandbox 存下的沙箱表到期（直接把 expiresAt 改到过去）→ enqueueDueSandboxExpiries →
// 调度器派发 sandbox.expire → 湖里的表、parquet 文件与内联在 catalog 的行、平台元数据里的 expiredAt、工作台的列表与查询
import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { sandboxTables, tasks } from '../../app/.server/db/schema';
import { lakeRow } from '../../app/.server/lake';
import { enqueueDueSandboxExpiries, lockForSave } from '../../app/.server/sandbox';
import { listSandboxTables, runQuery, sandboxSchema, saveAsSandbox } from '../../app/.server/workbench';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, onLake, runTask } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();
const ROWS = 'SELECT * FROM (VALUES (1, \'a\'), (2, \'b\'), (3, \'c\')) t(id, label)';

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

    expect(await enqueueDueSandboxExpiries()).toEqual([]);
    expect(await runTask(acme, 'sandbox.expire', { tables: [`${mine}.filed`] })).toMatchObject({ status: 'succeeded' });

    // 过期后同名再保存：重新列出
    await saveAsSandbox(analyst, 'filed', ROWS);
    expect((await listSandboxTables(analyst)).map(t => t.name)).toEqual(['filed', 'fresh']);
  });

  it('过期任务排队时同名保存被拒（别的表名、别的成员照常），清理后可以再存；正在保存的表不入队，保存提交后才入队', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const engineer = await memberOf(acme, 'de@acme.com');
    await saveAsSandbox(analyst, 'old', ROWS);
    await saveAsSandbox(engineer, 'old', ROWS);
    await expire(analyst.memberId, 'old');
    expect(await enqueueDueSandboxExpiries()).toEqual([acme]);

    await expect(saveAsSandbox(analyst, 'old', ROWS)).rejects.toThrow('这张沙箱表已到期、正在清理');
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

  it('sandbox.expire 只认沙箱 schema 里的表名', async () => {
    const acme = await newTenant('acme');
    const schema = sandboxSchema((await memberOf(acme, 'analyst@acme.com', 'analyst')).memberId);
    for (const table of ['gold.rfm__x', 'silver.customer', 'sandbox_abc.t', `${schema}.T`, `${schema}."t"`, `${schema}.t; DROP SCHEMA silver`, schema, `${schema}.t.u`]) {
      expect(await runTask(acme, 'sandbox.expire', { tables: [table] }), table).toMatchObject({ status: 'failed' });
    }
    expect(await runTask(acme, 'sandbox.expire', { tables: [] })).toMatchObject({ status: 'failed' });
    expect(await runTask(acme, 'sandbox.expire', { tables: [`${schema}.never_saved`] })).toMatchObject({ status: 'succeeded' });
  });
});

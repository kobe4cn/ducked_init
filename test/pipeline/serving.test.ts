// test/pipeline/serving.test.ts —— 生成服务库的流水线接缝：runTask('serving.build') → 调度器派发 → 打开上传到租户存储前缀 _serving/ 下的 DuckDB 文件核对；
// 自动重建：快照登记或过期后调度器入队 serving.build → 成功后 currentServingStore 的指针切到新版本、_serving/ 下只留两版
import { existsSync, mkdtempSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { snapshots as snapshotsTable, tasks } from '../../app/.server/db/schema';
import { createDefinition, deleteDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { servingPath } from '../../app/.server/pipeline/serving-engine';
import { platformS3 } from '../../app/.server/s3-accounts';
import { getObject } from '../../app/.server/s3-client';
import { tenantServingKey } from '../../app/.server/secrets';
import { currentServingStore, enqueueServingBuild } from '../../app/.server/serving-store';
import { enqueueDueExpiries, listSnapshots } from '../../app/.server/snapshots';
import { syncSource } from '../../app/.server/source-sync';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const ALL_REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';
const REVENUE_BY_CITY = `${ALL_REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`;

/** 用给定密钥只读挂载服务库文件后执行 SQL（ADR-0033：文件按租户密钥加密） */
async function attachServing<T = Record<string, unknown>>(file: string, key: string | undefined, sql: string) {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    await con.run(`ATTACH '${file}' AS s (READ_ONLY${key ? `, ENCRYPTION_KEY '${key}'` : ''}); USE s`);
    return (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

/** 用本租户的服务库密钥读出服务库文件里的一张表 */
async function readServing<T = Record<string, unknown>>(tenantId: string, file: string, sql: string) {
  return attachServing<T>(file, await tenantServingKey(tenantId), sql);
}

/** 在本租户数据湖里执行 SQL（可写） */
async function onLake<T = Record<string, unknown>>(tenantId: string, sql: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    session.close();
  }
}

/** 身份打通与订单映射已发布，跑出 RFM 快照，双人发布指标 revenue、带城市维度的 revenue_by_city 与引用 revenue 的标签 value_tier */
async function publishedDefinitions() {
  const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
  expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'succeeded' });
  await createDefinition(author, 'metric', 'revenue', ALL_REVENUE);
  await createDefinition(author, 'metric', 'revenue_by_city', REVENUE_BY_CITY);
  await publishDefinition(reviewer, 'metric', 'revenue', 1);
  await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
  await drain();
  await createDefinition(author, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
  await publishDefinition(reviewer, 'tag', 'value_tier', 1);
  await drain();
  const snapshots = await listSnapshots(acme);
  expect(snapshots.map(s => s.template).sort()).toEqual(['metric:revenue', 'metric:revenue_by_city', 'rfm', 'tag:value_tier']);
  const { dataPath } = (await lakeRow(acme))!;
  return { acme, author, sources, snapshots, dataPath };
}

describe('生成服务库', () => {
  it('把各快照表写进 _serving/v<版本>.duckdb：标签、指标（维度进 dims）、RFM、退役 ID 对照与 meta，都按 consumer_id 排序，结果给出各表行数', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    const count = (template: string) => snapshots.find(s => s.template === template)!.rowCount;
    const target = servingPath(dataPath, 101);
    const task = await runTask(acme, 'serving.build', {
      version: 101, target, snapshots: snapshots.map(s => ({ id: s.id, template: s.template, table: s.table, definitionVersion: s.definitionVersion })),
    });
    expect(task).toMatchObject({ status: 'succeeded' });
    // 夹具里的身份打通已有一次合并（一个退役 ID，没有链）
    const merged = await onLake(acme, `SELECT old_id AS retired_id, new_id AS consumer_id FROM silver._consumer_id_changes WHERE reason = 'merge' ORDER BY ALL`);
    expect(merged).toHaveLength(1);
    const rows = { tags: count('tag:value_tier'), metrics: count('metric:revenue') + count('metric:revenue_by_city'), rfm: count('rfm'), consumer_aliases: 1 };
    expect(task!.result).toMatchObject({ version: 101, path: target, rows });

    expect(await readServing(acme, target, `SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
      FROM information_schema.columns GROUP BY table_name ORDER BY table_name`)).toEqual([
      { table_name: 'consumer_aliases', columns: 'retired_id,consumer_id' },
      { table_name: 'meta', columns: 'version,built_at' },
      { table_name: 'metrics', columns: 'consumer_id,metric,dims,value' },
      { table_name: 'rfm', columns: 'consumer_id,segment,r,f,m,recency_days,frequency,monetary' },
      { table_name: 'tags', columns: 'consumer_id,tag,tag_value' },
    ]);
    for (const table of ['tags', 'metrics', 'rfm']) {
      const ids = (await readServing<{ consumer_id: string }>(acme, target, `SELECT consumer_id FROM ${table}`)).map(r => r.consumer_id);
      expect(ids).toHaveLength(rows[table as keyof typeof rows]);
      expect(ids).toEqual([...ids].sort());
    }
    const dims = await readServing<{ metric: string; keys: string }>(acme, target,
      `SELECT DISTINCT metric, json_keys(dims)::VARCHAR AS keys FROM metrics ORDER BY metric`);
    expect(dims).toEqual([{ metric: 'revenue', keys: '[]' }, { metric: 'revenue_by_city', keys: '[city]' }]);
    expect(await readServing(acme, target, 'SELECT DISTINCT tag FROM tags')).toEqual([{ tag: 'value_tier' }]);
    expect(await readServing(acme, target, 'SELECT * FROM consumer_aliases')).toEqual(merged);
    expect(await readServing(acme, target, 'SELECT version FROM meta')).toEqual([{ version: 101 }]);
  });

  it('退役 ID 沿着 merge 链指向现在的 ID，split 不算', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    await onLake(acme, `CREATE TABLE IF NOT EXISTS silver._consumer_id_changes (old_id VARCHAR, new_id VARCHAR, reason VARCHAR, changed_at TIMESTAMPTZ);
      INSERT INTO silver._consumer_id_changes VALUES ('a', 'b', 'merge', now()), ('b', 'c', 'merge', now()), ('c', 'd', 'split', now()), ('x', 'c', 'merge', now())`);
    const target = servingPath(dataPath, 102);
    const task = await runTask(acme, 'serving.build', { version: 102, target, snapshots: snapshots.map(({ id, template, table }) => ({ id, template, table })) });
    // 夹具里已有的一个退役 ID 之外再多三个
    expect(task).toMatchObject({ status: 'succeeded', result: { rows: { consumer_aliases: 4 } } });
    expect(await readServing(acme, target, `SELECT * FROM consumer_aliases WHERE retired_id IN ('a', 'b', 'x')`)).toEqual([
      { retired_id: 'a', consumer_id: 'c' }, { retired_id: 'b', consumer_id: 'c' }, { retired_id: 'x', consumer_id: 'c' },
    ]);
  });

  it('表名不合规、表不在、模板与表名不符或 target 不是本租户这一版的位置时失败，不上传', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    const [rfm] = snapshots.filter(s => s.template === 'rfm');
    const base = { id: rfm!.id, template: 'rfm', table: rfm!.table };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ snapshots: [{ ...base, table: 'silver.customer' }] }, /参数 snapshots/],
      [{ snapshots: [{ ...base, table: 'gold.rfm__00000000-0000-0000-0000-000000000000' }] }, /结果层没有快照表/],
      [{ snapshots: [{ ...base, template: 'tag:value_tier' }] }, /不合规/],
      [{ snapshots: [base], target: `${dataPath}elsewhere/v103.duckdb` }, /参数 target/],
    ];
    const target = servingPath(dataPath, 103);
    for (const [params, error] of cases) {
      const task = await runTask(acme, 'serving.build', { version: 103, target, ...params });
      expect(task).toMatchObject({ status: 'failed', error: expect.stringMatching(error) });
    }
    expect(existsSync(target)).toBe(false);
  });
});

describe('服务库加密', () => {
  it('文件按租户密钥加密：不带密钥、带另一租户的密钥都挂不上，带本租户的密钥可读', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const target = servingPath((await lakeRow(acme))!.dataPath, 1);
    expect(await runTask(acme, 'serving.build', { version: 1, target, snapshots: [] })).toMatchObject({ status: 'succeeded' });
    await expect(attachServing(target, undefined, 'SELECT * FROM meta')).rejects.toThrow(/encrypt/i);
    await expect(attachServing(target, await tenantServingKey(globex), 'SELECT * FROM meta')).rejects.toThrow();
    expect(await readServing(acme, target, 'SELECT version FROM meta')).toEqual([{ version: 1 }]);
  });

  it('密钥不进任务参数、结果与报错', async () => {
    const acme = await newTenant('acme');
    const key = await tenantServingKey(acme);
    const target = servingPath((await lakeRow(acme))!.dataPath, 1);
    const ok = await runTask(acme, 'serving.build', { version: 1, target, snapshots: [] });
    const failed = await runTask(acme, 'serving.build', {
      version: 2, target: servingPath((await lakeRow(acme))!.dataPath, 2),
      snapshots: [{ id: '00000000-0000-0000-0000-000000000000', template: 'rfm', table: 'gold.rfm__00000000-0000-0000-0000-000000000000' }],
    });
    expect(failed).toMatchObject({ status: 'failed' });
    for (const task of [ok, failed]) expect(JSON.stringify(task)).not.toContain(key);
  });
});

/** _serving/ 下的服务库文件版本，从小到大 */
const servingVersions = async (dataPath: string) => (await readdir(`${dataPath}_serving/`))
  .flatMap(f => { const m = /^v(\d+)\.duckdb$/.exec(f); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);

/** 本租户的 serving.build 任务（按创建先后）的状态与版本 */
const builds = async (tenantId: string) => (await getDb().select({ status: tasks.status, params: tasks.params }).from(tasks)
  .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'serving.build'))).orderBy(tasks.createdAt))
  .map(t => ({ status: t.status, version: t.params.version as number }));

describe('自动重建服务库', () => {
  it('快照登记后自动入队并切换指针：指针指向最新一版，放的是每个模板最新的快照；_serving/ 下只留两版；已有排队中的不重复入队、改用现在的快照', async () => {
    const { acme, author, snapshots, dataPath } = await publishedDefinitions();
    const store = (await currentServingStore(acme))!;
    expect(store.path).toBe(servingPath(dataPath, store.version));
    expect(store.snapshots).toEqual(snapshots.map(s => ({
      id: s.id, template: s.template, definitionVersion: s.definitionVersion, createdAt: s.createdAt.toISOString(), incomplete: false,
    })).sort((a, b) => a.template.localeCompare(b.template)));
    expect(await readServing(acme, store.path, 'SELECT version FROM meta')).toEqual([{ version: store.version }]);
    expect(await readServing(acme, store.path, 'SELECT DISTINCT tag FROM tags')).toEqual([{ tag: 'value_tier' }]);
    const done = await builds(acme);
    expect(done.length).toBeGreaterThan(1);
    expect(done.every(b => b.status === 'succeeded')).toBe(true);
    expect(done.map(b => b.version)).toEqual(done.map((_, i) => i + 1));
    expect(store.version).toBe(done.length);
    expect(await servingVersions(dataPath)).toEqual([store.version - 1, store.version]);

    // 排队中的不重复入队，但参数改用现在的快照：入队后删掉的定义不再放进服务库
    expect(await enqueueServingBuild(acme)).toMatchObject({ id: expect.any(String) });
    await deleteDefinition(author, 'tag', 'value_tier');
    expect(await enqueueServingBuild(acme)).toBeNull();
    expect(await builds(acme)).toHaveLength(done.length + 1);
    await drain();
    const next = (await currentServingStore(acme))!;
    expect(next.version).toBe(store.version + 1);
    expect(next.snapshots.map(s => s.template)).toEqual(['metric:revenue', 'metric:revenue_by_city', 'rfm']);
    expect(await readServing(acme, next.path, 'SELECT count(*)::INT AS n FROM tags')).toEqual([{ n: 0 }]);
    expect(await servingVersions(dataPath)).toEqual([store.version, next.version]);
  });

  it('快照过期后自动重建，不再放过期的快照', async () => {
    const { acme, snapshots } = await publishedDefinitions();
    const tag = snapshots.find(s => s.template === 'tag:value_tier')!;
    await getDb().update(snapshotsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(snapshotsTable.id, tag.id));
    const before = (await currentServingStore(acme))!;
    expect(await enqueueDueExpiries()).toEqual([acme]);
    await drain();
    const after = (await currentServingStore(acme))!;
    expect(after.version).toBe(before.version + 1);
    expect(after.snapshots.map(s => s.template)).toEqual(['metric:revenue', 'metric:revenue_by_city', 'rfm']);
    expect(await readServing(acme, after.path, 'SELECT count(*)::INT AS n FROM tags')).toEqual([{ n: 0 }]);
  });

  it('生成失败时指针不变、旧版本文件仍在；只接受比当前指针新的版本', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    const before = (await currentServingStore(acme))!;
    const rfm = snapshots.find(s => s.template === 'rfm')!;
    await onLake(acme, `DROP TABLE gold."${rfm.table.slice('gold.'.length)}"`);
    expect(await enqueueServingBuild(acme)).not.toBeNull();
    await drain();
    expect((await builds(acme)).at(-1)).toEqual({ status: 'failed', version: before.version + 1 });
    expect(await currentServingStore(acme)).toEqual(before);
    expect(existsSync(before.path)).toBe(true);

    // 更新的版本先完成，旧版本之后完成也不再生效
    const others = snapshots.filter(s => s !== rfm).map(({ id, template, table }) => ({ id, template, table }));
    const newer = before.version + 10;
    for (const version of [newer, newer - 1]) {
      expect(await runTask(acme, 'serving.build', { version, target: servingPath(dataPath, version), snapshots: others })).toMatchObject({ status: 'succeeded' });
    }
    expect(await currentServingStore(acme)).toMatchObject({ version: newer, path: servingPath(dataPath, newer) });
  });

  it('error 级断言失败、没有登记快照时不重建，服务库仍是上一版', async () => {
    const { acme, sources } = await publishedDefinitions();
    await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
    await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
    await drain();
    const before = (await currentServingStore(acme))!;
    const count = (await builds(acme)).length;
    expect(await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' })).toMatchObject({ status: 'failed', error: expect.stringContaining('金额非负') });
    expect(await builds(acme)).toHaveLength(count);
    expect(await currentServingStore(acme)).toEqual(before);
    expect(existsSync(before.path)).toBe(true);
  });
});

describe.skipIf(!process.env.TEST_S3_LAKE_URI)('生成服务库（对象存储）', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });

  it('没有快照时也生成服务库（各表为空），用租户账号上传到存储前缀的 _serving/ 下', async () => {
    const acme = await newTenant('acme');
    const { dataPath } = (await lakeRow(acme))!;
    const target = servingPath(dataPath, 1);
    expect(target).toMatch(/^s3:\/\//);
    const task = await runTask(acme, 'serving.build', { version: 1, target, snapshots: [] });
    expect(task).toMatchObject({ status: 'succeeded', result: { path: target, rows: { tags: 0, metrics: 0, rfm: 0, consumer_aliases: 0 } } });

    const file = join(mkdtempSync(join(tmpdir(), 'serving-')), 'v1.duckdb');
    await writeFile(file, Buffer.from(await new Response(await getObject(platformS3(), target)).arrayBuffer()));
    expect(await readServing(acme, file, 'SELECT version FROM meta')).toEqual([{ version: 1 }]);
    expect(await readServing(acme, file, 'SELECT count(*)::INT AS n FROM tags')).toEqual([{ n: 0 }]);
  });
});

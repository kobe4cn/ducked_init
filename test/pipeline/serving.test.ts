// test/pipeline/serving.test.ts —— 生成服务库的流水线接缝：runTask('serving.build') → 调度器派发 → 打开上传到租户存储前缀 _serving/ 下的 DuckDB 文件核对
import { existsSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { servingPath } from '../../app/.server/pipeline/serving-engine';
import { platformS3 } from '../../app/.server/s3-accounts';
import { getObject } from '../../app/.server/s3-client';
import { listSnapshots } from '../../app/.server/snapshots';
import { resetDb } from '../http/harness';
import { newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const ALL_REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\n';
const REVENUE_BY_CITY = `${ALL_REVENUE}dimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n`;

/** 读出服务库文件里的一张表 */
async function readServing<T = Record<string, unknown>>(file: string, sql: string) {
  const instance = await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' });
  const con = await instance.connect();
  try {
    return (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  } finally {
    con.closeSync();
    instance.closeSync();
  }
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
  const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
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
  return { acme, snapshots, dataPath };
}

describe('生成服务库', () => {
  it('把各快照表写进 _serving/v<版本>.duckdb：标签、指标（维度进 dims）、RFM、退役 ID 对照与 meta，都按 consumer_id 排序，结果给出各表行数', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    const count = (template: string) => snapshots.find(s => s.template === template)!.rowCount;
    const target = servingPath(dataPath, 1);
    const task = await runTask(acme, 'serving.build', {
      version: 1, target, snapshots: snapshots.map(s => ({ id: s.id, template: s.template, table: s.table, definitionVersion: s.definitionVersion })),
    });
    expect(task).toMatchObject({ status: 'succeeded' });
    // 夹具里的身份打通已有一次合并（一个退役 ID，没有链）
    const merged = await onLake(acme, `SELECT old_id AS retired_id, new_id AS consumer_id FROM silver._consumer_id_changes WHERE reason = 'merge' ORDER BY ALL`);
    expect(merged).toHaveLength(1);
    const rows = { tags: count('tag:value_tier'), metrics: count('metric:revenue') + count('metric:revenue_by_city'), rfm: count('rfm'), consumer_aliases: 1 };
    expect(task!.result).toMatchObject({ version: 1, path: target, rows });

    expect(await readServing(target, `SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
      FROM information_schema.columns GROUP BY table_name ORDER BY table_name`)).toEqual([
      { table_name: 'consumer_aliases', columns: 'retired_id,consumer_id' },
      { table_name: 'meta', columns: 'version,built_at' },
      { table_name: 'metrics', columns: 'consumer_id,metric,dims,value' },
      { table_name: 'rfm', columns: 'consumer_id,segment,r,f,m,recency_days,frequency,monetary' },
      { table_name: 'tags', columns: 'consumer_id,tag,tag_value' },
    ]);
    for (const table of ['tags', 'metrics', 'rfm']) {
      const ids = (await readServing<{ consumer_id: string }>(target, `SELECT consumer_id FROM ${table}`)).map(r => r.consumer_id);
      expect(ids).toHaveLength(rows[table as keyof typeof rows]);
      expect(ids).toEqual([...ids].sort());
    }
    const dims = await readServing<{ metric: string; keys: string }>(target,
      `SELECT DISTINCT metric, json_keys(dims)::VARCHAR AS keys FROM metrics ORDER BY metric`);
    expect(dims).toEqual([{ metric: 'revenue', keys: '[]' }, { metric: 'revenue_by_city', keys: '[city]' }]);
    expect(await readServing(target, 'SELECT DISTINCT tag FROM tags')).toEqual([{ tag: 'value_tier' }]);
    expect(await readServing(target, 'SELECT * FROM consumer_aliases')).toEqual(merged);
    expect(await readServing(target, 'SELECT version FROM meta')).toEqual([{ version: 1 }]);
  });

  it('退役 ID 沿着 merge 链指向现在的 ID，split 不算', async () => {
    const { acme, snapshots, dataPath } = await publishedDefinitions();
    await onLake(acme, `CREATE TABLE IF NOT EXISTS silver._consumer_id_changes (old_id VARCHAR, new_id VARCHAR, reason VARCHAR, changed_at TIMESTAMPTZ);
      INSERT INTO silver._consumer_id_changes VALUES ('a', 'b', 'merge', now()), ('b', 'c', 'merge', now()), ('c', 'd', 'split', now()), ('x', 'c', 'merge', now())`);
    const target = servingPath(dataPath, 2);
    const task = await runTask(acme, 'serving.build', { version: 2, target, snapshots: snapshots.map(({ id, template, table }) => ({ id, template, table })) });
    // 夹具里已有的一个退役 ID 之外再多三个
    expect(task).toMatchObject({ status: 'succeeded', result: { rows: { consumer_aliases: 4 } } });
    expect(await readServing(target, `SELECT * FROM consumer_aliases WHERE retired_id IN ('a', 'b', 'x')`)).toEqual([
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
      [{ snapshots: [base], target: `${dataPath}elsewhere/v3.duckdb` }, /参数 target/],
    ];
    const target = servingPath(dataPath, 3);
    for (const [params, error] of cases) {
      const task = await runTask(acme, 'serving.build', { version: 3, target, ...params });
      expect(task).toMatchObject({ status: 'failed', error: expect.stringMatching(error) });
    }
    expect(existsSync(target)).toBe(false);
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
    expect(await readServing(file, 'SELECT version FROM meta')).toEqual([{ version: 1 }]);
    expect(await readServing(file, 'SELECT count(*)::INT AS n FROM tags')).toEqual([{ n: 0 }]);
  });
});

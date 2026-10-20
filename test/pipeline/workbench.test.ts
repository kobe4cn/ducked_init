// test/pipeline/workbench.test.ts —— 数据查询工作台的流水线接缝：成员 runQuery(sql) → 在只读挂载的本租户数据湖上校验并执行 →
// 返回的列与行、审计日志 workbench.query；交互查询挂起时调度器照常领取并完成正式任务；
// 查询用本租户的只读 PG 角色与只读对象存储账号，凭据本身就写不进 catalog 与存储
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, tenantLakes } from '../../app/.server/db/schema';
import { dropTenantS3Account, ensureReadOnlyLakeAccess, ensureTenantS3Account, lakeRow, readOnlyLakeSpecOf } from '../../app/.server/lake';
import { deleteTenantS3Account, platformS3 } from '../../app/.server/s3-accounts';
import { getObject, listObjects, putObject } from '../../app/.server/s3-client';
import { listSnapshots } from '../../app/.server/snapshots';
import { enqueueTask, getTask } from '../../app/.server/tasks';
import { runQuery, WORKBENCH_ROWS } from '../../app/.server/workbench';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, runTask } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

let acme: string;
afterAll(async () => { await closeDb(); });
beforeAll(async () => {
  await resetDb();
  ({ acme } = await publishedIdentitySources({ orders: true }));
});

const analyst = () => memberOf(acme, 'analyst@acme.com', 'analyst');
const audits = () => getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'workbench.query')));
/** 足够慢的只读查询：标准层的表自己交叉连接十几次 */
const SLOW = `SELECT count(*) FROM ${Array.from({ length: 12 }, (_, i) => `silver.customer c${i}`).join(', ')}`;
const errorOf = (p: Promise<unknown>) => p.then(() => '成功', (e: Error & { status?: number }) => `${e.status ?? ''} ${e.message}`);

describe('只读查询', () => {
  it('读标准层与结果层，记审计（执行人、SQL、耗时、行数），不记结果', async () => {
    const member = await analyst();
    const before = (await audits()).length;
    const customers = await runQuery(member, 'SELECT customer_id FROM silver.customer ORDER BY 1;');
    expect(customers.columns).toEqual([{ name: 'customer_id', type: 'VARCHAR' }]);
    expect(customers.rows.length).toBeGreaterThan(0);
    expect(customers.truncated).toBe(false);

    const [rfm] = (await listSnapshots(acme)).filter(s => s.template === 'rfm');
    const [schema, name] = rfm.table.split('.');
    const gold = await runQuery(member, `WITH s AS (SELECT * FROM lake.${schema}."${name}"), t AS (SELECT * FROM s) SELECT count(*) AS n FROM t`);
    expect((await runQuery(member, 'WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT * FROM n')).rows).toEqual([[1], [2], [3]]);
    expect(gold.rows).toEqual([[String(rfm.rowCount)]]); // BIGINT 按文本给出

    const described = await runQuery(member, 'DESCRIBE silver.customer');
    expect(described.rows.map(r => r[0])).toContain('customer_id');
    expect((await runQuery(member, 'SUMMARIZE silver.customer')).rows.length).toBeGreaterThan(0);
    expect((await runQuery(member, 'EXPLAIN SELECT * FROM silver.customer')).rows.length).toBeGreaterThan(0);
    // SHOW TABLES 只列标准层与结果层
    const tables = await runQuery(member, 'SHOW ALL TABLES');
    expect(new Set(tables.rows.map(r => r[0]))).toEqual(new Set(['silver', 'gold']));
    expect(tables.rows).toContainEqual(['gold', name, 'BASE TABLE']);
    expect((await runQuery(member, 'SHOW TABLES FROM gold')).rows.every(r => r[0] === 'gold')).toBe(true);

    const logs = (await audits()).slice(before);
    expect(logs).toHaveLength(8);
    expect(logs[0]).toMatchObject({ actorEmail: 'analyst@acme.com', detail: {
      sql: 'SELECT customer_id FROM silver.customer ORDER BY 1', rows: customers.rows.length, truncated: false, durationMs: expect.any(Number),
    } });
    expect(Object.keys(logs[0].detail as object).sort()).toEqual(['durationMs', 'rows', 'sql', 'truncated']);
  });

  it(`超过 ${WORKBENCH_ROWS} 行时截断`, async () => {
    const result = await runQuery(await analyst(), 'SELECT a.customer_id FROM silver.customer a, silver.customer b, silver.customer c, silver.customer d');
    expect(result.rows).toHaveLength(WORKBENCH_ROWS);
    expect(result.truncated).toBe(true);
    expect((await audits()).at(-1)!.detail).toMatchObject({ rows: WORKBENCH_ROWS, truncated: true });
  });

  it('写入、多条语句、silver / gold 之外的 catalog 与 schema、表函数与读配置的函数都被拒并给出原因，失败也记审计', async () => {
    const member = await analyst();
    const rejected: [string, RegExp][] = [
      ['INSERT INTO silver.customer SELECT * FROM silver.customer', /只能执行一条 SELECT/],
      ['CREATE TABLE gold.x AS SELECT 1', /只能执行一条 SELECT/],
      ["COPY silver.customer TO '/tmp/x.csv'", /只能执行一条 SELECT/],
      ["ATTACH '/tmp/x.duckdb' AS x", /只能执行一条 SELECT/],
      ['SET threads = 8', /只能执行一条 SELECT/],
      ['SELECT 1; SELECT 2', /只能执行一条 SELECT/],
      ['EXPLAIN SELECT 1; DROP TABLE silver.customer', /只能执行一条 SELECT/],
      ['SELECT * FROM stage.main.x', /不能读 stage\.main\.x/],
      ['SELECT * FROM stage.x', /不能读 stage\.x/],
      ['SELECT * FROM __ducklake_metadata_lake.ducklake_metadata', /不能读 __ducklake_metadata_lake/],
      ['SELECT * FROM information_schema.tables', /不能读 information_schema\.tables/],
      ['SELECT * FROM bronze_x.customers', /不能读 bronze_x\.customers/],
      ['SELECT * FROM customer', /要写明 schema/],
      ['SELECT * FROM silver.customer WHERE customer_id IN (SELECT 1 FROM stage.t)', /不能读 stage\.t/],
      ["SELECT * FROM read_parquet('/tmp/*.parquet')", /表函数 read_parquet/],
      ["SELECT * FROM postgres_query('x', 'SELECT 1')", /表函数 postgres_query/],
      ['SELECT * FROM duckdb_settings()', /表函数 duckdb_settings/],
      // CTE 的定义体里同名的引用不是它自己（递归 CTE 的锚点也不是），而是同名的系统视图或表
      ['WITH duckdb_databases AS (SELECT * FROM duckdb_databases) SELECT * FROM duckdb_databases', /要写明 schema/],
      ['WITH RECURSIVE sqlite_master AS (SELECT * FROM sqlite_master UNION ALL SELECT * FROM sqlite_master) SELECT * FROM sqlite_master', /要写明 schema/],
      ['WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a', /要写明 schema/],
      ["SELECT getenv('HOME')", /函数 getenv/],
      ["SELECT current_setting('allowed_directories')", /函数 current_setting/],
      ['DESCRIBE stage.x', /不能读 stage\.x/],
      ['SHOW DATABASES', /SHOW/],
      ['SHOW TABLES FROM stage', /不能列出 stage/],
      ['SELECT * FROM (SHOW TABLES)', /SHOW/],
      ['SELEC 1', /语法错误/],
      ['SELECT no_such_column FROM silver.customer', /查询出错/],
    ];
    const before = (await audits()).length;
    for (const [sql, message] of rejected) expect(await errorOf(runQuery(member, sql)), sql).toMatch(message);
    const logs = (await audits()).slice(before);
    expect(logs).toHaveLength(rejected.length);
    expect(logs[0].detail).toMatchObject({ sql: rejected[0][0], rows: 0, error: expect.stringMatching(/只能执行一条 SELECT/) });
  });

  it('查看者没有沙箱权限', async () => {
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(runQuery(viewer, 'SELECT 1')).rejects.toMatchObject({ init: { status: 403 } });
  });
});

describe('超时、取消与并发', () => {
  it('超时被中断并报超时；中止即取消', async () => {
    const member = await analyst();
    expect(await errorOf(runQuery(member, SLOW, undefined, { timeoutMs: 300 }))).toMatch(/查询超过 0.3 秒，已中断/);
    const controller = new AbortController();
    const pending = errorOf(runQuery(member, SLOW, controller.signal));
    setTimeout(() => controller.abort(), 1500);
    const started = Date.now();
    expect(await pending).toMatch(/查询已取消/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect((await audits()).at(-1)!.detail).toMatchObject({ sql: SLOW, error: '查询已取消' });
  });

  it('同租户已有查询在运行时第二个被拒（429）；运行期间正式任务照常被领取、完成', async () => {
    const member = await analyst();
    const controller = new AbortController();
    const first = errorOf(runQuery(member, SLOW, controller.signal));
    await new Promise(r => setTimeout(r, 1000));
    expect(await errorOf(runQuery(member, 'SELECT 1 FROM silver.customer'))).toMatch(/^429 本租户已有查询在运行/);

    const { id } = await enqueueTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    expect(await getTask(id)).toMatchObject({ status: 'succeeded' });

    controller.abort();
    expect(await first).toMatch(/查询已取消/);
    expect((await runQuery(member, 'SELECT 1 AS one')).rows).toEqual([[1]]);
  }, 120_000);
});

/** 以给定的 PG 账号连平台库执行 SQL，返回结果或报错信息 */
async function asRole(role: string, password: string, sql: string) {
  const url = new URL(process.env.PLATFORM_DATABASE_URL!);
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await client.query(sql).then(r => r.rows, (e: Error) => e.message);
  } finally {
    await client.end();
  }
}

const platformSql = (query: string) => getDb().execute(sql.raw(query));
const clearReadOnlyColumns = (tenantId: string) => getDb().update(tenantLakes)
  .set({ roDbRole: null, roDbPassword: null, roS3AccessKey: null, roS3SecretKey: null }).where(eq(tenantLakes.tenantId, tenantId));

describe('只读凭据', () => {
  it('开通时建好只读角色：catalog 的表只能 SELECT，INSERT、建表被拒；不是超级用户，也不继承租户角色', async () => {
    const lake = (await lakeRow(acme))!;
    expect(lake.roDbRole).toBe(`${lake.dbRole}_ro`);
    const ro = (sql: string) => asRole(lake.roDbRole!, lake.roDbPassword!, sql);
    const table = `"${lake.catalogSchema}".ducklake_metadata`;
    expect(await ro(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: expect.any(String) }]);
    expect(await ro(`INSERT INTO ${table} (key, value) VALUES ('evil', '1')`)).toMatch(/permission denied/);
    expect(await ro(`UPDATE ${table} SET value = value`)).toMatch(/permission denied/);
    expect(await ro(`CREATE TABLE "${lake.catalogSchema}".evil (x int)`)).toMatch(/permission denied/);
    const { rows: [role] } = await platformSql(`SELECT rolsuper, pg_has_role('${lake.roDbRole}', '${lake.dbRole}', 'USAGE') AS inherits
      FROM pg_roles WHERE rolname = '${lake.roDbRole}'`);
    expect(role).toEqual({ rolsuper: false, inherits: false });
    expect(readOnlyLakeSpecOf(lake).catalogUrl).toContain(`//${lake.roDbRole}:`);
  });

  it('工作台查询用只读凭据：收回只读角色的 SELECT 后查询报权限不足', async () => {
    const lake = (await lakeRow(acme))!;
    await platformSql(`REVOKE SELECT ON ALL TABLES IN SCHEMA "${lake.catalogSchema}" FROM "${lake.roDbRole}"`);
    try {
      expect(await errorOf(runQuery(await analyst(), 'SELECT count(*) FROM silver.customer'))).toMatch(/permission denied/);
    } finally {
      await platformSql(`GRANT SELECT ON ALL TABLES IN SCHEMA "${lake.catalogSchema}" TO "${lake.roDbRole}"`);
    }
  });

  it('老租户第一次查询时补建只读角色（角色不存在或只是没记下凭据），重复调用不报错', async () => {
    const before = (await lakeRow(acme))!;
    await clearReadOnlyColumns(acme);
    await platformSql(`DROP OWNED BY "${before.roDbRole}"; DROP ROLE "${before.roDbRole}"`);
    expect((await runQuery(await analyst(), 'SELECT count(*) > 0 AS ok FROM silver.customer')).rows).toEqual([[true]]);
    const after = (await lakeRow(acme))!;
    expect(after.roDbRole).toBe(before.roDbRole);

    await clearReadOnlyColumns(acme);
    await ensureReadOnlyLakeAccess(acme);
    await ensureReadOnlyLakeAccess(acme);
    // 记下了角色、没记下密码时同样补齐
    await getDb().update(tenantLakes).set({ roDbPassword: null }).where(eq(tenantLakes.tenantId, acme));
    await ensureReadOnlyLakeAccess(acme);
    const again = (await lakeRow(acme))!;
    expect(again.roDbPassword).toBeTruthy();
    expect(await asRole(again.roDbRole!, again.roDbPassword!, `SELECT 1 AS one FROM "${again.catalogSchema}".ducklake_metadata LIMIT 1`))
      .toEqual([{ one: 1 }]);
    expect((await runQuery(await analyst(), 'SELECT count(*) > 0 AS ok FROM silver.customer')).rows).toEqual([[true]]);
  });
});

describe.skipIf(!process.env.TEST_S3_LAKE_URI)('只读凭据（对象存储）', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  afterAll(() => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; });
  const roCreds = (lake: { roS3AccessKey: string | null; roS3SecretKey: string | null }) =>
    ({ ...platformS3(), key: lake.roS3AccessKey!, secret: lake.roS3SecretKey! });

  it('开通时建好只读账号：GET、List 本租户前缀可用，PUT 被拒；工作台用它查询；吊销账号时一并删除', async () => {
    const tenant = await newTenant('rolake');
    expect((await runTask(tenant, 'demo.seed', { customers: 20 })).status).toBe('succeeded');
    const lake = (await lakeRow(tenant))!;
    expect(lake.roS3AccessKey).toBeTruthy();
    expect(lake.roS3AccessKey).not.toBe(lake.s3AccessKey);
    const creds = roCreds(lake);
    const files = await listObjects(creds, lake.dataPath);
    const parquet = files.find(f => f.path.endsWith('.parquet'))!;
    expect(parquet).toBeDefined();
    expect(await errorOf(getObject(creds, `${lake.dataPath}${parquet.path}`).then(b => new Response(b).arrayBuffer()))).toBe('成功');
    expect(await errorOf(putObject(creds, `${lake.dataPath}evil.txt`, 'x'))).toMatch(/HTTP 403/);
    expect(readOnlyLakeSpecOf(lake).s3!.key).toBe(lake.roS3AccessKey);

    const member = await memberOf(tenant, 'analyst@rolake.com', 'analyst');
    expect((await runQuery(member, 'SHOW TABLES')).rows).toBeDefined();

    await dropTenantS3Account(tenant);
    expect(await lakeRow(tenant)).toMatchObject({ s3AccessKey: null, roS3AccessKey: null, roS3SecretKey: null });
    expect(await errorOf(listObjects(creds, lake.dataPath))).toMatch(/HTTP 403/);
  });

  it('老租户第一次查询时补建只读账号，重复调用不报错', async () => {
    const tenant = await newTenant('oldlake');
    await deleteTenantS3Account(tenant);
    await clearReadOnlyColumns(tenant);
    // 读写账号随 deleteTenantS3Account 一起删了，补回来（只读账号的补建不依赖它，这里只为数据湖照常可用）
    await getDb().update(tenantLakes).set({ s3AccessKey: null, s3SecretKey: null }).where(eq(tenantLakes.tenantId, tenant));
    await ensureTenantS3Account(tenant, null);

    await runQuery(await memberOf(tenant, 'analyst@oldlake.com', 'analyst'), 'SHOW TABLES');
    await ensureReadOnlyLakeAccess(tenant);
    const lake = (await lakeRow(tenant))!;
    expect(await errorOf(listObjects(roCreds(lake), lake.dataPath))).toBe('成功');
    expect(await errorOf(putObject(roCreds(lake), `${lake.dataPath}evil.txt`, 'x'))).toMatch(/HTTP 403/);
  });
});

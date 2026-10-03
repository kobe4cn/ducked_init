// 数据湖加密存储的流水线接缝：开通租户（初始化 catalog 时开启 DuckLake 加密）→ 同步 → 存储前缀下的数据文件不带密钥读不出来；
// 加密前开通、catalog 未加密的数据湖重新初始化不报错，照常同步
import { readFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { createCatalogSchema, initTenantCatalog, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { listLakeFiles } from '../../app/.server/lake-storage';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 登记电商库、确认 customers 按更新时间同步（其余表全量比对），同步一次 */
async function synced(tenantId: string) {
  const engineer = await memberOf(tenantId, 'de@acme.com');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return id;
}

/** 存储前缀下的 parquet 文件（完整路径） */
async function parquetFiles(tenantId: string) {
  const { dataPath } = (await lakeRow(tenantId))!;
  return (await listLakeFiles(dataPath)).filter(f => f.path.endsWith('.parquet')).map(f => `${dataPath}${f.path}`);
}

/** 不挂载数据湖、直接读 parquet 文件：返回读到的行数，读不出来时返回报错 */
async function readDirectly(file: string) {
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    const reader = await con.runAndReadAll(`SELECT count(*)::INT AS n FROM read_parquet('${file}')`);
    return reader.getRowObjectsJson()[0].n as number;
  } catch (e) {
    return (e as Error).message;
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

describe('数据湖加密存储', () => {
  it('新租户的原始层、主键状态与镜像的数据文件不带密钥读不出来，也不含明文；经数据湖照常读取', async () => {
    const acme = await newTenant('acme');
    const sourceId = await synced(acme);
    const bronze = bronzeSchema(sourceId);

    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    let email: string;
    try {
      const reader = await session.con.runAndReadAll(`SELECT count(*)::INT AS n, max(email) AS email FROM "${bronze}".customers`);
      const [row] = reader.getRowObjectsJson() as { n: number; email: string }[];
      expect(row.n).toBe(40);
      email = row.email;
    } finally {
      session.close();
    }

    const files = await parquetFiles(acme);
    for (const schema of [bronze, `${bronze}_keys`, `${bronze}_mirror`]) {
      expect(files.some(f => f.includes(`/${schema}/`))).toBe(true);
    }
    for (const file of files) {
      expect(await readDirectly(file)).toMatch(/encrypted/);
      expect((await readFile(file)).includes(email)).toBe(false);
    }
  });

  it('加密前开通的未加密数据湖重新初始化不报错，照常同步（文件仍是明文）', async () => {
    const acme = await newTenant('acme');
    const lake = (await lakeRow(acme))!;
    // 模拟加密上线前的数据湖：重建 catalog schema，用不带加密的 DuckLake 初始化元数据表
    await getDb().transaction(async tx => {
      await tx.execute(sql`DROP SCHEMA ${sql.identifier(lake.catalogSchema)} CASCADE`);
      await createCatalogSchema(tx, lake.catalogSchema, lake.dbRole);
    });
    (await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 256, threads: 1 })).close();

    await initTenantCatalog(acme, null);
    await synced(acme);
    const files = await parquetFiles(acme);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(typeof await readDirectly(file)).toBe('number');
  });
});

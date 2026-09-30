// app/.server/lake.ts —— 租户数据湖的开通（ADR-0001、0002、0008）：存储前缀、平台 PG 中独占的 catalog schema 与数据库角色。
// 工作进程只拿到 lakeSpecOf() 给出的本租户凭据，拿不到平台 PG 的连接串
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb, type Db } from './db/client';
import { tenantLakes } from './db/schema';
import { openTenantLake, type LakeSpec } from './pipeline/lake-engine';

type TenantLakeRow = typeof tenantLakes.$inferSelect;

/** 租户数据湖的根：对象存储（s3://bucket/prefix）或本地目录，默认 ./data/platform-lake */
function lakeRoot() {
  const root = (process.env.PLATFORM_LAKE_URI ?? './data/platform-lake').replace(/\/+$/, '');
  return root.startsWith('s3://') ? root : resolve(root);
}

const isS3 = (path: string) => path.startsWith('s3://');

/** 每个租户的存储前缀与 catalog schema、数据库角色都由租户 ID 决定 */
function layout(tenantId: string) {
  const root = lakeRoot();
  const name = `lake_${tenantId.replace(/-/g, '')}`;
  return {
    dataPath: isS3(root) ? `${root}/tenants/${tenantId}/` : `${join(root, 'tenants', tenantId)}/`,
    catalogSchema: name,
    dbRole: name,
  };
}

/**
 * 在开通租户的事务里建好 catalog schema 与只能访问它的数据库角色（DDL 随事务回滚）。
 * schema 归平台所有，只授予本租户角色使用与建表的权限；其他租户的角色没有 USAGE，连表名都看不到。
 * 要求 PostgreSQL 15 及以上：更早的版本默认允许所有角色在 public schema 建表，租户之间会多出一条互通的渠道
 */
export async function provisionTenantLake(tx: Tx, tenantId: string) {
  const { dataPath, catalogSchema, dbRole } = layout(tenantId);
  const dbPassword = randomBytes(24).toString('base64url');
  await tx.execute(sql.raw(`CREATE ROLE "${dbRole}" LOGIN PASSWORD '${dbPassword}'`));
  await tx.execute(sql.raw(`CREATE SCHEMA "${catalogSchema}"`));
  await tx.execute(sql.raw(`GRANT USAGE, CREATE ON SCHEMA "${catalogSchema}" TO "${dbRole}"`));
  await tx.insert(tenantLakes).values({ tenantId, dataPath, catalogSchema, dbRole, dbPassword });
}

/** 任务进程访问本租户数据湖所需的全部信息：只含本租户角色的凭据 */
export function lakeSpecOf(lake: Pick<TenantLakeRow, 'dataPath' | 'catalogSchema' | 'dbRole' | 'dbPassword'>): LakeSpec {
  const url = new URL(process.env.PLATFORM_DATABASE_URL ?? '');
  url.username = lake.dbRole;
  url.password = lake.dbPassword;
  const env = (k: string, d: string) => process.env[k] ?? d;
  return {
    dataPath: lake.dataPath,
    catalogUrl: url.toString(),
    catalogSchema: lake.catalogSchema,
    ...(isS3(lake.dataPath) && {
      s3: {
        endpoint: env('S3_ENDPOINT', 'localhost:8333'),
        region: env('S3_REGION', 'us-east-1'),
        key: env('S3_ACCESS_KEY', ''),
        secret: env('S3_SECRET_KEY', ''),
        urlStyle: env('S3_URL_STYLE', 'path'),
        useSsl: env('S3_USE_SSL', 'false') === 'true',
      },
    }),
  };
}

async function lakeRow(tenantId: string, db: Tx | Db = getDb()) {
  const [lake] = await db.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId));
  return lake;
}

/** 租户已有数据湖时返回其 catalog schema，否则 null（本功能上线前开通的租户） */
export async function tenantLakeExists(tx: Tx, tenantId: string) {
  return (await lakeRow(tenantId, tx))?.catalogSchema ?? null;
}

/**
 * 建好存储前缀并初始化 DuckLake catalog（首次挂载时建元数据表）。可重复执行：开通时初始化失败，运营者可以重试。
 * 用本租户的数据库角色挂载，初始化出的元数据表归该角色所有
 */
export async function initTenantCatalog(tenantId: string) {
  const lake = await lakeRow(tenantId);
  if (!lake) throw new Error(`租户 ${tenantId} 还没有数据湖`);
  if (!isS3(lake.dataPath)) await mkdir(lake.dataPath, { recursive: true });
  const session = await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 256, threads: 1 });
  session.close();
  await getDb().update(tenantLakes).set({ catalogInitializedAt: new Date() }).where(eq(tenantLakes.tenantId, tenantId));
}

/** 运营者可见的数据湖元数据（不含凭据）；还没有数据湖时返回 null */
export async function getTenantLake(tenantId: string) {
  const lake = await lakeRow(tenantId);
  if (!lake) return null;
  return { dataPath: lake.dataPath, catalogSchema: lake.catalogSchema, catalogInitialized: !!lake.catalogInitializedAt };
}

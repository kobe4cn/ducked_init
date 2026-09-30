// app/.server/lake.ts —— 租户数据湖的开通（ADR-0001、0002、0008）：存储前缀（对象存储上另有本租户的账号）、
// 平台 PG 中独占的 catalog schema 与数据库角色。工作进程只拿到 lakeSpecOf() 给出的本租户凭据，
// 拿不到平台 PG 的连接串，也拿不到对象存储的平台账号
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { desc, eq, sql } from 'drizzle-orm';
import { recordAudit, type OperatorActor, type Tx } from './audit';
import { getDb, type Db } from './db/client';
import { lakeMigrations, tenantLakes } from './db/schema';
import { isS3 } from './lake-storage';
import { openTenantLake, type LakeSpec } from './pipeline/lake-engine';
import { deleteTenantS3Account, issueTenantS3Account, platformS3, putPrefixPlaceholder, s3UserOf } from './s3-accounts';

type TenantLakeRow = typeof tenantLakes.$inferSelect;

/** 数据湖根的规范写法：对象存储（s3://bucket/prefix）原样去掉结尾的 /，本地目录转为绝对路径 */
export function normalizeLakeRoot(uri: string) {
  const root = uri.trim().replace(/\/+$/, '');
  return isS3(root) ? root : resolve(root);
}

/** 租户数据湖的根：PLATFORM_LAKE_URI，默认 ./data/platform-lake。只决定之后开通的租户放在哪里 */
const lakeRoot = () => normalizeLakeRoot(process.env.PLATFORM_LAKE_URI ?? './data/platform-lake');

/** 租户在某个数据湖根下的存储前缀：<根>/tenants/<租户 ID>/ */
export const tenantDataPath = (root: string, tenantId: string) =>
  isS3(root) ? `${root}/tenants/${tenantId}/` : `${join(root, 'tenants', tenantId)}/`;

/** 每个租户的存储前缀与 catalog schema、数据库角色都由租户 ID 决定 */
function layout(tenantId: string) {
  const name = `lake_${tenantId.replace(/-/g, '')}`;
  return { dataPath: tenantDataPath(lakeRoot(), tenantId), catalogSchema: name, dbRole: name };
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

/** 任务进程访问本租户数据湖所需的全部信息：只含本租户数据库角色与对象存储账号的凭据 */
export function lakeSpecOf(lake: Pick<TenantLakeRow, 'dataPath' | 'catalogSchema' | 'dbRole' | 'dbPassword' | 's3AccessKey' | 's3SecretKey'>): LakeSpec {
  const url = new URL(process.env.PLATFORM_DATABASE_URL ?? '');
  url.username = lake.dbRole;
  url.password = lake.dbPassword;
  if (isS3(lake.dataPath) && !(lake.s3AccessKey && lake.s3SecretKey)) throw new Error('租户在对象存储上还没有账号，请先初始化数据湖');
  return {
    dataPath: lake.dataPath,
    catalogUrl: url.toString(),
    catalogSchema: lake.catalogSchema,
    ...(isS3(lake.dataPath) && { s3: { ...platformS3(), key: lake.s3AccessKey!, secret: lake.s3SecretKey! } }),
  };
}

export async function lakeRow(tenantId: string, db: Tx | Db = getDb()) {
  const [lake] = await db.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId));
  return lake;
}

/** 租户已有数据湖时返回其 catalog schema，否则 null（本功能上线前开通的租户） */
export async function tenantLakeExists(tx: Tx, tenantId: string) {
  return (await lakeRow(tenantId, tx))?.catalogSchema ?? null;
}

/**
 * 存储前缀（默认为数据湖当前的前缀，迁移存储时为新前缀）在对象存储上、租户还没有账号时，在存储服务上建好账号与
 * 只能访问该前缀的策略，与审计记录一起保存密钥。锁住数据湖行，同一租户的并发初始化不会各自签发密钥、互相作废
 */
export async function ensureTenantS3Account(tenantId: string, operator: OperatorActor, prefix?: string) {
  return getDb().transaction(async tx => {
    const [lake] = await tx.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId)).for('update');
    if (!lake) throw new Error(`租户 ${tenantId} 还没有数据湖`);
    const dataPath = prefix ?? lake.dataPath;
    if (!isS3(dataPath) || lake.s3AccessKey) return;
    const { accessKey, secretKey } = await issueTenantS3Account(tenantId, dataPath);
    await tx.update(tenantLakes).set({ s3AccessKey: accessKey, s3SecretKey: secretKey }).where(eq(tenantLakes.tenantId, tenantId));
    await recordAudit(tx, {
      tenantId,
      operator,
      action: 'tenant.s3_account_created',
      targetType: 'tenant',
      targetId: tenantId,
      detail: { s3User: s3UserOf(tenantId), dataPath },
    });
  });
}

/** 删除租户在对象存储上的账号并清掉保存的密钥：数据湖迁离对象存储后，或迁往对象存储失败时收回为它新建的账号 */
export async function dropTenantS3Account(tenantId: string) {
  await deleteTenantS3Account(tenantId);
  await getDb().update(tenantLakes).set({ s3AccessKey: null, s3SecretKey: null }).where(eq(tenantLakes.tenantId, tenantId));
}

/**
 * 建好存储前缀（对象存储上先建好本租户的账号，再用它写入占位对象 .keep）并初始化 DuckLake catalog（首次挂载时建元数据表）。
 * 可重复执行：开通时初始化失败，或本功能上线前开通、还没有对象存储账号的租户，运营者可以重试补建。
 * 用本租户的数据库角色挂载，初始化出的元数据表归该角色所有。新建对象存储账号时记入审计，操作者为 operator
 */
export async function initTenantCatalog(tenantId: string, operator: OperatorActor) {
  await ensureTenantS3Account(tenantId, operator);
  const spec = lakeSpecOf((await lakeRow(tenantId))!);
  if (spec.s3) await putPrefixPlaceholder(spec.dataPath, spec.s3);
  else await mkdir(spec.dataPath, { recursive: true });
  const session = await openTenantLake(spec, { memoryLimitMb: 256, threads: 1 });
  session.close();
  await getDb().update(tenantLakes).set({ catalogInitializedAt: new Date() }).where(eq(tenantLakes.tenantId, tenantId));
}

/** 数据湖可以运行任务：catalog 已初始化，存储前缀在对象存储上时租户已有账号 */
export const lakeReady = (lake: TenantLakeRow) => !!lake.catalogInitializedAt && (!isS3(lake.dataPath) || !!lake.s3AccessKey);

/**
 * 运营者可见的数据湖元数据（不含凭据）；还没有数据湖时返回 null。s3User 在本地目录模式下为 null。
 * migration 是最近一次迁移存储（没有迁移过时为 null），状态为 pending / running 即「迁移中」
 */
export async function getTenantLake(tenantId: string) {
  const lake = await lakeRow(tenantId);
  if (!lake) return null;
  const [migration] = await getDb()
    .select({
      status: lakeMigrations.status,
      fromPath: lakeMigrations.fromPath,
      toPath: lakeMigrations.toPath,
      error: lakeMigrations.error,
      createdAt: lakeMigrations.createdAt,
      finishedAt: lakeMigrations.finishedAt,
    })
    .from(lakeMigrations)
    .where(eq(lakeMigrations.tenantId, tenantId))
    .orderBy(desc(lakeMigrations.createdAt))
    .limit(1);
  return {
    migration: migration ?? null,
    dataPath: lake.dataPath,
    catalogSchema: lake.catalogSchema,
    catalogInitialized: !!lake.catalogInitializedAt,
    s3User: isS3(lake.dataPath) ? { name: s3UserOf(tenantId), ready: !!lake.s3AccessKey } : null,
    ready: lakeReady(lake),
  };
}

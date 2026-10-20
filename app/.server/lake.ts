// app/.server/lake.ts —— 租户数据湖的开通（ADR-0001、0002、0008）：存储前缀（对象存储上另有本租户的账号）、
// 平台 PG 中独占的 catalog schema 与数据库角色。工作进程只拿到 lakeSpecOf() 给出的本租户凭据，
// 拿不到平台 PG 的连接串，也拿不到对象存储的平台账号。数据查询工作台另用 readOnlyLakeSpecOf() 给出的只读凭据（ADR-0036）
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { desc, eq, sql } from 'drizzle-orm';
import { recordAudit, type OperatorActor, type Tx } from './audit';
import { getDb, type Db } from './db/client';
import { lakeMigrations, tenantLakes } from './db/schema';
import { isS3 } from './lake-storage';
import { openTenantLake, type LakeSpec } from './pipeline/lake-engine';
import { ensureLakeSchemas } from './pipeline/lake-schemas';
import { deleteTenantS3Account, issueTenantReadOnlyS3Account, issueTenantS3Account, platformS3, putPrefixPlaceholder, s3UserOf } from './s3-accounts';

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

/** 租户的只读数据库角色：租户角色名加 _ro */
const readOnlyRoleOf = (dbRole: string) => `${dbRole}_ro`;
const newPassword = () => randomBytes(24).toString('base64url');

/**
 * 在开通租户的事务里建好 catalog schema、只能访问它的数据库角色与只读角色（DDL 随事务回滚）。
 * schema 归平台所有，只授予本租户角色使用与建表的权限；其他租户的角色没有 USAGE，连表名都看不到。
 * 要求 PostgreSQL 15 及以上：更早的版本默认允许所有角色在 public schema 建表，租户之间会多出一条互通的渠道
 */
export async function provisionTenantLake(tx: Tx, tenantId: string) {
  const { dataPath, catalogSchema, dbRole } = layout(tenantId);
  const dbPassword = newPassword();
  const roDbRole = readOnlyRoleOf(dbRole);
  const roDbPassword = newPassword();
  await tx.execute(sql.raw(`CREATE ROLE "${dbRole}" LOGIN PASSWORD '${dbPassword}'`));
  await loginRole(tx, roDbRole, roDbPassword);
  await createCatalogSchema(tx, catalogSchema, dbRole, roDbRole);
  await tx.insert(tenantLakes).values({ tenantId, dataPath, catalogSchema, dbRole, dbPassword, roDbRole, roDbPassword });
}

/**
 * 建好归平台所有的 catalog schema，只授予本租户角色使用与建表的权限（开通与重置数据湖时使用）；
 * 有只读角色时一并授予它只读（grantReadOnly）
 */
export async function createCatalogSchema(tx: Tx, catalogSchema: string, dbRole: string, roDbRole: string | null) {
  await tx.execute(sql`CREATE SCHEMA ${sql.identifier(catalogSchema)}`);
  await tx.execute(sql`GRANT USAGE, CREATE ON SCHEMA ${sql.identifier(catalogSchema)} TO ${sql.identifier(dbRole)}`);
  if (roDbRole) await grantReadOnly(tx, catalogSchema, dbRole, roDbRole);
}

/**
 * 建好可以登录的角色（默认不是超级用户，不属于任何角色）；已存在时只重设密码（记下凭据前中断留下的）。
 * 不写 NOSUPERUSER：PG 16 起只有超级用户能改这个属性，写了平台账号就 ALTER 不了
 */
async function loginRole(tx: Tx, role: string, password: string) {
  const { rows: [{ exists }] } = await tx.execute<{ exists: boolean }>(sql`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${role}) AS exists`);
  await tx.execute(sql.raw(`${exists ? 'ALTER' : 'CREATE'} ROLE "${role}" LOGIN PASSWORD '${password}'`));
}

/**
 * 只读角色对 catalog schema 只有 USAGE，对其中的表只有 SELECT：DuckLake 只读挂载要读全部元数据表（含加密密钥，ADR-0020）。
 * 元数据表归租户角色所有，以它的身份授予现有的表，并设好它之后建的表的默认权限。可重复执行
 */
async function grantReadOnly(tx: Tx, catalogSchema: string, dbRole: string, roDbRole: string) {
  const catalog = sql.identifier(catalogSchema);
  const ro = sql.identifier(roDbRole);
  await tx.execute(sql`GRANT USAGE ON SCHEMA ${catalog} TO ${ro}`);
  await asTenantRole(tx, dbRole, async () => {
    await tx.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA ${catalog} TO ${ro}`);
    await tx.execute(sql`ALTER DEFAULT PRIVILEGES IN SCHEMA ${catalog} GRANT SELECT ON TABLES TO ${ro}`);
  });
}

/**
 * 在事务里切换到租户的数据库角色执行 fn；平台账号不能 SET ROLE 到它时在本事务里临时授予、执行完即收回。
 * PG 16 起 CREATEROLE 账号对自己建的角色只有 ADMIN 成员关系、没有 SET 选项：临时加上 SET，之后只收回 SET，ADMIN 保留。
 * fn 出错时不收回，靠整个事务回滚撤销
 */
export async function asTenantRole<T>(tx: Tx, dbRole: string, fn: () => Promise<T>) {
  const role = sql.identifier(dbRole);
  const { rows: [{ pg16, member, me }] } = await tx.execute<{ pg16: boolean; member: boolean; me: string }>(sql`
    SELECT current_setting('server_version_num')::int >= 160000 AS pg16, pg_has_role(current_user, ${dbRole}, 'MEMBER') AS member, current_user::text AS me`);
  const canSet = pg16 ? (await tx.execute<{ s: boolean }>(sql`SELECT pg_has_role(current_user, ${dbRole}, 'SET') AS s`)).rows[0].s : member;
  if (!canSet) await tx.execute(pg16 ? sql`GRANT ${role} TO current_user WITH SET TRUE, INHERIT FALSE` : sql`GRANT ${role} TO current_user`);
  await tx.execute(sql`SET LOCAL ROLE ${role}`);
  const result = await fn();
  await tx.execute(sql`RESET ROLE`);
  if (!canSet) await tx.execute(member ? sql`REVOKE SET OPTION FOR ${role} FROM ${sql.identifier(me)}` : sql`REVOKE ${role} FROM ${sql.identifier(me)}`);
  return result;
}

/** 任务进程访问本租户数据湖所需的全部信息：只含本租户数据库角色与对象存储账号的凭据 */
export function lakeSpecOf(lake: Pick<TenantLakeRow, 'dataPath' | 'catalogSchema' | 'dbRole' | 'dbPassword' | 's3AccessKey' | 's3SecretKey'>): LakeSpec {
  if (isS3(lake.dataPath) && !(lake.s3AccessKey && lake.s3SecretKey)) throw new Error('租户在对象存储上还没有账号，请先初始化数据湖');
  return specOf(lake.dataPath, lake.catalogSchema, [lake.dbRole, lake.dbPassword], [lake.s3AccessKey, lake.s3SecretKey]);
}

type ReadOnlyCreds = Pick<TenantLakeRow, 'dataPath' | 'catalogSchema' | 'roDbRole' | 'roDbPassword' | 'roS3AccessKey' | 'roS3SecretKey'>;

/** 只读凭据已建好：有只读角色，存储前缀在对象存储上时还有只读账号 */
export const readOnlyAccessReady = (lake: ReadOnlyCreds) =>
  !!(lake.roDbRole && lake.roDbPassword) && (!isS3(lake.dataPath) || !!(lake.roS3AccessKey && lake.roS3SecretKey));

/** 同 lakeSpecOf，凭据换成只读角色与只读对象存储账号（数据查询工作台用，ADR-0036）；还没建好时抛错，先 ensureReadOnlyLakeAccess */
export function readOnlyLakeSpecOf(lake: ReadOnlyCreds): LakeSpec {
  if (!readOnlyAccessReady(lake)) throw new Error('租户的只读凭据还没有建好');
  return specOf(lake.dataPath, lake.catalogSchema, [lake.roDbRole!, lake.roDbPassword!], [lake.roS3AccessKey, lake.roS3SecretKey]);
}

function specOf(dataPath: string, catalogSchema: string, [user, password]: [string, string], [key, secret]: (string | null)[]): LakeSpec {
  const url = new URL(process.env.PLATFORM_DATABASE_URL ?? '');
  url.username = user;
  url.password = password;
  return {
    dataPath,
    catalogUrl: url.toString(),
    catalogSchema,
    ...(isS3(dataPath) && { s3: { ...platformS3(), key: key!, secret: secret! } }),
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

/**
 * 补建工作台用的只读凭据（缺的才建，可重复执行）：只读数据库角色，以及存储前缀在对象存储上时只能读、列出该前缀的账号。
 * 本功能上线前开通的租户在第一次执行工作台查询时补上。锁住数据湖行，并发补建不会各自签发密钥
 */
export async function ensureReadOnlyLakeAccess(tenantId: string) {
  await getDb().transaction(async tx => {
    const [lake] = await tx.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId)).for('update');
    if (!lake) throw new Error(`租户 ${tenantId} 还没有数据湖`);
    if (!(lake.roDbRole && lake.roDbPassword)) {
      const roDbRole = readOnlyRoleOf(lake.dbRole);
      const roDbPassword = newPassword();
      await loginRole(tx, roDbRole, roDbPassword);
      await grantReadOnly(tx, lake.catalogSchema, lake.dbRole, roDbRole);
      await tx.update(tenantLakes).set({ roDbRole, roDbPassword }).where(eq(tenantLakes.tenantId, tenantId));
    }
    if (isS3(lake.dataPath) && !(lake.roS3AccessKey && lake.roS3SecretKey)) {
      const { accessKey, secretKey } = await issueTenantReadOnlyS3Account(tenantId, lake.dataPath);
      await tx.update(tenantLakes).set({ roS3AccessKey: accessKey, roS3SecretKey: secretKey }).where(eq(tenantLakes.tenantId, tenantId));
    }
  });
}

/**
 * 删除租户在对象存储上的读写与只读账号并清掉保存的密钥：数据湖迁离对象存储后，或迁往对象存储失败时收回为它新建的账号
 */
export async function dropTenantS3Account(tenantId: string) {
  await deleteTenantS3Account(tenantId);
  await getDb().update(tenantLakes).set({ s3AccessKey: null, s3SecretKey: null, roS3AccessKey: null, roS3SecretKey: null })
    .where(eq(tenantLakes.tenantId, tenantId));
}

/**
 * 建好存储前缀（对象存储上先建好本租户的账号，再用它写入占位对象 .keep）并初始化 DuckLake catalog（首次挂载时建元数据表），
 * 再建好名字固定的 schema 与平台表（ensureLakeSchemas）。
 * catalog 还没有元数据表时以加密方式新建，此后写入的数据文件都加密（ADR-0020）；加密上线前建好的 catalog 保持不加密。
 * 可重复执行：开通时初始化失败，或本功能上线前开通、还没有对象存储账号的租户，运营者可以重试补建。
 * 用本租户的数据库角色挂载，初始化出的元数据表归该角色所有。新建对象存储账号时记入审计，操作者为 operator。
 * 工作台用的只读凭据也在这里补齐（ensureReadOnlyLakeAccess）
 */
export async function initTenantCatalog(tenantId: string, operator: OperatorActor) {
  await ensureTenantS3Account(tenantId, operator);
  await ensureReadOnlyLakeAccess(tenantId);
  const spec = lakeSpecOf((await lakeRow(tenantId))!);
  if (spec.s3) await putPrefixPlaceholder(spec.dataPath, spec.s3);
  else await mkdir(spec.dataPath, { recursive: true });
  const { rows: [{ initialized }] } = await getDb().execute<{ initialized: boolean }>(
    sql`SELECT to_regclass(${`${spec.catalogSchema}.ducklake_metadata`}) IS NOT NULL AS initialized`);
  const session = await openTenantLake(spec, { memoryLimitMb: 256, threads: 1 }, undefined, { encrypted: !initialized });
  try {
    await ensureLakeSchemas(session.con);
  } finally {
    session.close();
  }
  await getDb().update(tenantLakes).set({ catalogInitializedAt: new Date() }).where(eq(tenantLakes.tenantId, tenantId));
}

/** 给已初始化的数据湖补建名字固定的 schema 与平台表（pnpm lake:ensure）：初始化时还不建这些对象的时候开通的租户靠它补上 */
export async function ensureTenantLakeSchemas(tenantId: string) {
  const lake = await lakeRow(tenantId);
  if (!lake?.catalogInitializedAt) throw new Error('数据湖还没有初始化');
  const session = await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 256, threads: 1 });
  try {
    await ensureLakeSchemas(session.con);
  } finally {
    session.close();
  }
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

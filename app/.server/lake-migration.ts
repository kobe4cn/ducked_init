// app/.server/lake-migration.ts —— 租户数据湖迁移存储（本地目录 ⇄ 对象存储、换桶或换前缀）。
// 运营者用 pnpm lake:migrate 申请，调度器执行：等该租户运行中的任务结束 → 复制存储前缀下的全部文件 → 核对清单与大小 →
// 一个事务里切换 catalog（ducklake_metadata）与 tenant_lakes 的 data_path → 盘点比对。迁移中不派发该租户的任务。
// DuckLake catalog 里 schema、表与数据文件的路径都是相对 data_path 的，切换只需改这一处。旧位置的文件不自动删除
import { mkdir } from 'node:fs/promises';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { recordAudit, type OperatorActor, type Tx } from './audit';
import { getDb, type Db } from './db/client';
import { lakeMigrations, tenantLakes, tenants, type LakeInventory } from './db/schema';
import { dropTenantS3Account, ensureTenantS3Account, lakeReady, lakeRow, lakeSpecOf, normalizeLakeRoot, tenantDataPath } from './lake';
import { copyLakeFile, isS3, listLakeFiles, type LakeFile } from './lake-storage';
import { inventory } from './pipeline/handlers';
import { openTenantLake, redactLakeSecrets, type EngineLimits } from './pipeline/lake-engine';
import { putPrefixPlaceholder, setTenantS3Prefixes } from './s3-accounts';
import { lockClaims } from './tasks';
import { TenantError } from './tenants';

type LakeMigrationRow = typeof lakeMigrations.$inferSelect;

export const ACTIVE_MIGRATION = ['pending', 'running'] as const;

/**
 * 申请把租户的数据湖迁到 root 下（<root>/tenants/<租户 ID>/）。数据湖须已初始化；已在目标位置时拒绝，
 * 正在迁往同一位置时返回进行中的那次迁移（created 为 false），正在迁往别处时拒绝。
 * 申请即标记「迁移中」，记入租户的审计日志
 */
export async function requestLakeMigration(operator: OperatorActor, tenantId: string, root: string) {
  const toRoot = normalizeLakeRoot(root);
  return getDb().transaction(async tx => {
    // 锁住数据湖行：与同一租户的并发申请、切换互斥
    const [lake] = await tx.select().from(tenantLakes).where(eq(tenantLakes.tenantId, tenantId)).for('update');
    if (!lake) throw new TenantError('租户还没有数据湖');
    if (!lakeReady(lake)) throw new TenantError('数据湖未初始化，请先在运营后台初始化数据湖');
    const toPath = tenantDataPath(toRoot, tenantId);
    const [active] = await tx.select().from(lakeMigrations)
      .where(and(eq(lakeMigrations.tenantId, tenantId), inArray(lakeMigrations.status, ACTIVE_MIGRATION)));
    if (active?.toPath === toPath) return { migration: active, created: false };
    if (active) throw new TenantError(`数据湖正在迁移到 ${active.toPath}`);
    if (lake.dataPath === toPath) throw new TenantError(`数据湖已在 ${toPath}`);

    const [migration] = await tx.insert(lakeMigrations).values({ tenantId, fromPath: lake.dataPath, toPath }).returning();
    await audit(tx, operator, migration, 'tenant.lake_migration_started');
    return { migration, created: true };
  });
}

/** 把所有不在 root 下的租户迁过去；已在目标位置或正在迁往那里的跳过，可以重复执行。单个租户申请不了时记在 skipped 里 */
export async function requestLakeMigrations(operator: OperatorActor, root: string) {
  const toRoot = normalizeLakeRoot(root);
  const lakes = await getDb()
    .select({ tenantId: tenants.id, slug: tenants.slug, dataPath: tenantLakes.dataPath })
    .from(tenantLakes)
    .innerJoin(tenants, eq(tenants.id, tenantLakes.tenantId))
    .orderBy(asc(tenants.createdAt), asc(tenants.slug));
  const requested: { tenantId: string; slug: string; fromPath: string; toPath: string }[] = [];
  const skipped: { tenantId: string; slug: string; reason: string }[] = [];
  for (const { tenantId, slug, dataPath } of lakes) {
    if (dataPath === tenantDataPath(toRoot, tenantId)) continue;
    try {
      const { migration: m, created } = await requestLakeMigration(operator, tenantId, toRoot);
      if (created) requested.push({ tenantId, slug, fromPath: m.fromPath, toPath: m.toPath });
      else skipped.push({ tenantId, slug, reason: '已在迁移中' });
    } catch (e) {
      if (!(e instanceof TenantError)) throw e;
      skipped.push({ tenantId, slug, reason: e.message });
    }
  }
  return { requested, skipped };
}

export interface ClaimedMigration extends LakeMigrationRow { claim: string; limits: EngineLimits }

/**
 * 领取一个可以开始的迁移：申请中且该租户没有运行中的任务，或执行它的调度器已失联（超过 staleAfterMs 没有续期）。
 * 与领取任务共用一把锁：领到之后该租户不会再有任务被派发出去
 */
export async function claimLakeMigration(staleAfterMs = 60_000): Promise<ClaimedMigration | null> {
  return getDb().transaction(async tx => {
    await lockClaims(tx);
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT m.id FROM platform.lake_migrations m
      WHERE (m.status = 'pending'
             OR (m.status = 'running' AND m.heartbeat_at < now() - make_interval(secs => ${staleAfterMs / 1000})))
        AND NOT EXISTS (SELECT 1 FROM platform.tasks t WHERE t.tenant_id = m.tenant_id AND t.status = 'running')
      ORDER BY m.created_at
      LIMIT 1`);
    if (!rows.length) return null;
    const [m] = await tx
      .update(lakeMigrations)
      .set({ status: 'running', claim: sql`gen_random_uuid()`, heartbeatAt: sql`now()`, startedAt: sql`coalesce(${lakeMigrations.startedAt}, now())` })
      .where(eq(lakeMigrations.id, rows[0].id))
      .returning();
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, m.tenantId));
    return { ...m, claim: m.claim!, limits: { memoryLimitMb: tenant.memoryLimitMb, threads: tenant.threads } };
  });
}

/** 调度器为自己执行的迁移续期；返回已不归自己的（被失联判定后由其他调度器重新领取） */
export async function heartbeatLakeMigrations(claims: string[]) {
  if (!claims.length) return [];
  const alive = await getDb()
    .update(lakeMigrations)
    .set({ heartbeatAt: sql`now()` })
    .where(and(inArray(lakeMigrations.claim, claims), eq(lakeMigrations.status, 'running')))
    .returning({ claim: lakeMigrations.claim });
  return claims.filter(c => !alive.some(a => a.claim === c));
}

class LostClaim extends Error {
  constructor() { super('迁移已由其他调度器接手'); }
}

/** 同时复制的文件数 */
const COPY_CONCURRENCY = 4;

/**
 * 执行一次迁移。复制与核对期间数据湖仍指向旧位置；切换之后盘点不一致时切回旧位置。
 * 出错时记为失败并写入审计：数据湖仍指向旧位置，可以重新申请，新位置上已复制的文件下次覆盖。
 * signal 中止表示迁移已被其他调度器接手（本调度器续期失败），就此放弃、不再写库
 */
export async function runLakeMigration(m: ClaimedMigration, signal?: AbortSignal) {
  let switched = false;
  let result = m.result;
  try {
    let inventoryBefore = m.inventory;
    const lake = (await lakeRow(m.tenantId))!;
    if (lake.dataPath === m.fromPath) {
      inventoryBefore ??= await lakeInventory(m.tenantId, m.limits);
      await updateIfClaimed(m, { inventory: inventoryBefore });
      await grantS3Access(m);
      // 与开通时一样先建好新前缀：还没有数据时本地目录也在，对象存储上用租户自己的账号写入占位对象（顺带确认它能写新前缀）
      if (isS3(m.toPath)) await putPrefixPlaceholder(m.toPath, lakeSpecOf({ ...(await lakeRow(m.tenantId))!, dataPath: m.toPath }).s3!);
      else await mkdir(m.toPath, { recursive: true });
      result = await copyAndVerify(m.fromPath, m.toPath, signal);
      await updateIfClaimed(m, { result });
      await switchDataPath(m, m.fromPath, m.toPath);
    } else if (lake.dataPath !== m.toPath) {
      throw new Error(`数据湖当前位置 ${lake.dataPath} 既不是迁移的起点也不是终点`);
    }
    // 上一个执行者切换后失联时，接手的调度器从这里继续
    switched = true;

    const after = await lakeInventory(m.tenantId, m.limits);
    if (summarize(after) !== summarize(inventoryBefore!)) {
      throw new Error(`迁移后的盘点与迁移前不一致：迁移前 ${summarize(inventoryBefore!)}，迁移后 ${summarize(after)}`);
    }
    // 收回租户账号对旧前缀的访问：迁往对象存储时策略只留新前缀，迁离对象存储时删掉账号。失败不影响迁移结果，写进审计提醒运营者
    const revoke = isS3(m.toPath) ? () => setTenantS3Prefixes(m.tenantId, [m.toPath]) : isS3(m.fromPath) ? () => dropTenantS3Account(m.tenantId) : null;
    const warning = await revoke?.().then(() => undefined, e => {
      console.error(`[数据湖迁移] 租户 ${m.tenantId} 的对象存储账号收回旧前缀失败`, e);
      return `租户的对象存储账号仍可访问旧前缀 ${m.fromPath}（${(e as Error).message}），重新初始化数据湖可以收回`;
    });
    await finish(m, 'succeeded', null, { ...result!, ...(warning && { warning }) });
  } catch (e) {
    if (e instanceof LostClaim) return;
    console.error(`[数据湖迁移失败] 租户 ${m.tenantId}：${m.fromPath} → ${m.toPath}`, e);
    try {
      if (switched) await switchDataPath(m, m.toPath, m.fromPath);
      // 租户账号回到只能访问旧前缀；本地目录上的租户为这次迁移新建的账号删掉
      if (isS3(m.fromPath)) await setTenantS3Prefixes(m.tenantId, [m.fromPath]);
      else if (isS3(m.toPath)) await dropTenantS3Account(m.tenantId);
      await finish(m, 'failed', redactLakeSecrets((e as Error).message, lakeSpecOf((await lakeRow(m.tenantId))!)), result);
    } catch (e2) {
      // 切不回去或记录不了结果：迁移停在执行中，调度器失联判定后由其他调度器重新领取
      if (!(e2 instanceof LostClaim)) console.error(`[数据湖迁移] 租户 ${m.tenantId} 的失败处理出错，稍后由调度器重试`, e2);
    }
  }
}

const summarize = (inv: LakeInventory) => inv.map(t => `${t.name} ${t.rows} 行`).join('，') || '（没有表）';

/** 本租户数据湖的全部表与行数，用本租户的凭据挂载 */
async function lakeInventory(tenantId: string, limits: EngineLimits): Promise<LakeInventory> {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), limits);
  try {
    return await inventory(session.con);
  } finally {
    session.close();
  }
}

/** 迁往对象存储：租户要有账号，切换前后能同时访问新旧两个前缀（都是本租户的），工作进程在切换后才用新前缀 */
async function grantS3Access(m: ClaimedMigration) {
  if (!isS3(m.toPath)) return;
  await ensureTenantS3Account(m.tenantId, null, m.toPath);
  await setTenantS3Prefixes(m.tenantId, [m.fromPath, m.toPath].filter(isS3));
}

/** 复制旧前缀下的全部文件到新前缀，再核对新前缀上每个文件都在、大小一致（新前缀上多出的残留文件不影响） */
async function copyAndVerify(from: string, to: string, signal?: AbortSignal) {
  const files = await listLakeFiles(from);
  const queue = [...files];
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (signal?.aborted) throw new LostClaim();
      await copyLakeFile(from, to, f);
    }
  }));
  const copied = new Map((await listLakeFiles(to)).map(f => [f.path, f.size]));
  const bad = files.filter((f: LakeFile) => copied.get(f.path) !== f.size);
  if (bad.length) {
    throw new Error(`核对失败：新位置有 ${bad.length} 个文件缺失或大小不一致，如 ${bad.slice(0, 3).map(f => f.path).join('、')}`);
  }
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** 迁移仍归本调度器时更新它，否则抛出 LostClaim */
async function updateIfClaimed(m: ClaimedMigration, set: PgUpdateSetSource<typeof lakeMigrations>, tx: Tx | Db = getDb()) {
  const rows = await tx.update(lakeMigrations).set({ ...set, heartbeatAt: sql`now()` })
    .where(and(eq(lakeMigrations.id, m.id), eq(lakeMigrations.claim, m.claim), eq(lakeMigrations.status, 'running')))
    .returning({ id: lakeMigrations.id });
  if (!rows.length) throw new LostClaim();
}

/**
 * 一个事务里把 catalog 与 tenant_lakes 的 data_path 从 from 改为 to，不会只切一半。
 * catalog 的元数据表归租户的数据库角色所有，改它时切换到该角色；平台账号不是其成员时在本事务里临时加入、改完即收回
 */
async function switchDataPath(m: ClaimedMigration, from: string, to: string) {
  await getDb().transaction(async tx => {
    await updateIfClaimed(m, {}, tx);
    const [lake] = await tx.select().from(tenantLakes).where(eq(tenantLakes.tenantId, m.tenantId)).for('update');
    if (lake.dataPath !== from) throw new Error(`数据湖当前位置 ${lake.dataPath} 不是 ${from}`);
    const role = sql.identifier(lake.dbRole);
    const catalog = sql.identifier(lake.catalogSchema);
    const { rows: [{ member }] } = await tx.execute<{ member: boolean }>(sql`SELECT pg_has_role(current_user, ${lake.dbRole}, 'MEMBER') AS member`);
    if (!member) await tx.execute(sql`GRANT ${role} TO current_user`);
    const platformRole = sql.identifier((await tx.execute<{ u: string }>(sql`SELECT current_user AS u`)).rows[0].u);
    await tx.execute(sql`SET LOCAL ROLE ${role}`);
    // 用绝对路径登记的文件（如 ducklake_add_data_files 加入的）不随前缀搬走，不能迁移
    const { rows: [{ absolute }] } = await tx.execute<{ absolute: number }>(sql`
      SELECT ((SELECT count(*) FROM ${catalog}.ducklake_data_file WHERE NOT path_is_relative)
            + (SELECT count(*) FROM ${catalog}.ducklake_delete_file WHERE NOT path_is_relative))::int AS absolute`);
    if (absolute) throw new Error(`catalog 里有 ${absolute} 个以绝对路径登记的文件，不能迁移`);
    const updated = await tx.execute(sql`
      UPDATE ${catalog}.ducklake_metadata SET value = ${to} WHERE key = 'data_path' AND scope IS NULL AND value = ${from}`);
    if (updated.rowCount !== 1) throw new Error(`catalog 里的 data_path 不是 ${from}`);
    await tx.execute(sql`RESET ROLE`);
    if (!member) await tx.execute(sql`REVOKE ${role} FROM ${platformRole}`);
    await tx.update(tenantLakes).set({ dataPath: to }).where(eq(tenantLakes.tenantId, m.tenantId));
  });
}

async function finish(m: ClaimedMigration, status: 'succeeded' | 'failed', error: string | null, result: LakeMigrationRow['result']) {
  await getDb().transaction(async tx => {
    await updateIfClaimed(m, { status, error, result, finishedAt: sql`now()` }, tx);
    const [done] = await tx.select().from(lakeMigrations).where(eq(lakeMigrations.id, m.id));
    await audit(tx, null, done, status === 'succeeded' ? 'tenant.lake_migrated' : 'tenant.lake_migration_failed');
  });
}

function audit(tx: Tx, operator: OperatorActor, m: LakeMigrationRow, action: 'tenant.lake_migration_started' | 'tenant.lake_migrated' | 'tenant.lake_migration_failed') {
  return recordAudit(tx, {
    tenantId: m.tenantId,
    operator,
    action,
    targetType: 'tenant',
    targetId: m.tenantId,
    detail: { from: m.fromPath, to: m.toPath, ...m.result, ...(m.error && { error: m.error }) },
  });
}

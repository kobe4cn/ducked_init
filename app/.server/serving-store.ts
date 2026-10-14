// app/.server/serving-store.ts —— 服务库的重建与指针切换（ADR-0033）：新快照登记后、快照标记过期后，调度器为租户入队一次 serving.build，
// 参数里放各已发布定义（RFM 与仍有已发布版本的指标、标签）最新、未过期的快照；任务成功后才把指针 serving_stores 切到新版本，
// 再删掉 _serving/ 下除新版与上一版以外的旧文件。版本号只增不减，同一租户两个 serving.build 不会写同一个文件，
// 先完成的新版本之后完成的旧版本不再生效。一律限定在给定租户内
import { rm } from 'node:fs/promises';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { dslDefinitions, dslVersions, servingStores, snapshots, tasks, type ServingStoreSnapshot } from './db/schema';
import { lakeReady, lakeRow } from './lake';
import { isS3, listLakeFiles } from './lake-storage';
import { lockTenant } from './mappings';
import { SERVING_DIR } from './pipeline/lake-engine';
import { servingPath } from './pipeline/serving-engine';
import { platformS3 } from './s3-accounts';
import { deleteObject } from './s3-client';
import { insertTask } from './tasks';

export type ServingStore = typeof servingStores.$inferSelect;

/** 本租户当前生效的服务库指针；还没有任何版本时为 null */
export async function currentServingStore(tenantId: string): Promise<ServingStore | null> {
  const [row] = await getDb().select().from(servingStores).where(eq(servingStores.tenantId, tenantId));
  return row ?? null;
}

/**
 * 为租户入队一次 serving.build：每个模板最新、未过期的快照（指标、标签只取定义仍有已发布版本的），
 * 版本号取指针与本租户所有 serving.build 用过的版本号中最大的再加一。数据湖没有初始化时跳过；
 * 已有排队中的 serving.build 时不另入队，改用现在的快照改写它的参数（入队后又登记或过期的快照也算进去）。
 * 先锁租户行，多个调度器同时入队也不会重复。返回新入队的任务，没有新入队时为 null
 */
export async function enqueueServingBuild(tenantId: string) {
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) return null;
  return getDb().transaction(async tx => {
    await lockTenant(tx, tenantId);
    const picked = await servingSnapshots(tx, tenantId);
    const ofBuilds = and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'serving.build'));
    // 只改仍在排队的：已被领取的任务按原参数运行，这里另入队一个
    const [refreshed] = await tx.update(tasks).set({ params: sql`${tasks.params} || jsonb_build_object('snapshots', ${JSON.stringify(picked)}::jsonb)` })
      .where(and(ofBuilds, eq(tasks.status, 'queued'))).returning({ id: tasks.id });
    if (refreshed) return null;

    const [{ used }] = await tx.select({ used: sql<number>`coalesce(max((${tasks.params}->>'version')::int), 0)` }).from(tasks).where(ofBuilds);
    const [pointer] = await tx.select({ version: servingStores.version }).from(servingStores).where(eq(servingStores.tenantId, tenantId));
    const version = Math.max(used, pointer?.version ?? 0) + 1;
    return insertTask(tx, tenantId, 'serving.build', { version, target: servingPath(lake.dataPath, version), snapshots: picked });
  });
}

/** 要放进服务库的快照（serving.build 的参数 snapshots）：每个模板最新、未过期的一张，指标、标签只取定义仍有已发布版本的，按模板排序 */
async function servingSnapshots(tx: Tx, tenantId: string): Promise<(ServingStoreSnapshot & { table: string })[]> {
  const published = new Set((await tx.selectDistinct({ kind: dslDefinitions.kind, key: dslDefinitions.key }).from(dslDefinitions)
    .innerJoin(dslVersions, and(eq(dslVersions.definitionId, dslDefinitions.id), eq(dslVersions.status, 'published')))
    .where(eq(dslDefinitions.tenantId, tenantId))).map(d => `${d.kind}:${d.key}`));
  // 每个模板最新的一张：按登记时间倒序，取每个模板第一次出现的
  const live = await tx.select().from(snapshots)
    .where(and(eq(snapshots.tenantId, tenantId), isNull(snapshots.expiredAt), gt(snapshots.expiresAt, new Date())))
    .orderBy(desc(snapshots.createdAt), desc(snapshots.id));
  const latest = new Map<string, typeof live[number]>();
  for (const s of live) if (!latest.has(s.template)) latest.set(s.template, s);
  return [...latest.values()]
    .filter(s => s.template === 'rfm' || published.has(s.template))
    .sort((a, b) => a.template.localeCompare(b.template))
    .map(s => ({
      id: s.id, template: s.template, table: s.table, definitionVersion: s.definitionVersion,
      createdAt: s.createdAt.toISOString(), incomplete: !!s.incomplete,
    }));
}

/**
 * serving.build 成功后把指针切到它生成的版本（只接受比当前指针大的版本），再删掉 _serving/ 下比新版旧、又不是上一版的文件。
 * 任务没有成功或版本不比当前指针新时什么也不做
 */
export async function activateServingStore(tenantId: string, taskId: string) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params, result: tasks.result, finishedAt: tasks.finishedAt }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId), eq(tasks.kind, 'serving.build')));
  if (task?.status !== 'succeeded' || !task.result) return;
  const { version, path } = task.result as { version: number; path: string };
  const stored = (task.params.snapshots as (ServingStoreSnapshot & { table: string })[])
    .map(({ id, template, definitionVersion, createdAt, incomplete }) => ({ id, template, definitionVersion, createdAt, incomplete }));
  const previous = await db.transaction(async tx => {
    // 锁租户行而不是指针行：第一版之前指针行还不存在，两个同时完成的任务锁不住它
    await lockTenant(tx, tenantId);
    const [current] = await tx.select({ version: servingStores.version }).from(servingStores).where(eq(servingStores.tenantId, tenantId));
    if (current && current.version >= version) return null;
    const row = { version, path, snapshots: stored, builtAt: task.finishedAt ?? new Date() };
    await tx.insert(servingStores).values({ tenantId, ...row }).onConflictDoUpdate({ target: servingStores.tenantId, set: row });
    return { version: current?.version ?? 0 };
  });
  if (!previous) return;
  await pruneServingFiles(tenantId, version, previous.version);
}

/** 删掉本租户 _serving/ 下版本号小于 version、又不是 keep（上一版）的服务库文件（正在生成的更新版本不碰） */
async function pruneServingFiles(tenantId: string, version: number, keep: number) {
  const lake = await lakeRow(tenantId);
  if (!lake) return;
  const dir = `${lake.dataPath}${SERVING_DIR}`;
  const stale = (await listLakeFiles(dir)).flatMap(f => {
    const v = Number(/^v(\d+)\.duckdb$/.exec(f.path)?.[1]);
    return v && v < version && v !== keep ? [dir + f.path] : [];
  });
  for (const file of stale) await (isS3(file) ? deleteObject(platformS3(), file) : rm(file, { force: true }));
}

// app/.server/catalog/projection.ts —— 目录的检索投影（ADR-0047，部分修订 ADR-0041）：每个条目在每个可见性类别下参与检索的文字、别名、主题与所属空间。
// 投影是派生数据：deriveProjection 是纯函数，从已裁剪的目录生成行，能从零重建（rebuildProjection），也能按 catalogChangesSince 的净差异增量刷新（refreshProjection）。
// 可见性类别只由服务端按角色算（visibilityClass），任何对外接口都不收这个参数；restricted 里没有数据源、源表与映射血缘（ADR-0005）。
// 净差异不超过 PROJECTION_SYNC_LIMIT 时在请求里同步刷新，超过时入队 catalog.projection，由调度器结束钩子从零重建；所有行带同一个目录版本号，增量刷新与从零重建得到的投影完全相同。
// rankedSearch 在投影上排序（rank）；投影不可用时回退到旧 search()，P2 不设租户开关，靠这个回退兜底
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import { can } from '../access';
import type { Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogProjection, tasks, type Role } from '../db/schema';
import { insertTask } from '../tasks';
import { haystack, search, type Catalog, type CatalogEntry } from './index';
import { tenantCatalog } from './load';
import { rank, type Ranked, type RankScope } from './rank';
import { catalogChangesSince, stripStats } from './versions';

/** 请求里同步刷新的净差异条目数上限，超过时交给调度器任务 */
export const PROJECTION_SYNC_LIMIT = 200;

export const PROJECTION_CLASSES = ['full', 'restricted'] as const;
export type ProjectionClass = typeof PROJECTION_CLASSES[number];

/** 投影的一行（不含租户、类别与版本号） */
export type ProjectionRow = Omit<typeof catalogProjection.$inferSelect, 'tenantId' | 'visibilityClass' | 'catalogVersion'>;

/** 成员角色对应的可见性类别：有 sources:read 是 full，否则 restricted */
export const visibilityClass = (role: Role): ProjectionClass => can(role, 'sources:read') ? 'full' : 'restricted';

/** 按可见性类别裁剪目录：restricted 去掉数据源与源表条目，字段不带来源、实体不列映射到它的源表与合并组 */
export function visibleCatalog(c: Catalog, cls: ProjectionClass): Catalog {
  if (cls === 'full') return c;
  const entries = c.entries.flatMap((e): CatalogEntry[] => {
    switch (e.kind) {
      case 'source':
      case 'table':
        return [];
      case 'field':
        return [{ ...e, lineage: [] }];
      case 'entity':
        return [{ ...e, tables: [], unscoped: [], mergeGroups: [] }];
      default:
        return [e];
    }
  });
  return { ...c, entries };
}

/** 从目录派生某一类别的投影行：先去掉统计再裁剪，每个条目一行，按 entryId 排序 */
export function deriveProjection(c: Catalog, cls: ProjectionClass): ProjectionRow[] {
  return visibleCatalog({ entries: stripStats(c) }, cls).entries
    .map(e => {
      const text = haystack(e);
      return {
        entryId: e.id, text, textHash: createHash('sha256').update(text).digest('hex'),
        aliases: 'knowledge' in e ? e.knowledge?.aliases ?? [] : [],
        subjects: 'knowledge' in e ? e.knowledge?.subjects ?? [] : [],
        spaceId: 'spaceId' in e ? e.spaceId : null,
      };
    })
    .sort((a, b) => cmp(a.entryId, b.entryId));
}

/** 投影版本：该租户投影行的最大目录版本号；还没有投影时为 null（能力条目一直在，投影不会是空的） */
export async function projectionVersion(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<number | null> {
  const [row] = await db.select({ v: max(catalogProjection.catalogVersion) }).from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
  return row?.v ?? null;
}

const lock = (tx: Tx, tenantId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalog_projection:${tenantId}`}, 0))`);

/** 两类投影里 entryId 在 ids 里的行（ids 省略时全部），带上租户与版本号 */
function rowsOf(c: Catalog, tenantId: string, ids?: Set<string>) {
  return PROJECTION_CLASSES.flatMap(cls => deriveProjection(c, cls)
    .filter(r => !ids || ids.has(r.entryId))
    .map(r => ({ ...r, tenantId, visibilityClass: cls, catalogVersion: c.version ?? 0 })));
}

/**
 * 在已拿锁的事务里把投影从版本 now 刷到目录 c：now 为 null（还没有投影）时删掉全部行、插入两类；
 * 否则按 now 到当前的净差异只重写变了的条目，再把所有行的版本号改成 c 的版本。
 * 传了 syncLimit 时（从零重建除外）：同租户已有排队中或运行中的 catalog.projection 就不动投影；净差异条目数超过它时只入队一个，返回 queued。
 * 只供 refreshProjection、rebuildProjection 与测试用
 */
export async function refreshFrom(tx: Tx, tenantId: string, now: number | null, c: Catalog, opts: { syncLimit?: number } = {}): Promise<'refreshed' | 'queued'> {
  if (now === null) {
    await tx.delete(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
    const rows = rowsOf(c, tenantId);
    if (rows.length) await tx.insert(catalogProjection).values(rows);
    return 'refreshed';
  }
  const { syncLimit } = opts;
  if (syncLimit !== undefined) {
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.projection'), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (pending) return 'queued';
  }
  const { net } = await catalogChangesSince(tx, tenantId, now);
  const ids = new Set([...net.added, ...net.changed, ...net.removed].map(x => x.id));
  if (syncLimit !== undefined && ids.size > syncLimit) {
    await insertTask(tx, tenantId, 'catalog.projection');
    return 'queued';
  }
  if (ids.size) {
    await tx.delete(catalogProjection).where(and(eq(catalogProjection.tenantId, tenantId), inArray(catalogProjection.entryId, [...ids])));
    const rows = rowsOf(c, tenantId, ids);
    if (rows.length) await tx.insert(catalogProjection).values(rows);
  }
  await tx.update(catalogProjection).set({ catalogVersion: c.version ?? 0 }).where(eq(catalogProjection.tenantId, tenantId));
  return 'refreshed';
}

/** 从零重建：按当前目录删掉该租户的全部投影行、重新插入两类 */
export async function rebuildProjection(tenantId: string): Promise<void> {
  const c = await tenantCatalog(tenantId);
  await getDb().transaction(async tx => {
    await lock(tx, tenantId);
    await refreshFrom(tx, tenantId, null, c);
  });
}

/**
 * 把投影刷到当前目录版本：已是最新返回 fresh；否则在锁里重读投影版本，按它刷新（还没有投影时从零重建）。
 * 版本号用 tenantCatalog 返回的那个（目录只会比它新，下一轮会收敛）。净差异超过 syncLimit 或已有刷新任务时返回 queued（见 refreshFrom）
 */
export async function refreshProjection(tenantId: string, { syncLimit = PROJECTION_SYNC_LIMIT }: { syncLimit?: number } = {}): Promise<'fresh' | 'refreshed' | 'queued'> {
  const db = getDb();
  const v = await projectionVersion(db, tenantId);
  const c = await tenantCatalog(tenantId);
  if (v === (c.version ?? 0)) return 'fresh';
  return db.transaction(async tx => {
    await lock(tx, tenantId);
    const now = await projectionVersion(tx, tenantId);
    if (now !== null && now >= (c.version ?? 0)) return 'refreshed';
    return refreshFrom(tx, tenantId, now, c, { syncLimit });
  });
}

/** 读某一类别的投影：行（不含租户、类别与版本号，按 entryId 排序）与行的最大目录版本号（没有行时为 null） */
export async function readProjection(db: Tx | ReturnType<typeof getDb>, tenantId: string, cls: ProjectionClass): Promise<{ version: number | null; rows: ProjectionRow[] }> {
  const p = catalogProjection;
  const found = await db.select({ entryId: p.entryId, text: p.text, textHash: p.textHash, aliases: p.aliases, subjects: p.subjects, spaceId: p.spaceId, catalogVersion: p.catalogVersion })
    .from(p).where(and(eq(p.tenantId, tenantId), eq(p.visibilityClass, cls))).orderBy(asc(p.entryId));
  const version = found.length ? Math.max(...found.map(r => r.catalogVersion)) : null;
  return { version, rows: found.map(({ catalogVersion: _, ...row }) => row) };
}

/**
 * 在持久投影上排序（rank）：先把投影刷到最新，再读 cls 类的行，按调用方的可见目录 c 排序。
 * 投影不可用时回退到旧 search()、理由为空、fallback 为 true：刷新抛错、刷新交给了调度器（queued）、投影版本不等于 c 的版本、读投影或排序抛错（ADR-0047）
 */
export async function rankedSearch(tenantId: string, cls: ProjectionClass, c: Catalog, query: string, scope: RankScope, limit = 20): Promise<{ ranked: Ranked[]; fallback: boolean }> {
  try {
    if (await refreshProjection(tenantId) !== 'queued') {
      const { version, rows } = await readProjection(getDb(), tenantId, cls);
      if (version === (c.version ?? 0)) return { ranked: rank(rows, c, query, scope, limit), fallback: false };
    }
  } catch (e) {
    console.warn('检索投影不可用，回退到实时目录搜索', tenantId, e);
  }
  return { ranked: search(c, query, limit).map(entry => ({ entry, score: 0, reasons: [] })), fallback: true };
}

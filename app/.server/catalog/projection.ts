// app/.server/catalog/projection.ts —— 目录的检索投影（ADR-0047，部分修订 ADR-0041）：每个条目在每个可见性类别下参与检索的文字、别名、主题与所属空间。
// 投影是派生数据：deriveProjection 是纯函数，从已裁剪的目录生成行，能从零重建（rebuildProjection），也能按 catalogChangesSince 的净差异增量刷新（refreshProjection）。
// 可见性类别只由服务端按角色算（visibilityClass），任何对外接口都不收这个参数；restricted 里没有数据源、源表与映射血缘（ADR-0005）。
// 本片总在请求里同步刷新；所有行带同一个目录版本号，增量刷新与从零重建得到的投影完全相同
import { createHash } from 'node:crypto';
import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { cmp } from '../../lib/compare';
import { can } from '../access';
import type { Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogProjection, type Role } from '../db/schema';
import { haystack, type Catalog, type CatalogEntry } from './index';
import { tenantCatalog } from './load';
import { catalogChangesSince, stripStats } from './versions';

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

/** 从零重建：按当前目录删掉该租户的全部投影行、重新插入两类 */
export async function rebuildProjection(tenantId: string): Promise<void> {
  const c = await tenantCatalog(tenantId);
  await getDb().transaction(async tx => {
    await lock(tx, tenantId);
    await tx.delete(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
    const rows = rowsOf(c, tenantId);
    if (rows.length) await tx.insert(catalogProjection).values(rows);
  });
}

/**
 * 把投影刷到当前目录版本：已是最新返回 fresh；还没有投影时从零重建；否则按投影版本到当前的净差异只重写变了的条目，
 * 再把所有行的版本号改成当前版本。版本号用 tenantCatalog 返回的那个（目录只会比它新，下一轮会收敛）
 */
export async function refreshProjection(tenantId: string): Promise<'fresh' | 'refreshed'> {
  const db = getDb();
  const v = await projectionVersion(db, tenantId);
  const c = await tenantCatalog(tenantId);
  if (v === (c.version ?? 0)) return 'fresh';
  if (v === null) {
    await rebuildProjection(tenantId);
    return 'refreshed';
  }
  const { net } = await catalogChangesSince(db, tenantId, v);
  const ids = new Set([...net.added, ...net.changed, ...net.removed].map(x => x.id));
  await db.transaction(async tx => {
    await lock(tx, tenantId);
    const now = await projectionVersion(tx, tenantId);
    if (now !== null && now >= (c.version ?? 0)) return;
    if (ids.size) {
      await tx.delete(catalogProjection).where(and(eq(catalogProjection.tenantId, tenantId), inArray(catalogProjection.entryId, [...ids])));
      const rows = rowsOf(c, tenantId, ids);
      if (rows.length) await tx.insert(catalogProjection).values(rows);
    }
    await tx.update(catalogProjection).set({ catalogVersion: c.version ?? 0 }).where(eq(catalogProjection.tenantId, tenantId));
  });
  return 'refreshed';
}

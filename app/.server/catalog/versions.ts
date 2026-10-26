// app/.server/catalog/versions.ts —— 语义目录的版本（ADR-0041）：目录的结构或含义变了才记一版，比较前去掉统计，只改统计不产生版本。
// 版本由 recordAudit 在白名单动作的同一事务里触发：重新生成目录、去掉统计，和上一版的快照按条目标识比较，有差异才记新版本
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AuditAction, Tx } from '../audit';
import type { getDb } from '../db/client';
import { catalogVersions } from '../db/schema';
import { buildCatalog, type Catalog, type CatalogEntry } from './index';
import { loadCatalogInput } from './load';

/** 会改变目录结构或含义的审计动作；只发起停用（mapping.disable_requested）目录不变，不在里面 */
export const CATALOG_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'mapping.published', 'mapping.disabled', 'mapping.restored',
  'custom_entity.published', 'custom_entity.deleted',
  'merge_group.published', 'source_view.published',
  'source.scope_changed', 'source.registered', 'source.updated',
  'definition.published', 'definition.deleted',
  'template.published', 'template.auto_enabled',
  'business_note.updated',
]);

export interface DiffItem { id: string; kind: CatalogEntry['kind']; name: string }

/** 两版目录按条目标识比出的差异；changed 的 keys 是变了的顶层键 */
export interface CatalogDiff { added: DiffItem[]; removed: DiffItem[]; changed: (DiffItem & { keys: string[] })[] }

/** 去掉统计后的条目：源表与实体的统计、字段来源的源端样本、模板的快照；指标、标签与模板的 version 是定义的版本，保留 */
export function stripStats(c: Catalog): CatalogEntry[] {
  return c.entries.map(e => {
    switch (e.kind) {
      case 'table':
      case 'entity':
        return { ...e, stats: null };
      case 'field':
        return { ...e, lineage: e.lineage.map(l => ({ ...l, sample: [] })) };
      case 'template':
        return { ...e, snapshot: null };
      default:
        return e;
    }
  });
}

/** 键排好序的 JSON，键顺序不同视为相同 */
const stable = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

const item = (e: CatalogEntry): DiffItem => ({ id: e.id, kind: e.kind, name: e.name });

/** 按条目标识比较两版条目：新增、删除，以及顶层键有变化的改动 */
export function diffCatalog(prev: CatalogEntry[], next: CatalogEntry[]): CatalogDiff {
  const before = new Map(prev.map(e => [e.id, e]));
  const after = new Map(next.map(e => [e.id, e]));
  const changed: CatalogDiff['changed'] = [];
  for (const e of next) {
    const p = before.get(e.id);
    if (!p) continue;
    const a = p as unknown as Record<string, unknown>;
    const b = e as unknown as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => stable(a[k]) !== stable(b[k])).sort();
    if (keys.length) changed.push({ ...item(e), keys });
  }
  return {
    added: next.filter(e => !before.has(e.id)).map(item),
    removed: prev.filter(e => !after.has(e.id)).map(item),
    changed,
  };
}

const isEmpty = (d: CatalogDiff) => !d.added.length && !d.removed.length && !d.changed.length;

/** 最新一版；还没有版本时为 undefined */
async function latest(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const [row] = await db.select().from(catalogVersions).where(eq(catalogVersions.tenantId, tenantId))
    .orderBy(desc(catalogVersions.version)).limit(1);
  return row;
}

/** 当前目录版本号；还没有版本时为 null */
export const currentCatalogVersion = async (db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<number | null> =>
  (await latest(db, tenantId))?.version ?? null;

/**
 * 在事务里重新生成目录（不读统计）、去掉统计，和最新一版比较：有差异时记下一版并返回版本号，没有差异时返回 null。
 * 没有上一版时记第 1 版，全部条目都是新增。用事务级 advisory 锁按租户串行化（不用 lockTenant：它锁租户行的时机太晚，可能死锁）。
 * 这把锁之后不能再等租户行的锁：事务开头没锁租户行的白名单动作，审计要记在入队任务（insertTask 加 FOR SHARE）、lockTenant 之后，
 * 否则与先锁租户行（或已因插审计行持有 KEY SHARE）再记审计的事务互相等待
 */
export async function recordCatalogVersion(tx: Tx, tenantId: string, reason: string): Promise<number | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalog_version:${tenantId}`}, 0))`);
  const snapshot = stripStats(buildCatalog(await loadCatalogInput(tx, tenantId, { stats: false })));
  const prev = await latest(tx, tenantId);
  const diff = diffCatalog(prev?.snapshot ?? [], snapshot);
  if (isEmpty(diff)) return null;
  const version = (prev?.version ?? 0) + 1;
  await tx.insert(catalogVersions).values({ tenantId, version, reason, snapshot, diff });
  return version;
}

/** 版本 since 之后的各版本（版本号、时间、原因、差异），以及版本 since 与当前之间的净差异；since 为 0 或不存在时和空目录比 */
export async function catalogChangesSince(db: Tx | ReturnType<typeof getDb>, tenantId: string, since: number) {
  const versions = await db
    .select({ version: catalogVersions.version, reason: catalogVersions.reason, createdAt: catalogVersions.createdAt, diff: catalogVersions.diff })
    .from(catalogVersions).where(and(eq(catalogVersions.tenantId, tenantId), gt(catalogVersions.version, since))).orderBy(catalogVersions.version);
  const current = await latest(db, tenantId);
  const [base] = await db.select({ snapshot: catalogVersions.snapshot }).from(catalogVersions)
    .where(and(eq(catalogVersions.tenantId, tenantId), eq(catalogVersions.version, since)));
  return { current: current?.version ?? null, versions, net: diffCatalog(base?.snapshot ?? [], current?.snapshot ?? []) };
}

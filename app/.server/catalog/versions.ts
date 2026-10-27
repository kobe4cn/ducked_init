// app/.server/catalog/versions.ts —— 语义目录的版本（ADR-0041）：目录的结构或含义变了才记一版，比较前去掉统计，只改统计不产生版本。
// 版本由 recordAudit 在白名单动作的同一事务里触发，调度器在采集与同步成功后、tenantCatalog 在读取时也各比较一次：重新生成目录、去掉统计，和上一版的快照按条目标识比较，有差异才记新版本
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { AuditAction, Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogVersions, tenants } from '../db/schema';
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

/**
 * 一版目录的原因：白名单审计动作，采集 / 同步后发现源表结构变了（source.profiled / source.synced），
 * 或读取时补记（catalog.initial / platform.capabilities / catalog.detected，见 ensureCatalogVersion）
 */
export type CatalogVersionReason = AuditAction | 'source.profiled' | 'source.synced' | 'catalog.initial' | 'platform.capabilities' | 'catalog.detected';

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

/** 按当前元数据生成、去掉统计的目录条目 */
const strippedCatalog = async (db: Tx | ReturnType<typeof getDb>, tenantId: string) =>
  stripStats(buildCatalog(await loadCatalogInput(db, tenantId, { stats: false })));

/**
 * 在事务里重新生成目录（不读统计）、去掉统计，和最新一版比较：有差异时记下一版并返回版本号，没有差异时返回 null。
 * reason 可以是函数，按差异与有没有上一版决定原因。
 * 没有上一版时记第 1 版，全部条目都是新增。用事务级 advisory 锁按租户串行化（不用 lockTenant：它锁租户行的时机太晚，可能死锁）。
 * 这把锁之后不能再等租户行的锁：事务开头没锁租户行的白名单动作，审计要记在入队任务（insertTask 加 FOR SHARE）、lockTenant 之后，
 * 否则与先锁租户行（或已因插审计行持有 KEY SHARE）再记审计的事务互相等待。所以拿锁前先对租户行加 FOR KEY SHARE（插版本行的外键要的就是它）：
 * 经 recordAudit 来的已经持有，调度器与读取时补记的在这里先等 lockTenant 的事务结束
 */
export async function recordCatalogVersion(
  tx: Tx, tenantId: string, reason: CatalogVersionReason | ((diff: CatalogDiff, first: boolean) => CatalogVersionReason),
): Promise<number | null> {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('key share');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`catalog_version:${tenantId}`}, 0))`);
  const snapshot = await strippedCatalog(tx, tenantId);
  const prev = await latest(tx, tenantId);
  const diff = diffCatalog(prev?.snapshot ?? [], snapshot);
  if (isEmpty(diff)) return null;
  const version = (prev?.version ?? 0) + 1;
  await tx.insert(catalogVersions).values({ tenantId, version, reason: typeof reason === 'string' ? reason : reason(diff, !prev), snapshot, diff });
  return version;
}

/**
 * 不在事务里先比较一次，目录和最新一版有差异时才开事务、加锁记一版（recordCatalogVersion 会在锁里重新比较）。
 * 给不经成员事务的变化用：采集、同步与读取多半没有变化，这样不必锁租户行、和合并入队等成员操作抢锁
 */
export async function recordCatalogVersionIfChanged(tenantId: string, reason: Parameters<typeof recordCatalogVersion>[2]): Promise<number | null> {
  const db = getDb();
  const prev = await latest(db, tenantId);
  if (prev && isEmpty(diffCatalog(prev.snapshot, await strippedCatalog(db, tenantId)))) return null;
  return db.transaction(tx => recordCatalogVersion(tx, tenantId, reason));
}

/**
 * 读目录时补记：目录和最新一版不一致而没有事件记下来（如代码升级后能力说明变了）时记一版。
 * 原因：还没有版本时是 catalog.initial，只有能力条目变了是 platform.capabilities，否则 catalog.detected
 */
export const ensureCatalogVersion = (tenantId: string) => recordCatalogVersionIfChanged(tenantId, (diff, first) =>
  first ? 'catalog.initial'
  : [...diff.added, ...diff.removed, ...diff.changed].every(x => x.kind === 'capability') ? 'platform.capabilities'
  : 'catalog.detected');

const versionsAfter = (db: Tx | ReturnType<typeof getDb>, tenantId: string, since: number) => db
  .select({ version: catalogVersions.version, reason: catalogVersions.reason, createdAt: catalogVersions.createdAt, diff: catalogVersions.diff })
  .from(catalogVersions).where(and(eq(catalogVersions.tenantId, tenantId), gt(catalogVersions.version, since)));

/** 版本 since 之后的各版本（版本号、时间、原因、差异），以及版本 since 与当前之间的净差异；since 为 0 或不存在时和空目录比 */
export async function catalogChangesSince(db: Tx | ReturnType<typeof getDb>, tenantId: string, since: number) {
  const versions = await versionsAfter(db, tenantId, since).orderBy(catalogVersions.version);
  const current = await latest(db, tenantId);
  const [base] = await db.select({ snapshot: catalogVersions.snapshot }).from(catalogVersions)
    .where(and(eq(catalogVersions.tenantId, tenantId), eq(catalogVersions.version, since)));
  return { current: current?.version ?? null, versions, net: diffCatalog(base?.snapshot ?? [], current?.snapshot ?? []) };
}

/** 版本 since 之后最新的 limit 个版本（新的在前）与当前版本号；不读快照、不算净差异，供变更记录页面用 */
export async function recentCatalogChanges(db: Tx | ReturnType<typeof getDb>, tenantId: string, since: number, limit: number) {
  const versions = await versionsAfter(db, tenantId, since).orderBy(desc(catalogVersions.version)).limit(limit);
  const [current] = await db.select({ version: catalogVersions.version }).from(catalogVersions)
    .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1);
  return { current: current?.version ?? null, versions };
}

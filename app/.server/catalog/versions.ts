// app/.server/catalog/versions.ts —— 语义目录的版本（ADR-0041）：目录的结构或含义变了才记一版，比较前去掉统计，只改统计不产生版本。
// 版本由 catalogTx 在成员事务的收尾记一次（ADR-0054；recordAudit 只登记白名单动作，见 catalog/tx.ts），
// 调度器在采集与同步成功后、tenantCatalog 在读取时也各比较一次：重新生成目录、去掉统计，和上一版的快照按条目标识比较，有差异才记新版本。
// prefetchEmbeddings 供 catalogTx 提交后与开关入口（打开混合检索、保存 embedding 配置的路由）提前补算检索向量（#824）
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { CurrentMember } from '../auth';
import type { AuditAction, Tx } from '../audit';
import { getDb } from '../db/client';
import { catalogVersions, tenants } from '../db/schema';
import { resolveEmbeddingProvider } from '../llm';
import { ensureEmbeddings } from './embeddings';
import { buildCatalog, type Catalog, type CatalogEntry } from './index';
import { loadCatalogInput } from './load';
// projection.ts 也从本文件导入：这个环只能在函数体里用它的绑定，不能在模块顶层求值
import { refreshProjection, RESTRICTED_CLEARED_KEYS, RESTRICTED_HIDDEN_KINDS, SOURCE_REASONS, visibilityClass } from './projection';

/**
 * 一版目录的原因：白名单审计动作，采集 / 同步后发现源表结构变了（source.profiled / source.synced），
 * 或读取时补记（catalog.initial / platform.capabilities / catalog.detected，见 ensureCatalogVersion）
 */
export type CatalogVersionReason = AuditAction | 'source.profiled' | 'source.synced' | 'catalog.initial' | 'platform.capabilities' | 'catalog.detected';

export interface DiffItem { id: string; kind: CatalogEntry['kind']; name: string }

/** 源表条目 columns 键的变化明细：新增与删除的列名（各自排序）。只改了列类型的列不在里面；两个数组都为空时不写这个字段。
 *  旧版本存在 catalog_versions.diff 里的数据没有这个字段，读取时须容忍缺失 */
export interface ColumnDiff { added: string[]; removed: string[] }

/** 两版目录按条目标识比出的差异；changed 的 keys 是变了的顶层键，源表条目另给列级明细 */
export interface CatalogDiff { added: DiffItem[]; removed: DiffItem[]; changed: (DiffItem & { keys: string[]; columns?: ColumnDiff })[] }

/** 去掉统计后的单个条目：源表与实体的统计、字段来源的源端样本、模板与指标、标签的快照；指标、标签与模板的 version 是定义的版本，保留 */
export function stripEntryStats(e: CatalogEntry): CatalogEntry {
  switch (e.kind) {
    case 'table':
    case 'entity':
      return { ...e, stats: null };
    case 'field':
      return { ...e, lineage: e.lineage.map(l => ({ ...l, sample: [] })) };
    case 'template':
      return { ...e, snapshot: null };
    case 'metric':
    case 'tag': {
      // 去掉键而不是设成 null：和没有快照时的旧版本 JSON 相同
      const { snapshot: _, ...rest } = e;
      return rest;
    }
    default:
      return e;
  }
}

/** 去掉统计后的条目：源表与实体的统计、字段来源的源端样本、模板与指标、标签的快照；指标、标签与模板的 version 是定义的版本，保留 */
export const stripStats = (c: Catalog): CatalogEntry[] => c.entries.map(stripEntryStats);

/** 键排好序的 JSON，键顺序不同视为相同 */
const stable = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

const item = (e: CatalogEntry): DiffItem => ({ id: e.id, kind: e.kind, name: e.name });

/** 按条目标识比较两版条目：新增、删除，以及顶层键有变化的改动；源表条目的 columns 有增删时给列级明细 */
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
    if (!keys.length) continue;
    const entry: CatalogDiff['changed'][number] = { ...item(e), keys };
    // TableEntry.columns 已去掉敏感列与系统列，列名明细不会泄露它们；只改类型的列两边差集都进不去，两个数组都为空时不写
    if (e.kind === 'table' && p.kind === 'table' && keys.includes('columns')) {
      const had = new Set(p.columns.map(c => c.name));
      const has = new Set(e.columns.map(c => c.name));
      const columns = { added: e.columns.filter(c => !had.has(c.name)).map(c => c.name).sort(), removed: p.columns.filter(c => !has.has(c.name)).map(c => c.name).sort() };
      if (columns.added.length || columns.removed.length) entry.columns = columns;
    }
    changed.push(entry);
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
 * 成员操作经 catalogTx 在事务收尾记版本：是事务里最后一步，之后不再拿锁（ADR-0054），不会拿了这把锁再等租户行的锁。
 * 拿锁前先对租户行加 FOR KEY SHARE（插版本行的外键要的就是它）为不经 catalogTx 的路径保留：调度器与读取时补记的在这里先等 lockTenant 的事务结束
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

/**
 * 提前补算检索向量（#824）：catalogTx 提交后、运营打开混合检索、租户保存 embedding 配置时调用，让第一次混合检索不必等后台补算。
 * 租户没开混合检索或没配 embedding 端点时返回 off，不刷投影也不排任务（先查开关，没开的租户不再多查端点）；
 * 否则先把检索投影刷到最新（refreshProjection）：改动多时它自己去重排 catalog.projection、其结束钩子照常 ensureEmbeddings，这里返回 queued；
 * 改动少时同步刷新完再 ensureEmbeddings，去重排一个 catalog.embed；向量已齐时返回 fresh。幂等：投影与向量都齐了什么都不排。
 * 最近一次补算失败、还在退避期内时照 ensureEmbeddings 返回 backoff，不排任务
 */
export async function prefetchEmbeddings(tenantId: string): Promise<'off' | 'fresh' | 'queued' | 'backoff'> {
  const [tenant] = await getDb().select({ hybridSearch: tenants.hybridSearch }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant?.hybridSearch) return 'off';
  if (!(await resolveEmbeddingProvider(tenantId))) return 'off';
  if (await refreshProjection(tenantId) === 'queued') return 'queued';
  return ensureEmbeddings(tenantId);
}

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

/** 版本 since 之后最新的 limit 个版本（新的在前）与当前版本号；不读快照、不算净差异，只供 catalogChangesFor 用 */
async function recentCatalogChanges(db: Tx | ReturnType<typeof getDb>, tenantId: string, since: number, limit: number) {
  const versions = await versionsAfter(db, tenantId, since).orderBy(desc(catalogVersions.version)).limit(limit);
  const [current] = await db.select({ version: catalogVersions.version }).from(catalogVersions)
    .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1);
  return { current: current?.version ?? null, versions };
}

/** 变更记录页给成员看的一版：查看者的数据源相关原因统一为 sources（masked，不列明细）；差异按 visibleCatalog 的规则裁剪 */
export interface CatalogChangesForMember {
  current: number | null;
  versions: { version: number; reason: CatalogVersionReason | 'sources'; masked: boolean; createdAt: Date; diff: CatalogDiff }[];
}

/**
 * 按成员的可见性类别裁剪的变更记录（与 visibleCatalog 共用规则，ADR-0047）：full 原样返回；
 * restricted 去掉数据源与源表条目，changed 的 keys 去掉该种类要清空的键、去掉后为空的条目整条不显示，
 * 与数据源有关的原因（SOURCE_REASONS）统一返回 sources 并清空差异（ADR-0005）
 */
export async function catalogChangesFor(member: CurrentMember, since: number, limit: number): Promise<CatalogChangesForMember> {
  const { current, versions } = await recentCatalogChanges(getDb(), member.tenant.id, since, limit);
  // reason 列是 text，写进去的原因都来自白名单（recordCatalogVersion 的 reason 参数），这里收窄回 CatalogVersionReason
  const rows = versions.map(({ reason, ...v }) => ({ ...v, reason: reason as CatalogVersionReason }));
  if (visibilityClass(member.role) === 'full') {
    return { current, versions: rows.map(v => ({ ...v, masked: false })) };
  }
  return {
    current,
    versions: rows.map(v => {
      if (SOURCE_REASONS.has(v.reason)) {
        // 查看者看到的数据源相关原因统一为 sources，不暴露具体动作与明细
        return { ...v, reason: 'sources' as const, masked: true, diff: { added: [], removed: [], changed: [] } };
      }
      return {
        ...v,
        masked: false,
        diff: {
          added: v.diff.added.filter(x => !RESTRICTED_HIDDEN_KINDS.has(x.kind)),
          removed: v.diff.removed.filter(x => !RESTRICTED_HIDDEN_KINDS.has(x.kind)),
          changed: v.diff.changed.flatMap(x => {
            if (RESTRICTED_HIDDEN_KINDS.has(x.kind)) return [];
            const keys = x.keys.filter(k => !RESTRICTED_CLEARED_KEYS[x.kind]?.has(k));
            return keys.length ? [{ ...x, keys }] : [];
          }),
        },
      };
    }),
  };
}

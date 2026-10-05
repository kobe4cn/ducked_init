// app/.server/source-views.ts —— 源视图：数据工程师在某个数据源下手写一段只读原始层的 SELECT，把复杂源表整理成可映射的形状（ADR-0022）。
// 保存草稿时在请求内只读挂载本租户的数据湖校验 SQL（只能读本数据源原始层的表，见 pipeline/source-view-engine.ts），并取出视图的列与前几行样本。
// 草稿按映射同样的规则双人发布：由最后保存它的人以外的另一位有发布权限的成员在页面上发布，也可以丢弃（回到最近的已发布版本，
// 从没发布过时整个删除）；发布后版本锁定，并为基于它的已发布映射入队合并（ADR-0023）。没有任何自动发布的路径。一律限定在操作者所属租户内
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { mappings, sources, sourceViews, sourceViewVersions } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { enqueueMerge } from './mappings';
import { openTenantLake, redactLakeSecrets } from './pipeline/lake-engine';
import { normalizeViewSql, previewView, VIEW_PLATFORM_COLUMNS, ViewSqlError, type ViewPreview } from './pipeline/source-view-engine';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import { tenantPiiSalt } from './secrets';
import { requireSource } from './source-config';
import { confirmedTables } from './sources';
import { looksSensitive } from '../lib/sensitive';

/** 可以展示给成员的业务错误 */
export class SourceViewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

/** 预览取多少行样本，与所用的计算资源 */
export const PREVIEW_ROWS = 20;
const PREVIEW_LIMITS = { memoryLimitMb: 512, threads: 1 };

/** 视图名：小写字母开头，只含小写字母、数字、下划线（映射里像表名一样引用它） */
const VIEW_NAME = /^[a-z][a-z0-9_]{0,62}$/;

async function sourceOf(tenantId: string, sourceId: string) {
  return requireSource(tenantId, sourceId).catch(() => { throw new SourceViewError('数据源不存在', 404); });
}

/** 本租户、数据源 sourceId 下的源视图，带数据源名称；不存在（含属于别的数据源）时 404 */
async function requireView(tenantId: string, sourceId: string, viewId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(viewId) || !/^[0-9a-f-]{36}$/i.test(sourceId)) throw new SourceViewError('源视图不存在', 404);
  const [row] = await getDb().select({ id: sourceViews.id, name: sourceViews.name, sourceId: sources.id, sourceName: sources.name })
    .from(sourceViews).innerJoin(sources, eq(sources.id, sourceViews.sourceId))
    .where(and(eq(sourceViews.id, viewId), eq(sourceViews.sourceId, sourceId), eq(sourceViews.tenantId, tenantId)));
  if (!row) throw new SourceViewError('源视图不存在', 404);
  return row;
}

/**
 * 在只读挂载的数据湖上校验 SQL 并取预览（视图的列与前 PREVIEW_ROWS 行，敏感列是加盐哈希）。
 * 不合规或执行出错时抛出 SourceViewError（报错里抹掉凭据与盐）
 */
async function checkAndPreview(tenantId: string, sourceId: string, viewSql: string) {
  // 采集时像敏感信息的列（列名或过半取值像邮箱、手机号），预览前在原始层的同名视图里先换成哈希
  const { tables } = await confirmedTables(tenantId, sourceId);
  const sensitive = Object.fromEntries(tables.map(({ table }) => [table.name, table.columns.filter(c => looksSensitive(c)).map(c => c.name)]));
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) throw new SourceViewError('本租户的数据湖还没有初始化');
  const salt = await tenantPiiSalt(tenantId);
  const spec = lakeSpecOf(lake);
  const session = await openTenantLake(spec, PREVIEW_LIMITS, undefined, { readOnly: true });
  try {
    return await previewView(session.con, viewSql, sourceId, salt, PREVIEW_ROWS, sensitive);
  } catch (e) {
    if (e instanceof ViewSqlError) throw new SourceViewError(e.message);
    throw new SourceViewError(`源视图执行出错：${redactLakeSecrets((e as Error).message, spec).replaceAll(salt, '***')}`);
  } finally {
    session.close();
  }
}

/** 版本里存下的形状：输出列（不含平台列，映射对照字段用）与引用的原始层表（这些表同步后合并基于视图的映射） */
const shapeOf = (preview: ViewPreview) => ({
  columns: preview.columns.filter(c => !(VIEW_PLATFORM_COLUMNS as readonly string[]).includes(c.name)).map(c => ({ name: c.name, type: c.type })),
  tables: preview.tables,
});

/** 列表里的一个源视图：最近的已发布版本号与草稿的版本号，没有时为 null */
export interface SourceViewSummary { id: string; name: string; published: number | null; draft: number | null }

/** 数据源与它下面的源视图：名称、最近的已发布版本号与草稿的版本号（没有时为 null） */
export async function listSourceViews(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  const source = await sourceOf(actor.tenant.id, sourceId);
  const versions = await getDb().select({ id: sourceViews.id, name: sourceViews.name, version: sourceViewVersions.version, status: sourceViewVersions.status })
    .from(sourceViews).innerJoin(sourceViewVersions, eq(sourceViewVersions.viewId, sourceViews.id))
    .where(and(eq(sourceViews.tenantId, actor.tenant.id), eq(sourceViews.sourceId, sourceId)))
    .orderBy(sourceViews.name, desc(sourceViewVersions.version));
  const views = new Map<string, SourceViewSummary>();
  for (const v of versions) {
    const view = views.get(v.id) ?? { id: v.id, name: v.name, published: null, draft: null };
    if (v.status === 'draft') view.draft = v.version;
    else view.published ??= v.version;
    views.set(v.id, view);
  }
  return { source: { id: source.id, name: source.name }, views: [...views.values()] };
}

/** 源视图详情：所属数据源、各版本（最新的在前，带当前成员发布不了的原因）、草稿与最近的已发布版本，以及本租户有发布权限的成员人数 */
export async function getSourceView(actor: CurrentMember, sourceId: string, viewId: string) {
  assertCan(actor, 'sources:read');
  const view = await requireView(actor.tenant.id, sourceId, viewId);
  const versions = await getDb().select({
    version: sourceViewVersions.version, status: sourceViewVersions.status, sql: sourceViewVersions.sql,
    authors: sourceViewVersions.authors, lastEditor: sourceViewVersions.lastEditor,
    publishedByEmail: sourceViewVersions.publishedByEmail, publishedAt: sourceViewVersions.publishedAt, updatedAt: sourceViewVersions.updatedAt,
  }).from(sourceViewVersions).where(eq(sourceViewVersions.viewId, viewId)).orderBy(desc(sourceViewVersions.version));
  return {
    view: { id: view.id, name: view.name },
    source: { id: view.sourceId, name: view.sourceName },
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft: versions.find(v => v.status === 'draft') ?? null,
    published: versions.find(v => v.status === 'published') ?? null,
    publishers: await publisherCount(actor.tenant.id),
  };
}

/** 预览源视图的第 version 版：视图的列与前几行样本（敏感列是加盐哈希）。不写数据湖、不记审计 */
export async function previewSourceView(actor: CurrentMember, sourceId: string, viewId: string, version: number) {
  assertCan(actor, 'sources:write');
  const view = await requireView(actor.tenant.id, sourceId, viewId);
  const [row] = await getDb().select({ sql: sourceViewVersions.sql }).from(sourceViewVersions)
    .where(and(eq(sourceViewVersions.viewId, viewId), eq(sourceViewVersions.version, version)));
  if (!row) throw new SourceViewError(`没有第 ${version} 版`, 404);
  return checkAndPreview(actor.tenant.id, view.sourceId, row.sql);
}

/** 新建源视图：SQL 在数据湖上校验通过后保存为第一版草稿。同一数据源下视图名唯一。返回新建的源视图 ID */
export async function createSourceView(actor: CurrentMember, sourceId: string, input: { name: string; sql: string }) {
  assertCan(actor, 'sources:write');
  const source = await sourceOf(actor.tenant.id, sourceId);
  const name = input.name.trim();
  if (!VIEW_NAME.test(name)) throw new SourceViewError('视图名要以小写字母开头，只含小写字母、数字和下划线，最长 63 个字符');
  const viewSql = normalizeViewSql(input.sql);
  const shape = shapeOf(await checkAndPreview(actor.tenant.id, sourceId, viewSql));
  try {
    return await getDb().transaction(async tx => {
      const [view] = await tx.insert(sourceViews).values({ tenantId: actor.tenant.id, sourceId, name }).returning({ id: sourceViews.id });
      await tx.insert(sourceViewVersions).values({ viewId: view.id, version: 1, sql: viewSql, ...shape, authors: [actor.email], lastEditor: actor.email });
      await recordAudit(tx, {
        tenantId: actor.tenant.id,
        actor,
        action: 'source_view.drafted',
        targetType: 'source_view',
        targetId: view.id,
        detail: { source: source.name, name, version: 1 },
      });
      return view.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new SourceViewError(`「${source.name}」已有名为 ${name} 的源视图，请在那个源视图上修改`);
    throw e;
  }
}

/**
 * 保存草稿：SQL 在数据湖上校验通过后，已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 返回草稿的版本号
 */
export async function saveSourceViewDraft(actor: CurrentMember, sourceId: string, viewId: string, input: string) {
  assertCan(actor, 'sources:write');
  const view = await requireView(actor.tenant.id, sourceId, viewId);
  const viewSql = normalizeViewSql(input);
  const shape = shapeOf(await checkAndPreview(actor.tenant.id, view.sourceId, viewSql));
  return getDb().transaction(async tx => {
    // 锁住源视图行：与发布、丢弃互斥；丢弃从没发布过的源视图会删除它
    const [locked] = await tx.select({ id: sourceViews.id }).from(sourceViews).where(eq(sourceViews.id, viewId)).for('update');
    if (!locked) throw new SourceViewError('源视图已被删除', 404);
    const [latest] = await tx.select().from(sourceViewVersions)
      .where(eq(sourceViewVersions.viewId, viewId)).orderBy(desc(sourceViewVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      await tx.update(sourceViewVersions).set({ sql: viewSql, ...shape, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(sourceViewVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(sourceViewVersions).values({ viewId, version, sql: viewSql, ...shape, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source_view.drafted',
      targetType: 'source_view',
      targetId: viewId,
      detail: { source: view.sourceName, name: view.name, version },
    });
    return version;
  });
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。只由成员在页面上调用，没有自动发布。
 * 发布后版本锁定，并为基于这个源视图的已发布映射入队一次合并（按新版本重建）
 */
export async function publishSourceView(actor: CurrentMember, sourceId: string, viewId: string, version: number) {
  assertCan(actor, 'publish');
  const view = await requireView(actor.tenant.id, sourceId, viewId);
  const [draft] = await getDb().select(getTableColumns(sourceViewVersions)).from(sourceViewVersions)
    .where(and(eq(sourceViewVersions.viewId, viewId), eq(sourceViewVersions.version, version)));
  if (!draft) throw new SourceViewError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new SourceViewError(blocker, draft.status === 'draft' ? 403 : 400);
  // 早于映射读源视图（#96）保存的草稿没有输出列与引用的表，映射对照不了、同步后也触发不了合并
  if (!draft.columns || !draft.tables) throw new SourceViewError('这份草稿保存得较早，没有记下视图的列与引用的表：请重新保存一次再发布');
  await getDb().transaction(async tx => {
    // 锁住源视图行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿
    await tx.select({ id: sourceViews.id }).from(sourceViews).where(eq(sourceViews.id, viewId)).for('update');
    const [current] = await tx.select().from(sourceViewVersions).where(eq(sourceViewVersions.id, draft.id));
    if (isStale(current, draft)) throw new SourceViewError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    await tx.update(sourceViewVersions)
      .set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(sourceViewVersions.id, draft.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source_view.published',
      targetType: 'source_view',
      targetId: viewId,
      detail: { source: view.sourceName, name: view.name, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
    const dependents = await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.sourceViewId, viewId));
    if (dependents.length) await enqueueMerge(tx, actor.tenant.id, dependents.map(m => m.id));
  });
}

/**
 * 丢弃草稿：回到最近的已发布版本；从没发布过的源视图整个删除。用于草稿卡住（如最后保存的人离职）的情况。
 * 返回源视图是否还在
 */
export async function discardSourceViewDraft(actor: CurrentMember, sourceId: string, viewId: string) {
  assertCan(actor, 'sources:write');
  const view = await requireView(actor.tenant.id, sourceId, viewId);
  return getDb().transaction(async tx => {
    // 锁住源视图行：与保存、发布互斥
    const [locked] = await tx.select({ id: sourceViews.id }).from(sourceViews).where(eq(sourceViews.id, viewId)).for('update');
    if (!locked) throw new SourceViewError('源视图已被删除', 404);
    const versions = await tx.select({ id: sourceViewVersions.id, version: sourceViewVersions.version, status: sourceViewVersions.status })
      .from(sourceViewVersions).where(eq(sourceViewVersions.viewId, viewId)).orderBy(desc(sourceViewVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new SourceViewError('这个源视图没有草稿');
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除源视图，各版本随之级联删除
    if (published) await tx.delete(sourceViewVersions).where(eq(sourceViewVersions.id, draft.id));
    else await tx.delete(sourceViews).where(eq(sourceViews.id, viewId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source_view.draft_discarded',
      targetType: 'source_view',
      targetId: viewId,
      detail: { source: view.sourceName, name: view.name, version: draft.version, published },
    });
    return { kept: published !== null };
  });
}

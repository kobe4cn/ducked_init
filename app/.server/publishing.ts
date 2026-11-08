// app/.server/publishing.ts —— 可发布项（映射、源视图、指标 / 标签 / 模板定义、自定义实体、合并组）的保存草稿、发布、丢弃由这一个模块负责（ADR-0051）：
// 每种可发布项通过适配器接入：两张表、要不要先锁租户行、事务外与事务内检查、发布后与丢弃后动作、审计与文案。
// 发布顺序固定：读草稿 → publishBlocker → 事务外检查 → 开事务 → 加锁 → 过期检查 → 事务内检查 → 改状态 → 发布后动作 → 审计
// （审计放在最后：记目录版本拿的锁要是事务里最后一个锁，ADR-0047）。流程本身的错误（不是草稿、已发布、草稿被改过、没有草稿可丢弃）
// 抛 PublishError，各可发布项自己的错误类继承它。不能 import mappings.ts（它经 publish-rules.ts 导入这里，循环依赖）：
// 锁租户行在这里内联一份私有的，写法同 mappings.ts 的 lockTenant；enqueueMerge 只由各适配器的 afterPublish 调
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { recordAudit, type AuditAction, type Tx } from './audit';
import { can, deniedReason } from './access';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { members, ROLES, tenants } from './db/schema';

/** 发布流程本身的错误（ADR-0051 一律 400，双人规则在草稿状态下拦下时报 403）；可发布项自己的错误类继承它，保留各自的 status 与文案 */
export class PublishError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

// —— 双人发布规则（ADR-0015），原在 publish-rules.ts，由本模块导出；调用方改从那里导入是 #500 ——

/**
 * 有发布权限的成员发布不了某一版的原因（不是草稿、最后保存这一版草稿的是自己）；可以发布时为 null。发布权限由调用方另行检查。
 * 每一处改动都要由另一个人看过才能发布：最后保存的人之前的改动，最后保存的人保存时已经看过
 */
export function publishBlocker(actor: CurrentMember, version: { status: string; lastEditor: string }) {
  if (version.status !== 'draft') return '已发布的版本已锁定';
  if (version.lastEditor === actor.email) return '你最后改了这一版草稿，需由另一位数据工程师或管理员发布';
  return null;
}

/**
 * 给成员看的、当前成员发布不了这一版草稿的原因（没有发布权限、最后保存的是自己、租户里没有别人能发布）；可以发布或不是草稿时为 null。
 * version.publishBlocker 是 publishBlocker 的结果，publishers 是本租户有发布权限的成员人数
 */
export function publishReason(actor: CurrentMember, version: { status: string; lastEditor: string; publishBlocker: string | null }, publishers: number) {
  if (version.status !== 'draft') return null;
  if (!can(actor.role, 'publish')) return deniedReason('publish');
  if (version.publishBlocker && publishers === 1 && version.lastEditor === actor.email) return '本租户只有你有发布权限，请先邀请一位数据工程师或管理员';
  return version.publishBlocker;
}

/** 本租户有发布权限的成员人数 */
export async function publisherCount(tenantId: string) {
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(members)
    .where(and(eq(members.tenantId, tenantId), inArray(members.role, ROLES.filter(r => can(r, 'publish')))));
  return n;
}

/** 保存草稿后的作者列表：加上保存的人（已在其中时不变） */
export const withAuthor = (authors: string[], email: string) => (authors.includes(email) ? authors : [...authors, email]);

/** 发布前加锁后重新读出的版本与检查时的草稿不同（已被修改、发布或丢弃）。updatedAt 按毫秒比对，草稿时间须在应用层写入 */
export const isStale = (current: { status: string; updatedAt: Date } | undefined, draft: { updatedAt: Date }) =>
  !current || current.status !== 'draft' || current.updatedAt.getTime() !== draft.updatedAt.getTime();

/** 版本表共有的列（各可发布项的版本表形状相同，ADR-0051，没有 createdBy / publishedBy 列）；内容列（sql、members 这些）在表自己身上。
 * 适配器给的是通用表，select 读出的行按这个形状断言（列由 schema 保证存在） */
export interface VersionRow {
  id: string;
  version: number;
  status: string;
  authors: string[];
  lastEditor: string;
  publishedByEmail: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 版本表的一整行（共有列之外带各可发布项自己的内容列）：事务外 / 内检查与发布后动作收到的是它 */
export type DraftRow = VersionRow & Record<string, unknown>;

/**
 * 可发布项的适配器（ADR-0051）。给具体表与列，不做泛型 drizzle：Ctx 是定位这一项的上下文（发布前读草稿用 ctx.parentId），
 * Input 是保存的输入，Inside 是事务内检查传给发布后动作的值（合并组用它读出上一版的组员），After 是发布后动作（入队任务）的结果
 */
export interface PublishableAdapter<Ctx, Input, Inside = undefined, After = null> {
  /** 父表与版本表，以及版本表指向父表的外键列（如 sourceViewVersions.viewId）；丢弃从没发布过的项时连父行一起删 */
  parent: PgTable;
  versions: PgTable;
  versionsFk: AnyPgColumn;

  /** 保存 / 发布 / 丢弃要不要先锁租户行（按租户串行，入队合并也锁它）：映射与合并组要，其余不要 */
  lockTenant: boolean;

  /** 锁住父行并返回父行 ID，与保存、发布、丢弃互斥；不存在时抛可发布项自己的 404 */
  lockParent(tx: Tx, ctx: Ctx): Promise<string>;

  /** 保存的事务外检查（可以访问 DuckDB 或数据湖），把输入变成要写进版本表的内容列（sql、columns、tables 这些） */
  checkSave(ctx: Ctx, input: Input): Promise<Record<string, unknown>>;

  /** 保存的事务内检查（只查 PG）：合并组的校验与懒建父行在这里做 */
  saveInside?(tx: Tx, ctx: Ctx): Promise<void>;

  /** 发布的事务外检查（可以访问 DuckDB 或数据湖） */
  checkOutside?(draft: DraftRow, ctx: Ctx): Promise<void>;

  /** 发布的事务内检查（只查 PG），返回值传给 afterPublish：合并组用它读出上一版的组员 */
  checkInside?(tx: Tx, draft: DraftRow, ctx: Ctx): Promise<Inside>;

  /** 发布后动作（入队任务），返回任务或 null；在审计之前执行 */
  afterPublish?(tx: Tx, draft: DraftRow, ctx: Ctx, inside: Inside): Promise<After | null>;

  /** 丢弃后动作（回到的已发布版本还在时 kept 为真） */
  afterDiscard?(tx: Tx, ctx: Ctx, kept: boolean): Promise<void>;

  /** 审计：三个动作名与目标类型；detail 带上这一步看到的字段（版本号、作者这些），上下文里的公共字段（如所属数据源与名称）由它补 */
  audit: {
    drafted: { action: AuditAction; detail(ctx: Ctx, columns: Record<string, unknown>, version: number): Record<string, unknown> };
    published: { action: AuditAction; detail(ctx: Ctx, draft: DraftRow): Record<string, unknown> };
    discarded: { action: AuditAction; detail(ctx: Ctx, version: number, published: number | null): Record<string, unknown> };
    targetType: string;
  };

  /** 文案：发布没有这一版时 404、丢弃没有草稿可丢 */
  missingVersion(version: number): string;
  noDraft(ctx: Ctx): string;
}

/** 锁住租户行（按租户串行）：写法同 mappings.ts 的 lockTenant，这里私有内联一份（不能 import mappings.ts，见文件头） */
const lockTenantRow = (tx: Tx, tenantId: string) =>
  tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');

/** 版本表 / 父表的共有列（各可发布项形状相同、名字相同，ADR-0051）：按名字从具体表上取 */
const sharedOf = (table: PgTable) => {
  const cols = getTableColumns(table) as Record<string, AnyPgColumn>;
  return { id: cols.id, version: cols.version, status: cols.status };
};

/** 版本表指向父表的外键列在表里的字段名（insert 版本时按它写父行 ID） */
const fkKeyOf = (versions: PgTable, versionsFk: AnyPgColumn) =>
  Object.entries(getTableColumns(versions)).find(([, column]) => column === versionsFk)![0];

/** 在调用方的事务里执行，没给时自己开一个 */
const inTx = <T>(tx: Tx | undefined, run: (tx: Tx) => Promise<T>): Promise<T> =>
  tx ? run(tx) : getDb().transaction(run);

/**
 * 保存草稿：事务外检查（适配器的 checkSave，可以访问 DuckDB 或数据湖）→ 开事务 →（锁租户行）→ 保存的事务内检查 → 锁父行 →
 * 最新一版是草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）并记 *.drafted 审计。
 * 返回草稿的版本号
 */
export async function saveDraft<Ctx, Input, Inside, After>(
  adapter: PublishableAdapter<Ctx, Input, Inside, After>, actor: CurrentMember, ctx: Ctx, input: Input, tx?: Tx,
) {
  const columns = await adapter.checkSave(ctx, input);
  return inTx(tx, async tx => {
    if (adapter.lockTenant) await lockTenantRow(tx, actor.tenant.id);
    await adapter.saveInside?.(tx, ctx);
    const parentId = await adapter.lockParent(tx, ctx);
    const { id, version: versionCol } = sharedOf(adapter.versions);
    const [latest] = (await tx.select().from(adapter.versions).where(eq(adapter.versionsFk, parentId))
      .orderBy(desc(versionCol)).limit(1)) as unknown as VersionRow[];
    if (latest?.status === 'draft') {
      await tx.update(adapter.versions)
        .set({ ...columns, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(adapter.versions)
      .values({ [fkKeyOf(adapter.versions, adapter.versionsFk)]: parentId, version, ...columns, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: adapter.audit.drafted.action,
      targetType: adapter.audit.targetType,
      targetId: parentId,
      detail: adapter.audit.drafted.detail(ctx, columns, version),
    });
    return version;
  });
}

/**
 * 发布草稿：读草稿 → publishBlocker → 事务外检查 → 开事务 →（锁租户行）→ 锁父行 → 过期检查 → 事务内检查 → 改状态 → 发布后动作 → 审计。
 * 可以在调用方传入的事务里执行（publishPassthrough 一个事务里发布登记与映射）。返回发布后动作的结果（入队的任务）或 null
 */
export async function publish<Ctx, Input, Inside, After>(
  adapter: PublishableAdapter<Ctx, Input, Inside, After>, actor: CurrentMember, ctx: Ctx & { parentId: string }, version: number, tx?: Tx,
): Promise<After | null> {
  const { id, version: versionCol } = sharedOf(adapter.versions);
  const [draft] = (await getDb().select().from(adapter.versions)
    .where(and(eq(adapter.versionsFk, ctx.parentId), eq(versionCol, version)))) as unknown as DraftRow[];
  if (!draft) throw new PublishError(adapter.missingVersion(version), 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new PublishError(blocker, draft.status === 'draft' ? 403 : 400);
  await adapter.checkOutside?.(draft, ctx);
  return inTx(tx, async tx => {
    if (adapter.lockTenant) await lockTenantRow(tx, actor.tenant.id);
    await adapter.lockParent(tx, ctx);
    const [current] = (await tx.select().from(adapter.versions).where(eq(id, draft.id))) as unknown as VersionRow[];
    if (isStale(current, draft)) {
      throw new PublishError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    }
    // checkInside 没有时是 undefined，声明了就一定有值
    const inside = (await adapter.checkInside?.(tx, draft, ctx)) as Inside;
    await tx.update(adapter.versions)
      .set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(id, draft.id));
    const task = await adapter.afterPublish?.(tx, draft, ctx, inside) ?? null;
    // 审计放在发布后动作（入队）之后：记目录版本拿的锁要是事务里最后一个锁（ADR-0047）
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: adapter.audit.published.action,
      targetType: adapter.audit.targetType,
      targetId: ctx.parentId,
      detail: adapter.audit.published.detail(ctx, draft),
    });
    return task;
  });
}

/** 丢弃草稿：回到最近的已发布版本；从没发布过的可发布项连父行一起删（各版本随之级联删除）。返回父行是否还在 */
export async function discard<Ctx, Input, Inside, After>(
  adapter: PublishableAdapter<Ctx, Input, Inside, After>, actor: CurrentMember, ctx: Ctx,
): Promise<{ kept: boolean }> {
  return getDb().transaction(async tx => {
    if (adapter.lockTenant) await lockTenantRow(tx, actor.tenant.id);
    const parentId = await adapter.lockParent(tx, ctx);
    const { id, version: versionCol, status } = sharedOf(adapter.versions);
    const versions = (await tx.select({ id, version: versionCol, status }).from(adapter.versions)
      .where(eq(adapter.versionsFk, parentId)).orderBy(desc(versionCol))) as unknown as VersionRow[];
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new PublishError(adapter.noDraft(ctx));
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    if (published) await tx.delete(adapter.versions).where(eq(id, draft.id));
    else await tx.delete(adapter.parent).where(eq(sharedOf(adapter.parent).id, parentId));
    await adapter.afterDiscard?.(tx, ctx, published !== null);
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: adapter.audit.discarded.action,
      targetType: adapter.audit.targetType,
      targetId: parentId,
      detail: adapter.audit.discarded.detail(ctx, draft.version, published),
    });
    return { kept: published !== null };
  });
}

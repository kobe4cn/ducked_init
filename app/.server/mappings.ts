// app/.server/mappings.ts —— 映射：数据工程师用 YAML 编写“源表 → 标准实体”的映射，校验通过才能保存为草稿；草稿由另一位有发布权限的成员发布，
// 发布后版本锁定（再改是新的一版草稿）。发布后入队合并任务（silver.merge），同步之后也会再合并一次，把原始层的变更批次合并进标准层（ADR-0015）。
// 一律限定在操作者所属租户内；合并本身在工作进程里进行（pipeline/merge-engine.ts）
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { mappings, mappingVersions, sources, tasks, tenants, type TaskStatus } from './db/schema';
import type { MergeMappingParam, MergeRecord } from './pipeline/merge-engine';
import { draftMapping } from './pipeline/mapping-draft';
import { checkMapping, type MappingIssue, type MergePlan } from './pipeline/mapping-spec';
import { requireSource } from './source-config';
import { confirmedTables } from './sources';
import { insertTask } from './tasks';
import { entityLabel, entityOf } from '../lib/canonical-model';

/** 可以展示给成员的业务错误；issues 是映射文档里带行列位置的问题 */
export class MappingError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400, readonly issues: MappingIssue[] = []) { super(message); }
}

/** 合并状态取最近多少次合并任务 */
const HISTORY_TASKS = 50;

/** 数据源里各表最近一次成功采集到的列统计（带声明的业务主键）：表不在同步范围、还没采集时返回原因 */
async function profiledTables(tenantId: string, sourceId: string) {
  const { listing, tables } = await confirmedTables(tenantId, sourceId);
  return (table: string) => {
    const profiled = tables.find(t => t.table.name === table);
    if (profiled) return profiled;
    const listed = listing.find(t => t.tableName === table);
    if (!listed || (listed.goneAt && !listed.inScope)) return `数据源中没有表 ${table}`;
    if (!listed.inScope) return `表 ${table} 不在同步范围内，请先在数据源页选入`;
    if (listed.goneAt) return `源端已不存在表 ${table}`;
    if (!listed.readable) return `账号没有表 ${table} 的读权限`;
    return `表 ${table} 还没有采集到列统计，请等采集完成`;
  };
}

/** 数据源里各表的字段（最近一次成功采集到的）：表不在同步范围、还没采集时返回原因 */
async function sourceColumns(tenantId: string, sourceId: string) {
  const lookup = await profiledTables(tenantId, sourceId);
  return (table: string) => {
    const profiled = lookup(table);
    return typeof profiled === 'string' ? profiled : profiled.table.columns.map(c => c.name);
  };
}

/**
 * 编写映射时对照的源表（同步范围内、已采集的）：各列的类型、空值率、不同取值数与常见取值，
 * 主键（源端主键，没有时为声明的业务主键）与确认的水位线字段
 */
export async function referenceTables(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  const { tables } = await confirmedTables(actor.tenant.id, sourceId);
  return tables.map(({ table, watermark, key }) => ({
    name: table.name,
    sampleRows: table.sampleRows,
    // 旧的采集结果里没有主键信息
    primaryKey: table.primaryKey?.length ? table.primaryKey : (key ?? []),
    watermark: watermark?.column ?? null,
    columns: table.columns.map(c => ({ name: c.name, type: c.type, nullRate: c.nullRate, distinct: c.distinct, top: c.top ?? null })),
  }));
}

/**
 * 按规则生成映射草稿（ADR-0017）：对照源表最近一次采集的列统计与目标实体，返回 YAML 文本。不调用模型、不保存、不记审计，
 * 成员确认修改后仍走保存校验与双人发布
 */
export async function draftFor(actor: CurrentMember, sourceId: string, table: string, entity: string) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId).catch(() => { throw new MappingError('请选择数据源'); });
  if (!table) throw new MappingError('请选择表');
  const target = entityOf(entity);
  if (!target) throw new MappingError(`只能为标准实体生成草稿，${entity} 不是标准实体`);
  const profiled = (await profiledTables(actor.tenant.id, sourceId))(table);
  if (typeof profiled === 'string') throw new MappingError(profiled);
  return draftMapping(profiled.table, target, { key: profiled.key ?? undefined });
}

/** 为已有映射（它的源表与实体）按规则生成草稿 */
export async function draftForMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  return draftFor(actor, mapping.sourceId, mapping.tableName, mapping.entity);
}

/** 校验映射文档（对照数据源的字段），不通过时抛出带问题列表的 MappingError */
async function checked(tenantId: string, sourceId: string, yaml: string) {
  const result = checkMapping(yaml, await sourceColumns(tenantId, sourceId));
  if (!result.ok) throw new MappingError(`映射有 ${result.issues.length} 处问题，未保存`, 400, result.issues);
  return result;
}

async function requireMapping(tenantId: string, mappingId: string, tx: Tx | ReturnType<typeof getDb> = getDb()) {
  if (!/^[0-9a-f-]{36}$/i.test(mappingId)) throw new MappingError('映射不存在', 404);
  const [row] = await tx.select().from(mappings).where(and(eq(mappings.id, mappingId), eq(mappings.tenantId, tenantId)));
  if (!row) throw new MappingError('映射不存在', 404);
  return row;
}

/** 新建映射：文档校验通过后保存为第一版草稿。同一数据源的同一张表到同一个实体只能有一个映射 */
export async function createMapping(actor: CurrentMember, sourceId: string, yaml: string) {
  assertCan(actor, 'sources:write');
  const source = await requireSource(actor.tenant.id, sourceId).catch(() => { throw new MappingError('请选择数据源'); });
  const { plan } = await checked(actor.tenant.id, sourceId, yaml);
  try {
    return await getDb().transaction(async tx => {
      const [mapping] = await tx.insert(mappings).values({
        tenantId: actor.tenant.id, spaceId: actor.space.id, sourceId, tableName: plan.table, entity: plan.entity,
      }).returning();
      await tx.insert(mappingVersions).values({ mappingId: mapping.id, version: 1, yaml, plan, authors: [actor.email] });
      await recordAudit(tx, {
        tenantId: actor.tenant.id,
        actor,
        action: 'mapping.drafted',
        targetType: 'mapping',
        targetId: mapping.id,
        detail: { source: source.name, table: plan.table, entity: plan.entity, version: 1 },
      });
      return mapping;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new MappingError(`「${source.name}」的 ${plan.table} 已有到 ${entityLabel(plan.entity)} 的映射，请在那个映射上修改`);
    throw e;
  }
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 表与实体在第一版就定下了，换表或换实体请新建映射
 */
export async function saveDraft(actor: CurrentMember, mappingId: string, yaml: string) {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const { plan } = await checked(actor.tenant.id, mapping.sourceId, yaml);
  if (plan.table !== mapping.tableName || plan.entity !== mapping.entity) {
    throw new MappingError(`这个映射是 ${mapping.tableName} → ${mapping.entity}，不能改表或实体；请新建映射`);
  }
  return getDb().transaction(async tx => {
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const [latest] = await tx.select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      const authors = latest.authors.includes(actor.email) ? latest.authors : [...latest.authors, actor.email];
      await tx.update(mappingVersions).set({ yaml, plan, authors, updatedAt: new Date() }).where(eq(mappingVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(mappingVersions).values({ mappingId, version, yaml, plan, authors: [actor.email] });
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.drafted',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version },
    });
    return version;
  });
}

/** 有发布权限的成员发布不了某一版的原因（不是草稿、是这一版的作者）；可以发布时为 null。发布权限由调用方另行检查 */
export function publishBlocker(actor: CurrentMember, version: { status: string; authors: string[] }) {
  if (version.status !== 'draft') return '已发布的版本已锁定';
  if (version.authors.includes(actor.email)) return '你改过这一版草稿，需由另一位数据工程师或管理员发布';
  return null;
}

/**
 * 扩展字段在同一实体上的类型必须一致：与已发布映射（含本映射之前发布的版本）里同名扩展字段的类型冲突时拒绝。
 * 标准层表的列一旦建好不改类型，换类型请换一个字段名
 */
async function assertExtensionTypes(tx: Tx, tenantId: string, plan: MergePlan) {
  const others = await publishedPlans(tx, tenantId);
  for (const other of others.filter(o => o.entity === plan.entity)) {
    for (const c of plan.entityColumns) {
      const clash = other.entityColumns.find(o => o.name === c.name && o.type !== c.type);
      if (clash) throw new MappingError(`字段 ${c.name} 在已发布的映射里是 ${clash.type}，这里是 ${c.type}：同一实体上的扩展字段类型必须一致`);
    }
  }
}

/**
 * 发布草稿：需要发布权限，且发布者不能是这一版草稿的作者（双人发布）。发布前对照数据源当前的字段再校验一次。
 * 发布后版本锁定，并入队一次合并（已有合并在排队或运行时，由调度器在它之后补上）
 */
export async function publishMapping(actor: CurrentMember, mappingId: string, version: number) {
  assertCan(actor, 'publish');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [draft] = await getDb().select().from(mappingVersions)
    .where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.version, version)));
  if (!draft) throw new MappingError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new MappingError(blocker, draft.status === 'draft' ? 403 : 400);
  const { plan } = await checked(actor.tenant.id, mapping.sourceId, draft.yaml);
  return getDb().transaction(async tx => {
    // 锁住映射行：与保存草稿互斥，发布的正是检查过的那份草稿
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const [current] = await tx.select().from(mappingVersions).where(eq(mappingVersions.id, draft.id));
    if (current.status !== 'draft' || current.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw new MappingError('草稿在你发布前被修改或已发布，请刷新后重新检查');
    }
    await assertExtensionTypes(tx, actor.tenant.id, plan);
    await tx.update(mappingVersions)
      .set({ status: 'published', plan, publishedByEmail: actor.email, publishedAt: new Date() })
      .where(eq(mappingVersions.id, draft.id));
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.published',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version, authors: draft.authors },
    });
    return enqueueMerge(tx, actor.tenant.id);
  });
}

/** 租户各映射最新的已发布版本及其合并计划（合并任务的参数） */
async function publishedPlans(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<MergeMappingParam[]> {
  const rows = await db
    .selectDistinctOn([mappingVersions.mappingId], {
      mapping: mappings.id, sourceId: mappings.sourceId, version: mappingVersions.version, plan: mappingVersions.plan,
    })
    .from(mappingVersions)
    .innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
    .where(and(eq(mappings.tenantId, tenantId), eq(mappingVersions.status, 'published')))
    .orderBy(mappingVersions.mappingId, desc(mappingVersions.version));
  return rows
    .sort((a, b) => a.mapping.localeCompare(b.mapping))
    .map(r => ({ ...r.plan, mapping: r.mapping, version: r.version, sourceId: r.sourceId }));
}

const ofMerge = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'));

/**
 * 在调用方的事务里入队一次合并（全部已发布映射的最新版本）。锁住租户行后检查：同一租户同时只有一个合并在排队或运行
 * （两个合并同时写同一张标准层表会冲突）；已有时不入队，返回 null。没有已发布的映射时也不入队
 */
export async function enqueueMerge(tx: Tx, tenantId: string) {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  const [pending] = await tx.select({ id: tasks.id }).from(tasks).where(and(ofMerge(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
  if (pending) return null;
  const plans = await publishedPlans(tx, tenantId);
  if (!plans.length) return null;
  return insertTask(tx, tenantId, 'silver.merge', { mappings: plans });
}

/** 同步结束后合并一次（调度器在同步任务结束时调用）：租户停用或没有已发布的映射时什么都不做 */
export async function mergeAfterSync(tenantId: string) {
  return getDb().transaction(async tx => {
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant || tenant.suspendedAt) return null;
    return enqueueMerge(tx, tenantId);
  });
}

/** 成员手动触发一次合并 */
export async function mergeNow(actor: CurrentMember) {
  assertCan(actor, 'sources:write');
  const task = await getDb().transaction(tx => enqueueMerge(tx, actor.tenant.id));
  if (task) return task;
  const [pending] = await getDb().select({ id: tasks.id }).from(tasks).where(and(ofMerge(actor.tenant.id), inArray(tasks.status, ['queued', 'running']))).limit(1);
  throw new MappingError(pending ? '已有一次合并在排队或运行中' : '还没有已发布的映射');
}

/**
 * 为到期的租户入队合并（调度器定期调用）：租户未停用、有已发布的映射、没有合并在排队或运行，
 * 且最近一次合并之后有同步结束或有映射发布（合并运行期间发生的变化由此补上）。返回入队的租户
 */
export async function enqueueDueMerges() {
  const { rows } = await getDb().execute<{ tenant_id: string }>(sql`
    SELECT DISTINCT m.tenant_id FROM ${mappings} m
    JOIN ${tenants} t ON t.id = m.tenant_id AND t.suspended_at IS NULL
    JOIN ${mappingVersions} v ON v.mapping_id = m.id AND v.status = 'published'
    CROSS JOIN LATERAL (SELECT max(created_at) AS at FROM ${tasks} WHERE tenant_id = m.tenant_id AND kind = 'silver.merge') last
    WHERE last.at IS NULL
      OR v.published_at > last.at
      OR EXISTS (SELECT 1 FROM ${tasks} s WHERE s.tenant_id = m.tenant_id AND s.kind = 'source.sync' AND s.finished_at > last.at)
    ORDER BY m.tenant_id`);
  const enqueued: string[] = [];
  for (const { tenant_id: tenantId } of rows) {
    try {
      if (await getDb().transaction(tx => enqueueMerge(tx, tenantId))) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的合并入队失败`, e);
    }
  }
  return enqueued;
}

/** 一个映射最近一次合并的结果，带所属任务 */
export type MergeHistoryEntry = MergeRecord & { taskId: string };

/** 最近的合并任务（任何状态）与每个映射最近的合并结果（新的在前） */
async function mergeStatus(tenantId: string) {
  const runs = await getDb().select().from(tasks).where(ofMerge(tenantId)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(HISTORY_TASKS);
  const history: Record<string, MergeHistoryEntry[]> = {};
  for (const run of runs) {
    for (const record of (run.result?.mappings ?? []) as MergeRecord[]) (history[record.mapping] ??= []).push({ ...record, taskId: run.id });
  }
  const [latest] = runs;
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
    history,
  };
}

/** 本租户的映射：数据源、源表、实体、已发布的最新版本与草稿，以及最近一次合并的结果 */
export async function listMappings(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const rows = await getDb()
    .select({ mapping: mappings, sourceName: sources.name })
    .from(mappings)
    .innerJoin(sources, eq(sources.id, mappings.sourceId))
    .where(eq(mappings.tenantId, actor.tenant.id))
    .orderBy(mappings.entity, sources.name, mappings.tableName);
  const versions = rows.length
    ? await getDb().select({ mappingId: mappingVersions.mappingId, version: mappingVersions.version, status: mappingVersions.status })
      .from(mappingVersions).where(inArray(mappingVersions.mappingId, rows.map(r => r.mapping.id)))
    : [];
  const merge = await mergeStatus(actor.tenant.id);
  return {
    merge,
    mappings: rows.map(({ mapping, sourceName }) => {
      const mine = versions.filter(v => v.mappingId === mapping.id);
      return {
        ...mapping,
        sourceName,
        published: Math.max(0, ...mine.filter(v => v.status === 'published').map(v => v.version)) || null,
        draft: mine.find(v => v.status === 'draft')?.version ?? null,
        lastMerge: merge.history[mapping.id]?.[0] ?? null,
      };
    }),
  };
}

/** 映射详情：各版本（新的在前）、当前成员能否发布草稿及原因，以及合并历史 */
export async function getMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:read');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [source] = await getDb().select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
  const versions = await getDb().select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
  const merge = await mergeStatus(actor.tenant.id);
  return {
    ...mapping,
    source,
    versions: versions.map(v => ({
      version: v.version,
      status: v.status,
      yaml: v.yaml,
      authors: v.authors,
      publishedBy: v.publishedByEmail,
      publishedAt: v.publishedAt,
      updatedAt: v.updatedAt,
      publishBlocker: v.status === 'draft' ? publishBlocker(actor, v) : null,
    })),
    merge: { ...merge, history: merge.history[mappingId] ?? [] },
  };
}

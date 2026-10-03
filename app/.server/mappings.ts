// app/.server/mappings.ts —— 映射：数据工程师用 YAML 编写“源表 → 标准实体”的映射，校验通过才能保存为草稿；草稿由最后保存它的人以外的
// 另一位有发布权限的成员发布，也可以丢弃（回到最近的已发布版本），发布后版本锁定（再改是新的一版草稿）。发布后为这个映射入队合并任务（silver.merge），同步给已发布映射的源表写入变更后也为这些映射再合并一次，把原始层的变更批次合并进标准层（ADR-0015）。
// 一律限定在操作者所属租户内；合并本身在工作进程里进行（pipeline/merge-engine.ts）
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { assertCan, can } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { mappings, mappingVersions, members, ROLES, sources, tasks, tenants, type TaskStatus } from './db/schema';
import type { MergeMappingParam, MergeRecord } from './pipeline/merge-engine';
import { draftMapping } from './pipeline/mapping-draft';
import { checkMapping, mappingTemplate, type MappingIssue, type MergePlan } from './pipeline/mapping-spec';
import { requireSource } from './source-config';
import { confirmedTables } from './sources';
import { insertTask } from './tasks';
import { CANONICAL_ENTITIES, entityLabel, entityOf } from '../lib/canonical-model';
import { entityForTable } from '../lib/field-synonyms';

/** 可以展示给成员的业务错误；issues 是映射文档里带行列位置的问题 */
export class MappingError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400, readonly issues: MappingIssue[] = []) { super(message); }
}

/** 映射详情的合并历史取最近多少次带这个映射的合并任务 */
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
    return typeof profiled === 'string' ? profiled : profiled.table.columns.map(c => ({ name: c.name, type: c.type }));
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
    // formats：表单新建扩展字段时据此判断是否像敏感信息
    columns: table.columns.map(c => ({ name: c.name, type: c.type, nullRate: c.nullRate, distinct: c.distinct, top: c.top ?? null, formats: c.formats ?? [] })),
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

/**
 * 新建映射时编辑框的默认内容：数据源里第一张能按表名认出实体的已采集表的草稿（都认不出时取第一张表、第一个实体）；
 * 没有已采集的表、生成不了时是模板
 */
export async function defaultDraft(actor: CurrentMember, sourceId: string) {
  const candidates = (await referenceTables(actor, sourceId)).map(t => ({ table: t.name, entity: entityForTable(t.name) }));
  const pick = candidates.find(c => c.entity) ?? candidates[0];
  if (!pick) return mappingTemplate('order', 'orders');
  try {
    return await draftFor(actor, sourceId, pick.table, (pick.entity ?? CANONICAL_ENTITIES[0]).name);
  } catch (e) {
    if (e instanceof MappingError) return mappingTemplate('order', 'orders');
    throw e;
  }
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
      await tx.insert(mappingVersions).values({ mappingId: mapping.id, version: 1, yaml, plan, authors: [actor.email], lastEditor: actor.email });
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
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
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
    // 锁住映射行；等锁期间映射可能因丢弃草稿被删除
    const [locked] = await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    if (!locked) throw new MappingError('映射不存在', 404);
    const [latest] = await tx.select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      const authors = latest.authors.includes(actor.email) ? latest.authors : [...latest.authors, actor.email];
      await tx.update(mappingVersions).set({ yaml, plan, authors, lastEditor: actor.email, updatedAt: new Date() }).where(eq(mappingVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(mappingVersions).values({ mappingId, version, yaml, plan, authors: [actor.email], lastEditor: actor.email });
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
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。发布前对照数据源当前的字段再校验一次。
 * 发布后版本锁定，并为这个映射入队一次合并（已有合并在排队时补进那个合并，在运行时由调度器在它之后补上）
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
    // 先锁住租户行（入队合并也锁它）：与入队合并、定时检查互斥
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, actor.tenant.id)).for('update');
    // 锁住映射行：与保存草稿互斥，发布的正是检查过的那份草稿
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    // 等锁期间草稿可能已被丢弃
    const [current] = await tx.select().from(mappingVersions).where(eq(mappingVersions.id, draft.id));
    if (!current || current.status !== 'draft' || current.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw new MappingError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    }
    await assertExtensionTypes(tx, actor.tenant.id, plan);
    await tx.update(mappingVersions)
      .set({ status: 'published', plan, publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(mappingVersions.id, draft.id));
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.published',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
    return enqueueMerge(tx, actor.tenant.id, [mappingId]);
  });
}

/**
 * 丢弃草稿：映射回到最近的已发布版本；从没发布过的映射整个删除（可以重新新建同一个“表 → 实体”映射）。
 * 用于草稿卡住（如最后保存的人离职）的情况。返回映射是否还在
 */
export async function discardDraft(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  return getDb().transaction(async tx => {
    const mapping = await requireMapping(actor.tenant.id, mappingId, tx);
    // 锁住映射行：与保存、发布互斥
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const versions = await tx.select({ id: mappingVersions.id, version: mappingVersions.version, status: mappingVersions.status })
      .from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new MappingError('这个映射没有草稿');
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除映射，各版本随之级联删除
    if (published) await tx.delete(mappingVersions).where(eq(mappingVersions.id, draft.id));
    else await tx.delete(mappings).where(eq(mappings.id, mappingId));
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.draft_discarded',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version: draft.version, published },
    });
    return { kept: published !== null };
  });
}

/** 本租户有发布权限的成员人数 */
async function publisherCount(tenantId: string) {
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(members)
    .where(and(eq(members.tenantId, tenantId), inArray(members.role, ROLES.filter(r => can(r, 'publish')))));
  return n;
}

/** 租户各映射（给了 mappingIds 时只取这些）最新的已发布版本及其合并计划（合并任务的参数） */
export async function publishedPlans(db: Tx | ReturnType<typeof getDb>, tenantId: string, mappingIds?: string[]): Promise<MergeMappingParam[]> {
  if (mappingIds && !mappingIds.length) return [];
  const rows = await db
    .selectDistinctOn([mappingVersions.mappingId], {
      mapping: mappings.id, sourceId: mappings.sourceId, version: mappingVersions.version, plan: mappingVersions.plan,
    })
    .from(mappingVersions)
    .innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
    .where(and(eq(mappings.tenantId, tenantId), eq(mappingVersions.status, 'published'), mappingIds && inArray(mappings.id, mappingIds)))
    .orderBy(mappingVersions.mappingId, desc(mappingVersions.version));
  return rows
    .sort((a, b) => a.mapping.localeCompare(b.mapping))
    .map(r => ({ ...r.plan, mapping: r.mapping, version: r.version, sourceId: r.sourceId }));
}

const ofMerge = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'));

/**
 * 在调用方的事务里为给定映射（不给时为全部已发布映射）的最新已发布版本入队一次合并，返回带上它们的合并任务。
 * 锁住租户行后检查：同一租户同时只有一个合并在排队或运行（两个合并同时写同一张标准层表会冲突）。
 * 已有合并在排队时把映射补进去（同一映射换成最新版本）；已在运行（或补的时候刚被领取）时不入队，返回 null，由定时检查在它之后补上。
 * 给定的映射都没有已发布版本时也不入队
 */
export async function enqueueMerge(tx: Tx, tenantId: string, mappingIds?: string[]) {
  await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  const plans = await publishedPlans(tx, tenantId, mappingIds);
  if (!plans.length) return null;
  const [pending] = await tx.select().from(tasks).where(and(ofMerge(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
  if (!pending) return insertTask(tx, tenantId, 'silver.merge', { mappings: plans });
  if (pending.status !== 'queued') return null;
  const queued = (pending.params.mappings ?? []) as MergeMappingParam[];
  const merged = [...queued.filter(q => !plans.some(p => p.mapping === q.mapping)), ...plans].sort((a, b) => a.mapping.localeCompare(b.mapping));
  // 领取合并不锁租户行：只在它仍在排队时改参数
  const [task] = await tx.update(tasks).set({ params: { ...pending.params, mappings: merged } })
    .where(and(eq(tasks.id, pending.id), eq(tasks.status, 'queued'))).returning();
  return task ?? null;
}

/**
 * 同步任务 s 是否给已发布映射 m 的源表写入了变更：同一数据源、同一张表、本批次写进原始层的行数大于 0（删除也算在内）。
 * 比对周期里同一张表有两条记录，任意一条有变更即可；失败的记录没有 rows，自然排除（部分失败的任务照样参与判断）。
 * 同步后的合并与定时检查共用这个判断（ADR-0015）
 */
const syncWroteMappingTable = (s: 's', m: 'm') => sql.raw(`${s}.kind = 'source.sync' AND ${s}.params->>'sourceId' = ${m}.source_id::text
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(${s}.result->'tables') r WHERE r->>'table' = ${m}.table_name AND (r->>'rows')::int > 0)`);

/**
 * 同步结束后合并一次（调度器在同步任务结束时调用）：只为这次同步给源表写入了变更的已发布映射入队，没有这样的映射时不入队；
 * 租户停用时什么都不做
 */
export async function mergeAfterSync(tenantId: string, syncTaskId: string) {
  return getDb().transaction(async tx => {
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant || tenant.suspendedAt) return null;
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT m.id FROM ${tasks} s
      JOIN ${mappings} m ON m.tenant_id = s.tenant_id
      WHERE s.id = ${syncTaskId} AND ${syncWroteMappingTable('s', 'm')}
        AND EXISTS (SELECT 1 FROM ${mappingVersions} v WHERE v.mapping_id = m.id AND v.status = 'published')`);
    if (!rows.length) return null;
    return enqueueMerge(tx, tenantId, rows.map(r => r.id));
  });
}

/** 成员手动触发一次合并（全部已发布映射）；已有合并在排队时把全部映射补进去，在运行时报错 */
export async function mergeNow(actor: CurrentMember) {
  assertCan(actor, 'sources:write');
  const task = await getDb().transaction(tx => enqueueMerge(tx, actor.tenant.id));
  if (task) return task;
  const [pending] = await getDb().select({ id: tasks.id }).from(tasks).where(and(ofMerge(actor.tenant.id), inArray(tasks.status, ['queued', 'running']))).limit(1);
  throw new MappingError(pending ? '已有一次合并在排队或运行中' : '还没有已发布的映射');
}

/** 成员在映射详情页手动合并这一个映射（最新已发布版本）；已有合并在排队时把它补进去，在运行时报错（之后还有没合并的版本或变更时由定时检查补上） */
export async function mergeMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  await requireMapping(actor.tenant.id, mappingId);
  return getDb().transaction(async tx => {
    const task = await enqueueMerge(tx, actor.tenant.id, [mappingId]);
    if (task) return task;
    // 在同一个事务里判断原因：排队中的合并恰被领取时，这里读到的是运行中
    if (!(await publishedPlans(tx, actor.tenant.id, [mappingId])).length) throw new MappingError('这个映射还没有已发布的版本');
    throw new MappingError('已有一次合并在运行；它结束后，这个映射还有没合并的版本或变更时由定时检查补上');
  });
}

/** 合并任务的参数 params 带了映射 mappingId（任一版本） */
const mergeHas = (params: SQL, mappingId: SQL) => sql`${params}->'mappings' @> jsonb_build_array(jsonb_build_object('mapping', ${mappingId}))`;

/**
 * 到期要合并的映射（给了 tenantId 时只看这个租户）：映射已发布、租户未停用，带它的最近一次合并 last 不在排队，且
 * (a) last 带的不是它最新的已发布版本（还没合并过也算；last 失败了也算带过，不自动重试），或
 * (b) last 开始之后有同步结束并给它的源表写入了变更（合并运行期间发生的变化由此补上）。
 * 同一租户的合并一个接一个，入队或补映射时都在租户锁里取最新的已发布版本，所以 last 带的就是合并过的最高版本；
 * 按版本而不按发布时间判断 (a)：发布时间是事务开始时间，可能早于并发领取的合并的开始时间。
 * 只找最近一次（按入队时间倒序走索引），不随历史合并增多而变慢
 */
async function dueMappings(db: Tx | ReturnType<typeof getDb>, tenantId?: string) {
  const { rows } = await db.execute<{ tenant_id: string; mapping_id: string }>(sql`
    SELECT m.tenant_id, m.id AS mapping_id FROM ${mappings} m
    JOIN ${tenants} t ON t.id = m.tenant_id AND t.suspended_at IS NULL
    CROSS JOIN LATERAL (SELECT max(version) AS version FROM ${mappingVersions} WHERE mapping_id = m.id AND status = 'published') v
    LEFT JOIN LATERAL (
      SELECT l.status, coalesce(l.started_at, l.created_at) AS at,
        (SELECT (e->>'version')::int FROM jsonb_array_elements(l.params->'mappings') e WHERE e->>'mapping' = m.id::text) AS version
      FROM ${tasks} l
      WHERE l.tenant_id = m.tenant_id AND l.kind = 'silver.merge' AND ${mergeHas(sql`l.params`, sql`m.id::text`)}
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) last ON true
    WHERE v.version IS NOT NULL ${tenantId ? sql`AND m.tenant_id = ${tenantId}` : sql``}
      AND last.status IS DISTINCT FROM 'queued'
      AND (
        last.version IS DISTINCT FROM v.version
        OR EXISTS (SELECT 1 FROM ${tasks} s WHERE s.tenant_id = m.tenant_id AND s.finished_at > last.at AND ${syncWroteMappingTable('s', 'm')})
      )
    ORDER BY m.tenant_id, m.id`);
  return rows;
}

/** 为到期的映射入队合并（调度器定期调用），每个租户一个合并；已有合并在排队时补进去。返回入队（或补进）合并的租户 */
export async function enqueueDueMerges() {
  const tenantIds = [...new Set((await dueMappings(getDb())).map(r => r.tenant_id))];
  const enqueued: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      const task = await getDb().transaction(async tx => {
        // 先锁住租户行再算一次（enqueueMerge 里再锁是同一把锁）：查询之后可能已有发布、同步或合并入队
        await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
        return enqueueMerge(tx, tenantId, (await dueMappings(tx, tenantId)).map(r => r.mapping_id));
      });
      if (task) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的合并入队失败`, e);
    }
  }
  return enqueued;
}

/** 一个映射最近一次合并的结果，带所属任务 */
export type MergeHistoryEntry = MergeRecord & { taskId: string };

/** 本租户最近一次合并任务（任何状态） */
async function tenantLatestMerge(tenantId: string) {
  const [latest] = await getDb().select().from(tasks).where(ofMerge(tenantId)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
  };
}

/** 各映射最近一次合并的结果（每个映射分别找带它的最近一次合并任务，不受别的映射合并得多少影响） */
async function lastMergeByMapping(tenantId: string, mappingIds: string[]) {
  if (!mappingIds.length) return {};
  const { rows } = await getDb().execute<{ mapping_id: string; task_id: string; record: MergeRecord }>(sql`
    SELECT m.id AS mapping_id, r.task_id, r.record FROM unnest(ARRAY[${sql.join(mappingIds.map(id => sql`${id}`), sql`, `)}]::uuid[]) m(id)
    CROSS JOIN LATERAL (
      SELECT t.id AS task_id, rec AS record FROM ${tasks} t, jsonb_array_elements(t.result->'mappings') rec
      WHERE t.tenant_id = ${tenantId} AND t.kind = 'silver.merge' AND rec->>'mapping' = m.id::text
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1
    ) r`);
  return Object.fromEntries(rows.map(r => [r.mapping_id, { ...r.record, taskId: r.task_id } as MergeHistoryEntry]));
}

/**
 * 一个映射的合并状态与历史（新的在前）：只看带这个映射的合并任务。结束了的任务按这个映射自己的结果判断成败，
 * 别的映射合并失败不算在它头上
 */
async function mergesOfMapping(tenantId: string, mappingId: string) {
  const runs = await getDb().select().from(tasks).where(and(ofMerge(tenantId), mergeHas(sql`${tasks.params}`, sql`${mappingId}::text`)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(HISTORY_TASKS);
  const history = runs.flatMap(run => ((run.result?.mappings ?? []) as MergeRecord[])
    .filter(r => r.mapping === mappingId).map(r => ({ ...r, taskId: run.id }) as MergeHistoryEntry));
  const [latest] = runs;
  const own = latest && ((latest.result?.mappings ?? []) as MergeRecord[]).find(r => r.mapping === mappingId);
  const status: TaskStatus | 'none' = !latest ? 'none' : own ? ('error' in own ? 'failed' : 'succeeded') : latest.status;
  return { status, history };
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
  const merge = await tenantLatestMerge(actor.tenant.id);
  const last = await lastMergeByMapping(actor.tenant.id, rows.map(r => r.mapping.id));
  return {
    merge,
    mappings: rows.map(({ mapping, sourceName }) => {
      const mine = versions.filter(v => v.mappingId === mapping.id);
      return {
        ...mapping,
        sourceName,
        published: Math.max(0, ...mine.filter(v => v.status === 'published').map(v => v.version)) || null,
        draft: mine.find(v => v.status === 'draft')?.version ?? null,
        lastMerge: last[mapping.id] ?? null,
      };
    }),
  };
}

/** 映射详情：各版本（新的在前）、当前成员能否发布草稿及原因、本租户有发布权限的成员人数，以及合并历史 */
export async function getMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:read');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [source] = await getDb().select({ id: sources.id, name: sources.name, kind: sources.kind }).from(sources).where(eq(sources.id, mapping.sourceId));
  const versions = await getDb().select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
  const merge = await mergesOfMapping(actor.tenant.id, mappingId);
  return {
    ...mapping,
    source,
    publishers: await publisherCount(actor.tenant.id),
    versions: versions.map(v => ({
      version: v.version,
      status: v.status,
      yaml: v.yaml,
      authors: v.authors,
      lastEditor: v.lastEditor,
      publishedBy: v.publishedByEmail,
      publishedAt: v.publishedAt,
      updatedAt: v.updatedAt,
      publishBlocker: v.status === 'draft' ? publishBlocker(actor, v) : null,
    })),
    merge,
  };
}

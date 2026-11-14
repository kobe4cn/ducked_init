// app/.server/merges.ts —— 合并编排与合并结果（ADR-0053）：发布、停用或源视图变更后为受影响的已发布映射入队合并任务（silver.merge），
// 同步给已发布映射的源表写入变更后再合并一次（mergeAfterSync），定时检查补上漏掉的合并（enqueueDueMerges），成员手动合并与重建
// （报 MergeError）。合并任务把工作进程要用的参数（合并计划、身份打通的规则、要统计孤儿的关系）一次带全，工作进程不读平台库；
// 合并结果的读取（打通摘要、孤儿统计、各映射的最近一次合并）也在这里，mappings.ts 只管映射的定义生命周期（ADR-0015、ADR-0053）。
// 一律限定在操作者所属租户内；合并本身在工作进程里进行（pipeline/merge-engine.ts）
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { assertCan } from './access';
import type { Tx } from './audit';
import type { CurrentMember } from './auth';
import { allRelations, publishedCustomEntities, type RegisteredEntity, uniqueKeys } from './custom-entities';
import { getDb } from './db/client';
import { mappings, mappingVersions, sourceViewVersions, tasks, tenants, type TaskStatus } from './db/schema';
import { excludedHashes } from './identity-exclusions';
import { publishedMergeGroups } from './merge-groups';
import { mappingName, publishedPlans, requireMapping } from './mappings';
import { consumerSensitive, identityRules, type IdentitySummary } from './pipeline/identity-engine';
import { groupMemberOf, type MergeDrop, type MergeMappingParam, type MergeRecord, type RelationParam } from './pipeline/merge-engine';
import { isSensitiveField, type PublishedPlan } from './pipeline/mapping-spec';
import { readResult } from './pipeline/task-contracts';
import { PublishError } from './publishing';
import { insertTask, updateQueuedParams } from './tasks';
import { lockTenant } from './tenant-lock';
import { type RelationStat, relationText } from '../lib/canonical-model';
import { cmp } from '../lib/compare';

/** 手动合并与重建（mergeNow、mergeMapping、rebuildEntity）报的业务错误；不继承 MappingError——merges 与 mappings 互相引用，顶层 extends 会撞上循环加载的 TDZ */
export class MergeError extends PublishError {
  constructor(message: string, status: 400 | 403 | 404 | 422 = 400) { super(message, status); }
}

/** 映射详情的合并历史取最近多少次带这个映射的合并任务 */
const HISTORY_TASKS = 50;

/**
 * 已发布计划再补上合并任务的参数（合并入口与主键体检用，ADR-0053）：写入全部实体（customer 除外，ADR-0024「独占」）的映射带上
 * 实体主键 uniqueKey，合并时跨映射查重；主键含指向 customer 的字段时另带 uniqueBySource，只在同一个数据源内查重。
 * 在已发布合并组里、组里可用（已发布、未停用、仍写入该实体）的组员至少 2 个的映射带上 group（ADR-0032），组员按优先级排。
 * 合并组要看全部组员：给了 mappingIds 时把它们所在组的组员一并取来算 group，最后只返回给定的映射
 */
export async function mergePlans(db: Tx | ReturnType<typeof getDb>, tenantId: string, mappingIds?: string[]): Promise<MergeMappingParam[]> {
  if (mappingIds && !mappingIds.length) return [];
  const groups = await publishedMergeGroups(db, tenantId);
  const wanted = mappingIds && [...new Set([...mappingIds, ...[...groups.values()].flatMap(g => (g.members.some(m => mappingIds.includes(m)) ? g.members : []))])];
  const plans = await publishedPlans(db, tenantId, wanted);
  const uniqueByEntity = uniqueKeys(await publishedCustomEntities(db, tenantId));
  const withKeys = plans.map(plan => {
    const unique = uniqueByEntity.get(plan.entity);
    return { ...plan, ...(unique && { uniqueKey: unique.key, ...(unique.bySource && { uniqueBySource: true }) }) };
  });
  const withGroups = withKeys.map(plan => {
    const group = groups.get(plan.entity);
    if (!group?.members.includes(plan.mapping) || !plan.uniqueKey) return plan;
    // 组失效（可用组员不到 2 个）时不带，组员之间照常查独占
    const members = group.members.flatMap(id => withKeys.filter(p => p.mapping === id && p.entity === plan.entity));
    if (members.length < 2) return plan;
    return { ...plan, group: { id: group.id, rule: group.rule, key: plan.uniqueKey, members: members.map(groupMemberOf) } };
  });
  return mappingIds ? withGroups.filter(p => mappingIds.includes(p.mapping)) : withGroups;
}

const ofMerge = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'));

/** 租户在排队或运行中的合并（同一租户同时只有一个） */
export async function pendingMerge(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const [pending] = await db.select().from(tasks).where(and(ofMerge(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
  return pending;
}

/**
 * 这次合并是否要强制重算身份打通（工作进程只看这次改没改到 customer / event，判断不出下面几种情况）：取本租户最近一次真正跑过打通
 * （结果里有 identities 且不是跳过）或没写结果就结束（崩溃、超时，之前提交的映射可能已改了 customer / event）的合并，
 * 它不存在、没写结果、打通失败了，或它的匹配规则与这次的 identity、属性取舍的名次与这次的 survivorship、不参与匹配的值与这次的 exclude（ADR-0039）不同时强制。
 * 多算一次没有坏处，宁可偏向强制
 */
export async function mustRecomputeIdentities(db: Tx, tenantId: string, identity: unknown, survivorship: Record<string, number>, exclude: string[]) {
  const [last] = await db.select({ params: tasks.params, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), inArray(tasks.status, ['succeeded', 'failed']),
      sql`(${tasks.result} IS NULL OR ${tasks.result} ? 'identities' AND NOT (${tasks.result}->'identities') ? 'skipped')`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const r = readResult('silver.merge', last);
  return !r || !r.identities || 'error' in r.identities
    || JSON.stringify(last.params.identity ?? null) !== JSON.stringify(identity ?? null)
    || JSON.stringify(rankEntries(last.params.survivorship)) !== JSON.stringify(rankEntries(survivorship))
    || JSON.stringify(sortedHashes(last.params.identityExclude)) !== JSON.stringify(exclude);
}

/** 属性取舍的名次（ADR-0027）：各已发布 customer 映射里配置的名次，映射 ID → 名次（没配置的映射不在里面） */
const survivorshipPriority = (plans: PublishedPlan[]): Record<string, number> =>
  Object.fromEntries(plans.filter(p => p.entity === 'customer' && p.survivorship).map(p => [p.mapping, p.survivorship!.priority]));

/** 名次表按映射 ID 排好的键值对，用来比对是否变了（早先的合并参数里没有这一项，等同于空表） */
const rankEntries = (ranks: unknown) => Object.entries((ranks ?? {}) as Record<string, number>).sort(([a], [b]) => cmp(a, b));

/** 排好序的排除列表，用来比对是否变了（早先的合并参数里没有这一项，等同于空列表） */
const sortedHashes = (hashes: unknown) => [...((hashes ?? []) as string[])].sort();

/**
 * 合并后要统计孤儿的关系：全部已发布关系（内置 ref 与已发布登记上的），带上起点是否敏感（isSensitiveField；标准层里是哈希，不给样例键）
 */
export function relationParams(published: Map<string, RegisteredEntity>, plans: PublishedPlan[]): RelationParam[] {
  return allRelations(published).map(r => ({ ...r, sensitive: isSensitiveField(r.from, e => published.get(e)?.fields, plans) }));
}

/**
 * 在调用方的事务里为给定映射（不给时为全部已发布映射）的最新已发布版本入队一次合并，返回带上它们的合并任务。
 * 锁住租户行后检查：同一租户同时只有一个合并在排队或运行（两个合并同时写同一张标准层表会冲突）。
 * 已有合并在排队时把映射补进去（同一映射换成最新版本）；已在运行（或补的时候刚被领取）时不入队，返回 null，由定时检查在它之后补上。
 * 给定的映射都没有已发布版本时也不入队。参数里另带身份打通的匹配规则、属性取舍的名次（映射 ID → 名次）与不进 _consumer 的敏感字段，由全部已发布的 customer 映射汇总（重算打通时整表重算，不只看这次的映射），
 * 与要统计孤儿的全部已发布关系（工作进程不读平台库），
 * 本租户不参与匹配的值 identityExclude（排好序的哈希，ADR-0039），以及是否强制重算打通 identityForce（见 mustRecomputeIdentities；补进排队中的合并时，已为真的保留）。
 * opts.rebuild 时给这些映射带上强制重建标记；排队中的映射已带标记时，补进去的同一映射保留它。
 * opts.drop 是要撤下的停用映射（ADR-0031）：带上它时没有已发布的映射也入队；并进排队中的合并时，从它的映射里剔除这些映射、drop 并在一起
 */
export async function enqueueMerge(tx: Tx, tenantId: string, mappingIds?: string[], opts?: { rebuild?: boolean; drop?: MergeDrop[] }) {
  await lockTenant(tx, tenantId);
  const plans = (await mergePlans(tx, tenantId, mappingIds)).map(p => (opts?.rebuild ? { ...p, rebuild: true } : p));
  const incoming = opts?.drop ?? [];
  if (!plans.length && !incoming.length) return null;
  const pending = await pendingMerge(tx, tenantId);
  const all: PublishedPlan[] = mappingIds ? await publishedPlans(tx, tenantId) : plans;
  const identity = identityRules(all, mappingName);
  const survivorship = survivorshipPriority(all);
  const sensitive = consumerSensitive(all);
  const relations = relationParams(await publishedCustomEntities(tx, tenantId), all);
  if (pending?.status === 'running') return null;
  const identityExclude = await excludedHashes(tx, tenantId);
  const force = await mustRecomputeIdentities(tx, tenantId, identity, survivorship, identityExclude);
  if (!pending) {
    return insertTask(tx, tenantId, 'silver.merge', {
      // identity 由 schema 推出的入参类型是 string[]（identityRules 返回 readonly string[]），这里复制成可写的
      mappings: plans, ...(incoming.length > 0 && { drop: incoming }), identity: [...identity], survivorship, consumerSensitive: sensitive, relations, identityExclude, identityForce: force,
    });
  }
  // 已在排队：并进同一个任务。领取合并不锁租户行，updateQueuedParams 只在它仍在排队时改参数（刚被领取时返回 null，由定时检查补上）
  return updateQueuedParams(tx, pending.id, 'silver.merge', p => {
    const queuedDrop = p.drop;
    const drop = [...queuedDrop, ...incoming.filter(d => !queuedDrop.some(q => q.mapping === d.mapping))];
    const queued = p.mappings;
    const merged = [
      ...queued.filter(q => !plans.some(pl => pl.mapping === q.mapping) && !drop.some(d => d.mapping === q.mapping)),
      ...plans.map(pl => (queued.some(q => q.mapping === pl.mapping && q.rebuild) ? { ...pl, rebuild: true } : pl)),
    ].sort((a, b) => cmp(a.mapping, b.mapping));
    return { ...p, mappings: merged, drop, identity: [...identity], survivorship, consumerSensitive: sensitive, relations, identityExclude, identityForce: p.identityForce || force };
  });
}

/**
 * 同步任务 s 是否给已发布映射 m 的源表写入了变更：同一数据源、同一张表、本批次写进原始层的行数大于 0（删除也算在内），
 * 或源表有列被删除、改了类型（没有行变化也要合并，让合并前的结构检查报出来，ADR-0034）。
 * 输入是源视图的映射看视图最新的已发布版本引用的任一张表。
 * 比对周期里同一张表有两条记录，任意一条有变更即可；失败的记录没有 rows，自然排除（部分失败的任务照样参与判断）。
 * 同步后的合并与定时检查共用这个判断（ADR-0015）。
 * SQL 里读的 params->'sourceId'、result->'tables'（各表的批次、rows 与结构变化）的形状是 pipeline/task-contracts.ts 里
 * 'source.sync' 的参数与结果类型
 */
export const syncWroteMappingTable = (s: 's', m: 'm') => sql.raw(`${s}.kind = 'source.sync' AND ${s}.params->>'sourceId' = ${m}.source_id::text
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(${s}.result->'tables') r WHERE ((r->>'rows')::int > 0
    OR jsonb_array_length(coalesce(r->'schema'->'removed', '[]')) > 0 OR jsonb_array_length(coalesce(r->'schema'->'typeChanged', '[]')) > 0) AND r->>'table' = ANY(CASE
    WHEN ${m}.source_view_id IS NULL THEN ARRAY[${m}.table_name]
    ELSE (SELECT vv.tables FROM platform.source_view_versions vv WHERE vv.view_id = ${m}.source_view_id AND vv.status = 'published' ORDER BY vv.version DESC LIMIT 1)
  END))`);

/**
 * 同步结束后合并一次（调度器在同步任务结束时调用）：只为这次同步给源表写入了变更的已发布映射（停用的除外）入队，没有这样的映射时不入队；
 * 租户停用时什么都不做
 */
export async function mergeAfterSync(tenantId: string, syncTaskId: string) {
  return getDb().transaction(async tx => {
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant || tenant.suspendedAt) return null;
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT m.id FROM ${tasks} s
      JOIN ${mappings} m ON m.tenant_id = s.tenant_id
      WHERE s.id = ${syncTaskId} AND m.disabled_at IS NULL AND ${syncWroteMappingTable('s', 'm')}
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
  const pending = await pendingMerge(getDb(), actor.tenant.id);
  throw new MergeError(pending ? '已有一次合并在排队或运行中' : '还没有已发布的映射');
}

/** 成员在映射详情页手动合并这一个映射（最新已发布版本）；已有合并在排队时把它补进去，在运行时报错（之后还有没合并的版本或变更时由定时检查补上） */
export async function mergeMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  await requireMapping(actor.tenant.id, mappingId);
  return getDb().transaction(async tx => {
    const task = await enqueueMerge(tx, actor.tenant.id, [mappingId]);
    if (task) return task;
    // 在同一个事务里判断原因：排队中的合并恰被领取时，这里读到的是运行中
    if (!(await mergePlans(tx, actor.tenant.id, [mappingId])).length) throw new MergeError('这个映射还没有已发布的版本');
    throw new MergeError('已有一次合并在运行；它结束后，这个映射还有没合并的版本或变更时由定时检查补上');
  });
}

/**
 * 成员在数据地图上重建合并一张标准层表（漂移检查报告缺列时）：写入实体 entity 的全部已发布映射都带上强制重建标记入队一次合并，
 * 合并时补上缺的列（只补列，不改列类型、不删列，ADR-0015）。已有合并在排队或运行中时报错，不并进去（先锁租户行再查，与入队互斥）
 */
export async function rebuildEntity(actor: CurrentMember, entity: string) {
  assertCan(actor, 'sources:write');
  return getDb().transaction(async tx => {
    await lockTenant(tx, actor.tenant.id);
    const ids = (await mergePlans(tx, actor.tenant.id)).filter(p => p.entity === entity).map(p => p.mapping);
    if (!ids.length) throw new MergeError('这张表没有已发布的映射写入');
    if (await pendingMerge(tx, actor.tenant.id)) throw new MergeError('已有一次合并在排队或运行中，等它结束后再重建');
    // 锁已持有、没有排队或运行中的合并，入队必定成功
    return (await enqueueMerge(tx, actor.tenant.id, ids, { rebuild: true }))!;
  });
}

/** 合并任务的参数 params 带了映射 mappingId（任一版本） */
const mergeHas = (params: SQL, mappingId: SQL) => sql`${params}->'mappings' @> jsonb_build_array(jsonb_build_object('mapping', ${mappingId}))`;

/**
 * 到期要合并的映射（给了 tenantId 时只看这个租户）：映射已发布且没停用、租户未停用，带它的最近一次合并 last 不在排队，且
 * (a) last 带的不是它最新的已发布版本（还没合并过也算；last 失败了也算带过，不自动重试；读源视图的映射另看 last 带的视图版本，
 *     视图发布时已有合并在运行、入队不了的由此补上），或
 * (b) last 开始之后有同步结束并给它的源表写入了变更（合并运行期间发生的变化由此补上）。
 * 同一租户的合并一个接一个，入队或补映射时都在租户锁里取最新的已发布版本，所以 last 带的就是合并过的最高版本；
 * 按版本而不按发布时间判断 (a)：发布时间是事务开始时间，可能早于并发领取的合并的开始时间。
 * 只找最近一次（按入队时间倒序走索引），不随历史合并增多而变慢。
 * SQL 里读的 params->'mappings'（每项带 mapping、version 与 sourceView.version）的形状是 pipeline/task-contracts.ts 里
 * 'silver.merge' 的参数类型
 */
export async function dueMappings(db: Tx | ReturnType<typeof getDb>, tenantId?: string) {
  const { rows } = await db.execute<{ tenant_id: string; mapping_id: string }>(sql`
    SELECT m.tenant_id, m.id AS mapping_id FROM ${mappings} m
    JOIN ${tenants} t ON t.id = m.tenant_id AND t.suspended_at IS NULL
    CROSS JOIN LATERAL (SELECT max(version) AS version FROM ${mappingVersions} WHERE mapping_id = m.id AND status = 'published') v
    LEFT JOIN LATERAL (
      SELECT l.status, coalesce(l.started_at, l.created_at) AS at,
        (SELECT (e->>'version')::int FROM jsonb_array_elements(l.params->'mappings') e WHERE e->>'mapping' = m.id::text) AS version,
        (SELECT (e->'sourceView'->>'version')::int FROM jsonb_array_elements(l.params->'mappings') e WHERE e->>'mapping' = m.id::text) AS view_version
      FROM ${tasks} l
      WHERE l.tenant_id = m.tenant_id AND l.kind = 'silver.merge' AND ${mergeHas(sql`l.params`, sql`m.id::text`)}
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) last ON true
    WHERE v.version IS NOT NULL AND m.disabled_at IS NULL ${tenantId ? sql`AND m.tenant_id = ${tenantId}` : sql``}
      AND last.status IS DISTINCT FROM 'queued'
      AND (
        last.version IS DISTINCT FROM v.version
        OR (m.source_view_id IS NOT NULL AND last.view_version IS DISTINCT FROM
          (SELECT max(version) FROM ${sourceViewVersions} WHERE view_id = m.source_view_id AND status = 'published'))
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
        await lockTenant(tx, tenantId);
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
export async function tenantLatestMerge(tenantId: string) {
  const [latest] = await getDb().select().from(tasks).where(ofMerge(tenantId)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
  };
}

/**
 * 本租户最近一次打通成功的摘要（统一消费者数、参与打通的记录数、已归属的设备数，以及本次 ID 合并与拆开的组数，上一版的结果没有这两项时为 null；
 * hot 是连了太多源记录的匹配值，只有加盐哈希与数据源 ID，上一版的结果没有时为空），带所属任务与时间；不带消费者标识。
 * 跳过没有打通的合并（没有 silver.customer）、打通失败的与沿用上次结果而跳过打通的；部分失败的合并任务照样落了 result，也算在内。还没打通过时为 null
 */
export async function latestIdentitySummary(tenantId: string) {
  const [latest] = await getDb().select({ id: tasks.id, createdAt: tasks.createdAt, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), sql`${tasks.result} ? 'identities' AND NOT (${tasks.result}->'identities') ?| array['error', 'skipped']`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  if (!latest) return null;
  const { groups, records, devices, merged, split, hot } = readResult('silver.merge', latest)!.identities as Partial<IdentitySummary> & Pick<IdentitySummary, 'groups' | 'records' | 'devices'>;
  return { groups, records, devices, merged: merged ?? null, split: split ?? null, hot: hot ?? [], taskId: latest.id, at: latest.createdAt };
}

/** 本租户最近一次带关系孤儿统计的合并：各关系的统计与完成时间；还没有时为 null */
export async function latestRelationStats(tenantId: string) {
  const [latest] = await getDb().select({ finishedAt: tasks.finishedAt, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), sql`${tasks.result} ? 'relations'`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  if (!latest) return null;
  return { relations: readResult('silver.merge', latest)!.relations ?? [], at: latest.finishedAt };
}

/**
 * 一个实体相关（起点或终点是它）的已发布关系与最近一次合并后的孤儿统计（ADR-0019）。
 * 最近一次合并没有统计到的关系（还没合并过，或合并之后才发布的）为 unmerged
 */
export async function entityRelationStats(tenantId: string, entity: string) {
  const latest = await latestRelationStats(tenantId);
  const relations = allRelations(await publishedCustomEntities(getDb(), tenantId)).filter(r => r.from.entity === entity || r.ref.entity === entity);
  return {
    at: latest?.at ?? null,
    relations: relations.map((r): RelationStat => latest?.relations.find(s => relationText(s) === relationText(r)) ?? { ...r, status: 'unmerged' }),
  };
}

/** 各映射最近一次合并的结果（每个映射分别找带它的最近一次合并任务，不受别的映射合并得多少影响） */
export async function lastMergeByMapping(tenantId: string, mappingIds: string[]) {
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
export async function mergesOfMapping(tenantId: string, mappingId: string) {
  const runs = await getDb().select().from(tasks).where(and(ofMerge(tenantId), mergeHas(sql`${tasks.params}`, sql`${mappingId}::text`)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(HISTORY_TASKS);
  const history = runs.flatMap(run => (readResult('silver.merge', run)?.mappings ?? [])
    .filter(r => r.mapping === mappingId).map(r => ({ ...r, taskId: run.id }) as MergeHistoryEntry));
  const [latest] = runs;
  const own = latest && readResult('silver.merge', latest)?.mappings.find(r => r.mapping === mappingId);
  const status: TaskStatus | 'none' = !latest ? 'none' : own ? ('error' in own ? 'failed' : 'succeeded') : latest.status;
  return { status, history };
}


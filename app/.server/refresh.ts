// app/.server/refresh.ts —— 结果层定时刷新（ADR-0028）：调度器定时检查各租户已发布的指标与标签（各自最新的已发布版本），
// 依赖的实体（任务参数里的 entities 加上 customer：都要关联身份打通结果）在这个定义最近一次 gold.dsl 之后有了改到数据的合并，
// 就以当天为 asOf 按生效版本入队一次 gold.dsl（来源 scheduled），指标连同引用它的已发布标签在同一事务里入队。
// 只看平台库里合并任务的结果，不开 DuckDB。租户有合并在排队或运行时整个跳过（同一 asOf 的指标与标签读同一份标准层）；
// 定义已有任务在排队或运行、或当天已有当前版本的快照时跳过这个定义。已发布的模板（如 RFM，依赖 TEMPLATES[模板].entities）同样检查，
// 按模板去重（每个租户一个），以生效版本的参数入队模板任务。一律限定在给定租户内
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit, type Tx } from './audit';
import { getDb } from './db/client';
import { dslDefinitions, dslVersions, snapshots, tasks, templateDefinitions, templateVersions, tenants } from './db/schema';
import { dslContext, downstreamTags, enqueueDsl, type DslVersionRef } from './dsl-definitions';
import { publishedDependents } from './dsl-dependencies';
import { pendingMerge } from './mappings';
import { DSL_KINDS } from './pipeline/dsl';
import { TEMPLATES } from './pipeline/templates';
import { enqueueTemplate, TASK_KINDS, type TemplateId } from './templates';

type Task = typeof tasks.$inferSelect;

/**
 * 这些实体在定义最近一次计算任务（任何状态：kind 类型的任务，给了 definitionId 时只看这个定义的）提交之后，有没有结束了的合并改到了数据：
 * 合并记录的实体属于 entities，且插入、更新、删除了行或由全部批次重建
 */
async function mergedSince(tx: Tx, tenantId: string, run: { kind: string; definitionId?: string }, entities: readonly string[]) {
  const ofDefinition = run.definitionId ? sql` AND d.params->>'definitionId' = ${run.definitionId}` : sql``;
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM ${tasks} t, jsonb_array_elements(t.result->'mappings') rec
    WHERE t.tenant_id = ${tenantId} AND t.kind = 'silver.merge' AND t.status IN ('succeeded', 'failed')
      AND t.finished_at > COALESCE((
        SELECT max(d.created_at) FROM ${tasks} d
        WHERE d.tenant_id = ${tenantId} AND d.kind = ${run.kind}${ofDefinition}), '-infinity')
      AND rec->>'entity' IN (${sql.join(entities.map(e => sql`${e}`), sql`, `)})
      AND (rec->>'mode' = 'rebuild'
        OR coalesce((rec->>'inserted')::bigint, 0) + coalesce((rec->>'updated')::bigint, 0) + coalesce((rec->>'deleted')::bigint, 0) > 0)
    LIMIT 1`);
  return rows.length > 0;
}

/** 在锁住租户行的事务里为一个租户入队到期的刷新，返回入队的任务 */
async function refreshTenant(tx: Tx, tenantId: string, asOf: string) {
  const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  if (!tenant || tenant.suspendedAt || await pendingMerge(tx, tenantId)) return [];
  const definitions = await publishedDependents(tx, tenantId);
  const busy = new Set((await tx.select({ id: sql<string>`${tasks.params}->>'definitionId'` }).from(tasks).where(and(
    eq(tasks.tenantId, tenantId), eq(tasks.kind, 'gold.dsl'), inArray(tasks.status, ['queued', 'running']),
  ))).map(t => t.id));
  const fresh = new Set((await tx.select({ template: snapshots.template, version: snapshots.definitionVersion }).from(snapshots).where(and(
    eq(snapshots.tenantId, tenantId), sql`${snapshots.params}->>'asOf' = ${asOf}`, isNull(snapshots.expiredAt),
  ))).map(s => `${s.template}@${s.version}`));
  const skip = (d: DslVersionRef) => busy.has(d.definitionId) || fresh.has(`${d.kind}:${d.key}@${d.version}`);
  // ctx 里的指标就是各自生效的版本，下游标签按它内联
  const ctx = await dslContext(tx, tenantId);
  const enqueued: Task[] = [];
  const enqueueOne = async (d: DslVersionRef, spec: unknown) => {
    busy.add(d.definitionId);
    enqueued.push(await enqueueDsl(tx, tenantId, d, spec, ctx, asOf, 'scheduled'));
  };
  // publishedDependents 按种类、键排序，指标排在标签前面：随指标入队过的标签不再单独检查
  for (const { definitionId, kind, key, version, yaml } of definitions) {
    const self = { kind, key, definitionId, version };
    if (skip(self)) continue;
    const checked = DSL_KINDS[kind].check(yaml, ctx);
    if (!checked.ok || !await mergedSince(tx, tenantId, { kind: 'gold.dsl', definitionId }, [...DSL_KINDS[kind].entities(checked.spec, ctx), 'customer'])) continue;
    const downstream = kind === 'metric' ? await downstreamTags(tx, tenantId, key, ctx) : { ready: [], skipped: [] };
    // 随指标入队的标签只在已有任务排队或运行时跳过：当天已有快照也重算，与指标读同一份标准层
    const tags = downstream.ready.filter(t => !busy.has(t.tag.definitionId));
    await enqueueOne(self, checked.spec);
    for (const { tag, spec } of tags) await enqueueOne(tag, spec);
    await recordAudit(tx, {
      tenantId, system: true, action: 'definition.refreshed', targetType: 'definition', targetId: definitionId,
      detail: { kind, key, version, asOf, tags: tags.map(t => t.tag.key), skippedTags: downstream.skipped },
    });
  }
  enqueued.push(...await refreshTemplates(tx, tenantId, asOf));
  return enqueued;
}

/** 在 refreshTenant 的事务里为租户已发布的模板（各自最新的已发布版本）入队到期的刷新 */
async function refreshTemplates(tx: Tx, tenantId: string, asOf: string) {
  const published = await tx.selectDistinctOn([templateDefinitions.template], {
    definitionId: templateDefinitions.id, template: templateDefinitions.template, version: templateVersions.version, params: templateVersions.params,
  }).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(and(eq(templateDefinitions.tenantId, tenantId), eq(templateVersions.status, 'published')))
    .orderBy(templateDefinitions.template, desc(templateVersions.version));
  const enqueued: Task[] = [];
  for (const { definitionId, template: id, version, params } of published) {
    if (!Object.hasOwn(TEMPLATES, id)) continue;
    const template = id as TemplateId;
    const kind = TASK_KINDS[template];
    const [busy] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, kind), inArray(tasks.status, ['queued', 'running']))).limit(1);
    const [fresh] = await tx.select({ id: snapshots.id }).from(snapshots).where(and(
      eq(snapshots.tenantId, tenantId), eq(snapshots.template, template), eq(snapshots.definitionVersion, version),
      sql`${snapshots.params}->>'asOf' = ${asOf}`, isNull(snapshots.expiredAt),
    )).limit(1);
    if (busy || fresh || !await mergedSince(tx, tenantId, { kind }, TEMPLATES[template].entities)) continue;
    enqueued.push(await enqueueTemplate(tx, tenantId, template, params, version, asOf, 'scheduled'));
    await recordAudit(tx, {
      tenantId, system: true, action: 'template.refreshed', targetType: 'template', targetId: definitionId,
      detail: { template, version, asOf },
    });
  }
  return enqueued;
}

/**
 * 为有已发布的指标、标签或模板且未停用的租户入队到期的结果层刷新（见文件头），asOf 为 now 当天（UTC）：每个租户一个事务，先锁住租户行，
 * 多个调度器同时检查也不会重复入队；单个租户出错只记日志。返回入队的任务
 */
export async function enqueueDueRefreshes(now = new Date()) {
  const asOf = now.toISOString().slice(0, 10);
  const dsl = getDb().selectDistinct({ tenantId: dslDefinitions.tenantId }).from(dslDefinitions)
    .innerJoin(dslVersions, and(eq(dslVersions.definitionId, dslDefinitions.id), eq(dslVersions.status, 'published')))
    .innerJoin(tenants, and(eq(tenants.id, dslDefinitions.tenantId), isNull(tenants.suspendedAt)));
  const templates = getDb().selectDistinct({ tenantId: templateDefinitions.tenantId }).from(templateDefinitions)
    .innerJoin(templateVersions, and(eq(templateVersions.definitionId, templateDefinitions.id), eq(templateVersions.status, 'published')))
    .innerJoin(tenants, and(eq(tenants.id, templateDefinitions.tenantId), isNull(tenants.suspendedAt)));
  const due = [...new Set([...await dsl, ...await templates].map(t => t.tenantId))].sort();
  const enqueued: Task[] = [];
  for (const tenantId of due) {
    try {
      enqueued.push(...await getDb().transaction(tx => refreshTenant(tx, tenantId, asOf)));
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的结果层定时刷新入队失败`, e);
    }
  }
  return enqueued;
}

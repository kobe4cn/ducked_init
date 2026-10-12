// app/.server/source-drift.ts —— 映射的源表列差异：已发布映射的源表在最近一次采集里新增了映射没用到的列，或映射引用的列在源端已删除。
// 新列的基线是最新已发布版本发布时（publishedAt 之前）这张表最近一次成功采集到的列：发布时就有、没被引用的列视为有意不映射。
// 「已引用」是最新已发布版本与当前草稿引用的列之并，草稿用上了新列提醒就消失。只读，不带操作；
// 源视图的映射没有列统计，不在同步范围、读不了、源端已没有的表不在最近一次采集里，都不报差异。与标准层漂移（lineage-drift.ts）无关
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { mappings, mappingVersions, tasks } from './db/schema';
import type { MergePlan } from './pipeline/mapping-spec';
import type { ColumnProfile } from './pipeline/source-engine';
import { confirmedTables } from './sources';
import { ExprError, parseExpression, referencedColumns } from '../lib/mapping-expr';

export interface MappingDrift {
  sourceId: string;
  tableName: string;
  /** 最近一次采集里有、发布时的采集里没有、已发布版本与草稿都没引用的列 */
  newColumns: ColumnProfile[];
  /** 最新已发布版本引用、最近一次采集里已经没有的列 */
  missing: string[];
}

/** 合并计划的列表达式与行过滤引用的源表列；解析不了的表达式跳过 */
function referenced(plan: MergePlan) {
  const names = new Set<string>();
  for (const src of [...plan.columns.map(c => c.expr), ...(plan.where ? [plan.where] : [])]) {
    try {
      for (const c of referencedColumns(parseExpression(src))) names.add(c.name);
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
    }
  }
  return names;
}

/**
 * 租户各已发布映射（给了 mappingIds 时只取这些）的源表列差异；没有差异的映射不在结果里
 */
export async function mappingDrift(tenantId: string, mappingIds?: string[]): Promise<Map<string, MappingDrift>> {
  const drift = new Map<string, MappingDrift>();
  if (mappingIds && !mappingIds.length) return drift;
  const live = (await getDb()
    .selectDistinctOn([mappingVersions.mappingId], {
      mappingId: mappings.id, sourceId: mappings.sourceId, tableName: mappings.tableName, plan: mappingVersions.plan, publishedAt: mappingVersions.publishedAt,
    })
    .from(mappingVersions)
    .innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
    .where(and(
      eq(mappings.tenantId, tenantId), eq(mappingVersions.status, 'published'), isNull(mappings.sourceViewId), mappingIds && inArray(mappings.id, mappingIds),
    ))
    .orderBy(mappingVersions.mappingId, desc(mappingVersions.version)))
    .flatMap(r => (r.publishedAt ? [{ ...r, publishedAt: r.publishedAt }] : []));
  if (!live.length) return drift;
  const drafts = await getDb().select({ mappingId: mappingVersions.mappingId, plan: mappingVersions.plan }).from(mappingVersions)
    .where(and(inArray(mappingVersions.mappingId, live.map(r => r.mappingId)), eq(mappingVersions.status, 'draft')));
  const latestColumns = new Map<string, Map<string, ColumnProfile[]>>();
  for (const sourceId of new Set(live.map(r => r.sourceId))) {
    const { tables } = await confirmedTables(tenantId, sourceId);
    latestColumns.set(sourceId, new Map(tables.map(t => [t.table.name, t.table.columns])));
  }
  const profiled = live.filter(r => latestColumns.get(r.sourceId)!.has(r.tableName));
  const baselines = await baselineColumns(tenantId, profiled);
  for (const r of profiled) {
    const columns = latestColumns.get(r.sourceId)!.get(r.tableName)!;
    const used = referenced(r.plan);
    const draft = drafts.find(d => d.mappingId === r.mappingId);
    const referencedByLiveOrDraft = new Set([...used, ...(draft ? referenced(draft.plan) : [])]);
    const baseline = baselines.get(r.mappingId) ?? new Set(columns.map(c => c.name));
    const newColumns = columns.filter(c => !baseline.has(c.name) && !referencedByLiveOrDraft.has(c.name));
    const missing = [...used].filter(name => !columns.some(c => c.name === name));
    if (newColumns.length || missing.length) drift.set(r.mappingId, { sourceId: r.sourceId, tableName: r.tableName, newColumns, missing });
  }
  return drift;
}

/**
 * 各映射的基线：发布时（publishedAt 之前）它的源表最近一次成功采集到的列名。按表取（选表触发的采集只覆盖新选入的表）；
 * 发布前没有采集过这张表时取发布后最早的一次
 */
async function baselineColumns(tenantId: string, rows: { mappingId: string; sourceId: string; tableName: string; publishedAt: Date }[]) {
  if (!rows.length) return new Map<string, Set<string>>();
  const { rows: found } = await getDb().execute<{ mapping_id: string; columns: { name: string }[] }>(sql`
    SELECT m.mapping_id, b.columns
    FROM unnest(${sql.param(rows.map(r => r.mappingId))}::text[], ${sql.param(rows.map(r => r.sourceId))}::text[],
      ${sql.param(rows.map(r => r.tableName))}::text[], ${sql.param(rows.map(r => r.publishedAt.toISOString()))}::timestamptz[])
      AS m(mapping_id, source_id, name, published_at)
    CROSS JOIN LATERAL (
      SELECT p->'columns' AS columns
      FROM ${tasks} t CROSS JOIN LATERAL jsonb_array_elements(t.result->'tables') p
      WHERE t.tenant_id = ${tenantId} AND t.kind = 'source.profile' AND t.status = 'succeeded' AND t.params->>'sourceId' = m.source_id
        AND p->>'name' = m.name
      ORDER BY t.finished_at <= m.published_at DESC, abs(extract(epoch FROM t.finished_at - m.published_at)), t.id DESC
      LIMIT 1
    ) b`);
  return new Map(found.map(r => [r.mapping_id, new Set(r.columns.map(c => c.name))]));
}

// app/.server/catalog/load.ts —— 从平台库读出生成语义目录（ADR-0041）的元数据：数据源、同步范围内的源表（带最近一次采集到的列）、
// 已发布源视图（带输出列）、已发布映射、自定义实体与合并组，以及源表的采集统计与实体的合并行数
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../audit';
import { publishedCustomEntities } from '../custom-entities';
import { getDb } from '../db/client';
import { sources, sourceTables, sourceViews, sourceViewVersions, tasks } from '../db/schema';
import { lastMergeByMapping, publishedPlans } from '../mappings';
import { publishedMergeGroups } from '../merge-groups';
import type { TableProfile } from '../pipeline/source-engine';
import { buildCatalog, type CatalogInput } from './index';

/** 本租户生成目录用的元数据 */
export async function loadCatalogInput(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<CatalogInput> {
  const rows = await db.select({ id: sources.id, name: sources.name, kind: sources.kind }).from(sources)
    .where(eq(sources.tenantId, tenantId)).orderBy(sources.name);
  // 同步范围内、源端仍在且可读的表（同 sources.ts 的 isSyncable），列取各表最近一次成功采集到的
  const scoped = await db.select({ sourceId: sourceTables.sourceId, name: sourceTables.tableName }).from(sourceTables)
    .innerJoin(sources, eq(sources.id, sourceTables.sourceId))
    .where(and(eq(sources.tenantId, tenantId), eq(sourceTables.inScope, true), isNull(sourceTables.goneAt), eq(sourceTables.readable, true)))
    .orderBy(sourceTables.sourceId, sourceTables.tableName);
  const { rows: profiles } = await db.execute<{ source_id: string; profile: TableProfile; finished_at: string }>(sql`
    SELECT DISTINCT ON (t.params->>'sourceId', p->>'name') t.params->>'sourceId' AS source_id, p AS profile, t.finished_at
    FROM ${tasks} t CROSS JOIN LATERAL jsonb_array_elements(t.result->'tables') p
    WHERE t.tenant_id = ${tenantId} AND t.kind = 'source.profile' AND t.status = 'succeeded'
    ORDER BY t.params->>'sourceId', p->>'name', t.created_at DESC, t.id DESC`);
  const tables: NonNullable<CatalogInput['tables']> = scoped.map(t => {
    const columns = profiles.find(p => p.source_id === t.sourceId && p.profile.name === t.name)?.profile.columns ?? [];
    return { ...t, view: false, columns: columns.map(c => ({ name: c.name, type: c.type, ...(c.formats && { formats: c.formats }) })) };
  });
  const views = await db
    .selectDistinctOn([sourceViewVersions.viewId], { sourceId: sourceViews.sourceId, name: sourceViews.name, columns: sourceViewVersions.columns })
    .from(sourceViewVersions)
    .innerJoin(sourceViews, eq(sourceViews.id, sourceViewVersions.viewId))
    .where(and(eq(sourceViews.tenantId, tenantId), eq(sourceViewVersions.status, 'published')))
    .orderBy(sourceViewVersions.viewId, desc(sourceViewVersions.version));
  tables.push(...views.map(v => ({ sourceId: v.sourceId, name: v.name, view: true, columns: v.columns ?? [] })));
  const tableStats = profiles.map(p => ({
    sourceId: p.source_id, name: p.profile.name, rows: p.profile.rows, sampleRows: p.profile.sampleRows,
    profiledAt: new Date(p.finished_at).toISOString(), columns: p.profile.columns,
  }));
  const plans = await publishedPlans(db, tenantId);
  // 实体行数：写入它的各映射最近一次合并成功的行数之和（同 lineage-flow.ts 的 silverTotals），截至其中最晚的一次
  const last = await lastMergeByMapping(tenantId, plans.map(p => p.mapping));
  const statsByEntity = new Map<string, { entity: string; rows: number; at: string }>();
  for (const p of plans) {
    const r = last[p.mapping];
    if (!r || !('rows' in r)) continue;
    const at = new Date(Date.parse(r.startedAt) + r.durationMs).toISOString();
    const s = statsByEntity.get(p.entity);
    statsByEntity.set(p.entity, { entity: p.entity, rows: (s?.rows ?? 0) + r.rows, at: s && s.at > at ? s.at : at });
  }
  return {
    sources: rows,
    tables,
    tableStats,
    entityStats: [...statsByEntity.values()],
    plans,
    customEntities: [...(await publishedCustomEntities(db, tenantId)).values()],
    mergeGroups: [...(await publishedMergeGroups(db, tenantId)).entries()].map(([entity, g]) => ({ entity, ...g })),
  };
}

/** 本租户当前的语义目录 */
export const tenantCatalog = async (tenantId: string) => buildCatalog(await loadCatalogInput(getDb(), tenantId));

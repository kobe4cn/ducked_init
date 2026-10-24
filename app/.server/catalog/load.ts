// app/.server/catalog/load.ts —— 从平台库读出生成语义目录（ADR-0041）的元数据：数据源、同步范围内的源表（带最近一次采集到的列）、
// 已发布源视图（带输出列）、已发布映射、自定义实体与合并组
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../audit';
import { publishedCustomEntities } from '../custom-entities';
import { getDb } from '../db/client';
import { sources, sourceTables, sourceViews, sourceViewVersions, tasks } from '../db/schema';
import { publishedPlans } from '../mappings';
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
  const { rows: profiles } = await db.execute<{ source_id: string; profile: TableProfile }>(sql`
    SELECT DISTINCT ON (t.params->>'sourceId', p->>'name') t.params->>'sourceId' AS source_id, p AS profile
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
  return {
    sources: rows,
    tables,
    plans: await publishedPlans(db, tenantId),
    customEntities: [...(await publishedCustomEntities(db, tenantId)).values()],
    mergeGroups: [...(await publishedMergeGroups(db, tenantId)).entries()].map(([entity, g]) => ({ entity, ...g })),
  };
}

/** 本租户当前的语义目录 */
export const tenantCatalog = async (tenantId: string) => buildCatalog(await loadCatalogInput(getDb(), tenantId));

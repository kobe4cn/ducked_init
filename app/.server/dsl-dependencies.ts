// app/.server/dsl-dependencies.ts —— 定义的依赖（ADR-0025「依赖按需计算，不建依赖表」）：由本租户每个定义最新的已发布版本的 YAML 解析得出
// （各种类的 dependencies，pipeline/dsl），草稿不算。用于拒绝删除被引用的指标与自定义实体，以及拒绝发布去掉被引用 x_ 字段的映射。
// 调用方要与发布定义互斥时，先在事务里锁住租户行（lockTenant）
import { and, desc, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import type { Tx } from './audit';
import type { getDb } from './db/client';
import { dslDefinitions, dslVersions } from './db/schema';
import { DSL_KINDS, type DslKind } from './pipeline/dsl';

/** 本租户每个定义最新的已发布版本的依赖，按种类、键排序 */
export async function publishedDependents(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const rows = await db
    .selectDistinctOn([dslVersions.definitionId], { kind: dslDefinitions.kind, key: dslDefinitions.key, yaml: dslVersions.yaml })
    .from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(and(eq(dslDefinitions.tenantId, tenantId), eq(dslVersions.status, 'published')))
    .orderBy(dslVersions.definitionId, desc(dslVersions.version));
  return rows
    .map(r => ({ kind: r.kind as DslKind, key: r.key, ...DSL_KINDS[r.kind as DslKind].dependencies(parse(r.yaml)) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** 引用这个指标的已发布标签的键 */
export const publishedTagsOf = async (db: Tx | ReturnType<typeof getDb>, tenantId: string, metric: string) =>
  (await publishedDependents(db, tenantId)).filter(d => d.kind === 'tag' && d.metrics.includes(metric)).map(d => d.key);

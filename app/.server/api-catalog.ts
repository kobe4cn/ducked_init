// app/.server/api-catalog.ts —— 外部系统的目录接口 GET /api/v1/catalog：本租户已发布的指标与标签，各自的当前版本（最新已发布版本）与发布时间。
// 草稿、从未发布的定义不列出；说明取当前版本 YAML 里的 description（可选，没写为 null）
import { and, asc, desc, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { getDb } from './db/client';
import { dslDefinitions, dslVersions } from './db/schema';
import type { DslKind } from './pipeline/dsl';

export interface CatalogEntry { kind: DslKind; key: string; version: number; description: string | null; publishedAt: string }

/** 已发布版本 YAML 里的说明（发布时已校验过；旧版本没写这一项） */
function descriptionOf(yaml: string): string | null {
  const value = (parse(yaml) as { description?: unknown } | null)?.description;
  return typeof value === 'string' ? value : null;
}

export async function apiCatalog(tenantId: string): Promise<{ definitions: CatalogEntry[] }> {
  const rows = await getDb()
    .select({ kind: dslDefinitions.kind, key: dslDefinitions.key, version: dslVersions.version, yaml: dslVersions.yaml, publishedAt: dslVersions.publishedAt })
    .from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(and(eq(dslDefinitions.tenantId, tenantId), eq(dslVersions.status, 'published')))
    .orderBy(asc(dslDefinitions.kind), asc(dslDefinitions.key), desc(dslVersions.version));
  const definitions: CatalogEntry[] = [];
  for (const r of rows) {
    const last = definitions.at(-1);
    if (last?.kind === r.kind && last.key === r.key) continue;
    definitions.push({ kind: r.kind, key: r.key, version: r.version, description: descriptionOf(r.yaml), publishedAt: r.publishedAt!.toISOString() });
  }
  return { definitions };
}

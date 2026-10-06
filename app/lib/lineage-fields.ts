// app/lib/lineage-fields.ts —— 数据地图的标准层表字段抽屉：一张标准层表每个字段在各已发布映射里的源表、源列与表达式，
// 敏感哈希、值字典、扩展字段与兜底标记，兜底的字段附上最近一次合并的兜底统计。源表名、表达式与兜底取值只给有 sources:read 的人，
// 查看者只拿 redactFields 留下的字段说明（ADR-0019）。前后端共用的纯函数
import type { FallbackStat } from '~/.server/pipeline/merge-engine';
import { cmp, type Lineage } from './lineage';

/** 字段说明：内置实体取 CanonicalField，自定义实体取实体登记（没有 label，用字段名） */
export interface FieldDescription { name: string; label?: string; description: string }

export interface FieldSource {
  mapping: string; version: number; sourceName: string; table: string;
  expr: string; sourceColumns: string[];
  sensitive: boolean; dictionary: boolean; extension: boolean;
  /** 兜底值（null 是写成空）与最近一次合并落入兜底的统计（没有合并过或没有落入兜底时为 null）；没写兜底时整个为 null */
  fallback: { value: string | null; stat: Omit<FallbackStat, 'column'> | null } | null;
}

export interface FieldSummary { name: string; label: string; description: string }

export interface EntityFieldDetail extends FieldSummary { sources: FieldSource[] }

/** 字段抽屉：标准层表、名称、行数（同流向图，取自任务结果）与字段；detail 为 false 时（没有 sources:read）只有字段说明 */
export type FieldDrawer = { entity: string; label: string; rows: number } & (
  | { detail: true; fields: EntityFieldDetail[] }
  | { detail: false; fields: FieldSummary[] }
);

/**
 * 一张标准层表映射到的字段：按实体登记的顺序，登记里没有的（扩展字段）按名字排在后面；
 * fallbacks 是各映射（按 id）最近一次合并的兜底统计
 */
export function entityFields(
  lineage: Lineage, entity: string, declared: readonly FieldDescription[], fallbacks: Record<string, FallbackStat[] | undefined>,
): EntityFieldDetail[] {
  const sourceName = new Map(lineage.tables.map(t => [t.mapping, t.sourceName]));
  const byField = new Map<string, FieldSource[]>();
  for (const f of lineage.fields) {
    if (f.entity !== entity) continue;
    const stat = f.fallback ? fallbacks[f.mapping]?.find(s => s.column === f.field) : undefined;
    const sources = byField.get(f.field) ?? [];
    sources.push({
      mapping: f.mapping, version: f.version, sourceName: sourceName.get(f.mapping) ?? f.sourceId, table: f.table,
      expr: f.expr, sourceColumns: f.sourceColumns,
      sensitive: f.sensitive, dictionary: f.dictionary, extension: f.extension,
      fallback: f.fallback && { value: f.fallback.value, stat: stat ? { rows: stat.rows, distinct: stat.distinct, values: stat.values } : null },
    });
    byField.set(f.field, sources);
  }
  const order = new Map(declared.map((d, i) => [d.name, i]));
  return [...byField.keys()]
    .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || cmp(a, b))
    .map(name => {
      const d = declared.find(x => x.name === name);
      return { name, label: d?.label ?? name, description: d?.description ?? '', sources: byField.get(name)! };
    });
}

/** 给没有 sources:read 的人：只留字段名、名称与说明 */
export const redactFields = (fields: EntityFieldDetail[]): FieldSummary[] =>
  fields.map(({ name, label, description }) => ({ name, label, description }));

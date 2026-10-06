// app/lib/lineage.ts —— 数据地图的血缘：由已发布映射推出表级（数据源 → 源表或源视图 → 映射及版本 → 标准层表）、
// 字段级（标准层字段在各映射里对应的源列与表达式）与标准实体之间的关系边。只看表达式与列名，不读数据值，不落库（ADR-0019）
import type { MergeMappingParam } from '~/.server/pipeline/merge-engine';
import { CANONICAL_ENTITIES, entityOf, EXTENSION_PATTERN, isCustomEntity } from './canonical-model';
import { parseExpression, referencedColumns } from './mapping-expr';

export interface TableLineage {
  sourceId: string; sourceName: string; sourceKind: string;
  /** 源表或源视图的名字 */
  table: string;
  viaView: boolean;
  mapping: string; version: number;
  entity: string;
  /** 标准层表：silver.<entity> */
  target: string;
  custom: boolean;
}

export interface FieldLineage {
  entity: string; field: string;
  mapping: string; version: number; sourceId: string; table: string;
  expr: string;
  /** 表达式引用的源列（去重，按出现顺序） */
  sourceColumns: string[];
  /** 标准层只存加盐哈希（ADR-0005） */
  sensitive: boolean;
  /** 经值字典对应过来（不输出字典内容） */
  dictionary: boolean;
  /** 标准实体上的扩展字段（x_ 开头）；自定义实体的列一律不算 */
  extension: boolean;
  /** 写了兜底值（otherwise）时是兜底值：对不上的取值写成它，value 为 null 是写成空（ADR-0015）；没写时为 null */
  fallback: { value: string | null } | null;
}

/**
 * 标准实体之间的关系边。ref 是内置关系；identity 是指向 customer 的关系，在标准层经 silver._identities 按 (_source, customer_id) 关联；
 * device 是 event.device_id 经 silver._device_owner 归到消费者
 */
export interface LineageEdge {
  from: { entity: string; field: string };
  to: { table: string; field: string };
  via?: { table: string; on: string[] };
  kind: 'ref' | 'identity' | 'device';
}

export interface Lineage { tables: TableLineage[]; fields: FieldLineage[]; edges: LineageEdge[] }

// 与 .server 里 IDENTITIES / DEVICE_OWNER 同值（前后端共用，不引入服务端的值）
const IDENTITIES = 'silver._identities';
const DEVICE_OWNER = 'silver._device_owner';

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const extensionName = new RegExp(EXTENSION_PATTERN);

function edges(): LineageEdge[] {
  const out: LineageEdge[] = [];
  for (const e of CANONICAL_ENTITIES) {
    for (const f of e.fields) {
      if (!f.ref) continue;
      const from = { entity: e.name, field: f.name };
      const to = { table: `silver.${f.ref.entity}`, field: f.ref.field };
      out.push(f.ref.entity === 'customer'
        ? { from, to, via: { table: IDENTITIES, on: ['_source', 'customer_id'] }, kind: 'identity' }
        : { from, to, kind: 'ref' });
    }
  }
  out.push({ from: { entity: 'event', field: 'device_id' }, to: { table: DEVICE_OWNER, field: 'device_id' }, kind: 'device' });
  return out;
}

/** 由已发布映射（publishedPlans 的结果）与数据源推出血缘；结果按实体、字段、映射排序 */
export function deriveLineage(input: { plans: MergeMappingParam[]; sources: { id: string; name: string; kind: string }[] }): Lineage {
  const sources = new Map(input.sources.map(s => [s.id, s]));
  const tables: TableLineage[] = input.plans.map(p => {
    const s = sources.get(p.sourceId);
    return {
      sourceId: p.sourceId, sourceName: s?.name ?? p.sourceId, sourceKind: s?.kind ?? '',
      table: p.table, viaView: !!p.sourceView,
      mapping: p.mapping, version: p.version,
      entity: p.entity, target: `silver.${p.entity}`, custom: isCustomEntity(p.entity),
    };
  });
  tables.sort((a, b) => cmp(a.entity, b.entity) || cmp(a.mapping, b.mapping));

  const fields: FieldLineage[] = input.plans.flatMap(p => {
    const canonical = !!entityOf(p.entity);
    return p.columns.map(c => ({
      entity: p.entity, field: c.name,
      mapping: p.mapping, version: p.version, sourceId: p.sourceId, table: p.table,
      expr: c.expr,
      sourceColumns: [...new Set(referencedColumns(parseExpression(c.expr)).map(r => r.name))],
      sensitive: !!c.sensitive,
      dictionary: !!c.dictionary,
      extension: canonical && extensionName.test(c.name),
      fallback: c.otherwise === undefined ? null : { value: c.otherwise },
    }));
  });
  fields.sort((a, b) => cmp(a.entity, b.entity) || cmp(a.field, b.field) || cmp(a.mapping, b.mapping));

  return { tables, fields, edges: edges() };
}

/** 一个源列影响了哪些标准层字段 */
export function impactOf(lineage: Lineage, sourceId: string, table: string, column: string): FieldLineage[] {
  return lineage.fields.filter(f => f.sourceId === sourceId && f.table === table && f.sourceColumns.includes(column));
}

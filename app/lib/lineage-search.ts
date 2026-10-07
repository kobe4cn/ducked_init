// app/lib/lineage-search.ts —— 数据地图的反向查：输入列名（匹配所有源表里的这个列）或「表.列」（匹配所有同名源表里的这个列，表名按源表或源视图名，
// 不按数据源名），不区分大小写，找出受影响的标准层字段，换成流向图（flowGraph）与聚焦画布（focusGraph）里的节点、连线 id 与字段行。
// 源表抽屉（tableImpact）按源列列出它影响的标准层字段。只看字段级血缘里的列名与表达式，不读数据值（ADR-0019）。前后端共用的纯函数
import { cmp, type FieldLineage, impactOf, type Lineage } from './lineage';
import { groupId } from './lineage-flow';

export interface SearchHits {
  /** 流向图与聚焦画布的节点 id：source:<数据源>、table:<数据源>:<表>、mapping:<映射>、silver.<实体> */
  nodes: Set<string>;
  /** 流向图的连线（<from>-><to>，含数据源折叠时从分组出发的）与聚焦画布的连线（<映射>:<源列>-><字段>） */
  edges: Set<string>;
  /** 聚焦画布里命中的字段行，见 fieldKey */
  fields: Set<string>;
}

/** 聚焦画布里一行字段：节点 id 加列名 */
export const fieldKey = (nodeId: string, column: string) => `${nodeId}/${column}`;

/** q 为空时返回 null；没有命中时各集合为空 */
export function searchImpact(lineage: Lineage, q: string): SearchHits | null {
  const query = q.trim().toLowerCase();
  if (!query) return null;
  const dot = query.lastIndexOf('.');
  const table = dot === -1 ? null : query.slice(0, dot);
  const column = dot === -1 ? query : query.slice(dot + 1);

  const hits: SearchHits = { nodes: new Set(), edges: new Set(), fields: new Set() };
  for (const f of lineage.fields) {
    if (table !== null && f.table.toLowerCase() !== table) continue;
    const columns = f.sourceColumns.filter(c => c.toLowerCase() === column);
    if (!columns.length) continue;
    const group = groupId(f.sourceId);
    const source = `table:${f.sourceId}:${f.table}`;
    const mapping = `mapping:${f.mapping}`;
    const silver = `silver.${f.entity}`;
    for (const id of [group, source, mapping, silver]) hits.nodes.add(id);
    for (const [from, to] of [[source, mapping], [group, mapping], [mapping, silver]]) hits.edges.add(`${from}->${to}`);
    for (const c of columns) {
      hits.edges.add(`${f.mapping}:${c}->${f.field}`);
      hits.fields.add(fieldKey(source, c));
    }
    hits.fields.add(fieldKey(silver, f.field));
  }
  return hits;
}

/** 源表抽屉：一张源表每个被引用的列影响了哪些标准层字段 */
export interface TableImpact {
  sourceId: string; sourceName: string; table: string;
  /** 按列名排序 */
  columns: { column: string; fields: Pick<FieldLineage, 'entity' | 'field' | 'mapping' | 'version' | 'expr'>[] }[];
}

/** node 是流向图与聚焦画布的源表节点 id（table:<数据源>:<表>）；不是源表节点或没有已发布映射用到这张表时返回 null */
export function tableImpact(lineage: Lineage, node: string): TableImpact | null {
  const match = /^table:([^:]+):(.+)$/.exec(node);
  const t = match && lineage.tables.find(l => l.sourceId === match[1] && l.table === match[2]);
  if (!t) return null;
  const columns = [...new Set(lineage.fields.filter(f => f.sourceId === t.sourceId && f.table === t.table).flatMap(f => f.sourceColumns))].sort(cmp);
  return {
    sourceId: t.sourceId, sourceName: t.sourceName, table: t.table,
    columns: columns.map(column => ({
      column,
      fields: impactOf(lineage, t.sourceId, t.table, column).map(({ entity, field, mapping, version, expr }) => ({ entity, field, mapping, version, expr })),
    })),
  };
}

// app/lib/lineage-focus.ts —— 数据地图的单表聚焦画布：一张标准层表与写入它的源表（同名源表按数据源分开），节点逐行列出字段，
// 每对（源列, 标准层字段）一条边，handle 是列名；源表只列表达式引用到的源列（页面不读湖，拿不到完整列清单），常量表达式没有入边。
// 用 dagre 排 LR 布局，返回 React Flow 的节点与边（ADR-0019）。前后端共用的纯函数
import { Graph, layout } from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import { cmp, type FieldLineage } from './lineage';

export type FocusData =
  | { kind: 'table'; label: string; sourceId: string; sourceName: string; columns: string[] }
  | { kind: 'silver'; label: string; columns: string[] };

export type FocusNode = Node<FocusData> & { width: number; height: number };

export type FocusEdge = Edge & { sourceHandle: string; targetHandle: string };

export interface FocusGraph { nodes: FocusNode[]; edges: FocusEdge[] }

const FOCUS_WIDTH = 220;
/** 节点表头（表名与数据源）的高度 */
export const FOCUS_HEADER = 44;
/** 每行字段的高度 */
export const FOCUS_ROW = 24;

const tableId = (sourceId: string, table: string) => `table:${sourceId}:${table}`;

/**
 * 单表聚焦画布的输入：标准层表、它的字段顺序、写入它的字段级血缘（不写入这张表的会被忽略）与数据源的名字（按 ID，缺省用 ID）
 */
export interface FocusInput { entity: string; fields: string[]; lineage: FieldLineage[]; sourceNames: Record<string, string> }

export function focusGraph({ entity, fields, lineage, sourceNames }: FocusInput): FocusGraph {
  const target = `silver.${entity}`;
  const order = new Map(fields.map((f, i) => [f, i]));
  const own = lineage
    .filter(f => f.entity === entity)
    .sort((a, b) => (order.get(a.field) ?? Infinity) - (order.get(b.field) ?? Infinity) || cmp(a.field, b.field));

  const tables = new Map<string, Extract<FocusData, { kind: 'table' }>>();
  const edges: FocusEdge[] = [];
  for (const f of own) {
    const id = tableId(f.sourceId, f.table);
    const t = tables.get(id) ?? { kind: 'table', label: f.table, sourceId: f.sourceId, sourceName: sourceNames[f.sourceId] ?? f.sourceId, columns: [] };
    tables.set(id, t);
    for (const column of f.sourceColumns) {
      if (!t.columns.includes(column)) t.columns.push(column);
      edges.push({ id: `${f.mapping}:${column}->${f.field}`, source: id, sourceHandle: column, target, targetHandle: f.field });
    }
  }

  const drafts: { id: string; data: FocusData }[] = [
    ...[...tables].map(([id, data]) => ({ id, data })),
    { id: target, data: { kind: 'silver', label: target, columns: fields } },
  ];
  const heightOf = (d: FocusData) => FOCUS_HEADER + d.columns.length * FOCUS_ROW;

  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 160 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of drafts) g.setNode(n.id, { width: FOCUS_WIDTH, height: heightOf(n.data) });
  // 每张源表一条边就够排出两列
  for (const id of tables.keys()) g.setEdge(id, target);
  layout(g);

  return {
    nodes: drafts.map(n => {
      const { x, y } = g.node(n.id);
      const height = heightOf(n.data);
      return { id: n.id, data: n.data, width: FOCUS_WIDTH, height, position: { x: x - FOCUS_WIDTH / 2, y: y - height / 2 } };
    }),
    edges,
  };
}

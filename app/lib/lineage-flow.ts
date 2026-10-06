// app/lib/lineage-flow.ts —— 数据地图的流向图：源表（按数据源分组，可折叠）→ 映射 → 标准层表 → 打通表（_identities、_device_owner），
// 映射节点带版本与最近一次合并的时间与结果，标准层表节点带行数（最近一次合并成功的各映射的行数之和，取自任务结果，不查湖）与写入它的映射数；
// 用 dagre 的复合图算好坐标，返回 React Flow 的节点与边。只用表级血缘，不带列与表达式（ADR-0019）。前后端共用的纯函数
import { Graph, layout } from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { LineageEdge, TableLineage } from './lineage';
import { DEVICE_OWNER, NODE_HEIGHT, IDENTITIES, type IdentityInfo, relationGraph, NODE_WIDTH } from './lineage-graph';

/** 一个映射最近一次合并：时间是结束时间（ISO）；rows 只在成功时有 */
export interface FlowMerge { status: 'ok' | 'skipped' | 'failed'; at: string; rows: number | null }

export type FlowStatus = FlowMerge['status'] | 'never';

export const MERGE_STATUS: Record<FlowStatus, string> = { ok: '合并成功', skipped: '跳过（源表还没同步）', failed: '合并失败', never: '尚未合并' };

export type FlowData =
  | { kind: 'source'; label: string; sourceId: string; sourceKind: string; collapsed: boolean }
  | { kind: 'table'; label: string; viaView: boolean }
  | { kind: 'mapping'; label: string; mappingId: string; version: number; at: string | null; status: FlowStatus }
  | { kind: 'silver'; label: string; entity: string; rows: number; mappings: number }
  | { kind: 'identity'; label: string; identity: IdentityInfo | null }
  | { kind: 'device'; label: string };

export type FlowNode = Node<FlowData> & { width: number; height: number };

export interface FlowGraph { nodes: FlowNode[]; edges: Edge[] }

/** 流向图的输入：表级血缘、各映射最近一次合并（按映射 id）、关系边（从中取指向打通表的）与 _identities 的打通现状 */
export interface FlowInput { tables: TableLineage[]; merges: Record<string, FlowMerge>; identityEdges: LineageEdge[]; identity?: IdentityInfo | null }

/** 数据源超过这么多个时默认全部折叠 */
const COLLAPSE_OVER = 5;
/** 分组框的内边距 */
const PAD = 12;
/** 分组框顶上放数据源名字的一栏 */
const HEADER = 28;

export const groupId = (sourceId: string) => `source:${sourceId}`;
const tableId = (t: TableLineage) => `table:${t.sourceId}:${t.table}`;
const mappingId = (mapping: string) => `mapping:${mapping}`;

/** 各标准层表（silver.<entity>）的行数（写入它的各映射中，最近一次合并成功的行数之和；最近一次跳过、失败或从未合并的不计，只有最近一次的结果可看）与映射数，按首次出现排序 */
export function silverTotals(tables: TableLineage[], merges: Record<string, FlowMerge>) {
  const out = new Map<string, { entity: string; rows: number; mappings: number }>();
  for (const t of tables) {
    const s = out.get(t.target) ?? { entity: t.entity, rows: 0, mappings: 0 };
    const merge = merges[t.mapping];
    out.set(t.target, { ...s, rows: s.rows + (merge?.status === 'ok' ? merge.rows ?? 0 : 0), mappings: s.mappings + 1 });
  }
  return out;
}

export function defaultCollapsed(sourceIds: string[]): Set<string> {
  const ids = new Set(sourceIds);
  return ids.size > COLLAPSE_OVER ? ids : new Set();
}

/** collapsed：折叠的数据源 id */
export function flowGraph(
  input: FlowInput,
  collapsed: Set<string>,
): FlowGraph {
  type Draft = { id: string; data: FlowData; parent?: string; width: number; height: number };
  const nodes = new Map<string, Draft>();
  const edges: Edge[] = [];
  const add = (n: Draft) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const link = (source: string, target: string) => {
    const id = `${source}->${target}`;
    if (!edges.some(e => e.id === id)) edges.push({ id, source, target });
  };

  for (const t of input.tables) {
    const group = groupId(t.sourceId);
    add({ id: group, data: { kind: 'source', label: t.sourceName, sourceId: t.sourceId, sourceKind: t.sourceKind, collapsed: collapsed.has(t.sourceId) }, width: NODE_WIDTH, height: NODE_HEIGHT });
    let from = group;
    if (!collapsed.has(t.sourceId)) {
      from = tableId(t);
      add({ id: from, data: { kind: 'table', label: t.table, viaView: t.viaView }, parent: group, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    const merge = input.merges[t.mapping];
    const m = mappingId(t.mapping);
    add({
      id: m, width: NODE_WIDTH, height: NODE_HEIGHT,
      data: { kind: 'mapping', label: `${t.table} → ${t.entity} v${t.version}`, mappingId: t.mapping, version: t.version, at: merge?.at ?? null, status: merge?.status ?? 'never' },
    });
    link(from, m);
    link(m, t.target);
  }
  for (const [target, { entity, rows, mappings }] of silverTotals(input.tables, input.merges)) {
    nodes.set(target, { id: target, data: { kind: 'silver', label: target, entity, rows, mappings }, width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  // 打通表与指向它们的边沿用关系图的口径
  const relation = relationGraph({ edges: input.identityEdges, connected: input.tables.map(t => t.entity), showAll: false, identity: input.identity });
  for (const n of relation.nodes) {
    if (n.id === IDENTITIES) add({ id: n.id, data: { kind: 'identity', label: n.label, identity: n.identity ?? null }, width: n.width, height: n.height });
    if (n.id === DEVICE_OWNER) add({ id: n.id, data: { kind: 'device', label: n.label }, width: n.width, height: n.height });
  }
  for (const e of relation.edges) {
    if ((e.kind === 'identity' || e.kind === 'device') && (e.target === IDENTITIES || e.target === DEVICE_OWNER)) link(`silver.${e.source}`, e.target);
  }

  // 展开的数据源是复合图里的分组：dagre 只排子节点，分组框按子节点的范围加内边距算
  const isGroup = (n: Draft) => n.data.kind === 'source' && !n.data.collapsed;
  const g = new Graph({ compound: true });
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes.values()) g.setNode(n.id, isGroup(n) ? {} : { width: n.width, height: n.height });
  for (const n of nodes.values()) if (n.parent) g.setParent(n.id, n.parent);
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);

  // 左上角的绝对坐标
  const topLeft = new Map<string, { x: number; y: number }>();
  for (const n of nodes.values()) {
    if (isGroup(n)) continue;
    const { x, y } = g.node(n.id);
    topLeft.set(n.id, { x: x - n.width / 2, y: y - n.height / 2 });
  }
  for (const n of nodes.values()) {
    if (!isGroup(n)) continue;
    const children = [...nodes.values()].filter(c => c.parent === n.id);
    const left = Math.min(...children.map(c => topLeft.get(c.id)!.x)) - PAD;
    const top = Math.min(...children.map(c => topLeft.get(c.id)!.y)) - PAD - HEADER;
    const right = Math.max(...children.map(c => topLeft.get(c.id)!.x + c.width)) + PAD;
    const bottom = Math.max(...children.map(c => topLeft.get(c.id)!.y + c.height)) + PAD;
    topLeft.set(n.id, { x: left, y: top });
    n.width = right - left;
    n.height = bottom - top;
  }

  // React Flow 要求分组排在子节点前，子节点的坐标相对分组
  const ordered = [...nodes.values()].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
  return {
    nodes: ordered.map(n => {
      const at = topLeft.get(n.id)!;
      const parent = n.parent ? topLeft.get(n.parent)! : null;
      return {
        id: n.id, data: n.data, width: n.width, height: n.height,
        position: parent ? { x: at.x - parent.x, y: at.y - parent.y } : at,
        ...(isGroup(n) ? { type: 'group' } : {}),
        ...(n.parent ? { parentId: n.parent, extent: 'parent' as const } : {}),
      };
    }),
    edges,
  };
}

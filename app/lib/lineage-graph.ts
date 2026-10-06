// app/lib/lineage-graph.ts —— 数据地图的关系图：由血缘的关系边与已接入的标准层表画出节点与边（指向 customer 的经 _identities 关联，
// event.device_id 经 _device_owner 归到消费者，口径见 ADR-0019），用 dagre 算好坐标；点表节点给出示例 SQL，
// 一律按租户湖挂载为 lake 来写（ADR-0001/0008），不带连接方式与凭据。前后端共用的纯函数
import { Graph, layout } from '@dagrejs/dagre';
import { entityOf } from './canonical-model';
import type { LineageEdge } from './lineage';

export interface GraphNode {
  id: string;
  label: string;
  kind: 'entity' | 'identity' | 'device';
  /** 节点中心的坐标 */
  x: number; y: number;
  width: number; height: number;
}

export interface GraphEdge { id: string; source: string; target: string; kind: 'ref' | 'identity' | 'device'; label: string }

export interface RelationGraph { nodes: GraphNode[]; edges: GraphEdge[] }

const IDENTITIES = '_identities';
const DEVICE_OWNER = '_device_owner';
const WIDTH = 180;
const HEIGHT = 56;

const tableOf = (silver: string) => silver.replace(/^silver\./, '');

export function relationGraph(input: { edges: LineageEdge[]; connected: string[] }): RelationGraph {
  const connected = [...new Set(input.connected)];
  const nodes: Omit<GraphNode, 'x' | 'y'>[] = connected.map(id => ({ id, label: entityOf(id)?.label ?? id, kind: 'entity', width: WIDTH, height: HEIGHT }));
  if (connected.includes('customer')) nodes.push({ id: IDENTITIES, label: IDENTITIES, kind: 'identity', width: WIDTH, height: HEIGHT });
  if (connected.includes('event')) nodes.push({ id: DEVICE_OWNER, label: DEVICE_OWNER, kind: 'device', width: WIDTH, height: HEIGHT });
  const nodeIds = new Set(nodes.map(n => n.id));

  const edges: GraphEdge[] = [];
  for (const e of input.edges) {
    const source = e.from.entity;
    const target = tableOf(e.to.table);
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const label = e.kind === 'ref' ? `${e.from.field} → ${target}.${e.to.field}`
      : e.kind === 'identity' ? '经 _identities 按 (_source, customer_id) 关联'
      : 'device_id（不带 _source，取最近一次登录）';
    edges.push({ id: `${e.kind}:${source}.${e.from.field}->${target}`, source, target, kind: e.kind, label });
  }
  if (nodeIds.has(IDENTITIES)) {
    edges.push({ id: `identity:customer.customer_id->${IDENTITIES}`, source: 'customer', target: IDENTITIES, kind: 'identity', label: 'customer_id → consumer_id' });
  }

  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);

  return {
    nodes: nodes.map(n => {
      const { x, y } = g.node(n.id);
      return { ...n, x, y };
    }),
    edges,
  };
}

const lake = (table: string) => `lake.silver."${table}"`;

/** 点表节点时给出的示例 SQL；不认识的节点返回 null */
export function sampleSql(nodeId: string, graph: RelationGraph): string | null {
  if (!graph.nodes.some(n => n.id === nodeId)) return null;
  const identitiesTable = lake(IDENTITIES);
  if (nodeId === 'customer') {
    return [
      '-- 每条消费者记录对应的统一消费者',
      'SELECT i.consumer_id, c.*',
      `FROM ${lake('customer')} c`,
      `JOIN ${identitiesTable} i ON i._source = c._source AND i.customer_id = c.customer_id`,
      'LIMIT 100;',
    ].join('\n');
  }
  if (nodeId === IDENTITIES) {
    return [
      '-- 每个统一消费者归并了几条源端记录',
      'SELECT consumer_id, count(*) AS records',
      `FROM ${identitiesTable}`,
      'GROUP BY consumer_id',
      'ORDER BY records DESC',
      'LIMIT 100;',
    ].join('\n');
  }
  if (nodeId === DEVICE_OWNER) {
    return [
      '-- 匿名事件按设备最近一次登录归到消费者',
      'SELECT e.*, d.consumer_id',
      `FROM ${lake('event')} e LEFT JOIN ${lake(DEVICE_OWNER)} d ON d.device_id = e.device_id`,
      'LIMIT 100;',
    ].join('\n');
  }
  if (graph.edges.some(e => e.kind === 'identity' && e.source === nodeId && e.target === 'customer')) {
    return [
      '-- 按统一消费者汇总',
      'SELECT i.consumer_id, count(*) AS records',
      `FROM ${lake(nodeId)} t`,
      `JOIN ${identitiesTable} i ON i._source = t._source AND i.customer_id = t.customer_id`,
      'GROUP BY i.consumer_id',
      'ORDER BY records DESC',
      'LIMIT 100;',
    ].join('\n');
  }
  return `SELECT *\nFROM ${lake(nodeId)}\nLIMIT 100;`;
}

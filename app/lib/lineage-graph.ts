// app/lib/lineage-graph.ts —— 数据地图的关系图：由血缘的关系边与已接入的标准层表画出节点与边（指向 customer 的经 _identities 关联，
// event.device_id 经 _device_owner 归到消费者，口径见 ADR-0019），用 dagre 算好坐标；_identities 节点挂上匹配规则与最近一次打通的摘要；
// 打开 showAll 时把未接入的标准实体与它们的内置关系也画出来，标为未接入；点表节点给出示例 SQL，
// 一律按租户湖挂载为 lake 来写（ADR-0001/0008），不带连接方式与凭据。前后端共用的纯函数
import { Graph, layout } from '@dagrejs/dagre';
import { CANONICAL_ENTITIES, entityOf } from './canonical-model';
import type { LineageEdge } from './lineage';

/** 身份打通的现状：匹配规则（读不出来时为 null）与最近一次打通的摘要（还没打通过时为 null），只有计数，不带消费者标识 */
export interface IdentityInfo { rules: readonly string[] | null; summary: { groups: number; records: number } | null }

export interface GraphNode {
  id: string;
  label: string;
  kind: 'entity' | 'identity' | 'device';
  /** 已接入（有已发布映射）；showAll 画出来的未接入标准实体为 false */
  connected: boolean;
  /** 只挂在 _identities 节点上 */
  identity?: IdentityInfo;
  /** 节点中心的坐标 */
  x: number; y: number;
  width: number; height: number;
}

/** connected：两端都已接入；fromField：起点字段，只挂在指向标准实体的 ref / identity 边上，用来对上合并后的孤儿统计（ADR-0019） */
export interface GraphEdge { id: string; source: string; target: string; kind: 'ref' | 'identity' | 'device'; label: string; connected: boolean; fromField?: string }

export interface RelationGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export const IDENTITIES = '_identities';
export const DEVICE_OWNER = '_device_owner';
/** 表节点的尺寸 */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 56;
/** 带打通摘要的 _identities 节点多出规则与计数两行 */
const IDENTITY_HEIGHT = 96;

const tableOf = (silver: string) => silver.replace(/^silver\./, '');

/** 匹配规则按 customer 的字段名称写，按优先级以「 > 」连接，如「手机号 > 邮箱 > 外部 ID」 */
export const ruleLabels = (rules: readonly string[]) =>
  rules.map(r => entityOf('customer')?.fields.find(f => f.name === r)?.label ?? r).join(' > ');

export function relationGraph(input: { edges: LineageEdge[]; connected: string[]; showAll: boolean; identity?: IdentityInfo | null }): RelationGraph {
  const connected = [...new Set(input.connected)];
  const entity = (id: string, live: boolean): Omit<GraphNode, 'x' | 'y'> =>
    ({ id, label: entityOf(id)?.label ?? id, kind: 'entity', connected: live, width: NODE_WIDTH, height: NODE_HEIGHT });
  const nodes = connected.map(id => entity(id, true));
  if (input.showAll) nodes.push(...CANONICAL_ENTITIES.filter(e => !connected.includes(e.name)).map(e => entity(e.name, false)));
  if (connected.includes('customer')) {
    nodes.push({
      id: IDENTITIES, label: IDENTITIES, kind: 'identity', connected: true, width: NODE_WIDTH,
      ...(input.identity ? { identity: input.identity, height: IDENTITY_HEIGHT } : { height: NODE_HEIGHT }),
    });
  }
  if (connected.includes('event')) nodes.push({ id: DEVICE_OWNER, label: DEVICE_OWNER, kind: 'device', connected: true, width: NODE_WIDTH, height: NODE_HEIGHT });
  const nodeIds = new Set(nodes.map(n => n.id));
  const liveIds = new Set(nodes.filter(n => n.connected).map(n => n.id));

  const edges: GraphEdge[] = [];
  for (const e of input.edges) {
    const source = e.from.entity;
    const target = tableOf(e.to.table);
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const label = e.kind === 'ref' ? `${e.from.field} → ${target}.${e.to.field}`
      : e.kind === 'identity' ? '经 _identities 按 (_source, customer_id) 关联'
      : 'device_id（不带 _source，取最近一次登录）';
    const toEntity = e.kind !== 'device' && target !== IDENTITIES && target !== DEVICE_OWNER;
    edges.push({
      id: `${e.kind}:${source}.${e.from.field}->${target}`, source, target, kind: e.kind, label, connected: liveIds.has(source) && liveIds.has(target),
      ...(toEntity && { fromField: e.from.field }),
    });
  }
  if (nodeIds.has(IDENTITIES)) {
    edges.push({ id: `identity:customer.customer_id->${IDENTITIES}`, source: 'customer', target: IDENTITIES, kind: 'identity', label: 'customer_id → consumer_id', connected: true });
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

/** 点表节点时给出的示例 SQL；不认识的节点与未接入的节点（湖里还没有这张表）返回 null */
export function sampleSql(nodeId: string, graph: RelationGraph): string | null {
  if (!graph.nodes.some(n => n.id === nodeId && n.connected)) return null;
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

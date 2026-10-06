// app/components/lineage-graph.tsx —— 数据地图的关系图：用 React Flow 画 relationGraph 算好坐标的节点与边，挂载后才渲染（服务端不测量节点）；
// 经 _identities、_device_owner 的边用虚线与不同颜色并显示说明；未接入的节点与边灰显；_identities 节点内显示匹配规则与打通摘要；
// 点节点把 ?node= 写进 URL，页面据此给出示例 SQL
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Background, type Edge, MarkerType, type Node, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type GraphEdge, type GraphNode, type RelationGraph, ruleLabels } from '~/lib/lineage-graph';

const NODE_STYLE: Record<GraphNode['kind'], React.CSSProperties> = {
  entity: { background: '#fff', borderColor: '#cbd5e1' },
  identity: { background: '#ecfdf5', borderColor: '#6ee7b7' },
  device: { background: '#f5f3ff', borderColor: '#c4b5fd' },
};

const EDGE_COLOR: Record<GraphEdge['kind'], string> = { ref: '#94a3b8', identity: '#059669', device: '#7c3aed' };
const DISCONNECTED_NODE: React.CSSProperties = { background: '#f8fafc', borderColor: '#e2e8f0', borderStyle: 'dashed', color: '#94a3b8', opacity: 0.7 };
const DISCONNECTED_EDGE = '#cbd5e1';

const nodeLabel = (n: GraphNode): React.ReactNode => {
  const name = n.kind === 'entity' && n.label !== n.id ? `${n.label}（${n.id}）` : n.label;
  if (!n.identity) return name;
  const { rules, summary } = n.identity;
  return (
    <div className="space-y-0.5 leading-tight">
      <div>{name}</div>
      {rules && <div className="text-[10px] text-slate-500">{ruleLabels(rules)}</div>}
      <div className="text-[10px] text-slate-500">
        {summary ? `统一消费者 ${summary.groups.toLocaleString()} · 记录 ${summary.records.toLocaleString()}` : '尚未合并'}
      </div>
    </div>
  );
};

export function RelationGraphView({ graph, selected }: { graph: RelationGraph; selected: string | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [, setSearchParams] = useSearchParams();

  const nodes = useMemo<Node[]>(() => graph.nodes.map(n => ({
    id: n.id,
    // React Flow 的坐标是左上角，dagre 给的是中心
    position: { x: n.x - n.width / 2, y: n.y - n.height / 2 },
    data: { label: nodeLabel(n) },
    width: n.width, height: n.height,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    draggable: false, connectable: false,
    selected: n.id === selected,
    style: {
      ...NODE_STYLE[n.kind], ...(n.connected ? {} : DISCONNECTED_NODE), width: n.width, height: n.height, borderWidth: n.id === selected ? 2 : 1, borderRadius: 12,
      fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
      ...(n.id === selected ? { borderColor: '#0f172a' } : {}),
    },
  })), [graph, selected]);

  const edges = useMemo<Edge[]>(() => graph.edges.map(e => {
    const color = e.connected ? EDGE_COLOR[e.kind] : DISCONNECTED_EDGE;
    return {
      id: e.id, source: e.source, target: e.target,
      label: e.kind === 'ref' ? undefined : e.label,
      labelStyle: { fontSize: 11, fill: color },
      style: { stroke: color, strokeDasharray: e.kind === 'ref' ? undefined : '6 4', opacity: e.connected ? 1 : 0.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    };
  }), [graph]);

  return (
    <div className="h-[480px] rounded-xl border bg-slate-50">
      {mounted && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => graph.nodes.find(n => n.id === node.id)?.connected && setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('node', node.id);
            return next;
          }, { preventScrollReset: true })}
        >
          <Background />
        </ReactFlow>
      )}
    </div>
  );
}

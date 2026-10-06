// app/components/lineage-graph.tsx —— 数据地图的关系图：用 React Flow 画 relationGraph 算好坐标的节点与边，挂载后才渲染（服务端不测量节点）；
// 经 _identities、_device_owner 的边用虚线与不同颜色并显示说明；点节点把 ?node= 写进 URL，页面据此给出示例 SQL
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Background, type Edge, MarkerType, type Node, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { GraphEdge, GraphNode, RelationGraph } from '~/lib/lineage-graph';

const NODE_STYLE: Record<GraphNode['kind'], React.CSSProperties> = {
  entity: { background: '#fff', borderColor: '#cbd5e1' },
  identity: { background: '#ecfdf5', borderColor: '#6ee7b7' },
  device: { background: '#f5f3ff', borderColor: '#c4b5fd' },
};

const EDGE_COLOR: Record<GraphEdge['kind'], string> = { ref: '#94a3b8', identity: '#059669', device: '#7c3aed' };

export function RelationGraphView({ graph, selected }: { graph: RelationGraph; selected: string | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [, setSearchParams] = useSearchParams();

  const nodes = useMemo<Node[]>(() => graph.nodes.map(n => ({
    id: n.id,
    // React Flow 的坐标是左上角，dagre 给的是中心
    position: { x: n.x - n.width / 2, y: n.y - n.height / 2 },
    data: { label: n.kind === 'entity' && n.label !== n.id ? `${n.label}（${n.id}）` : n.label },
    width: n.width, height: n.height,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    draggable: false, connectable: false,
    selected: n.id === selected,
    style: {
      ...NODE_STYLE[n.kind], width: n.width, height: n.height, borderWidth: n.id === selected ? 2 : 1, borderRadius: 12,
      fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
      ...(n.id === selected ? { borderColor: '#0f172a' } : {}),
    },
  })), [graph, selected]);

  const edges = useMemo<Edge[]>(() => graph.edges.map(e => ({
    id: e.id, source: e.source, target: e.target,
    label: e.kind === 'ref' ? undefined : e.label,
    labelStyle: { fontSize: 11, fill: EDGE_COLOR[e.kind] },
    style: { stroke: EDGE_COLOR[e.kind], strokeDasharray: e.kind === 'ref' ? undefined : '6 4' },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.kind] },
  })), [graph]);

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
          onNodeClick={(_, node) => setSearchParams(prev => {
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

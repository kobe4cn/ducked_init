// app/components/lineage-graph.tsx —— 数据地图的关系图：用 React Flow 画 relationGraph 算好坐标的节点与边，挂载后才渲染（服务端不测量节点）；
// 经 _identities、_device_owner 的边用虚线与不同颜色并显示说明；未接入的节点与边灰显；_identities 节点内显示匹配规则与打通摘要；
// 最近一次漂移检查有差异的标准层表标红边、带漂移徽标与 data-node-drift；
// 节点可以拖动（只在本页有效，可重置），悬停或选中节点时突出它的连线、其余变淡；点节点把 ?node= 写进 URL，页面据此给出示例 SQL
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Background, Controls, type Edge, MarkerType, type Node, type NodeChange, Panel, Position, ReactFlow, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DRIFT_NODE_STYLE, DriftBadge } from '~/components/drift-badge';
import { driftAttrs, type DriftByTable, type DriftCounts } from '~/lib/lineage-drift';
import { type GraphEdge, type GraphNode, type RelationGraph, ruleLabels } from '~/lib/lineage-graph';

const NODE_STYLE: Record<GraphNode['kind'], React.CSSProperties> = {
  entity: { background: '#fff', borderColor: '#cbd5e1' },
  identity: { background: '#ecfdf5', borderColor: '#6ee7b7' },
  device: { background: '#f5f3ff', borderColor: '#c4b5fd' },
};

const EDGE_COLOR: Record<GraphEdge['kind'], string> = { ref: '#94a3b8', identity: '#059669', device: '#7c3aed' };
const DISCONNECTED_NODE: React.CSSProperties = { background: '#f8fafc', borderColor: '#e2e8f0', borderStyle: 'dashed', color: '#94a3b8', opacity: 0.7 };
const DISCONNECTED_EDGE = '#cbd5e1';

const nodeLabel = (n: GraphNode, drift: DriftCounts | undefined): React.ReactNode => {
  const name = n.kind === 'entity' && n.label !== n.id ? `${n.label}（${n.id}）` : n.label;
  if (!n.identity && !drift) return name;
  const { rules, summary } = n.identity ?? {};
  return (
    <div className="space-y-0.5 leading-tight">
      <div>{name}</div>
      {rules && <div className="text-[10px] text-slate-500">{ruleLabels(rules)}</div>}
      {n.identity && (
        <div className="text-[10px] text-slate-500">
          {summary ? `统一消费者 ${summary.groups.toLocaleString()} · 记录 ${summary.records.toLocaleString()}` : '尚未合并'}
        </div>
      )}
      {drift && <DriftBadge counts={drift} small />}
    </div>
  );
};

/** drift：最近一次成功的漂移检查里有差异的表 */
export function RelationGraphView({ graph, selected, drift }: { graph: RelationGraph; selected: string | null; drift: DriftByTable }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [, setSearchParams] = useSearchParams();
  // 拖动过的节点位置（左上角）；节点变了（如切换显示未接入的实体）时回到 dagre 的布局。
  // 点节点会重新加载、换一个 graph 对象，所以按节点集合而不是 graph 本身判断
  const [moved, setMoved] = useState<Record<string, XYPosition>>({});
  const layoutKey = graph.nodes.map(n => n.id).join();
  useEffect(() => setMoved({}), [layoutKey]);
  // 悬停的节点：它与选中节点的连线突出显示，其余的变淡
  const [hovered, setHovered] = useState<string | null>(null);
  const focus = hovered ?? selected;

  const nodes = useMemo<Node[]>(() => graph.nodes.map(n => ({
    id: n.id,
    // React Flow 的坐标是左上角，dagre 给的是中心
    position: moved[n.id] ?? { x: n.x - n.width / 2, y: n.y - n.height / 2 },
    data: { label: nodeLabel(n, drift[n.id]) },
    domAttributes: driftAttrs(drift[n.id]) as React.HTMLAttributes<HTMLDivElement>,
    width: n.width, height: n.height,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    connectable: false,
    selected: n.id === selected,
    style: {
      ...NODE_STYLE[n.kind], ...(n.connected ? {} : DISCONNECTED_NODE), ...(drift[n.id] ? DRIFT_NODE_STYLE : {}), width: n.width, height: n.height, borderWidth: n.id === selected ? 2 : 1, borderRadius: 12,
      fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab',
      ...(n.id === selected ? { borderColor: '#0f172a' } : {}),
    },
  })), [graph, selected, moved, drift]);

  const edges = useMemo<Edge[]>(() => graph.edges.map(e => {
    const color = e.connected ? EDGE_COLOR[e.kind] : DISCONNECTED_EDGE;
    const near = focus !== null && (e.source === focus || e.target === focus);
    const faded = focus !== null && !near;
    return {
      id: e.id, source: e.source, target: e.target,
      // 内置关系平时不显示说明，悬停或选中一端时显示
      label: e.kind === 'ref' && !near ? undefined : e.label,
      labelStyle: { fontSize: 11, fill: color },
      zIndex: near ? 1 : 0,
      style: {
        stroke: color, strokeDasharray: e.kind === 'ref' ? undefined : '6 4', strokeWidth: near ? 2 : 1,
        opacity: faded ? 0.12 : e.connected ? 1 : 0.6,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    };
  }), [graph, focus]);

  const onNodesChange = (changes: NodeChange[]) => {
    const positions = changes.flatMap(c => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
    if (positions.length) setMoved(prev => ({ ...prev, ...Object.fromEntries(positions) }));
  };

  return (
    <div className="h-[560px] rounded-xl border bg-slate-50">
      {mounted && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesConnectable={false}
          onNodesChange={onNodesChange}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => graph.nodes.find(n => n.id === node.id)?.connected && setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('node', node.id);
            return next;
          }, { preventScrollReset: true })}
        >
          <Background />
          <Controls showInteractive={false} />
          {Object.keys(moved).length > 0 && (
            <Panel position="top-right">
              <button type="button" onClick={() => setMoved({})} className="rounded-lg border bg-white px-3 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50">
                重置布局
              </button>
            </Panel>
          )}
        </ReactFlow>
      )}
    </div>
  );
}

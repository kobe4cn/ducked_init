// app/components/lineage-focus.tsx —— 数据地图的单表聚焦画布：用 React Flow 画 focusGraph 算好坐标的节点与边，挂载后才渲染；
// 自定义节点 fieldTable 逐行列出字段，每行左右各一个 handle（id 是列名），连线从源列连到标准层字段。悬停节点时高亮它的连线，
// 点标准层表把 ?node=silver.<实体> 写进 URL 打开字段抽屉。节点可以拖动（只在本页有效，可重置）
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Background, Controls, type Edge, Handle, MarkerType, type Node, type NodeChange, type NodeProps, Panel, Position, ReactFlow, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FOCUS_HEADER, FOCUS_ROW, type FocusData, type FocusGraph } from '~/lib/lineage-focus';

const HIDDEN_HANDLE: React.CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 0 };

/** 一张表：表头是表名（源表再带数据源名字），下面逐行是列 */
function FieldTableNode({ data }: NodeProps<Node<FocusData>>) {
  const silver = data.kind === 'silver';
  return (
    <div className={`h-full overflow-hidden rounded-xl border text-xs ${silver ? 'border-slate-400 bg-slate-50' : 'border-slate-300 bg-white'}`}>
      <div className="flex flex-col justify-center border-b px-3" style={{ height: FOCUS_HEADER }}>
        <div className="truncate font-mono font-medium text-slate-900">{data.label}</div>
        {data.kind === 'table' && <div className="truncate text-[10px] text-slate-500">{data.sourceName}</div>}
      </div>
      {data.columns.map(c => (
        <div key={c} className="relative flex items-center px-3 font-mono text-slate-700" style={{ height: FOCUS_ROW }}>
          <Handle type="target" position={Position.Left} id={c} isConnectable={false} style={HIDDEN_HANDLE} />
          <span className="truncate">{c}</span>
          <Handle type="source" position={Position.Right} id={c} isConnectable={false} style={HIDDEN_HANDLE} />
        </div>
      ))}
      {data.columns.length === 0 && <div className="px-3 py-1 text-[10px] text-slate-400">没有引用源列</div>}
    </div>
  );
}
const NODE_TYPES = { fieldTable: FieldTableNode };

export function FocusGraphView({ graph }: { graph: FocusGraph }) {
  const [mounted, setMounted] = useState(false);
  const [, setSearchParams] = useSearchParams();
  useEffect(() => setMounted(true), []);
  // 拖动过的节点位置（左上角）；换了聚焦的表时全部回到 dagre 的布局
  const [moved, setMoved] = useState<Record<string, XYPosition>>({});
  const graphKey = graph.nodes.map(n => n.id).join();
  useEffect(() => setMoved({}), [graphKey]);
  const [hovered, setHovered] = useState<string | null>(null);

  const nodes = useMemo<Node[]>(() => graph.nodes.map(n => ({
    ...n,
    type: 'fieldTable',
    position: moved[n.id] ?? n.position,
    connectable: false,
    style: { width: n.width, height: n.height, cursor: n.data.kind === 'silver' ? 'pointer' : 'grab' },
  })), [graph, moved]);

  const edges = useMemo<Edge[]>(() => graph.edges.map(e => {
    const near = hovered !== null && (e.source === hovered || e.target === hovered);
    return {
      ...e,
      zIndex: 1,
      style: { stroke: '#94a3b8', strokeWidth: near ? 2 : 1, opacity: hovered !== null && !near ? 0.15 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    };
  }), [graph, hovered]);

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
          nodeTypes={NODE_TYPES}
          fitView
          nodesConnectable={false}
          onNodesChange={onNodesChange}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            if (graph.nodes.find(n => n.id === node.id)?.data.kind === 'silver') setSearchParams(prev => {
              const next = new URLSearchParams(prev);
              next.set('node', node.id);
              return next;
            }, { preventScrollReset: true });
          }}
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

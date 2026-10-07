// app/components/lineage-flow.tsx —— 数据地图的流向图：用 React Flow 画 flowGraph 算好坐标的节点与边，挂载后才渲染（服务端不测量节点）；
// 源表按数据源分组，点分组切换折叠（数据源超过 5 个时默认全部折叠），折叠后在客户端重新排版；映射节点显示版本与最近一次合并，
// 失败的标红并链到该映射的合并记录；标准层表节点显示行数与映射数，点它把 ?node=silver.<实体> 写进 URL 打开字段抽屉，点源表节点写 ?node=table:<数据源>:<表> 打开源表抽屉。
// 反向查有结果（hits）时未命中的节点与连线变淡。节点可以拖动（只在本页有效，可重置）
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock } from 'lucide-react';
import { Background, Controls, type Edge, MarkerType, type Node, type NodeChange, type NodeProps, Panel, Position, ReactFlow, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { KindIcon } from '~/components/kind-icon';
import { defaultCollapsed, type FlowData, type FlowInput, flowGraph, type FlowStatus, groupId, MERGE_STATUS } from '~/lib/lineage-flow';
import { ruleLabels } from '~/lib/lineage-graph';
import type { SearchHits } from '~/lib/lineage-search';
import type { SourceKind } from '~/lib/sources';

const NODE_STYLE: Record<FlowData['kind'], React.CSSProperties> = {
  source: { background: '#fff', borderColor: '#cbd5e1' },
  table: { background: '#fff', borderColor: '#cbd5e1' },
  mapping: { background: '#fff', borderColor: '#cbd5e1' },
  silver: { background: '#f8fafc', borderColor: '#94a3b8' },
  identity: { background: '#ecfdf5', borderColor: '#6ee7b7' },
  device: { background: '#f5f3ff', borderColor: '#c4b5fd' },
};
const FAILED: React.CSSProperties = { background: '#fef2f2', borderColor: '#fca5a5' };
/** 变淡：悬停时与它无关的连线、反向查时没命中的节点与连线 */
export const FADED = 0.15;

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

const STATUS_ICON: Record<FlowStatus, typeof CheckCircle2> = { ok: CheckCircle2, skipped: Clock, failed: AlertTriangle, never: CircleDashed };
const STATUS_TONE: Record<FlowStatus, string> = { ok: 'text-emerald-600', skipped: 'text-amber-600', failed: 'text-red-600', never: 'text-slate-500' };

/** 映射最近一次合并的结果：图标、文字与时间；失败的链到该映射的合并记录。small 用在图节点里 */
export function MergeStatus({ status, at, mappingId, small }: { status: FlowStatus; at: string | null; mappingId: string; small?: boolean }) {
  const Icon = STATUS_ICON[status];
  const label = status === 'failed'
    ? <Link to={`/mappings/${mappingId}?tab=merges`} className="nodrag underline-offset-2 hover:underline">{MERGE_STATUS.failed}</Link>
    : MERGE_STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 ${small ? 'text-[10px]' : 'text-sm'} ${STATUS_TONE[status]}`}>
      <Icon className={`${small ? 'size-3' : 'size-4'} shrink-0`} />
      {label}
      {at && <span className="text-slate-500">{` · ${time(at)}`}</span>}
    </span>
  );
}

/** 展开的数据源分组：只画顶栏的名字，点它切换折叠 */
function GroupNode({ data }: NodeProps<Node<{ label: React.ReactNode }>>) {
  return <div className="cursor-pointer px-3 py-1 text-left text-xs font-medium text-slate-700">{data.label}</div>;
}
const NODE_TYPES = { flowGroup: GroupNode };

const small = (text: React.ReactNode, className = 'text-slate-500') => <div className={`text-[10px] ${className}`}>{text}</div>;

function nodeLabel(d: FlowData, tableCount: Record<string, number>): React.ReactNode {
  switch (d.kind) {
    case 'source':
      return d.collapsed
        ? (
          <div className="flex items-center gap-2 leading-tight">
            <KindIcon kind={d.sourceKind as SourceKind} small />
            <div className="text-left"><div>{d.label} ▸</div>{small(`${tableCount[d.sourceId]} 张源表，点击展开`)}</div>
          </div>
        )
        : <span className="flex items-center gap-2"><KindIcon kind={d.sourceKind as SourceKind} small />{`${d.label} ▾`}</span>;
    case 'table':
      return d.viaView ? <div className="leading-tight"><div>{d.label}</div>{small('源视图')}</div> : d.label;
    case 'mapping':
      return (
        <div className="leading-tight">
          <div>{d.label}</div>
          <MergeStatus status={d.status} at={d.at} mappingId={d.mappingId} small />
        </div>
      );
    case 'silver':
      return <div className="leading-tight"><div>{d.label}</div>{small(`${d.rows.toLocaleString('zh-CN')} 行 · ${d.mappings} 个映射`)}</div>;
    case 'identity': {
      const summary = d.identity?.summary;
      return (
        <div className="leading-tight">
          <div>{d.label}</div>
          {d.identity?.rules && small(ruleLabels(d.identity.rules))}
          {small(summary ? `统一消费者 ${summary.groups.toLocaleString('zh-CN')} · 记录 ${summary.records.toLocaleString('zh-CN')}` : '尚未合并')}
        </div>
      );
    }
    case 'device':
      return d.label;
  }
}

export function FlowGraphView({ flow, hits }: { flow: FlowInput; hits?: SearchHits | null }) {
  const [mounted, setMounted] = useState(false);
  const [, setSearchParams] = useSearchParams();
  useEffect(() => setMounted(true), []);
  const sourceIds = useMemo(() => [...new Set(flow.tables.map(t => t.sourceId))], [flow]);
  const [collapsed, setCollapsed] = useState(() => defaultCollapsed(sourceIds));
  const graph = useMemo(() => flowGraph(flow, collapsed), [flow, collapsed]);
  const tableCount = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of sourceIds) out[id] = new Set(flow.tables.filter(t => t.sourceId === id).map(t => t.table)).size;
    return out;
  }, [flow, sourceIds]);
  // 拖动过的节点位置（左上角，子节点相对分组），按折叠状态分开存；映射变了时全部回到 dagre 的布局
  const [movedBy, setMovedBy] = useState<Record<string, Record<string, XYPosition>>>({});
  const collapseKey = [...collapsed].sort().join();
  const moved = useMemo(() => movedBy[collapseKey] ?? {}, [movedBy, collapseKey]);
  const setMoved = (update: (prev: Record<string, XYPosition>) => Record<string, XYPosition>) =>
    setMovedBy(prev => ({ ...prev, [collapseKey]: update(prev[collapseKey] ?? {}) }));
  const flowKey = flow.tables.map(t => t.mapping).join();
  useEffect(() => setMovedBy({}), [flowKey]);
  const [hovered, setHovered] = useState<string | null>(null);

  const nodes = useMemo<Node[]>(() => graph.nodes.map(n => {
    const failed = n.data.kind === 'mapping' && n.data.status === 'failed';
    const group = n.type === 'group';
    return {
      ...n,
      type: group ? 'flowGroup' : undefined,
      position: moved[n.id] ?? n.position,
      data: { label: nodeLabel(n.data, tableCount) },
      sourcePosition: Position.Right, targetPosition: Position.Left,
      connectable: false,
      style: {
        ...NODE_STYLE[n.data.kind], ...(failed ? FAILED : {}), width: n.width, height: n.height, borderWidth: 1, borderStyle: 'solid', borderRadius: 12, fontSize: 12,
        ...(group
          ? { background: 'rgba(240, 249, 255, 0.6)', display: 'flex', alignItems: 'flex-start' }
          : { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' as const, cursor: n.data.kind === 'source' || n.data.kind === 'table' ? 'pointer' : 'grab' }),
        ...(hits && !group && !hits.nodes.has(n.id) ? { opacity: FADED } : {}),
      },
    };
  }), [graph, moved, tableCount, hits]);

  const edges = useMemo<Edge[]>(() => graph.edges.map(e => {
    const near = hovered !== null && (e.source === hovered || e.target === hovered);
    return {
      ...e,
      zIndex: 1,
      style: { stroke: '#94a3b8', strokeWidth: near ? 2 : 1, opacity: (hovered !== null && !near) || (hits && !hits.edges.has(e.id)) ? FADED : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
    };
  }), [graph, hovered, hits]);

  const onNodesChange = (changes: NodeChange[]) => {
    const positions = changes.flatMap(c => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []));
    if (positions.length) setMoved(prev => ({ ...prev, ...Object.fromEntries(positions) }));
  };

  const toggle = (sourceId: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    return next;
  });

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
            const d = graph.nodes.find(n => n.id === node.id)?.data;
            if (d?.kind === 'source' && node.id === groupId(d.sourceId)) toggle(d.sourceId);
            if (d?.kind === 'silver' || d?.kind === 'table') setSearchParams(prev => {
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
              <button type="button" onClick={() => setMoved(() => ({}))} className="rounded-lg border bg-white px-3 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50">
                重置布局
              </button>
            </Panel>
          )}
        </ReactFlow>
      )}
    </div>
  );
}

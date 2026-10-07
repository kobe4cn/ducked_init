// app/components/drift-badge.tsx —— 数据地图上标准层表的漂移徽标：警示色的图标与差异种类、数量（如「缺 2 列 · 类型 1」），small 用在图节点里；
// 以及有差异的图节点的边框样式
import { AlertTriangle } from 'lucide-react';
import { type DriftCounts, driftSummary } from '~/lib/lineage-drift';

export const DRIFT_NODE_STYLE: React.CSSProperties = { borderColor: '#fca5a5' };

export function DriftBadge({ counts, small }: { counts: DriftCounts; small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-red-600 ${small ? 'text-[10px]' : 'text-xs'}`}>
      <AlertTriangle className={`${small ? 'size-3' : 'size-3.5'} shrink-0`} />
      {driftSummary(counts)}
    </span>
  );
}

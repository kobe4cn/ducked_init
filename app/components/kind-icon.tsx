// app/components/kind-icon.tsx —— 数据源类型的图标，各类型固定色调（见 docs/agents/ui.md）
import { Cloud, Database, FileBox, Leaf } from 'lucide-react';
import type { SourceKind } from '~/lib/sources';

const KIND_ICON: Record<SourceKind, typeof Database> = { postgres: Database, mysql: Database, mongodb: Leaf, s3: Cloud, duckdb: FileBox };
const KIND_TINT: Record<SourceKind, string> = {
  postgres: 'bg-sky-100 text-sky-700', mysql: 'bg-orange-100 text-orange-700', mongodb: 'bg-emerald-100 text-emerald-700', s3: 'bg-violet-100 text-violet-700', duckdb: 'bg-amber-100 text-amber-700',
};

/** small：放在行内或图节点里的小号 */
export function KindIcon({ kind, small }: { kind: SourceKind; small?: boolean }) {
  const Icon = KIND_ICON[kind];
  return small
    ? <span className={`grid size-5 shrink-0 place-items-center rounded-md ${KIND_TINT[kind]}`}><Icon className="size-3" /></span>
    : <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${KIND_TINT[kind]}`}><Icon className="size-5" /></span>;
}

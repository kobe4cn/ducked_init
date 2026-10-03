// app/components/stat-tile.tsx —— 概览页顶部的指标卡：标签、大号数值与提示；数值有含义时才用 tone 上状态色
import { cn } from '~/lib/utils';

export function StatTile({ label, value, hint, tone }: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** 数值的状态色，如 `text-emerald-600` */
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={cn('mt-1 text-3xl font-semibold', tone)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

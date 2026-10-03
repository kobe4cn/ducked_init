// app/components/status-text.tsx —— 状态色配图标和文字（见 docs/agents/ui.md）：一致 / 成功、进行中、差异 / 失败、未开始。
// data-* 属性放在只包文字的内层 span 上，HTTP 测试可以断言属性后面紧跟的文字
import { AlertTriangle, CheckCircle2, CircleDashed, Clock } from 'lucide-react';
import { cn } from '~/lib/utils';

export type StatusTone = 'ok' | 'pending' | 'bad' | 'none';

const TONES: Record<StatusTone, { icon: typeof CheckCircle2; color: string }> = {
  ok: { icon: CheckCircle2, color: 'text-emerald-600' },
  pending: { icon: Clock, color: 'text-amber-600' },
  bad: { icon: AlertTriangle, color: 'text-red-600' },
  none: { icon: CircleDashed, color: 'text-slate-500' },
};

/** 后台任务（采集、同步、核对等）状态及从未运行过的 none 对应的色调，任务页与数据源详情页共用 */
export const TASK_TONES = { none: 'none', queued: 'pending', running: 'pending', succeeded: 'ok', failed: 'bad' } as const satisfies Record<string, StatusTone>;

export function StatusText({ tone, className, children, ...data }: {
  tone: StatusTone;
  className?: string;
  children: React.ReactNode;
} & { [k: `data-${string}`]: string | number | boolean | undefined }) {
  const { icon: Icon, color } = TONES[tone];
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm font-normal', color, className)}>
      <Icon className="size-3.5 shrink-0" />
      <span {...data}>{children}</span>
    </span>
  );
}

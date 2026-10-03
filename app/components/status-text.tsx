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

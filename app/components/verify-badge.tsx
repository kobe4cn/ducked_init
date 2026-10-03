// app/components/verify-badge.tsx —— 数据源最近一次核对的结论：未核对、一致、几张表有差异（列表卡片与详情页共用）
import { StatusText } from '~/components/status-text';

export type VerifyState = 'none' | 'ok' | 'diff';
/** 未核对（没有成功核对记录，differences 传 null）、一致、有差异 */
export const verifyStateOf = (differences: number | null): VerifyState => differences === null ? 'none' : differences > 0 ? 'diff' : 'ok';

const VERIFY_TONES = { none: 'none', ok: 'ok', diff: 'bad' } as const;

/** differences：最近一次成功核对中有差异的表数，没有成功核对过为 null */
export function VerifyBadge({ differences, className }: { differences: number | null; className?: string }) {
  const state = verifyStateOf(differences);
  return (
    <StatusText tone={VERIFY_TONES[state]} className={className} data-verify-state={state} data-verify-differences={state === 'diff' ? differences! : undefined}>
      {state === 'none' ? '未核对' : state === 'ok' ? '一致' : `${differences} 张表有差异`}
    </StatusText>
  );
}

// app/.server/pipeline/templates/upgrade-summary.ts —— RFM 升级预览的一句话结论（#829 之二）：由代码从「原分群 × 新分群」迁移矩阵的计数生成，不调用模型。
// 纯函数、不碰平台库与数据湖，输入输出里只有计数（ADR-0025）；同样的输入同样的输出：人数相同的迁移按分群名（cmpName，ADR-0045）排序取第一个
import { cmpName } from '../../../lib/compare';
import type { TagTransition } from '../../dsl-definitions';

/** 一句话结论：text 给成员看（数字带千分位、占比 1 位小数、null 显示成「（无）」）；占比是 0–1 的小数；warn 为换了取值的人超过 20% */
export interface SegmentUpgradeSummary {
  text: string;
  unchangedShare: number;
  changedShare: number;
  warn: boolean;
}

const label = (segment: string | null) => segment ?? '（无）';

/** 总人数是矩阵所有格子之和（v1 与 v2 的并集）：没变 = before === after，换了取值 = 两边都不为 null 且不同（新增、移出不算） */
export function summarizeSegmentUpgrade(matrix: TagTransition[]): SegmentUpgradeSummary {
  const total = matrix.reduce((n, c) => n + c.consumers, 0);
  const consumersOf = (match: (c: TagTransition) => boolean) => matrix.filter(match).reduce((n, c) => n + c.consumers, 0);
  const unchanged = consumersOf(c => c.before === c.after);
  const changed = consumersOf(c => c.before !== null && c.after !== null && c.before !== c.after);
  const share = (n: number) => (total > 0 ? n / total : 0);
  const unchangedShare = share(unchanged), changedShare = share(changed);
  // 最大迁移在 before !== after 的格子里找（含新增、移出，句子里显示成「（无）」）；没变的格子不参与
  const moved = matrix
    .filter(c => c.before !== c.after)
    .sort((a, b) => b.consumers - a.consumers || cmpName(label(a.before), label(b.before)) || cmpName(label(a.after), label(b.after)));
  const head = `没变的人占 ${(unchangedShare * 100).toFixed(1)}%；`;
  return {
    text: moved.length > 0
      ? `${head}人数最多的迁移：${label(moved[0]!.before)} → ${label(moved[0]!.after)}，${moved[0]!.consumers.toLocaleString('en-US')} 人。`
      : `${head}没有人换分群。`,
    unchangedShare,
    changedShare,
    warn: changedShare > 0.2,
  };
}

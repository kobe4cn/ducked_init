// app/.server/pipeline/templates/upgrade-summary.ts —— 升级预览的一句话结论（不调模型）：RFM（#829 之二）由代码从「原分群 × 新分群」迁移矩阵的计数生成，
// 其他模板（#858，#829 之三）从换了取值的人数与按列统计生成。纯函数、不碰平台库与数据湖，输入输出里只有计数与统计量（ADR-0025）；
// 同样的输入同样的输出：人数相同的迁移按分群名（cmpName）、人数相同的列按列名（cmp，ADR-0045）排序取第一个。
// 只算结构与阈值，不拼句子：整句由页面按界面语言拼（ADR-0060，test/i18n-template-page.test.ts 断言两种语言）
import { cmp, cmpName } from '../../../lib/compare';
import type { DiffCounts, TagTransition } from '../../dsl-definitions';

/** RFM 的一句话结论：人数最多的迁移（before / after 为 null 表示新增或移出，页面显示成「（无）」），没有换分群的迁移时 topMove 为 null */
export interface SegmentSummaryDetail {
  kind: 'segment';
  topMove: { before: string | null; after: string | null; consumers: number } | null;
}

/** 其他模板的一句话结论：变化最大的列（换了取值人数最多），没有变化的列时 topColumn 为 null */
export interface ColumnSummaryDetail {
  kind: 'column';
  topColumn: ColumnStat | null;
}

/** 一句话结论（RFM 与按列对比共用）：占比是 0–1 的小数；warn 为换了取值的人超过 20% */
export interface UpgradeSummary {
  detail: SegmentSummaryDetail | ColumnSummaryDetail;
  unchangedShare: number;
  changedShare: number;
  warn: boolean;
}

/** bool 列一边的统计量：是的人数（占比由页面用该边的总人数算） */
export interface BoolStat { yes: number }

/** 数值列一边的统计量：均值、中位数、P90；这一列全为 null 时值是 null */
export interface NumberStat { mean: number | null; median: number | null; p90: number | null }

/** 文本列一边的统计量：人数最多的前 10 个取值（已按人数降序、同数按取值升序，超过 10 个不另标注）；value 为 null 是这一列为空的人（GROUP BY 把 NULL 也算一个取值），显示成「（无）」 */
export interface TextStat { values: { value: string | null; consumers: number }[] }

/** 其他类型（日期、列表等）列一边的统计量：非空人数 */
export interface OtherStat { nonNull: number }

/** 列的类型：BOOLEAN 是 bool；整型 / 浮点 / DECIMAL（不带 []）是 number；VARCHAR 是 text；日期、列表等其余是 other */
export type ColumnType = 'bool' | 'number' | 'text' | 'other';

/** 非 RFM 升级预览按列对比的一行（不含 consumer_id）：type 两边不一致时以 v2 为准；某一边没有这一列时那一边与 changed 为 null */
export type ColumnStat =
  | { name: string; type: 'bool'; before: BoolStat | null; after: BoolStat | null; changed: number | null }
  | { name: string; type: 'number'; before: NumberStat | null; after: NumberStat | null; changed: number | null }
  | { name: string; type: 'text'; before: TextStat | null; after: TextStat | null; changed: number | null }
  | { name: string; type: 'other'; before: OtherStat | null; after: OtherStat | null; changed: number | null };

const label = (segment: string | null) => segment ?? '（无）';

/** 总人数是矩阵所有格子之和（v1 与 v2 的并集）：没变 = before === after，换了取值 = 两边都不为 null 且不同（新增、移出不算） */
export function summarizeSegmentUpgrade(matrix: TagTransition[]): UpgradeSummary {
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
  const top = moved[0];
  return {
    detail: { kind: 'segment', topMove: top ? { before: top.before, after: top.after, consumers: top.consumers } : null },
    unchangedShare,
    changedShare,
    warn: changedShare > 0.2,
  };
}

/**
 * 非 RFM 模板的一句话结论：占比的分母是 v1 ∪ v2 的人数（两边都在 + 新增 + 移出，与 RFM 迁移矩阵的总和同口径），
 * 没变 = 两边都在 − 换了取值（新增、移出都不算）；变化最大的字段取换了取值人数最多的一列，人数相同按列名（cmp，ADR-0045）取第一个
 */
export function summarizeColumnUpgrade(counts: DiffCounts, columns: ColumnStat[], total: { before: number; after: number }): UpgradeSummary {
  const both = total.before - counts.removed;
  const union = both + counts.added + counts.removed;
  const unchanged = union - counts.changed - counts.added - counts.removed;
  const share = (n: number) => (union > 0 ? n / union : 0);
  const unchangedShare = share(unchanged), changedShare = share(counts.changed);
  const top = columns
    .filter(c => c.changed !== null && c.changed > 0)
    .sort((a, b) => b.changed! - a.changed! || cmp(a.name, b.name))[0];
  return {
    detail: { kind: 'column', topColumn: top ?? null },
    unchangedShare,
    changedShare,
    warn: changedShare > 0.2,
  };
}

// app/.server/pipeline/templates/upgrade-summary.ts —— 升级预览的一句话结论（不调模型）：RFM（#829 之二）由代码从「原分群 × 新分群」迁移矩阵的计数生成，
// 其他模板（#858，#829 之三）从换了取值的人数与按列统计生成。纯函数、不碰平台库与数据湖，输入输出里只有计数与统计量（ADR-0025）；
// 同样的输入同样的输出：人数相同的迁移按分群名（cmpName）、人数相同的列按列名（cmp，ADR-0045）排序取第一个
import { cmp, cmpName } from '../../../lib/compare';
import type { DiffCounts, TagTransition } from '../../dsl-definitions';

/** 一句话结论（RFM 与按列对比共用）：text 给成员看（数字带千分位、占比 1 位小数）；占比是 0–1 的小数；warn 为换了取值的人超过 20% */
export interface UpgradeSummary {
  text: string;
  unchangedShare: number;
  changedShare: number;
  warn: boolean;
}

/** bool 列一边的统计量：是的人数（占比由页面用该边的总人数算） */
export interface BoolStat { yes: number }

/** 数值列一边的统计量：均值、中位数、P90；这一列全为 null 时值是 null */
export interface NumberStat { mean: number | null; median: number | null; p90: number | null }

/** 文本列一边的统计量：人数最多的前 10 个取值（已按人数降序、同数按取值升序，超过 10 个不另标注） */
/** value 为 null 是这一列为空的人（GROUP BY 把 NULL 也算一个取值），显示成「（无）」 */
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
const count = (n: number) => n.toLocaleString('en-US');

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

/** 变化最大的字段在 v1、v2 下的取值：bool 写是的人数，number 写均值（2 位小数），text 写 v2 里人数最多的取值在两边的人数，other 写非空人数；缺的一边或 null 写「—」 */
function columnPhrase(c: ColumnStat): string {
  // 某一边没有这一列时那一边写「—」（正常数据里这种列 changed 为 null、不会被选作变化最大的字段，这里只是容错）
  if (c.type === 'bool') {
    const yes = (s: BoolStat | null) => (s === null ? '—' : count(s.yes));
    return `${c.name} 为是：${yes(c.before)} → ${yes(c.after)}`;
  }
  if (c.type === 'number') {
    const mean = (s: NumberStat | null) => (s === null || s.mean === null ? '—' : s.mean.toFixed(2));
    return `${c.name} 均值：${mean(c.before)} → ${mean(c.after)}`;
  }
  if (c.type === 'text') {
    // 取值写 v2 里人数最多的（values 已按人数降序）；v2 一个取值都没有时用 v1 的；那一边没有这一取值记 0
    const v = (c.after?.values.length ? c.after : c.before)?.values[0]?.value;
    const at = (s: TextStat | null) => (s === null ? '—' : count(s.values.find(x => x.value === v)?.consumers ?? 0));
    return v === undefined ? `${c.name}：${at(c.before)} → ${at(c.after)}` : `${c.name} 为 ${label(v)}：${at(c.before)} → ${at(c.after)}`;
  }
  const nonNull = (s: OtherStat | null) => (s === null ? '—' : count(s.nonNull));
  return `${c.name} 非空：${nonNull(c.before)} → ${nonNull(c.after)}`;
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
  const head = `没变的人占 ${(unchangedShare * 100).toFixed(1)}%；`;
  const top = columns
    .filter(c => c.changed !== null && c.changed > 0)
    .sort((a, b) => b.changed! - a.changed! || cmp(a.name, b.name))[0];
  return {
    text: top ? `${head}变化最大的字段：${columnPhrase(top)}。` : `${head}没有字段变化。`,
    unchangedShare,
    changedShare,
    warn: changedShare > 0.2,
  };
}

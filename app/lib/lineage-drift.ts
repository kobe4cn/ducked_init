// app/lib/lineage-drift.ts —— 数据地图节点上的漂移标记：把最近一次漂移检查的差异按表汇总成各种类的数量，
// 写成节点徽标（如「缺 2 列 · 类型 1」）与 data-node-drift 的种类列表，两者都按缺列、多列、类型、孤表的顺序（纯函数）

export type DriftKind = 'missing' | 'extra' | 'type' | 'orphan';
export type DriftCounts = Partial<Record<DriftKind, number>>;
/** 按表（实体名，不带 silver. 前缀）的差异数量 */
export type DriftByTable = Record<string, DriftCounts>;

const ORDER: readonly DriftKind[] = ['missing', 'extra', 'type', 'orphan'];
const TEXT: Record<DriftKind, (n: number) => string> = {
  missing: n => `缺 ${n} 列`,
  extra: n => `多 ${n} 列`,
  type: n => `类型 ${n}`,
  orphan: () => '孤表',
};

/** 按表（不带 silver. 前缀）汇总差异种类与数量；没有差异的表不出现 */
export function driftByTable(drifts: readonly { table: string; kind: DriftKind }[]): DriftByTable {
  const out: DriftByTable = {};
  for (const { table, kind } of drifts) {
    const counts = (out[table] ??= {});
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return out;
}

const present = (counts: DriftCounts) => ORDER.filter(k => counts[k]);

/** 节点徽标的文字 */
export const driftSummary = (counts: DriftCounts) => present(counts).map(k => TEXT[k](counts[k]!)).join(' · ');

/** data-node-drift 的值：有差异的种类，逗号分隔 */
export const driftKinds = (counts: DriftCounts) => present(counts).join(',');

/** 有差异的表的行或节点带 data-node-drift，没有差异时不带 */
export const driftAttrs = (counts: DriftCounts | undefined) => (counts ? { 'data-node-drift': driftKinds(counts) } : {});

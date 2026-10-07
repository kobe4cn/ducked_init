// test/lineage-drift.test.ts —— 数据地图节点上的漂移标记：按表汇总最近一次检查的差异种类与数量，徽标文字与 data-node-drift 的种类顺序（纯函数）
import { describe, expect, it } from 'vitest';
import { driftByTable, driftKinds, driftSummary } from '../app/lib/lineage-drift';

describe('漂移标记', () => {
  it('按表汇总各种差异的数量，没有差异的表不出现', () => {
    const byTable = driftByTable([
      { table: 'customer', kind: 'missing' },
      { table: 'customer', kind: 'type' },
      { table: 'customer', kind: 'missing' },
      { table: 'order', kind: 'extra' },
      { table: 'stray', kind: 'orphan' },
    ]);
    expect(byTable).toEqual({ customer: { missing: 2, type: 1 }, order: { extra: 1 }, stray: { orphan: 1 } });
    expect(driftByTable([])).toEqual({});
  });

  it('徽标按缺列、多列、类型、孤表的顺序写出数量，data-node-drift 用同样顺序的种类', () => {
    expect(driftSummary({ type: 1, missing: 2 })).toBe('缺 2 列 · 类型 1');
    expect(driftSummary({ extra: 3 })).toBe('多 3 列');
    expect(driftSummary({ orphan: 1 })).toBe('孤表');
    expect(driftKinds({ type: 1, extra: 1, missing: 2 })).toBe('missing,extra,type');
  });
});

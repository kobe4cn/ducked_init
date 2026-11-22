// test/template-upgrade-summary.test.ts —— 升级预览一句话结论的纯函数：RFM（#829 之二）从「原分群 × 新分群」迁移矩阵的计数选出人数最多的迁移，
// 其他模板（#829 之三）从换了取值的人数选出变化最大的列；不调模型、不碰库；同数时按名字（RFM 用 cmpName、列名用 cmp，ADR-0045）排序取第一个，
// 同样的输入同样的输出（ADR-0025：输入输出里都只有计数与统计量，没有 consumer_id）。
// 只算结构与阈值不拼句子：整句由页面按界面语言拼（ADR-0060），两种语言的句子在 test/i18n-template-page.test.ts 断言
import { describe, expect, it } from 'vitest';
import { summarizeColumnUpgrade, summarizeSegmentUpgrade, type ColumnStat } from '../app/.server/pipeline/templates/upgrade-summary';

describe('summarizeSegmentUpgrade', () => {
  it('没变的人占比与人数最多的迁移，没超过 20% 不警示', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 6000 },
      { before: '高价值', after: '其他', consumers: 1500 },
      { before: '其他', after: '其他', consumers: 2500 },
    ]);
    expect(s.unchangedShare).toBeCloseTo(0.85);
    expect(s.changedShare).toBeCloseTo(0.15);
    expect(s.warn).toBe(false);
    expect(s.detail).toEqual({ kind: 'segment', topMove: { before: '高价值', after: '其他', consumers: 1500 } });
  });

  it('人数相同的迁移按分群名排序取第一个', () => {
    const s = summarizeSegmentUpgrade([
      { before: '其他', after: 'v2:其他', consumers: 5 },
      { before: '高价值', after: 'v2:高价值', consumers: 5 },
    ]);
    expect(s.detail).toEqual({ kind: 'segment', topMove: { before: '高价值', after: 'v2:高价值', consumers: 5 } });
  });

  it('换了取值的人占比严格大于 20% 才警示，正好 20% 不警示', () => {
    const cells = (changed: number) => [
      { before: '高价值', after: '高价值', consumers: 100 - changed },
      { before: '高价值', after: '其他', consumers: changed },
    ];
    expect(summarizeSegmentUpgrade(cells(20)).warn).toBe(false);
    expect(summarizeSegmentUpgrade(cells(21)).warn).toBe(true);
  });

  it('新增或移出的人一边是 null（页面显示成「（无）」），也不算换了取值', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 8 },
      { before: null, after: '高价值', consumers: 2 },
    ]);
    expect(s.changedShare).toBe(0);
    expect(s.warn).toBe(false);
    expect(s.detail).toEqual({ kind: 'segment', topMove: { before: null, after: '高价值', consumers: 2 } });
  });

  it('全部没变时 topMove 为 null，不警示', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 7 },
      { before: '其他', after: '其他', consumers: 3 },
    ]);
    expect(s.unchangedShare).toBe(1);
    expect(s.warn).toBe(false);
    expect(s.detail).toEqual({ kind: 'segment', topMove: null });
  });
});

describe('summarizeColumnUpgrade', () => {
  // 变化人数都是编的，只测纯函数怎么选列；number 列的统计量形如 { mean, median, p90 }
  const number = (mean: number | null): ColumnStat => ({
    name: 'orders', type: 'number',
    before: { mean, median: mean, p90: mean }, after: { mean, median: mean, p90: mean }, changed: 0,
  });

  it('选出 changed 最多的列，换了取值的人超过 20% 警示', () => {
    const atRisk: ColumnStat = { name: 'at_risk', type: 'bool', before: { yes: 8282 }, after: { yes: 26612 }, changed: 30 };
    const s = summarizeColumnUpgrade({ changed: 30, added: 0, removed: 0 }, [number(5), atRisk], { before: 100, after: 100 });
    expect(s.unchangedShare).toBeCloseTo(0.7);
    expect(s.changedShare).toBeCloseTo(0.3);
    expect(s.warn).toBe(true);
    expect(s.detail).toEqual({ kind: 'column', topColumn: atRisk });
  });

  it('人数相同的列按列名的码点排序取第一个', () => {
    const s = summarizeColumnUpgrade(
      { changed: 10, added: 0, removed: 0 },
      [
        { name: 'silence_ratio', type: 'other', before: { nonNull: 20 }, after: { nonNull: 20 }, changed: 10 },
        { name: 'at_risk', type: 'bool', before: { yes: 5 }, after: { yes: 15 }, changed: 10 },
      ],
      { before: 20, after: 20 },
    );
    expect(s.detail).toEqual({ kind: 'column', topColumn: { name: 'at_risk', type: 'bool', before: { yes: 5 }, after: { yes: 15 }, changed: 10 } });
  });

  it('number 列也能当选，统计量原样给页面（均值 2 位小数等措辞在页面）', () => {
    const columns: ColumnStat[] = [
      { name: 'avg_gap_days', type: 'number', before: { mean: 1.5, median: 1, p90: 4 }, after: { mean: 2, median: 2, p90: 5 }, changed: 3 },
      { ...number(null), changed: 1 },
    ];
    const s = summarizeColumnUpgrade({ changed: 3, added: 0, removed: 0 }, columns, { before: 10, after: 10 });
    expect(s.detail).toEqual({ kind: 'column', topColumn: columns[0] });
    // 全为 null 的列也能当选变化最大的字段（取值怎么写是页面的事）
    const s2 = summarizeColumnUpgrade({ changed: 1, added: 0, removed: 0 }, [{ ...number(null), changed: 1 }], { before: 10, after: 10 });
    expect(s2.detail).toEqual({ kind: 'column', topColumn: { ...number(null), changed: 1 } });
  });

  it('text 列也能当选：统计量原样给页面（取 v2 里人数最多的取值等措辞在页面）', () => {
    const column: ColumnStat = {
      name: 'city', type: 'text',
      before: { values: [{ value: '北京', consumers: 60 }, { value: '上海', consumers: 40 }] },
      after: { values: [{ value: '上海', consumers: 55 }, { value: '北京', consumers: 45 }] },
      changed: 15,
    };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [column], { before: 100, after: 100 }).detail)
      .toEqual({ kind: 'column', topColumn: column });
    // v2 一个取值都没有：统计量原样下发给页面
    const empty: ColumnStat = { ...column, after: { values: [] }, changed: 5 };
    expect(summarizeColumnUpgrade({ changed: 5, added: 0, removed: 0 }, [empty], { before: 100, after: 100 }).detail)
      .toEqual({ kind: 'column', topColumn: empty });
  });

  it('other 列也能当选（缺列的一边是 null，怎么显示是页面的事）', () => {
    const column: ColumnStat = { name: 'last_order', type: 'other', before: { nonNull: 80 }, after: { nonNull: 95 }, changed: 15 };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [column], { before: 100, after: 100 }).detail)
      .toEqual({ kind: 'column', topColumn: column });
    // 缺列的一边为 null（正常数据里缺列的列 changed 为 null、不会被选中，这里直接喂给它，锁住结构）
    const missing: ColumnStat = { ...column, before: null };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [missing], { before: 100, after: 100 }).detail)
      .toEqual({ kind: 'column', topColumn: missing });
  });

  it('换了取值的人占比严格大于 20% 才警示，正好 20% 不警示', () => {
    const columns = (changed: number): ColumnStat[] => [{ name: 'at_risk', type: 'bool', before: { yes: 10 }, after: { yes: 90 }, changed }];
    expect(summarizeColumnUpgrade({ changed: 20, added: 0, removed: 0 }, columns(20), { before: 100, after: 100 }).warn).toBe(false);
    expect(summarizeColumnUpgrade({ changed: 21, added: 0, removed: 0 }, columns(21), { before: 100, after: 100 }).warn).toBe(true);
  });

  it('新增与移出不算没变也不算换了取值：占比按 v1 ∪ v2 的人数算', () => {
    // 100 人里 10 人移出、另来 10 人新增、90 人两边都在且取值没变
    const s = summarizeColumnUpgrade({ changed: 0, added: 10, removed: 10 }, [number(5)], { before: 100, after: 100 });
    expect(s.unchangedShare).toBeCloseTo(90 / 110);
    expect(s.changedShare).toBe(0);
    expect(s.warn).toBe(false);
    expect(s.detail).toEqual({ kind: 'column', topColumn: null });
  });

  it('没有任何列变化时 topColumn 为 null；并集为 0 时占比都是 0', () => {
    const s = summarizeColumnUpgrade({ changed: 0, added: 0, removed: 0 }, [number(5)], { before: 100, after: 100 });
    expect(s.detail).toEqual({ kind: 'column', topColumn: null });
    expect(s.warn).toBe(false);
    const empty = summarizeColumnUpgrade({ changed: 0, added: 0, removed: 0 }, [number(null)], { before: 0, after: 0 });
    expect(empty.unchangedShare).toBe(0);
    expect(empty.changedShare).toBe(0);
    expect(empty.detail).toEqual({ kind: 'column', topColumn: null });
  });
});

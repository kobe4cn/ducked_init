// test/template-upgrade-summary.test.ts —— 升级预览一句话结论的纯函数：RFM（#829 之二）从「原分群 × 新分群」迁移矩阵的计数生成结论，
// 其他模板（#829 之三）从换了取值的人数与按列统计生成结论；不调模型、不碰库；同数时按名字（RFM 用 cmpName、列名用 cmp，ADR-0045）排序取第一个，
// 同样的输入同样的输出（ADR-0025：输入输出里都只有计数与统计量，没有 consumer_id）
import { describe, expect, it } from 'vitest';
import { summarizeColumnUpgrade, summarizeSegmentUpgrade, type ColumnStat } from '../app/.server/pipeline/templates/upgrade-summary';

describe('summarizeSegmentUpgrade', () => {
  it('没变的人占比与人数最多的迁移：人数加千分位、占比 1 位小数，没超过 20% 不警示', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 6000 },
      { before: '高价值', after: '其他', consumers: 1500 },
      { before: '其他', after: '其他', consumers: 2500 },
    ]);
    expect(s.unchangedShare).toBeCloseTo(0.85);
    expect(s.changedShare).toBeCloseTo(0.15);
    expect(s.warn).toBe(false);
    expect(s.text).toBe('没变的人占 85.0%；人数最多的迁移：高价值 → 其他，1,500 人。');
  });

  it('人数相同的迁移按分群名排序取第一个', () => {
    const s = summarizeSegmentUpgrade([
      { before: '其他', after: 'v2:其他', consumers: 5 },
      { before: '高价值', after: 'v2:高价值', consumers: 5 },
    ]);
    expect(s.text).toContain('人数最多的迁移：高价值 → v2:高价值，5 人。');
  });

  it('换了取值的人占比严格大于 20% 才警示，正好 20% 不警示', () => {
    const cells = (changed: number) => [
      { before: '高价值', after: '高价值', consumers: 100 - changed },
      { before: '高价值', after: '其他', consumers: changed },
    ];
    expect(summarizeSegmentUpgrade(cells(20)).warn).toBe(false);
    expect(summarizeSegmentUpgrade(cells(21)).warn).toBe(true);
  });

  it('新增或移出的人一边是 null，结论里显示成「（无）」，也不算换了取值', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 8 },
      { before: null, after: '高价值', consumers: 2 },
    ]);
    expect(s.changedShare).toBe(0);
    expect(s.warn).toBe(false);
    expect(s.text).toBe('没变的人占 80.0%；人数最多的迁移：（无） → 高价值，2 人。');
  });

  it('全部没变时写「没有人换分群」，不警示', () => {
    const s = summarizeSegmentUpgrade([
      { before: '高价值', after: '高价值', consumers: 7 },
      { before: '其他', after: '其他', consumers: 3 },
    ]);
    expect(s.unchangedShare).toBe(1);
    expect(s.warn).toBe(false);
    expect(s.text).toBe('没变的人占 100.0%；没有人换分群。');
  });
});

describe('summarizeColumnUpgrade', () => {
  // 变化人数都是编的，只测纯函数怎么写结论；number 列的统计量形如 { mean, median, p90 }
  const number = (mean: number | null): ColumnStat => ({
    name: 'orders', type: 'number',
    before: { mean, median: mean, p90: mean }, after: { mean, median: mean, p90: mean }, changed: 0,
  });

  it('选出 changed 最多的列：bool 写「为是」，人数加千分位，换了取值的人超过 20% 警示', () => {
    const s = summarizeColumnUpgrade(
      { changed: 30, added: 0, removed: 0 },
      [
        number(5),
        { name: 'at_risk', type: 'bool', before: { yes: 8282 }, after: { yes: 26612 }, changed: 30 },
      ],
      { before: 100, after: 100 },
    );
    expect(s.unchangedShare).toBeCloseTo(0.7);
    expect(s.changedShare).toBeCloseTo(0.3);
    expect(s.warn).toBe(true);
    expect(s.text).toBe('没变的人占 70.0%；变化最大的字段：at_risk 为是：8,282 → 26,612。');
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
    expect(s.text).toContain('变化最大的字段：at_risk 为是：5 → 15。');
  });

  it('number 写均值（2 位小数），这一列全为 null 时写「—」', () => {
    const columns: ColumnStat[] = [
      { name: 'avg_gap_days', type: 'number', before: { mean: 1.5, median: 1, p90: 4 }, after: { mean: 2, median: 2, p90: 5 }, changed: 3 },
      { ...number(null), changed: 1 },
    ];
    const s = summarizeColumnUpgrade({ changed: 3, added: 0, removed: 0 }, columns, { before: 10, after: 10 });
    expect(s.text).toBe('没变的人占 70.0%；变化最大的字段：avg_gap_days 均值：1.50 → 2.00。');
    // 换成全为 null 的列做变化最大的字段时，取值写「—」
    const s2 = summarizeColumnUpgrade({ changed: 1, added: 0, removed: 0 }, [{ ...number(null), changed: 1 }], { before: 10, after: 10 });
    expect(s2.text).toBe('没变的人占 90.0%；变化最大的字段：orders 均值：— → —。');
  });

  it('text 写 v2 里人数最多的取值在两边的人数，没有就记 0；v2 没有取值时用 v1 的', () => {
    const column: ColumnStat = {
      name: 'city', type: 'text',
      before: { values: [{ value: '北京', consumers: 60 }, { value: '上海', consumers: 40 }] },
      after: { values: [{ value: '上海', consumers: 55 }, { value: '北京', consumers: 45 }] },
      changed: 15,
    };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [column], { before: 100, after: 100 }).text)
      .toBe('没变的人占 85.0%；变化最大的字段：city 为 上海：40 → 55。');
    // v2 一个取值都没有：用 v1 的第一个取值，v2 那边记 0
    const empty: ColumnStat = { ...column, after: { values: [] }, changed: 5 };
    expect(summarizeColumnUpgrade({ changed: 5, added: 0, removed: 0 }, [empty], { before: 100, after: 100 }).text)
      .toBe('没变的人占 95.0%；变化最大的字段：city 为 北京：60 → 0。');
  });

  it('other 写非空人数；某一边缺这一列时那一边写「—」', () => {
    const column: ColumnStat = { name: 'last_order', type: 'other', before: { nonNull: 80 }, after: { nonNull: 95 }, changed: 15 };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [column], { before: 100, after: 100 }).text)
      .toBe('没变的人占 85.0%；变化最大的字段：last_order 非空：80 → 95。');
    // 缺列的一边写「—」（正常数据里缺列的列 changed 为 null、不会被选中，这里直接喂给它，锁住写法）
    const missing: ColumnStat = { ...column, before: null };
    expect(summarizeColumnUpgrade({ changed: 15, added: 0, removed: 0 }, [missing], { before: 100, after: 100 }).text)
      .toBe('没变的人占 85.0%；变化最大的字段：last_order 非空：— → 95。');
  });

  it('换了取值的人占比严格大于 20% 才警示，正好 20% 不警示', () => {
    const columns = (changed: number): ColumnStat[] => [{ name: 'at_risk', type: 'bool', before: { yes: 10 }, after: { yes: 90 }, changed }];
    expect(summarizeColumnUpgrade({ changed: 20, added: 0, removed: 0 }, columns(20), { before: 100, after: 100 }).warn).toBe(false);
    expect(summarizeColumnUpgrade({ changed: 21, added: 0, removed: 0 }, columns(21), { before: 100, after: 100 }).warn).toBe(true);
  });

  it('新增与移出不算没变也不算换了取值：占比按 v1 ∪ v2 的人数算', () => {
    // 100 人里 10 人移出、另来 10 人新增、90 人两边都在且取值没变
    const s = summarizeColumnUpgrade({ changed: 0, added: 10, removed: 10 }, [number(5)], { before: 100, after: 90 });
    expect(s.unchangedShare).toBeCloseTo(90 / 110);
    expect(s.changedShare).toBe(0);
    expect(s.warn).toBe(false);
    expect(s.text).toBe('没变的人占 81.8%；没有字段变化。');
  });

  it('没有任何列变化时写「没有字段变化」；并集为 0 时占比都是 0', () => {
    const s = summarizeColumnUpgrade({ changed: 0, added: 0, removed: 0 }, [number(5)], { before: 100, after: 100 });
    expect(s.text).toBe('没变的人占 100.0%；没有字段变化。');
    expect(s.warn).toBe(false);
    const empty = summarizeColumnUpgrade({ changed: 0, added: 0, removed: 0 }, [number(null)], { before: 0, after: 0 });
    expect(empty.unchangedShare).toBe(0);
    expect(empty.changedShare).toBe(0);
    expect(empty.text).toBe('没变的人占 0.0%；没有字段变化。');
  });
});

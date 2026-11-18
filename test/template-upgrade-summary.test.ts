// test/template-upgrade-summary.test.ts —— RFM 升级预览一句话结论的纯函数（#829 之二）：从「原分群 × 新分群」迁移矩阵的计数生成结论，
// 不调模型、不碰库；同数的迁移按分群名排序取第一个，同样的输入同样的输出（ADR-0025：输入输出里都只有计数，没有 consumer_id）
import { describe, expect, it } from 'vitest';
import { summarizeSegmentUpgrade } from '../app/.server/pipeline/templates/upgrade-summary';

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

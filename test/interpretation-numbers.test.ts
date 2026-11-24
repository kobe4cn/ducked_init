// test/interpretation-numbers.test.ts —— 结果解读的数字核对 uncitedNumbers（#1218）：纯函数，用审计里的现场样本构造发给模型的 user 消息
// （15 个城市，苏州 3606、其余 13 个 2032–2232、无锡 122，facts 带 sum / max / min / maxShare / minShare）。
// 对得上的数字（原样、约数、千分位、万、与 maxShare 一致的百分比）不报；编出来的数、写错的百分比、对不上的「十分之一」报；序号与日期不核对
import { describe, expect, it } from 'vitest';
import { uncitedNumbers } from '../app/.server/interpretation-numbers';

const others = [2032, 2048, 2065, 2080, 2097, 2110, 2126, 2141, 2158, 2172, 2189, 2205, 2232];
const rows: [string, number][] = [['苏州', 3606], ...others.map((v, i): [string, number] => [`城市${i + 1}`, v]), ['无锡', 122]];
const sum = rows.reduce((a, [, v]) => a + v, 0);
const share = (v: number) => Math.round((v / sum) * 1000) / 1000;
const maxShare = share(3606);
const sent = JSON.stringify({
  sql: 'SELECT city, count(*) AS customers FROM silver.customer GROUP BY city',
  columns: [{ name: 'city', type: 'VARCHAR' }, { name: 'customers', type: 'BIGINT' }],
  rows,
  truncated: false,
  facts: [{ column: 'customers', sum, max: 3606, min: 122, maxShare, minShare: share(122), maxAt: '苏州', minAt: '无锡' }],
});
const maxPercent = `${(maxShare * 100).toFixed(1)}%`;

describe('uncitedNumbers', () => {
  it('对得上的数不报：原样、约数、与 maxShare 一致的百分比', () => {
    expect(uncitedNumbers(`苏州 3606 最多，其余城市大多约 2100，苏州占 ${maxPercent}。`, sent)).toEqual([]);
  });

  it('千分位与「万」规整后能对上', () => {
    expect(uncitedNumbers('苏州 3,606 位，约 0.36 万。', sent)).toEqual([]);
  });

  it('编出来的数报原文片段，与对得上的数混在一起时只报编出来的', () => {
    expect(uncitedNumbers('苏州 3606 最多，全国约 5000 位。', sent)).toEqual(['5000']);
  });

  it('「约十分之一」对不上 122 / 2100 时报「十分之一」', () => {
    expect(uncitedNumbers('无锡约为主群的十分之一。', sent)).toEqual(['十分之一']);
  });

  it('「N 分之一」落在比例区间里时不报', () => {
    // 2032 / 3606 ≈ 0.56，落在二分之一的区间 [0.4, 0.667] 里
    expect(uncitedNumbers('最少的城市约为苏州的二分之一。', sent)).toEqual([]);
  });

  it('百分比写错（25% 对 maxShare）时报', () => {
    expect(uncitedNumbers('苏州占 25%。', sent)).toEqual(['25%']);
  });

  it('序号、小个数与日期成分不核对', () => {
    expect(uncitedNumbers('前 3 名都在江苏，2026 年 11 月的数据，截至 2026-11-01。', sent)).toEqual([]);
  });

  it('同一个片段只报一次', () => {
    expect(uncitedNumbers('5000 位，又是 5000 位。', sent)).toEqual(['5000']);
  });
});

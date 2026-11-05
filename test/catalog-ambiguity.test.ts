// test/catalog-ambiguity.test.ts —— 歧义判定 judgeAmbiguity()（ADR-0047，#384 方案 A）：纯函数，手工构造 CatalogInput（标准实体自带字段名称）。
// 同一个别名「营收」挂在几个指标上：只是时间字段不同时只列时间字段、追问按哪个时间算；查询点名「支付时间」后只剩一个；「订单明细」按最长匹配、不算「订单」；
// 过滤留取值包含全部被点名取值的；口径完全一致（只是重名）不歧义；得分拉开且口径声明一致、不含未知时不追问，含未知或没拉开时追问；得分全为 0（投影回退）按差异追问
import { describe, expect, it } from 'vitest';
import { buildCatalog, type CatalogInput } from '../app/.server/catalog';
import { SCORE_GAP, judgeAmbiguity } from '../app/.server/catalog/ambiguity';
import { deriveProjection } from '../app/.server/catalog/projection';
import { rank, type Ranked } from '../app/.server/catalog/rank';
import type { Claim } from '../app/.server/knowledge/catalog';

const SPACE = '00000000-0000-0000-0000-00000000000a';

const yaml = {
  /** 订单明细上按下单 / 支付时间：窗口字段是路径，时间含义都是未知，口径声明相同 */
  item_by_order_time: 'base: order_item\nmeasure: { agg: sum, field: amount }\nwindow: { field: order_item.order_id -> order.created_at, days: 30 }\n',
  item_by_paid_time: 'base: order_item\nmeasure: { agg: sum, field: amount }\nwindow: { field: order_item.order_id -> order.paid_at, days: 30 }\n',
  order_by_order_time: 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n',
  order_paid: 'base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: status, op: in, value: [paid, completed] }\nwindow: { field: created_at, days: 30 }\n',
  order_with_refund: 'base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: status, op: in, value: [paid, completed, refunded] }\nwindow: { field: created_at, days: 30 }\n',
};
type Key = keyof typeof yaml;

/** keys 里的指标都挂别名「营收」；claims 给了的按类型覆盖系统口径声明 */
function catalogOf(defs: [string, Key][], claims?: Claim[]) {
  const input: CatalogInput = {
    definitions: defs.map(([key, y]) => ({ kind: 'metric' as const, key, version: 1, yaml: yaml[y], spaceId: SPACE })),
    knowledge: { byTarget: new Map(defs.map(([key]) => [`metric:${key}`, { aliases: ['营收'], ...(claims && { claims }) }])) },
  };
  return buildCatalog(input);
}
const ranked = (c: ReturnType<typeof buildCatalog>, q: string) => rank(deriveProjection(c, 'full'), c, q);
/** 手工给分的排序结果：都是别名命中 */
const scored = (c: ReturnType<typeof buildCatalog>, scores: Record<string, number>): Ranked[] =>
  Object.entries(scores).map(([id, score]) => ({ entry: c.entries.find(e => e.id === id)!, score, reasons: [{ lane: 'alias', matched: ['营收'] }] }));

const KNOWN: Claim[] = [
  { type: 'unit', value: 'currency_major' }, { type: 'currency', value: 'CNY' }, { type: 'tax_included', value: 'yes' },
  { type: 'refund_deducted', value: 'no' }, { type: 'time_meaning', value: 'order_time' },
];

describe('歧义判定 judgeAmbiguity()', () => {
  const byTime = catalogOf([['rev_a', 'item_by_order_time'], ['rev_b', 'item_by_paid_time']]);

  it('只是时间字段不同：只列时间字段（取路径最后一跳的字段名称），追问按哪个时间算', () => {
    const a = judgeAmbiguity(ranked(byTime, '近 30 天营收'), byTime, '近 30 天营收');
    expect(a.ambiguous).toBe(true);
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0]!.term).toBe('营收');
    expect([...a.groups[0]!.candidates].sort()).toEqual(['metric:rev_a', 'metric:rev_b']);
    expect(a.groups[0]!.diffs).toEqual([
      { dimension: 'timeField', label: '时间字段', values: { 'metric:rev_a': '下单时间', 'metric:rev_b': '支付时间' } },
    ]);
    expect(a.groups[0]!.questions).toHaveLength(1);
    expect(a.groups[0]!.questions[0]).toMatch(/^营收按(下单时间还是支付时间|支付时间还是下单时间)算？$/);
  });

  it('点名「支付时间」：只留时间字段是支付时间的候选，剩一个不歧义', () => {
    const q = '近 30 天按支付时间算的营收';
    expect(judgeAmbiguity(ranked(byTime, q), byTime, q)).toEqual({ ambiguous: false, groups: [] });
  });

  it('粒度按最长匹配：「订单明细」只留订单明细上的，里面的「订单」不算；单说「订单」只留订单上的', () => {
    const c = catalogOf([['rev_item', 'item_by_order_time'], ['rev_order', 'order_by_order_time']]);
    const all = judgeAmbiguity(ranked(c, '近 30 天营收'), c, '近 30 天营收');
    expect(all.ambiguous).toBe(true);
    expect(all.groups[0]!.diffs.map(d => d.dimension)).toEqual(['grain', 'claims']);
    expect(all.groups[0]!.diffs[0]!.values).toEqual({ 'metric:rev_item': '订单明细', 'metric:rev_order': '订单' });
    for (const q of ['近 30 天订单明细的营收', '近 30 天订单的营收']) expect(judgeAmbiguity(ranked(c, q), c, q).ambiguous, q).toBe(false);
  });

  it('过滤留取值包含全部被点名取值的：点名「已退款」只剩含退款的；没被点名的取值不起作用，过滤文字用字段名称与中文标签', () => {
    const c = catalogOf([['rev_paid', 'order_paid'], ['rev_gross', 'order_with_refund']]);
    const a = judgeAmbiguity(ranked(c, '营收'), c, '营收');
    expect(a.groups[0]!.diffs).toEqual([{ dimension: 'filter', label: '过滤', values: {
      'metric:rev_paid': '订单状态：已支付、已完成', 'metric:rev_gross': '订单状态：已支付、已完成、已退款',
    } }]);
    const q = '已支付、已完成与已退款的营收';
    expect(judgeAmbiguity(ranked(c, q), c, q).ambiguous).toBe(false);
  });

  it('口径完全一致（只是重名）不歧义', () => {
    const c = catalogOf([['rev_a', 'order_paid'], ['rev_b', 'order_paid']]);
    expect(judgeAmbiguity(ranked(c, '营收'), c, '营收')).toEqual({ ambiguous: false, groups: [] });
  });

  it(`得分拉开（≥ SCORE_GAP = ${SCORE_GAP}）且口径声明一致、不含未知时不追问；没拉开时追问`, () => {
    const c = catalogOf([['rev_a', 'item_by_order_time'], ['rev_b', 'item_by_paid_time']], KNOWN);
    expect(judgeAmbiguity(scored(c, { 'metric:rev_a': 0.05, 'metric:rev_b': 0.05 - SCORE_GAP }), c, '营收').ambiguous).toBe(false);
    const close = judgeAmbiguity(scored(c, { 'metric:rev_a': 0.05, 'metric:rev_b': 0.05 - SCORE_GAP / 2 }), c, '营收');
    expect(close.ambiguous).toBe(true);
    expect(close.groups[0]!.diffs.map(d => d.dimension)).toEqual(['timeField']);
  });

  it('口径声明含未知时，得分拉开也追问', () => {
    expect(judgeAmbiguity(scored(byTime, { 'metric:rev_a': 0.05, 'metric:rev_b': 0.01 }), byTime, '营收').ambiguous).toBe(true);
  });

  it('得分全为 0（投影回退）时按差异追问；只有依赖展开理由的条目不参与分组', () => {
    const c = catalogOf([['rev_a', 'item_by_order_time'], ['rev_b', 'item_by_paid_time']], KNOWN);
    const zero = scored(c, { 'metric:rev_a': 0, 'metric:rev_b': 0 });
    expect(judgeAmbiguity(zero, c, '营收').ambiguous).toBe(true);
    const expandOnly = zero.map((r, i) => (i === 1 ? { ...r, reasons: [{ lane: 'expand' as const, matched: [] }] } : r));
    expect(judgeAmbiguity(expandOnly, c, '营收')).toEqual({ ambiguous: false, groups: [] });
  });
});

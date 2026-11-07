// test/catalog-rank.test.ts —— 检索排序 rank()（ADR-0047）：纯函数，手工构造 CatalogInput。两个指标用同一个别名、挂在不同主题与不同空间，
// 另一个指标只有说明里有这个词：别名命中排在只有正文命中的前面；不给作用域、只给 memberSpaceId 时分数等于按常量算的 RRF；
// 查询里说了主题名、scope.subjects 或 scope.spaceIds 给了其中一个时它排第一，另一个仍在结果里。
// 别名一路同分时按别名以外的文字里的关键词命中数排；别名出现被别的条目更长的名称命中覆盖时不算（#400）。
// 依赖展开（expand.ts）：带「近 7 天」时补锚点实体的时间字段，「每个城市」补锚点到 customer 的关系，都标 expand、排在直接命中之后；两种词都没有时与不截断的结果的前 limit 个相同
import { describe, expect, it } from 'vitest';
import { buildCatalog, type CatalogInput } from '../app/.server/catalog';
import { deriveProjection } from '../app/.server/catalog/projection';
import { LANE_WEIGHTS, RRF_K, SCOPE_BOOST, rank } from '../app/.server/catalog/rank';

const SPACE_A = '00000000-0000-0000-0000-00000000000a';
const SPACE_B = '00000000-0000-0000-0000-00000000000b';

const metric = (key: string, description: string, spaceId: string) =>
  ({ kind: 'metric' as const, key, version: 1, yaml: `base: order\nmeasure: { agg: count }\ndescription: ${description}\n`, spaceId });

/** revenue_a / revenue_b 都有别名「营收」，分属 A组 / B组 与两个空间；aaa_note 只在说明里有「营收」，标识排在最前 */
const input: CatalogInput = {
  definitions: [
    metric('revenue_a', '下单金额合计', SPACE_A),
    metric('revenue_b', '支付金额合计', SPACE_B),
    metric('aaa_note', '营收明细的说明', SPACE_A),
  ],
  knowledge: { byTarget: new Map([
    ['metric:revenue_a', { aliases: ['营收'], subjects: ['A组'] }],
    ['metric:revenue_b', { aliases: ['营收'], subjects: ['B组'] }],
  ]) },
};

const c = buildCatalog(input);
const rows = deriveProjection(c, 'full');
const ids = (q: string, scope = {}) => rank(rows, c, q, scope).map(r => r.entry.id);
const rrf = (weight: number, place: number) => weight / (RRF_K + place);

describe('检索排序 rank()', () => {
  it('不给作用域：别名命中排在只有正文命中的前面，分数等于按常量算的 RRF，命中原因列出各路', () => {
    const r = rank(rows, c, '营收');
    expect(r.map(x => x.entry.id)).toEqual(['metric:revenue_a', 'metric:revenue_b', 'metric:aaa_note']);
    // 关键词一路三个都命中 1 个词，按标识排：aaa_note 第 1、revenue_a 第 2、revenue_b 第 3
    expect(r[0]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 1) + rrf(LANE_WEIGHTS.keyword, 2), 12);
    expect(r[1]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 2) + rrf(LANE_WEIGHTS.keyword, 3), 12);
    expect(r[2]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.keyword, 1), 12);
    expect(r[0]!.reasons).toEqual([{ lane: 'alias', matched: ['营收'] }, { lane: 'keyword', matched: ['营收'] }]);
    expect(r[2]!.reasons).toEqual([{ lane: 'keyword', matched: ['营收'] }]);
  });

  it('只给 memberSpaceId：所属空间的条目乘 1 + SCOPE_BOOST.member，另一个仍在结果里', () => {
    const r = rank(rows, c, '营收', { memberSpaceId: SPACE_B });
    expect(r.map(x => x.entry.id)).toEqual(['metric:revenue_b', 'metric:revenue_a', 'metric:aaa_note']);
    expect(r[0]!.score).toBeCloseTo((rrf(LANE_WEIGHTS.alias, 2) + rrf(LANE_WEIGHTS.keyword, 3)) * (1 + SCOPE_BOOST.member), 12);
    expect(r[1]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 1) + rrf(LANE_WEIGHTS.keyword, 2), 12);
  });

  it('查询里说了主题名、scope.subjects 或 scope.spaceIds 给了其中一个时它排第一，另一个仍在结果里', () => {
    // 不加权时 B组 也不占便宜：「组」两个都命中，revenue_a 按标识在前
    expect(ids('A组 营收')[0]).toBe('metric:revenue_a');
    expect(ids('B组 营收')).toEqual(['metric:revenue_b', 'metric:revenue_a', 'metric:aaa_note']);
    expect(ids('营收', { subjects: ['B组'] })).toEqual(['metric:revenue_b', 'metric:revenue_a', 'metric:aaa_note']);
    expect(ids('营收', { spaceIds: [SPACE_B] })).toEqual(['metric:revenue_b', 'metric:revenue_a', 'metric:aaa_note']);
    // 明确说的高于所属空间
    expect(ids('营收', { spaceIds: [SPACE_B], memberSpaceId: SPACE_A })[0]).toBe('metric:revenue_b');
  });

  it('目录里没有的行跳过，limit 生效，没有命中时为空', () => {
    expect(rank(rows, { entries: c.entries.filter(e => e.id !== 'metric:revenue_a') }, '营收').map(x => x.entry.id))
      .toEqual(['metric:revenue_b', 'metric:aaa_note']);
    expect(rank(rows, c, '营收', {}, 1)).toHaveLength(1);
    expect(rank(rows, c, '完全不相关')).toEqual([]);
  });

  it('依赖展开：带「近 7 天」时补上锚点 event 的时间字段，标 expand、排在所有直接命中之后', () => {
    const r = rank(rows, c, '近 7 天加购次数');
    const at = r.findIndex(x => x.entry.id === 'field:event.occurred_at');
    expect(at).toBe(r.length - 1);
    expect(r[at]!.reasons).toEqual([{ lane: 'expand', matched: ['entity:event 的时间字段'] }]);
    const direct = r.slice(0, at);
    expect(direct.map(x => x.entry.id)).toContain('entity:event');
    expect(direct.every(x => x.reasons.every(h => h.lane !== 'expand') && x.score > r[at]!.score)).toBe(true);
  });

  it('依赖展开：「每个城市」命中 customer 上的字段，补上锚点 order 到 customer 的关系；已在前面的 customer.city 不重复、不标 expand', () => {
    const r = rank(rows, c, '每个城市的订单数');
    const relation = r.find(x => x.entry.id === 'relation:order.customer_id');
    expect(relation?.reasons).toEqual([{ lane: 'expand', matched: ['entity:order → relation:order.customer_id'] }]);
    const city = r.filter(x => x.entry.id === 'field:customer.city');
    expect(city).toHaveLength(1);
    expect(city[0]!.reasons.map(h => h.lane)).not.toContain('expand');
    const first = r.findIndex(x => x.reasons.some(h => h.lane === 'expand'));
    expect(r.slice(first).every(x => x.reasons.some(h => h.lane === 'expand'))).toBe(true);
  });

  it('依赖展开：没有窗口词也没有维度词时，结果是不截断排序的前 limit 个，不带 expand', () => {
    for (const q of ['营收', '订单金额合计', '加购次数']) {
      const r = rank(rows, c, q, {}, 5);
      expect(r, q).toEqual(rank(rows, c, q, {}, 10_000).slice(0, 5));
      expect(r.flatMap(x => x.reasons).filter(h => h.lane === 'expand'), q).toEqual([]);
    }
  });

  it('别名一路同分时按关键词命中数排，不按标识：三个指标同挂「营收」，关键词命中多的在前', () => {
    const tie = buildCatalog({
      definitions: [
        metric('aaa', '金额合计', SPACE_A),
        metric('mmm', '门店金额合计', SPACE_A),
        metric('zzz', '门店营收金额', SPACE_A),
      ],
      knowledge: { byTarget: new Map(['metric:aaa', 'metric:mmm', 'metric:zzz'].map(id => [id, { aliases: ['营收'] }])) },
    });
    const r = rank(deriveProjection(tie, 'full'), tie, '门店营收');
    expect(r.map(x => x.entry.id).slice(0, 3)).toEqual(['metric:zzz', 'metric:mmm', 'metric:aaa']);
    // 关键词：zzz 命中 门店 / 店营 / 营收，mmm 命中 门店 / 营收，aaa 只命中 营收（与只命中「门店」的 order.channel、order.store_id 同分，按标识排第 5）
    expect(r[0]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 1) + rrf(LANE_WEIGHTS.keyword, 1), 12);
    expect(r[2]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 3) + rrf(LANE_WEIGHTS.keyword, 5), 12);
  });

  it('别名一路的次级比较不算别名本身带来的关键词：只靠别名带上「营收」的条目不多占一票', () => {
    const tie = buildCatalog({
      definitions: [metric('aaa', '门店营', SPACE_A), metric('zzz', '门店营收', SPACE_A)],
      knowledge: { byTarget: new Map(['metric:aaa', 'metric:zzz'].map(id => [id, { aliases: ['营收'] }])) },
    });
    const r = rank(deriveProjection(tie, 'full'), tie, '门店营收');
    // 连别名算，两个都命中 门店 / 店营 / 营收，关键词一路按标识 aaa 在前；别名以外 aaa 只命中 门店 / 店营，别名一路 zzz 在前
    expect(r.map(x => x.entry.id).slice(0, 2)).toEqual(['metric:zzz', 'metric:aaa']);
    expect(r[0]!.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 1) + rrf(LANE_WEIGHTS.keyword, 2), 12);
  });

  it('带向量一路：分数多出 vector 的 RRF、理由带两位相似度，只靠向量命中的条目也进结果，不在目录里的被忽略；不传与传空数组逐项相同', () => {
    // 向量按相似度降序传入（vectorLane 的输出）：revenue_b 第 1、entity:order 第 2；metric:gone 不在目录里
    const vector = [
      { entryId: 'metric:revenue_b', similarity: 0.83 },
      { entryId: 'entity:order', similarity: 0.4 },
      { entryId: 'metric:gone', similarity: 0.99 },
    ];
    const r = rank(rows, c, '营收', {}, 20, vector);
    const b = r.find(x => x.entry.id === 'metric:revenue_b')!;
    expect(b.score).toBeCloseTo(rrf(LANE_WEIGHTS.alias, 2) + rrf(LANE_WEIGHTS.keyword, 3) + rrf(LANE_WEIGHTS.vector, 1), 12);
    expect(b.reasons).toContainEqual({ lane: 'vector', matched: ['0.83'] });
    // 「营收」命不中 entity:order 的任何文字路，只有向量理由
    expect(r.find(x => x.entry.id === 'entity:order')?.reasons).toEqual([{ lane: 'vector', matched: ['0.40'] }]);
    expect(r.map(x => x.entry.id)).not.toContain('metric:gone');
    expect(rank(rows, c, '营收')).toEqual(rank(rows, c, '营收', {}, 20, []));
  });

  it('别名出现被别的条目更长的名称命中覆盖时不算：order.channel 的名称「渠道」在自身说明里延长成「下单渠道」，盖住 touch.channel 的别名「渠道」', () => {
    const ch = buildCatalog({ definitions: [], knowledge: { byTarget: new Map([['field:touch.channel', { aliases: ['渠道'] }]]) } });
    const r = rank(deriveProjection(ch, 'full'), ch, '各下单渠道的订单数');
    const touch = r.find(x => x.entry.id === 'field:touch.channel');
    expect(touch?.reasons.some(h => h.lane === 'alias') ?? false).toBe(false);
    const at = (id: string) => r.findIndex(x => x.entry.id === id);
    expect(at('field:order.channel')).toBeGreaterThanOrEqual(0);
    if (touch) expect(at('field:order.channel')).toBeLessThan(at('field:touch.channel'));
    // 查询没有被更长名称覆盖时别名照常命中
    expect(rank(deriveProjection(ch, 'full'), ch, '各渠道触达次数').find(x => x.entry.id === 'field:touch.channel')?.reasons)
      .toContainEqual({ lane: 'alias', matched: ['渠道'] });
  });
});

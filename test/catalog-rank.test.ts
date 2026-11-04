// test/catalog-rank.test.ts —— 检索排序 rank()（ADR-0047）：纯函数，手工构造 CatalogInput。两个指标用同一个别名、挂在不同主题与不同空间，
// 另一个指标只有说明里有这个词：别名命中排在只有正文命中的前面；不给作用域、只给 memberSpaceId 时分数等于按常量算的 RRF；
// 查询里说了主题名、scope.subjects 或 scope.spaceIds 给了其中一个时它排第一，另一个仍在结果里。
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
});

// test/retrieval-golden.test.ts —— 检索黄金集（#317，ADR-0047 的确定性层）：40 条黄金集的标注齐全、分布达标、引用的条目都在固定目录里；
// 对现有 search() 逐条断言候选都在前 20、第 1 名不是不能选的近义项、歧义判定与标注一致，汇总 Recall@20 不低于 BASELINE。
// 现有 search() 没有歧义概念（判定恒为 false），做不到的记在 KNOWN_GAPS（用 it.fails，改好后会变红，提醒从清单删掉并抬高 BASELINE）。
// 纯函数，不读库、不走模型
import { describe, expect, it } from 'vitest';
import { expand, search, type Catalog, type CatalogEntry } from '../app/.server/catalog';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import { CONTEXT, COVERS, FAILURE_TYPES, GOLDEN, GOLDEN_ALL, ROLES, type GoldenEntry } from '../scripts/eval-requirements/golden';
import { EXTRA_DEFINITIONS, RETRIEVAL_CATALOG } from '../scripts/eval-requirements/retrieval-catalog';

/** 总 Recall@20 的下限：本票实测值向下取两位小数；改好一条后抬高 */
const BASELINE = 0.7;

/** 现有 search() 做不到的条目与原因 */
const NO_AMBIGUITY = 'search() 不判歧义';
const KNOWN_GAPS = new Map<string, string>([
  ['active-ambiguous', NO_AMBIGUITY],
  ['aov-ambiguous', NO_AMBIGUITY],
  ['channel-ambiguous', NO_AMBIGUITY],
  ['revenue-ambiguous', NO_AMBIGUITY],
  ['revenue-yoy', NO_AMBIGUITY],
  ['sales-amount-alias', NO_AMBIGUITY],
  ['add-to-cart-7d', '需求里没有「发生时间」，event.occurred_at 没进前 20'],
  ['avg-completed-order-amount', '需求里没有「下单时间」，order.created_at 没进前 20；第 1 名是口径不同的客单价 aov_365d'],
  ['order-count-90d', '需求里没有「下单时间」，order.created_at 没进前 20'],
  ['distinct-products-180d', '只召回到 product_id，经 order_item.order_id 取下单时间的关系与字段没进前 20'],
  ['paid-revenue-by-city', '城市与 order → customer 的关系被带「近 30 天」的指标挤出前 20'],
  ['spend-tier', '第 1 名是两档的标签 high_spender，不是三档分层要引用的 revenue_30d'],
  ['points-ambiguous', '「每个消费者」的二元组把带消费者 ID 的条目排在前面，积分字段没进前 20；也不判歧义'],
  ['churn-forecast', '「流失」没有出现在任何说明里，days_since_last_order 没进前 20'],
  ['gmv-alias', '没有别名：GMV → 含退款的营收'],
  ['dormant-alias', '没有别名：沉睡 → 距最近一次下单的天数'],
  ['purchase-frequency-alias', '没有别名：购买频次 → 下单次数；也不判歧义'],
  ['pv-7d-alias', '没有别名：PV → 浏览事件'],
  ['region-alias', '没有别名：地区 → 城市'],
  ['vip-level-alias', '没有别名：VIP → 会员等级'],
]);

/**
 * 查看者（没有 sources:read）看到的目录：去掉数据源与源表，字段不带血缘，实体不带来源表与合并组。
 * 照抄 app/.server/assistant/tools.ts 的 catalogFor（本票不改 app/，抽成纯函数留给 P2）
 */
function viewerView(c: Catalog): Catalog {
  const entries = c.entries.flatMap((e): CatalogEntry[] => {
    switch (e.kind) {
      case 'source':
      case 'table':
        return [];
      case 'field':
        return [{ ...e, lineage: [] }];
      case 'entity':
        return [{ ...e, tables: [], unscoped: [], mergeGroups: [] }];
      default:
        return [e];
    }
  });
  return { ...c, entries };
}

const LIMIT = 20;
const VIEWER = viewerView(RETRIEVAL_CATALOG);

/** 一条的检索结果：前 20（先去掉能力说明，与 model-draft 的 relevantMarkdown 一致）、命中的候选数与歧义判定 */
function run(g: GoldenEntry) {
  const c = g.role === 'viewer' ? VIEWER : RETRIEVAL_CATALOG;
  const top = search(c, g.retrieval.query, c.entries.length).filter(e => e.kind !== 'capability').slice(0, LIMIT).map(e => e.id);
  const hits = g.retrieval.candidates.filter(id => top.includes(id)).length;
  // 现有 search() 不判歧义
  const ambiguous = false;
  return { top, hits, ambiguous };
}

const recall = (g: GoldenEntry, r: ReturnType<typeof run>) => (g.retrieval.candidates.length ? r.hits / g.retrieval.candidates.length : null);

describe('检索黄金集的标注', () => {
  it('40 条都有失败类型、正确候选、不能选的近义项与追问键，引用的条目都在目录里', () => {
    expect(GOLDEN_ALL).toHaveLength(40);
    for (const g of GOLDEN_ALL) {
      expect(FAILURE_TYPES, g.id).toContain(g.failure_type);
      expect(ROLES, g.id).toContain(g.role);
      for (const k of g.covers) expect(COVERS, g.id).toContain(k);
      expect(g.clarify, `${g.id} clarify`).not.toBeUndefined();
      expect(typeof g.retrieval.ambiguous, g.id).toBe('boolean');
      // 要追问的条目都写了追问
      if (g.retrieval.ambiguous) expect(g.clarify, g.id).toEqual(expect.any(String));
      for (const id of [...g.retrieval.candidates, ...g.retrieval.forbidden]) expect(expand(RETRIEVAL_CATALOG, id), `${g.id} ${id}`).not.toBeNull();
      expect(g.retrieval.candidates.filter(id => g.retrieval.forbidden.includes(id)), g.id).toEqual([]);
    }
  });

  it('a、b、c、d 每类至少 4 条，同名不同主题、多义别名、跨角色可见性每种至少 5 条', () => {
    for (const t of FAILURE_TYPES) expect(GOLDEN_ALL.filter(g => g.failure_type === t).length, t).toBeGreaterThanOrEqual(4);
    for (const k of COVERS) expect(GOLDEN_ALL.filter(g => g.covers.includes(k)).length, k).toBeGreaterThanOrEqual(5);
    expect(GOLDEN_ALL.some(g => g.role === 'viewer')).toBe(true);
    for (const id of KNOWN_GAPS.keys()) expect(GOLDEN_ALL.map(g => g.id), id).toContain(id);
    // 模型评测只拿有 expected 的条目
    expect(GOLDEN.map(c => c.id)).toEqual(GOLDEN_ALL.filter(g => g.kind && g.expected).map(g => g.id));
  });

  it('额外的近义定义都能对着固定上下文过校验，目录里有它们', () => {
    for (const [key, d] of Object.entries(EXTRA_DEFINITIONS)) {
      const r = DSL_KINDS[d.kind].check(d.yaml, CONTEXT);
      expect(r.ok ? [] : r.issues, key).toEqual([]);
      expect(expand(RETRIEVAL_CATALOG, `${d.kind}:${key}`), key).not.toBeNull();
    }
  });

  it('查看者的目录没有数据源与源表，字段不带血缘', () => {
    expect(VIEWER.entries.filter(e => e.kind === 'source' || e.kind === 'table')).toEqual([]);
    expect(RETRIEVAL_CATALOG.entries.some(e => e.kind === 'table')).toBe(true);
    expect(VIEWER.entries.every(e => e.kind !== 'field' || e.lineage.length === 0)).toBe(true);
  });
});

describe('确定性检索（现有 search()）', () => {
  for (const g of GOLDEN_ALL) {
    const gap = KNOWN_GAPS.get(g.id);
    (gap ? it.fails : it)(`${g.id}：候选都进前 20，第 1 名不是近义项，歧义判定一致${gap ? `（已知差距：${gap}）` : ''}`, () => {
      const r = run(g);
      // 跨角色可见性：查看者看不到数据源与源表，一条都不能出现
      if (g.role === 'viewer') expect(r.top.filter(id => /^(source|table):/.test(id)), '查看者搜到了数据源或源表').toEqual([]);
      expect(g.retrieval.candidates.filter(id => !r.top.includes(id)), '没进前 20 的候选').toEqual([]);
      if (r.top.length) expect(g.retrieval.forbidden, '第 1 名是不能选的近义项').not.toContain(r.top[0]);
      expect(r.ambiguous, '歧义判定').toBe(g.retrieval.ambiguous);
    });
  }

  it(`总 Recall@20 不低于 BASELINE（${BASELINE}）`, () => {
    const rows = GOLDEN_ALL.map(g => {
      const r = run(g);
      return { id: g.id, type: g.failure_type, recall: recall(g, r), top1: r.top[0] ?? null, ambiguous: r.ambiguous, expected: g.retrieval.ambiguous };
    });
    console.table(rows);
    const scored = rows.flatMap(x => (x.recall === null ? [] : [x.recall]));
    const total = scored.reduce((a, b) => a + b, 0) / scored.length;
    console.log(`Recall@20 = ${total.toFixed(4)}（${scored.length} 条有候选）`);
    expect(total).toBeGreaterThanOrEqual(BASELINE);
  });
});

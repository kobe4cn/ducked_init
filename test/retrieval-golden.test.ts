// test/retrieval-golden.test.ts —— 检索黄金集（#317，ADR-0047 的确定性层）：42 条黄金集的标注齐全、分布达标、引用的条目都在固定目录里；
// 对 rank()（检索投影上的多路召回 + RRF 融合 + 依赖展开）逐条断言候选都在前 20、第 1 名不是不能选的近义项、歧义判定与标注一致，汇总 Recall@20 不低于 BASELINE；
// 别名类 6 条另断言别名指向的条目进前 20；度量说法 2 条断言 revenue_365d 进前 5、「消费金额」前 10 没有外键字段（#1192）。歧义按 judgeAmbiguity()（点名排除 + 口径对比，#398）判，做不到的记在 KNOWN_GAPS（用 it.fails，改好后会变红，提醒从清单删掉并抬高 BASELINE）。
// 纯函数，不读库、不走模型
import { describe, expect, it } from 'vitest';
import { expand } from '../app/.server/catalog';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import { CONTEXT, COVERS, FAILURE_TYPES, GOLDEN, GOLDEN_ALL, HOLDOUT, ROLES } from '../scripts/eval-requirements/golden';
import { recallAt, retrieve, viewerView } from '../scripts/eval-requirements/retrieval';
import { EXTRA_DEFINITIONS, RETRIEVAL_CATALOG } from '../scripts/eval-requirements/retrieval-catalog';

/** 总 Recall@20 的下限：本票实测值向下取两位小数；改好一条后抬高 */
const BASELINE = 0.96;

/** rank() 与歧义判定做不到的条目与原因 */
const KNOWN_GAPS = new Map<string, string>([
  ['churn-forecast', '「流失」没有出现在任何说明里，days_since_last_order 没进前 20'],
  ['consumption-amount', '歧义判定只按查询里出现的名称或别名分组，「消费金额」不是任何指标的名称或别名，revenue_30d 与 revenue_365d 分不成一组（排序已让两者进前 5，#1192）'],
  ['pv-7d-alias', '锚点投票：前 5 名里 order 与 consent 各两票（「近」的关键词命中），event 只有 event_type 一票、不是锚点，依赖展开没补 event.occurred_at'],
]);

/** 别名类条目 → 别名指向的条目（RETRIEVAL_CATALOG 的 ALIASES） */
const ALIAS_TARGETS: Record<string, string[]> = {
  'gmv-alias': ['metric:gross_revenue_30d'],
  'dormant-alias': ['metric:days_since_last_order'],
  'purchase-frequency-alias': ['metric:order_count_365d', 'metric:paid_order_count_365d'],
  'pv-7d-alias': ['field:event.event_type'],
  'region-alias': ['field:customer.city'],
  'vip-level-alias': ['field:membership.level'],
};

/** 业务说法（度量词）条目 → 要进前 5 的现成指标（#1192） */
const TOP_TARGETS: Record<string, string[]> = {
  'consumption-amount': ['metric:revenue_365d'],
  'member-revenue-365d': ['metric:revenue_365d'],
};

const VIEWER = viewerView(RETRIEVAL_CATALOG);

describe('检索黄金集的标注', () => {
  it('42 条都有失败类型、正确候选、不能选的近义项与追问键，引用的条目都在目录里', () => {
    expect(GOLDEN_ALL).toHaveLength(42);
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
    // 模型评测只拿有 kind、且有 expected 或标了期望做不到的条目（#1210）
    expect(GOLDEN.map(c => c.id)).toEqual(GOLDEN_ALL.filter(g => g.kind && (g.expected || g.expected_unsupported)).map(g => g.id));
  });

  it('验收集（HOLDOUT）共 8 条、都在黄金集里，a–d 每类至少 1 条，holdout 字段与集合一致', () => {
    const ids = GOLDEN_ALL.map(g => g.id);
    expect(HOLDOUT.size).toBe(8);
    for (const id of HOLDOUT) expect(ids, id).toContain(id);
    const holdout = GOLDEN_ALL.filter(g => HOLDOUT.has(g.id));
    for (const t of FAILURE_TYPES) expect(holdout.filter(g => g.failure_type === t).length, t).toBeGreaterThanOrEqual(1);
    for (const g of GOLDEN_ALL) expect(g.holdout, g.id).toBe(HOLDOUT.has(g.id));
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

describe('确定性检索（rank()）', () => {
  it('别名类 6 条：别名指向的条目进前 20，第 1 名不是近义项', () => {
    for (const [id, targets] of Object.entries(ALIAS_TARGETS)) {
      const g = GOLDEN_ALL.find(x => x.id === id);
      if (!g) throw new Error(`黄金集里没有 ${id}`);
      const r = retrieve(g);
      expect(targets.filter(t => !r.top.includes(t)), `${id} 没进前 20 的别名目标`).toEqual([]);
      expect(g.retrieval.forbidden, `${id} 第 1 名是不能选的近义项`).not.toContain(r.top[0]);
    }
  });

  it('度量说法 2 条：现成指标 revenue_365d 进前 5；「消费金额」的前 10 没有只靠外键名命中的字段', () => {
    for (const [id, targets] of Object.entries(TOP_TARGETS)) {
      const g = GOLDEN_ALL.find(x => x.id === id);
      if (!g) throw new Error(`黄金集里没有 ${id}`);
      const r = retrieve(g);
      expect(targets.filter(t => !r.top.slice(0, 5).includes(t)), `${id} 没进前 5 的指标：${r.top.slice(0, 10).join(', ')}`).toEqual([]);
    }
    const top10 = retrieve(GOLDEN_ALL.find(x => x.id === 'consumption-amount')!).top.slice(0, 10);
    expect(top10).not.toContain('field:coupon.customer_id');
    expect(top10).not.toContain('field:consent.customer_id');
  });

  for (const g of GOLDEN_ALL) {
    const gap = KNOWN_GAPS.get(g.id);
    (gap ? it.fails : it)(`${g.id}：候选都进前 20，第 1 名不是近义项，歧义判定一致${gap ? `（已知差距：${gap}）` : ''}`, () => {
      const r = retrieve(g);
      // 跨角色可见性：查看者看不到数据源与源表，一条都不能出现
      if (g.role === 'viewer') expect(r.top.filter(id => /^(source|table):/.test(id)), '查看者搜到了数据源或源表').toEqual([]);
      expect(g.retrieval.candidates.filter(id => !r.top.includes(id)), '没进前 20 的候选').toEqual([]);
      if (r.top.length) expect(g.retrieval.forbidden, '第 1 名是不能选的近义项').not.toContain(r.top[0]);
      expect(r.ambiguous, '歧义判定').toBe(g.retrieval.ambiguous);
    });
  }

  it(`总 Recall@20 不低于 BASELINE（${BASELINE}）`, () => {
    const rows = GOLDEN_ALL.map(g => {
      const r = retrieve(g);
      return { id: g.id, type: g.failure_type, recall: recallAt(g, r), top1: r.top[0] ?? null, ambiguous: r.ambiguous, expected: g.retrieval.ambiguous };
    });
    console.table(rows);
    const scored = rows.flatMap(x => (x.recall === null ? [] : [x.recall]));
    const total = scored.reduce((a, b) => a + b, 0) / scored.length;
    console.log(`Recall@20 = ${total.toFixed(4)}（${scored.length} 条有候选）`);
    expect(total).toBeGreaterThanOrEqual(BASELINE);
  });
});

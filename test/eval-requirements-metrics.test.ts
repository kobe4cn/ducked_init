// test/eval-requirements-metrics.test.ts —— pnpm eval:requirements 的检索与追问指标（#318，ADR-0041 / ADR-0047）：
// groupByType 按失败类型 a–d 与合计算组内平均 Recall@20（没有候选的不计）、追问正确率与应追问召回；
// 计划模式的期望（#423，ADR-0050 的 plan-modes.ts）覆盖全部条目且与标注规则一致；
// 对真实黄金集跑 retrievalRows，合计与 test/retrieval-golden.test.ts 的汇总一致。
// 带手工构造的向量时向量一路参与融合（#416，ADR-0047 / 0049）：确定性测试不调真实 embedding，「有收益」只用手工向量证明机制。纯函数，不读库、不走模型
import { describe, expect, it } from 'vitest';
import type { PlanMode } from '../app/.server/catalog/plan';
import { GOLDEN_ALL } from '../scripts/eval-requirements/golden';
import { PLAN_MODE_BY_ID, expectedMode } from '../scripts/eval-requirements/plan-modes';
import { groupByType, retrievalRows, VIEWS, type RetrievalRow, type RetrievalVectors } from '../scripts/eval-requirements/retrieval';

const row = (id: string, type: RetrievalRow['type'], recall: number | null, asked: boolean, shouldAsk: boolean, mode: PlanMode | null = null, expected: PlanMode = 'draft_query', planned = mode !== null): RetrievalRow =>
  ({ id, type, holdout: false, recall, top1: null, asked, shouldAsk, planned, mode, expectedMode: expected });

describe('eval:requirements 的检索与追问指标', () => {
  it('分组：Recall@20 组内平均且没有候选的不计，追问正确率按条数，应追问召回只看应追问的条目，合计覆盖全部', () => {
    const g = groupByType([
      row('a1', 'a', 1, false, false),
      row('a2', 'a', 0.5, false, true),
      row('a3', 'a', null, true, true),
      row('b1', 'b', 0, true, false),
    ]);
    expect(g.a).toEqual({ cases: 3, recall: 0.75, clarifyAccuracy: 2 / 3, clarifyRecall: 0.5, modeAccuracy: null });
    // 组里没有应追问的条目：应追问召回为 null
    expect(g.b).toEqual({ cases: 1, recall: 0, clarifyAccuracy: 0, clarifyRecall: null, modeAccuracy: null });
    // 空组：没有可算的召回
    expect(g.c).toEqual({ cases: 0, recall: null, clarifyAccuracy: 1, clarifyRecall: null, modeAccuracy: null });
    expect(g.合计).toEqual({ cases: 4, recall: 0.5, clarifyAccuracy: 0.5, clarifyRecall: 0.5, modeAccuracy: null });
  });

  it('计划模式正确率：模式一致的条数 / 跑过模型的条数，跑了但失败（mode 为 null）算错，没跑的不计入，一条都没跑为 null', () => {
    const g = groupByType([
      row('p1', 'a', null, false, false, 'clarify', 'clarify'), // 一致
      row('p2', 'a', null, false, false, 'reuse_result', 'clarify'), // 不一致
      row('p3', 'a', null, false, false), // 没跑模型：不计入
      row('p4', 'a', null, false, false, null, 'clarify', true), // 跑了但失败：算错、进分母
      row('b1', 'b', 0, false, false, 'draft_definition', 'draft_definition'), // 一致
      row('c1', 'c', null, false, false, null, 'draft_query', true), // 组里只有失败行
    ]);
    expect(g.a.modeAccuracy).toBe(1 / 3);
    expect(g.b.modeAccuracy).toBe(1);
    // 只有失败行：0 而不是 null（不显示成「未运行」）
    expect(g.c.modeAccuracy).toBe(0);
    expect(g.d.modeAccuracy).toBeNull();
    expect(g.合计.modeAccuracy).toBe(2 / 5);
  });

  it('真实黄金集：合计 Recall@20 与 retrieval-golden 的汇总一致，应追问 12 条、判出 8 条（4 条不是检索歧义），验收集 8 条', () => {
    const rows = retrievalRows(GOLDEN_ALL);
    const total = groupByType(rows).合计;
    expect(total.cases).toBe(40);
    expect(total.recall).toBeGreaterThanOrEqual(0.96);
    expect(total.recall!.toFixed(4)).toBe('0.9615');
    expect(rows.filter(r => r.shouldAsk)).toHaveLength(12);
    expect(rows.filter(r => r.asked)).toHaveLength(8);
    expect(total.clarifyRecall).toBe(8 / 12);
    expect(total.clarifyAccuracy).toBe(36 / 40);
    // 没跑模型：每条的 planned 为 false、mode 为 null，正确率不可算
    expect(rows.every(r => !r.planned && r.mode === null)).toBe(true);
    expect(rows.every(r => r.expectedMode === PLAN_MODE_BY_ID[r.id])).toBe(true);
    expect(total.modeAccuracy).toBeNull();
    expect(rows.filter(r => r.holdout)).toHaveLength(8);
  });

  it('带手工构造的向量：KNOWN_GAPS 里 churn-forecast 的候选进前 20、合计 Recall@20 比不带时高；不带向量仍为 0.9615', () => {
    // 期望条目 metric:days_since_last_order 的所有视图行向量 [1, 0]、其余行 [0, 1]（正交、相似度 0），
    // 查询向量只给 churn-forecast 一条 [1, 0]：只有它的检索走向量一路，其余条目与不带向量时完全相同
    const rows = new Map<string, number[]>();
    for (const v of [VIEWS.full, VIEWS.restricted]) {
      for (const r of v.rows) {
        if (!r.entryId.startsWith('capability:')) rows.set(r.textHash, r.entryId === 'metric:days_since_last_order' ? [1, 0] : [0, 1]);
      }
    }
    const vectors: RetrievalVectors = { rows, queries: new Map([['churn-forecast', [1, 0]]]) };
    const plain = retrievalRows(GOLDEN_ALL);
    const withVector = retrievalRows(GOLDEN_ALL, vectors);
    expect(groupByType(plain).合计.recall!.toFixed(4)).toBe('0.9615');
    expect(withVector.find(r => r.id === 'churn-forecast')!.recall!).toBe(1);
    expect(plain.find(r => r.id === 'churn-forecast')!.recall!).toBe(0);
    expect(groupByType(withVector).合计.recall!).toBeGreaterThan(0.9615);
  });

  it('计划模式期望：PLAN_MODE_BY_ID 覆盖全部条目且没有多余 id，d 类是 unsupported、其余标注追问的是 clarify、有期望定义的是 draft_definition，五种模式至少出现四种', () => {
    expect(new Set(Object.keys(PLAN_MODE_BY_ID))).toEqual(new Set(GOLDEN_ALL.map(g => g.id)));
    for (const g of GOLDEN_ALL) {
      expect(expectedMode(g), g.id).toBe(PLAN_MODE_BY_ID[g.id]);
      if (g.failure_type === 'd') expect(PLAN_MODE_BY_ID[g.id], g.id).toBe('unsupported');
      else if (g.clarify !== null) expect(PLAN_MODE_BY_ID[g.id], g.id).toBe('clarify');
      else if (g.kind) expect(PLAN_MODE_BY_ID[g.id], g.id).toBe('draft_definition');
    }
    // 手工标的 reuse_result：固定目录里已有能直接回答的发布指标（GMV → gross_revenue_30d、按支付时间的营收 → revenue_paid_30d），其余逐条标的都是 draft_query
    expect(PLAN_MODE_BY_ID['gmv-alias']).toBe('reuse_result');
    expect(PLAN_MODE_BY_ID['viewer-paid-revenue']).toBe('reuse_result');
    expect(new Set(Object.values(PLAN_MODE_BY_ID)).size).toBeGreaterThanOrEqual(4);
  });
});

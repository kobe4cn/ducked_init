// test/eval-requirements-metrics.test.ts —— pnpm eval:requirements 的检索与追问指标（#318，ADR-0041 / ADR-0047）：
// groupByType 按失败类型 a–d 与合计算组内平均 Recall@20（没有候选的不计）、追问正确率与应追问召回；
// 对真实黄金集跑 retrievalRows，合计与 test/retrieval-golden.test.ts 的汇总一致。
// 带手工构造的向量时向量一路参与融合（#416，ADR-0047 / 0049）：确定性测试不调真实 embedding，「有收益」只用手工向量证明机制。纯函数，不读库、不走模型
import { describe, expect, it } from 'vitest';
import { GOLDEN_ALL } from '../scripts/eval-requirements/golden';
import { groupByType, retrievalRows, VIEWS, type RetrievalRow, type RetrievalVectors } from '../scripts/eval-requirements/retrieval';

const row = (id: string, type: RetrievalRow['type'], recall: number | null, asked: boolean, shouldAsk: boolean): RetrievalRow =>
  ({ id, type, holdout: false, recall, top1: null, asked, shouldAsk });

describe('eval:requirements 的检索与追问指标', () => {
  it('分组：Recall@20 组内平均且没有候选的不计，追问正确率按条数，应追问召回只看应追问的条目，合计覆盖全部', () => {
    const g = groupByType([
      row('a1', 'a', 1, false, false),
      row('a2', 'a', 0.5, false, true),
      row('a3', 'a', null, true, true),
      row('b1', 'b', 0, true, false),
    ]);
    expect(g.a).toEqual({ cases: 3, recall: 0.75, clarifyAccuracy: 2 / 3, clarifyRecall: 0.5 });
    // 组里没有应追问的条目：应追问召回为 null
    expect(g.b).toEqual({ cases: 1, recall: 0, clarifyAccuracy: 0, clarifyRecall: null });
    // 空组：没有可算的召回
    expect(g.c).toEqual({ cases: 0, recall: null, clarifyAccuracy: 1, clarifyRecall: null });
    expect(g.合计).toEqual({ cases: 4, recall: 0.5, clarifyAccuracy: 0.5, clarifyRecall: 0.5 });
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
});

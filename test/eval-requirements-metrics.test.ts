// test/eval-requirements-metrics.test.ts —— pnpm eval:requirements 的检索与追问指标（#318，ADR-0041 / ADR-0047）：
// groupByType 按失败类型 a–d 与合计算组内平均 Recall@20（没有候选的不计）、追问正确率与应追问召回；
// 对真实黄金集跑 retrievalRows，合计与 test/retrieval-golden.test.ts 的汇总一致。纯函数，不读库、不走模型
import { describe, expect, it } from 'vitest';
import { GOLDEN_ALL } from '../scripts/eval-requirements/golden';
import { groupByType, retrievalRows, type RetrievalRow } from '../scripts/eval-requirements/retrieval';

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

  it('真实黄金集：合计 Recall@20 与 retrieval-golden 的汇总一致，应追问 12 条、判出 6 条（4 条不是检索歧义，revenue-ambiguous、revenue-yoy 缺「营收」别名），验收集 8 条', () => {
    const rows = retrievalRows(GOLDEN_ALL);
    const total = groupByType(rows).合计;
    expect(total.cases).toBe(40);
    expect(total.recall).toBeGreaterThanOrEqual(0.96);
    expect(total.recall!.toFixed(4)).toBe('0.9615');
    expect(rows.filter(r => r.shouldAsk)).toHaveLength(12);
    expect(rows.filter(r => r.asked)).toHaveLength(6);
    expect(total.clarifyRecall).toBe(6 / 12);
    expect(total.clarifyAccuracy).toBe(34 / 40);
    expect(rows.filter(r => r.holdout)).toHaveLength(8);
  });
});

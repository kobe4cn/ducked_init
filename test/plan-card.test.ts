// test/plan-card.test.ts —— 计划卡视图 planCardView()（#452，ADR-0050 / 0005，纯函数，不连库）：模板条目的数据截至取快照时间，
// 没有快照写「暂无快照」；目录里没有的所选条目只留 id，状态按重新校验给出（不是 valid）
import { describe, expect, it } from 'vitest';
import { buildCatalog, type Catalog } from '../app/.server/catalog';
import { semanticHash } from '../app/.server/catalog/plan';
import { planCardView } from '../app/.server/assistant/plan-card';

const SPACE = '00000000-0000-0000-0000-00000000000a';
const AT = '2026-10-01T00:00:00.000Z';

describe('计划卡视图 planCardView', () => {
  it('模板取快照时间、没有快照写「暂无快照」；目录里没有的条目只留 id，状态不是 valid', () => {
    const catalog: Catalog = buildCatalog({
      templates: [
        { template: 'rfm', version: 1, params: { lookbackDays: 365 }, spaceId: SPACE, snapshot: { table: 'gold.rfm__t1', rows: 1200, at: AT } },
        { template: 'cohort', version: 1, params: {}, spaceId: SPACE, snapshot: null },
      ],
    });
    const entry = (id: string) => {
      const e = catalog.entries.find(x => x.id === id);
      if (!e || e.kind !== 'template') throw new Error(`${id} 不是目录里的模板`);
      return e;
    };
    const [rfm, cohort] = [entry('template:rfm'), entry('template:cohort')];
    const card = planCardView(catalog, {
      schemaVersion: 1, mode: 'draft_query',
      selected: [
        { id: 'template:rfm', version: rfm.version, semanticHash: semanticHash(rfm) },
        { id: 'template:cohort', version: cohort.version, semanticHash: semanticHash(cohort) },
        { id: 'metric:missing', version: 1, semanticHash: 'x' },
      ],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['template:rfm', 'template:cohort', 'metric:missing'] }],
      assumptions: [],
      questions: [],
    });
    expect(card.selected).toEqual([
      { id: 'template:rfm', name: rfm.name, description: rfm.description, asOf: AT },
      { id: 'template:cohort', name: cohort.name, description: cohort.description, asOf: '暂无快照' },
      { id: 'metric:missing' },
    ]);
    expect(card.status).not.toBe('valid');
    expect(card.issues.map(i => i.message)).toContain('选中的条目不在可见目录里（无权限、未发布或已停用）');
  });
});

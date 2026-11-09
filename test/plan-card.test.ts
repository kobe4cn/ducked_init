// test/plan-card.test.ts —— 计划卡视图 planCardView()（#452 / #453，ADR-0050 / 0005，纯函数，不连库）：模板条目的数据截至取快照时间，
// 没有快照写「暂无快照」；目录里没有的所选条目只留 id，状态按重新校验给出（不是 valid）；重新校验通过且 reuse_result 时
// 给 resultHref（所选条目里第一个有结果页的：模板 / 指标 / 标签），clarify / unsupported 原样带上 questions / reason；
// excluded（#539）目录里有的条目带 id 与名称、没有的只有 reason，excluded 的 id 也算检索过（状态可仍为 valid）
import { describe, expect, it } from 'vitest';
import { buildCatalog, type Catalog, type CatalogEntry } from '../app/.server/catalog';
import { semanticHash, type AnalysisPlan, type SelectedRef } from '../app/.server/catalog/plan';
import { planCardView } from '../app/.server/assistant/plan-card';
import { RETRIEVAL_CATALOG } from '../scripts/eval-requirements/retrieval-catalog';

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

  it('reuse_result 重新校验通过时给所选条目里第一个有结果页的 resultHref；实体与源表跳过，不是 valid 或不是 reuse_result 时不给；clarify / unsupported 原样带上 questions / reason', () => {
    // 模板条目：RETRIEVAL_CATALOG 没有，单独 buildCatalog（照上一条的写法）
    const withTemplate = buildCatalog({
      templates: [{ template: 'rfm', version: 1, params: {}, spaceId: SPACE, snapshot: null }],
    });
    const rfm = withTemplate.entries.find(e => e.id === 'template:rfm')!;
    if (rfm.kind !== 'template') throw new Error('template:rfm 不是目录里的模板');
    // 指标、标签、实体：检索黄金集的固定目录
    const entry = (id: string) => {
      const e = RETRIEVAL_CATALOG.entries.find(x => x.id === id);
      if (!e) throw new Error(`${id} 不在目录里`);
      return e;
    };
    const [metric, tag, entity] = ['metric:revenue_30d', 'tag:high_spender', 'entity:customer'].map(entry);
    /** 目录条目 → 所选条目引用：指标、标签、模板带版本，实体不带 */
    const ref = (e: CatalogEntry): SelectedRef => ({
      id: e.id,
      ...(e.kind === 'metric' || e.kind === 'tag' || e.kind === 'template' ? { version: e.version } : {}),
      semanticHash: semanticHash(e),
    });
    /** 一份选了这些条目的 reuse_result 计划（都当作检索过，与 planCardView 内部一致） */
    const planOf = (selected: SelectedRef[], over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
      schemaVersion: 1, mode: 'reuse_result', selected, request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: selected.map(s => s.id) }], assumptions: [], questions: [], ...over,
    });
    // 模板、指标、标签各有结果页
    expect(planCardView(withTemplate, planOf([ref(rfm)])).resultHref).toBe('/analytics/templates/rfm');
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(metric)])).resultHref).toBe('/analytics/definitions/metric/revenue_30d');
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(tag)])).resultHref).toBe('/analytics/definitions/tag/high_spender');
    // 实体没有结果页：跳过它取后面的指标；只选实体时不给
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(entity), ref(metric)])).resultHref).toBe('/analytics/definitions/metric/revenue_30d');
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(entity)])).resultHref).toBeUndefined();
    // 重新校验不通过（所选条目不在目录里）时不给
    const missing = planCardView(RETRIEVAL_CATALOG, planOf([{ id: 'metric:nope', version: 1, semanticHash: 'x' }]));
    expect(missing.status).not.toBe('valid');
    expect(missing.resultHref).toBeUndefined();
    // 校验通过但 mode 不是 reuse_result（起草工作台查询）时也不给
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(metric)], { mode: 'draft_query' })).resultHref).toBeUndefined();
    // clarify / unsupported 的 questions / reason 原样带上
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(metric)], { mode: 'clarify', questions: ['统计哪个时间范围的营收？'] })))
      .toMatchObject({ status: 'needs_clarification', questions: ['统计哪个时间范围的营收？'] });
    expect(planCardView(RETRIEVAL_CATALOG, planOf([ref(metric)], { mode: 'unsupported', reason: '平台只能算到统一消费者粒度' })))
      .toMatchObject({ status: 'unsupported', reason: '平台只能算到统一消费者粒度' });
  });

  it('plan 带 rationale 时卡片带同样的 rationale；不带时卡片没有 rationale 键（旧计划照旧）', () => {
    const e = RETRIEVAL_CATALOG.entries.find(x => x.id === 'metric:revenue_30d')!;
    const ref = { id: e.id, version: 1, semanticHash: semanticHash(e) };
    const planOf = (over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
      schemaVersion: 1, mode: 'reuse_result', selected: [ref], request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: [ref.id] }], assumptions: [], questions: [], ...over,
    });
    expect(planCardView(RETRIEVAL_CATALOG, planOf({ rationale: '成员问的是近 30 天的营收，revenue_30d 的窗口与口径正好对上' })))
      .toMatchObject({ rationale: '成员问的是近 30 天的营收，revenue_30d 的窗口与口径正好对上' });
    expect(planCardView(RETRIEVAL_CATALOG, planOf())).not.toHaveProperty('rationale');
  });

  it('plan 带 excluded 时卡片带「排除了哪些口径」：目录里有的条目带 id 与名称，没有的只有 reason（不带 id 与名称）；selected 都有效时状态仍是 valid（excluded 算作检索过）；不带 excluded 的计划没有这个键（#539）', () => {
    const e = RETRIEVAL_CATALOG.entries.find(x => x.id === 'metric:revenue_30d')!;
    const paid = RETRIEVAL_CATALOG.entries.find(x => x.id === 'metric:revenue_paid_30d')!;
    const ref = { id: e.id, version: 1, semanticHash: semanticHash(e) };
    const planOf = (over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
      schemaVersion: 1, mode: 'reuse_result', selected: [ref], request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: [ref.id] }], assumptions: [], questions: [], ...over,
    });
    const card = planCardView(RETRIEVAL_CATALOG, planOf({ excluded: [
      { id: 'metric:revenue_paid_30d', reason: '按支付时间统计，与问的下单时间不符' },
      { id: 'metric:missing', reason: '口径与提问不符' },
    ] }));
    expect(card.status).toBe('valid');
    expect(card.excluded).toEqual([
      { id: 'metric:revenue_paid_30d', name: paid.name, reason: '按支付时间统计，与问的下单时间不符' },
      { reason: '口径与提问不符' },
    ]);
    expect(JSON.stringify(card.excluded)).not.toContain('metric:missing');
    expect(planCardView(RETRIEVAL_CATALOG, planOf())).not.toHaveProperty('excluded');
  });
});

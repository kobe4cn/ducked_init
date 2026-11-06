// test/catalog-plan.test.ts —— 分析计划校验 validatePlan()（ADR-0050，#409）：纯函数，不起库。
// 结构校验（JSON Schema 与步骤业务检查）、硬性检查（本次检索、可见目录、版本、语义哈希）、口径检查（单位 / 时间含义 / 窗口，只对 reuse_result 选中的指标）。
// 口径用例的固定目录是检索黄金集的 RETRIEVAL_CATALOG（「营收」别名挂在 revenue_30d 等指标上），成员声明的用例手工构造 CatalogInput
import { describe, expect, it } from 'vitest';
import { buildCatalog, type Catalog, type MetricEntry } from '../app/.server/catalog';
import { semanticHash, validatePlan, type AnalysisPlan } from '../app/.server/catalog/plan';
import type { Claim } from '../app/.server/knowledge/catalog';
import { RETRIEVAL_CATALOG } from '../scripts/eval-requirements/retrieval-catalog';

const SPACE = '00000000-0000-0000-0000-00000000000a';
const entryOf = (c: Catalog, id: string) => c.entries.find(e => e.id === id)!;

/** 一份选了 id 的合法 reuse_result 计划：id 在检索结果里、版本与语义哈希都对；over 整块覆盖某个字段 */
function planOf(id = 'metric:revenue_30d', over: Partial<AnalysisPlan> = {}): AnalysisPlan {
  const e = entryOf(RETRIEVAL_CATALOG, id) as MetricEntry;
  return {
    schemaVersion: 1,
    mode: 'reuse_result',
    selected: [{ id, version: e.version, semanticHash: semanticHash(e) }],
    request: { dimensions: [] },
    steps: [{ id: 's1', action: 'answer', inputs: [id] }],
    assumptions: [],
    questions: [],
    ...over,
  };
}

const check = (input: unknown, retrieved: ReadonlySet<string> = new Set(['metric:revenue_30d'])) =>
  validatePlan(input, { catalog: RETRIEVAL_CATALOG, retrieved });

describe('分析计划校验 validatePlan()：结构', () => {
  it('缺字段、未知 mode、unit / timeMeaning 不在登记值里都返回 invalid，问题带 JSON 路径，plan 为 null', () => {
    const { mode: _mode, ...noMode } = planOf();
    const missing = check(noMode);
    expect(missing.status).toBe('invalid');
    expect(missing.plan).toBeNull();
    expect(missing.issues.some(i => i.message === '缺少 mode')).toBe(true);

    const badMode = check(planOf(undefined, { mode: 'run_sql' as AnalysisPlan['mode'] }));
    expect(badMode.status).toBe('invalid');
    expect(badMode.plan).toBeNull();
    expect(badMode.issues.some(i => i.path === 'mode' && i.message.includes('reuse_result'))).toBe(true);

    const badUnit = check(planOf(undefined, { request: { dimensions: [], unit: 'kg' as never } }));
    expect(badUnit.status).toBe('invalid');
    expect(badUnit.issues.some(i => i.path === 'request.unit')).toBe(true);

    const badTime = check(planOf(undefined, { request: { dimensions: [], timeMeaning: 'whenever' as never } }));
    expect(badTime.status).toBe('invalid');
    expect(badTime.issues.some(i => i.path === 'request.timeMeaning')).toBe(true);
  });

  it('clarify 没有问题、unsupported 没有原因返回 invalid', () => {
    const clarify = check(planOf(undefined, { mode: 'clarify', questions: [] }));
    expect(clarify.status).toBe('invalid');
    expect(clarify.plan).toBeNull();
    expect(clarify.issues.some(i => i.message === '不能为空' && (i.path === 'questions' || i.message.includes('questions')))).toBe(true);

    const unsupported = check(planOf(undefined, { mode: 'unsupported' }));
    expect(unsupported.status).toBe('invalid');
    expect(unsupported.plan).toBeNull();
    expect(unsupported.issues.some(i => i.message.includes('reason'))).toBe(true);
  });

  it('步骤 id 重复、inputs 引用不存在的步骤或条目、引用自己或后面的步骤（成环）都返回 invalid', () => {
    const dup = check(planOf(undefined, { steps: [
      { id: 's1', action: 'answer', inputs: [] }, { id: 's1', action: 'again', inputs: [] },
    ] }));
    expect(dup.status).toBe('invalid');
    expect(dup.plan).toBeNull();
    expect(dup.issues.some(i => i.path === 'steps.1.id' && i.message.includes('重复'))).toBe(true);

    const missing = check(planOf(undefined, { steps: [{ id: 's1', action: 'answer', inputs: ['nope'] }] }));
    expect(missing.status).toBe('invalid');
    expect(missing.issues.some(i => i.path === 'steps.0.inputs.0' && i.message.includes('nope'))).toBe(true);

    const cycle = check(planOf(undefined, { steps: [
      { id: 'a', action: 'x', inputs: ['b'] }, { id: 'b', action: 'y', inputs: ['a'] },
    ] }));
    expect(cycle.status).toBe('invalid');
    expect(cycle.issues.some(i => i.path === 'steps.0.inputs.0' && i.message.includes('环'))).toBe(true);

    const self = check(planOf(undefined, { steps: [{ id: 'a', action: 'x', inputs: ['a'] }] }));
    expect(self.status).toBe('invalid');
    expect(self.issues.some(i => i.path === 'steps.0.inputs.0' && i.message.includes('环'))).toBe(true);
  });

  it('合法的计划原样解析回 plan', () => {
    const plan = planOf();
    const r = check(plan);
    expect(r.status).toBe('valid');
    expect(r.issues).toEqual([]);
    expect(r.plan).toEqual(plan);
  });
});

describe('分析计划校验 validatePlan()：硬性检查', () => {
  const hashOf = (id: string) => semanticHash(entryOf(RETRIEVAL_CATALOG, id));
  /** 换掉选中条目的某一项，其余保持合法 */
  const select = (s: Partial<AnalysisPlan['selected'][number]>) => ({ ...planOf(), selected: [{ ...planOf().selected[0]!, ...s }] });

  it('选中的 id 不在本次检索结果里、不在可见目录里时返回 invalid，问题带 entryId 与哪一项不符', () => {
    const notRetrieved = validatePlan(planOf(), { catalog: RETRIEVAL_CATALOG, retrieved: new Set() });
    expect(notRetrieved.status).toBe('invalid');
    expect(notRetrieved.issues).toEqual([{ path: 'selected.0.id', entryId: 'metric:revenue_30d', message: '选中的条目不在本次检索结果里' }]);

    const absent = validatePlan({ ...planOf(), selected: [{ id: 'metric:nope', semanticHash: 'x' }], steps: [] },
      { catalog: RETRIEVAL_CATALOG, retrieved: new Set(['metric:nope']) });
    expect(absent.status).toBe('invalid');
    expect(absent.issues).toEqual([{ path: 'selected.0.id', entryId: 'metric:nope', message: '选中的条目不在可见目录里（无权限、未发布或已停用）' }]);
  });

  it('版本不一致、指标没带 version 返回 invalid；字段没有版本，带了也忽略', () => {
    const wrong = check(select({ version: 2 }));
    expect(wrong.status).toBe('invalid');
    expect(wrong.issues.some(i => i.path === 'selected.0.version' && i.entryId === 'metric:revenue_30d'
      && i.message.includes('v2') && i.message.includes('v1'))).toBe(true);

    const none = check(select({ version: undefined }));
    expect(none.status).toBe('invalid');
    expect(none.issues.some(i => i.path === 'selected.0.version' && i.message.includes('必须带 version'))).toBe(true);

    const field = validatePlan({ ...planOf(), selected: [{ id: 'field:order.amount', version: 9, semanticHash: hashOf('field:order.amount') }], steps: [] },
      { catalog: RETRIEVAL_CATALOG, retrieved: new Set(['field:order.amount']) });
    expect(field.status).toBe('valid');
    expect(field.issues).toEqual([]);
  });

  it('语义哈希与当前目录不一致返回 invalid；哈希忽略统计、对业务知识敏感', () => {
    const wrong = check(select({ semanticHash: hashOf('metric:revenue_paid_30d') }));
    expect(wrong.status).toBe('invalid');
    expect(wrong.issues.some(i => i.path === 'selected.0.semanticHash' && i.message.includes('语义哈希'))).toBe(true);

    const yaml = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
    const definition = { kind: 'metric' as const, key: 'rev', version: 1, yaml, spaceId: SPACE };
    const plain = buildCatalog({ definitions: [definition] });
    const withStats = buildCatalog({ definitions: [definition], entityStats: [{ entity: 'order', rows: 32000, at: '2024-12-01T00:00:00.000Z' }] });
    const aliased = buildCatalog({ definitions: [definition], knowledge: { byTarget: new Map([['metric:rev', { aliases: ['营收'] }]]) } });
    expect(semanticHash(entryOf(withStats, 'entity:order'))).toBe(semanticHash(entryOf(plain, 'entity:order')));
    expect(semanticHash(entryOf(aliased, 'metric:rev'))).not.toBe(semanticHash(entryOf(plain, 'metric:rev')));
  });
});

describe('分析计划校验 validatePlan()：口径检查', () => {
  /** 挂了成员口径声明的目录：rev 的定义与 RETRIEVAL_CATALOG 里 revenue_30d 相同（窗口 created_at 30 天），版本是 3 */
  const claimedCatalog = (claims: Claim[]): Catalog => buildCatalog({
    definitions: [{ kind: 'metric', key: 'rev', version: 3, yaml: 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n', spaceId: SPACE }],
    knowledge: { byTarget: new Map([['metric:rev', { claims }]]) },
  });
  const claimedPlan = (c: Catalog, request: AnalysisPlan['request']): AnalysisPlan => ({
    schemaVersion: 1,
    mode: 'reuse_result',
    selected: [{ id: 'metric:rev', version: 3, semanticHash: semanticHash(entryOf(c, 'metric:rev')) }],
    request,
    steps: [],
    assumptions: [],
    questions: [],
  });
  const checkClaimed = (c: Catalog, plan: AnalysisPlan) => validatePlan(plan, { catalog: c, retrieved: new Set(['metric:rev']) });

  it('reuse_result 选 revenue_30d（下单时间）而要求 pay_time 时返回 invalid，next 提示改选定义或 draft_definition', () => {
    const r = check(planOf(undefined, { request: { dimensions: [], timeMeaning: 'pay_time' } }));
    expect(r.status).toBe('invalid');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ path: 'request.timeMeaning', entryId: 'metric:revenue_30d' });
    expect(r.issues[0]!.message).toContain('时间含义');
    expect(r.issues[0]!.message).toContain('支付时间');
    expect(r.issues[0]!.message).toContain('下单时间');
    expect(r.issues[0]!.next).toContain('draft_definition');
    expect(r.plan).not.toBeNull();
  });

  it('要求了单位而指标的 unit 是 unknown（未声明）时返回 needs_clarification', () => {
    const r = check(planOf(undefined, { request: { dimensions: [], unit: 'currency_major' } }));
    expect(r.status).toBe('needs_clarification');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.path).toBe('request.unit');
    expect(r.issues[0]!.message).toContain('单位');
    expect(r.issues[0]!.message).toContain('未声明');
    expect(r.issues[0]!.next).toContain('追问');
  });

  it('口径声明需复核（原值在 previous）时返回 needs_clarification，message 带原值', () => {
    const c = claimedCatalog([{ type: 'unit', value: 'unknown', previous: 'currency_major', needsReview: true }]);
    const r = checkClaimed(c, claimedPlan(c, { dimensions: [], unit: 'currency_major' }));
    expect(r.status).toBe('needs_clarification');
    expect(r.issues[0]!.message).toContain('需复核');
    expect(r.issues[0]!.message).toContain('主币种单位');
  });

  it('成员写了口径声明且与要求一致时返回 valid；成员声明覆盖系统派生', () => {
    const c = claimedCatalog([{ type: 'unit', value: 'currency_major' }, { type: 'time_meaning', value: 'pay_time' }]);
    const agree = checkClaimed(c, claimedPlan(c, { dimensions: [], unit: 'currency_major', timeMeaning: 'pay_time' }));
    expect(agree.status).toBe('valid');
    expect(agree.issues).toEqual([]);
    // 窗口是 created_at（系统派生下单时间），成员声明了 pay_time：要求 pay_time 合、要求 order_time 不合
    expect(checkClaimed(c, claimedPlan(c, { dimensions: [], timeMeaning: 'order_time' })).status).toBe('invalid');
  });

  it('要求的窗口天数与定义的窗口不同时返回 invalid；相同或没提则无事', () => {
    const seven = check(planOf(undefined, { request: { dimensions: [], windowDays: 7 } }));
    expect(seven.status).toBe('invalid');
    expect(seven.issues[0]!.message).toContain('7');
    expect(seven.issues[0]!.message).toContain('30');
    expect(check(planOf(undefined, { request: { dimensions: [], windowDays: 30 } })).status).toBe('valid');
  });

  it('draft_definition 模式不做口径检查；clarify / unsupported 的合法计划分别是 needs_clarification / unsupported', () => {
    const draft = check(planOf(undefined, { mode: 'draft_definition', request: { dimensions: [], timeMeaning: 'pay_time' } }));
    expect(draft.status).toBe('valid');
    expect(draft.issues).toEqual([]);

    const clarify = check(planOf(undefined, { mode: 'clarify', questions: ['按哪个时间算？'] }));
    expect(clarify.status).toBe('needs_clarification');
    expect(clarify.issues).toEqual([]);

    const unsupported = check(planOf(undefined, { mode: 'unsupported', reason: 'DSL 只能算到统一消费者粒度', selected: [], steps: [] }));
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.issues).toEqual([]);
  });
});

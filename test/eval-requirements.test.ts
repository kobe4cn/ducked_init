// test/eval-requirements.test.ts —— 需求评测（#279，ADR-0041）：黄金集的期望都能对着固定上下文过校验、指标与标签都有、只引用目录里有的字段；
// runCase 用假 fetch 跑出的校验通过与结构命中：与期望一致、字段写错、不合 Schema；runPlanCase（#423，ADR-0050）用假模型选计划模式：
// 一致记对、不一致或解析失败记错，查看者条目用查看者目录（纯函数，不读库）
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { expand } from '../app/.server/catalog';
import { AGGREGATE_FNS, semanticHash, type PlanMode } from '../app/.server/catalog/plan';
import { CLAIM_TYPES } from '../app/lib/semantic-claims';
import { setLlmFetch } from '../app/.server/llm';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import { CATALOG, CONTEXT, GOLDEN, GOLDEN_ALL } from '../scripts/eval-requirements/golden';
import { RETRIEVAL_CATALOG } from '../scripts/eval-requirements/retrieval-catalog';
import { runCase, runPlanCase, summarize } from '../scripts/eval-requirements/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };

const caseNamed = (id: string) => GOLDEN.find(c => c.id === id)!;
const entryNamed = (id: string) => GOLDEN_ALL.find(g => g.id === id)!;
const clone = <T>(x: T): T => structuredClone(x);

describe('需求黄金集', () => {
  it('期望都能对着固定上下文过校验，指标与标签都有，引用的字段都在目录里', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(8);
    expect(new Set(GOLDEN.map(c => c.kind))).toEqual(new Set(['metric', 'tag']));
    expect(new Set(GOLDEN.map(c => c.id)).size).toBe(GOLDEN.length);
    for (const c of GOLDEN) {
      const r = DSL_KINDS[c.kind].check(stringify(c.expected), CONTEXT);
      expect(r.ok ? [] : r.issues, c.id).toEqual([]);
      // 敏感字段不在目录里：期望只能用目录里有的字段
      if (r.ok) for (const f of DSL_KINDS[c.kind].dependencies(r.spec).fields) expect(expand(CATALOG, `field:${f.entity}.${f.field}`), `${c.id} ${f.entity}.${f.field}`).not.toBeNull();
    }
  });
});

describe('需求评测跑分', () => {
  it('指标：模型输出与期望一致时校验通过、命中率 1，消息与产品相同', async () => {
    const c = caseNamed('paid-revenue-by-city');
    const { f } = fakeLlm(setLlmFetch, () => json(c.expected));
    const r = await runCase(PROVIDER, c);
    expect(r).toEqual({
      id: 'paid-revenue-by-city', kind: 'metric', valid: true, hits: 6, items: 6, hitRate: 1,
      structure: { kind: true, entity: true, measure: true, fields: true, filter: true, dimensions: true },
    });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('## capability:metric-dsl');
    expect(body.messages[1].content.endsWith(`# 需求\n\n${c.request}`)).toBe(true);
  });

  it('等价写法不扣分：eq 与单值 in、带基础实体前缀的字段、键的顺序', async () => {
    const c = caseNamed('paid-revenue-by-city');
    fakeLlm(setLlmFetch, () => json({
      dimensions: [{ path: 'order.customer_id->customer.city', name: 'customer_city' }],
      window: { days: 30, field: 'order.created_at' },
      filter: [{ value: ['paid'], op: 'in', field: 'status' }],
      measure: { field: 'amount', agg: 'sum' },
      base: 'order',
    }));
    expect(await runCase(PROVIDER, c)).toMatchObject({ valid: true, hits: 6, hitRate: 1 });
  });

  it('标签：模型输出与期望一致时命中率 1', async () => {
    const c = caseNamed('spend-tier');
    fakeLlm(setLlmFetch, () => json(c.expected));
    expect(await runCase(PROVIDER, c)).toEqual({
      id: 'spend-tier', kind: 'tag', valid: true, hits: 3, items: 3, hitRate: 1, structure: { kind: true, metrics: true, rules: true },
    });
  });

  it('度量字段写错：校验不过，度量与字段两项不命中', async () => {
    const c = caseNamed('avg-completed-order-amount');
    const draft = clone(c.expected) as { measure: { field: string } };
    draft.measure.field = 'pay_amount';
    fakeLlm(setLlmFetch, () => json(draft));
    const r = await runCase(PROVIDER, c);
    expect(r).toMatchObject({
      valid: false, hits: 4, items: 6, hitRate: 4 / 6,
      structure: { kind: true, entity: true, measure: false, fields: false, filter: true, dimensions: true },
      failed: { stage: 'definition', issues: expect.any(Number) },
    });
  });

  it('过滤取值写错、标签阈值写错：仍过校验，只有对应的项不命中', async () => {
    const metric = caseNamed('refund-rate');
    const draft = clone(metric.expected) as { measure: { numerator: { filter: { value: string }[] } } };
    draft.measure.numerator.filter[0]!.value = 'cancelled';
    fakeLlm(setLlmFetch, () => json(draft));
    expect(await runCase(PROVIDER, metric)).toMatchObject({ valid: true, hits: 5, hitRate: 5 / 6, structure: { measure: false } });

    const tag = caseNamed('churn-risk');
    fakeLlm(setLlmFetch, () => json({ ...tag.expected, rules: [{ value: 'at_risk', when: { gt: 60 } }] }));
    expect(await runCase(PROVIDER, tag)).toMatchObject({ valid: true, hits: 2, structure: { metrics: true, rules: false } });
  });

  it('只多一条过滤：仍过校验，只有过滤项不命中，字段项不重复计', async () => {
    const c = caseNamed('paid-revenue-by-city');
    const draft = clone(c.expected) as { filter: { field: string; op: string; value: unknown }[] };
    draft.filter.push({ field: 'channel', op: 'in', value: ['store'] });
    fakeLlm(setLlmFetch, () => json(draft));
    expect(await runCase(PROVIDER, c)).toMatchObject({ valid: true, hits: 5, hitRate: 5 / 6, structure: { filter: false, fields: true } });
  });

  it('模型返回不合 Schema：失败于模型调用，各项都不命中，Key 不出现在结果里', async () => {
    const c = caseNamed('order-count-90d');
    fakeLlm(setLlmFetch, () => json({ base: 'order' }));
    const r = await runCase(PROVIDER, c);
    expect(r).toMatchObject({ valid: false, hits: 0, items: 6, hitRate: 0, failed: { stage: 'model' } });
    expect(r.failed!.message).toContain('不符合 Schema');
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('总体：校验通过率按样例数，命中率按结构项加权', () => {
    const structure = {};
    expect(summarize([
      { id: 'a', kind: 'metric', valid: true, structure, hits: 6, items: 6, hitRate: 1 },
      { id: 'b', kind: 'tag', valid: false, structure, hits: 1, items: 3, hitRate: 1 / 3, failed: { stage: 'definition', message: 'x' } },
    ])).toEqual({ cases: 2, valid: 1, validRate: 0.5, hits: 7, items: 9, hitRate: 7 / 9 });
  });
});

describe('计划模式评测', () => {
  /** 合 Schema 的最小计划：模式可换，clarify 要带问题、unsupported 要带 reason */
  const plan = (mode: PlanMode, extra: Record<string, unknown> = {}) =>
    ({ schemaVersion: 1, mode, selected: [], request: { dimensions: [] }, steps: [], assumptions: [], questions: [], ...extra });

  it('模式一致记对：user 消息带前 20 条目、可选中条目的版本与语义哈希、需求原文', async () => {
    const g = entryNamed('gmv-alias'); // 期望 reuse_result：gross_revenue_30d 挂着 GMV 别名
    const { received } = fakeLlm(setLlmFetch, () => json(plan('reuse_result')));
    expect(await runPlanCase(PROVIDER, g)).toEqual({ id: 'gmv-alias', mode: 'reuse_result', expected: 'reuse_result', correct: true });
    const body = JSON.parse(JSON.stringify(received[0]!.body));
    expect(body.messages[0].content).toContain('reuse_result');
    expect(body.messages[0].content).toContain('unsupported');
    // Schema 的三个枚举字段要把可选值告诉模型，否则格式失败会混进模式正确率
    const system = body.messages[0].content as string;
    for (const fn of AGGREGATE_FNS) expect(system).toContain(fn);
    for (const { value } of [...CLAIM_TYPES.unit.values, ...CLAIM_TYPES.time_meaning.values]) expect(system).toContain(value);
    const user = body.messages[1].content as string;
    expect(user.endsWith(`# 需求\n\n${g.request}`)).toBe(true);
    expect(user).toContain('metric:gross_revenue_30d');
    expect(user).toContain(semanticHash(expand(RETRIEVAL_CATALOG, 'metric:gross_revenue_30d')!));
  });

  it('查看者条目用查看者目录：消息里没有数据源与源表', async () => {
    const g = entryNamed('viewer-paid-revenue'); // 期望 reuse_result：revenue_paid_30d 查看者也可见
    const { received } = fakeLlm(setLlmFetch, () => json(plan('reuse_result')));
    expect(await runPlanCase(PROVIDER, g)).toEqual({ id: 'viewer-paid-revenue', mode: 'reuse_result', expected: 'reuse_result', correct: true });
    expect(received[0]!.body.messages[1].content).not.toContain('source:');
    expect(received[0]!.body.messages[1].content).not.toContain('table:');
  });

  it('模式不一致记错；不合 Schema 或计划结构不合法时 mode 为 null 也记错，Key 不出现在结果里', async () => {
    const g = entryNamed('gmv-alias');
    fakeLlm(setLlmFetch, () => json(plan('draft_query')));
    expect(await runPlanCase(PROVIDER, g)).toMatchObject({ mode: 'draft_query', expected: 'reuse_result', correct: false });

    fakeLlm(setLlmFetch, () => json({ schemaVersion: 1, mode: 'reuse_result' })); // 缺必填项，不合 Schema
    const bad = await runPlanCase(PROVIDER, g);
    expect(bad).toMatchObject({ mode: null, expected: 'reuse_result', correct: false, failed: { stage: 'model' } });
    expect(JSON.stringify(bad)).not.toContain(PROVIDER.apiKey);

    // 合 Schema 但步骤引用不存在的步骤：validatePlan 解析不出计划
    fakeLlm(setLlmFetch, () => json(plan('clarify', { questions: ['按哪个口径？'], steps: [{ id: 's1', action: 'answer', inputs: ['nope'] }] })));
    const broken = await runPlanCase(PROVIDER, g);
    expect(broken).toMatchObject({ mode: null, correct: false, failed: { stage: 'plan' } });
    expect(broken.failed!.message).toContain('inputs 引用了不存在的步骤或条目');
  });
});

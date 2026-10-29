// test/eval-requirements.test.ts —— 需求评测（#279，ADR-0041）：黄金集的期望都能对着固定上下文过校验、指标与标签都有、只引用目录里有的字段；
// runCase 用假 fetch 跑出的校验通过与结构命中：与期望一致、字段写错、不合 Schema（纯函数，不读库）
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { expand } from '../app/.server/catalog';
import { setLlmFetch } from '../app/.server/llm';
import { DSL_KINDS } from '../app/.server/pipeline/dsl';
import { CATALOG, CONTEXT, GOLDEN } from '../scripts/eval-requirements/golden';
import { runCase, summarize } from '../scripts/eval-requirements/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };

const caseNamed = (id: string) => GOLDEN.find(c => c.id === id)!;
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

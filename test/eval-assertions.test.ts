// test/eval-assertions.test.ts —— 断言起草评测（#1261，ADR-0035）：黄金集的映射都过校验、期望字段都映射出来、有「做不到」的样例；
// runCase 用假 fetch 跑出的命中数：期望全中、少一条必须的、多一条不该给的、不合 Schema、转出的映射不过校验（纯函数，不读库、不调模型）
import { afterEach, describe, expect, it } from 'vitest';
import { setLlmFetch } from '../app/.server/llm';
import { checkMapping } from '../app/.server/pipeline/mapping-spec';
import type { AssertionDraft, ModelAssertion } from '../app/.server/pipeline/model-draft';
import { ASSERTION_GOLDEN } from '../scripts/eval-assertions/golden';
import { runCase, summarize } from '../scripts/eval-assertions/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };
const caseNamed = (name: string) => ASSERTION_GOLDEN.find(c => c.name === name)!;
const a = (field: string, check: ModelAssertion['check'], extra: Partial<ModelAssertion> = {}): ModelAssertion =>
  ({ field, check, level: 'warn', confidence: 0.8, reason: '依据列统计', ...extra });

/** nullable-member-sales 的期望全中：order_id 非空且唯一，status 在标准取值里 */
const PERFECT: AssertionDraft = { assertions: [
  a('order_id', 'not_null', { level: 'error' }),
  a('order_id', 'unique', { level: 'error' }),
  a('status', 'in', { values: ['created', 'paid', 'shipped', 'completed', 'cancelled', 'refunded'] }),
  a('amount', 'range', { min: 0, max: 5000 }),
] };

describe('断言黄金集', () => {
  it('至少 5 例；映射都过校验，期望里的字段都映射出来；有不要求断言、禁止敏感字段 range / in 的样例', () => {
    expect(ASSERTION_GOLDEN.length).toBeGreaterThanOrEqual(5);
    for (const c of ASSERTION_GOLDEN) {
      const r = checkMapping(c.yaml, () => c.profile.columns.map(({ name, type }) => ({ name, type })));
      expect(r.ok ? [] : r.issues, c.name).toEqual([]);
      if (!r.ok) continue;
      const fields = new Set(r.plan.columns.map(col => col.name));
      for (const e of [...c.require, ...c.forbid]) expect(fields.has(e.field), `${c.name} ${e.field}`).toBe(true);
    }
    expect(ASSERTION_GOLDEN.some(c => c.require.length === 0
      && c.forbid.some(f => ['phone', 'email'].includes(f.field) && ['range', 'in'].includes(f.check)))).toBe(true);
  });
});

describe('断言评测跑分', () => {
  it('期望全中：通过，命中 5/5；不带样本行', async () => {
    const { f } = fakeLlm(setLlmFetch, () => json(PERFECT));
    const r = await runCase(caseNamed('nullable-member-sales'), PROVIDER);
    expect(r).toEqual({ name: 'nullable-member-sales', pass: true, hits: 5, items: 5 });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(JSON.parse(body.messages[1].content).table).not.toHaveProperty('samples');
    expect(summarize([r])).toEqual({ passRate: 1, hitRate: 1 });
  });

  it('少一条必须的、多一条不该给的：只扣对应的项', async () => {
    fakeLlm(setLlmFetch, () => json({ assertions: [...PERFECT.assertions.filter(x => x.check !== 'unique'), a('customer_id', 'not_null')] }));
    expect(await runCase(caseNamed('nullable-member-sales'), PROVIDER)).toEqual({ name: 'nullable-member-sales', pass: false, hits: 3, items: 5 });
  });

  it('模型返回不合 Schema：失败于模型调用，一项不中', async () => {
    fakeLlm(setLlmFetch, () => json({ assertions: [{ field: 'order_id' }] }));
    expect(await runCase(caseNamed('nullable-member-sales'), PROVIDER)).toEqual({ name: 'nullable-member-sales', pass: false, hits: 0, items: 5, stage: 'model' });
  });

  it('转出的映射不过校验（敏感字段给了 range）：失败于映射校验，命中照模型输出算，结果里没有 Key', async () => {
    fakeLlm(setLlmFetch, () => json({ assertions: [a('customer_id', 'not_null'), a('phone', 'range', { min: 0, max: 1 })] }));
    const r = await runCase(caseNamed('sensitive-customers'), PROVIDER);
    expect(r).toEqual({ name: 'sensitive-customers', pass: false, hits: 3, items: 4, stage: 'mapping' });
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('做不到的样例：一条断言都不给也算通过', async () => {
    fakeLlm(setLlmFetch, () => json({ assertions: [] }));
    expect(await runCase(caseNamed('sensitive-customers'), PROVIDER)).toEqual({ name: 'sensitive-customers', pass: true, hits: 4, items: 4 });
  });

  it('总体：通过率按例，命中率按项加权', () => {
    expect(summarize([
      { name: 'a', pass: true, hits: 4, items: 4 },
      { name: 'b', pass: false, hits: 2, items: 6, stage: 'mapping' },
    ])).toEqual({ passRate: 0.5, hitRate: 0.6 });
  });
});

// test/eval-knowledge-import.test.ts —— 知识导入评测（#1264，ADR-0035 / 0046）：黄金集至少 5 例、至少 2 例「做不到」、期望的目标都在固定目录里、claim 取值合法；
// runCase 用假 fetch 跑出的计分：期望全中、alias 大小写与首尾空白不同、目标不在目录里被丢弃、做不到的样例给了 / 没给提案、不合 Schema（纯函数，不读库、不调模型）
import { afterEach, describe, expect, it } from 'vitest';
import { importInput, type ImportProposal } from '../app/.server/knowledge/import-draft';
import { setLlmFetch } from '../app/.server/llm';
import { isClaimValue } from '../app/lib/semantic-claims';
import { CATALOG } from '../scripts/eval-requirements/golden';
import { KNOWLEDGE_IMPORT_GOLDEN } from '../scripts/eval-knowledge-import/golden';
import { runCase, summarize } from '../scripts/eval-knowledge-import/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };
const caseNamed = (name: string) => KNOWLEDGE_IMPORT_GOLDEN.find(c => c.name === name)!;
const alias = (targetId: string, value: string): ImportProposal =>
  ({ kind: 'alias', targetId, alias: value, note: null, claim: null, evidence: [{ paragraph: 1 }], reason: '段落写明' });
const claim = (targetId: string, type: string, value: string): ImportProposal =>
  ({ kind: 'claim', targetId, claim: { type, value }, alias: null, note: null, evidence: [{ paragraph: 1 }], reason: '段落写明' });

describe('知识导入黄金集', () => {
  it('至少 5 例，至少 2 例期望做不到；期望的目标都在固定目录里，claim 取值合法', () => {
    expect(KNOWLEDGE_IMPORT_GOLDEN.length).toBeGreaterThanOrEqual(5);
    expect(KNOWLEDGE_IMPORT_GOLDEN.filter(c => c.empty && c.expect.length === 0).length).toBeGreaterThanOrEqual(2);
    const ids = new Set(importInput({ paragraphs: [] }, CATALOG).entries.map(e => e.id));
    for (const c of KNOWLEDGE_IMPORT_GOLDEN.filter(x => !x.empty)) {
      expect(c.expect.length, c.name).toBeGreaterThan(0);
      for (const e of c.expect) {
        expect(ids.has(e.targetId), `${c.name} ${e.targetId}`).toBe(true);
        if (e.kind === 'claim') expect(isClaimValue(e.claimType, e.claimValue), `${c.name} ${e.claimType}`).toBe(true);
        if (e.kind === 'alias') expect(e.alias?.trim(), c.name).toBeTruthy();
      }
    }
  });
});

describe('知识导入评测跑分', () => {
  it('期望全中：通过，命中 1/1；请求带段落与目录条目', async () => {
    const { received } = fakeLlm(setLlmFetch, () => json({ proposals: [claim('metric:revenue_30d', 'currency', 'CNY')] }));
    const r = await runCase(caseNamed('revenue-currency'), PROVIDER);
    expect(r).toEqual({ name: 'revenue-currency', pass: true, hits: 1, items: 1 });
    const user = JSON.parse(received[0]!.body.messages[1].content);
    expect(user.paragraphs).toEqual(caseNamed('revenue-currency').paragraphs);
    expect(user.entries.some((e: { id: string }) => e.id === 'metric:revenue_30d')).toBe(true);
  });

  it('alias 大小写或首尾空白不同也算命中；类型对、取值不对的 claim 不算', async () => {
    fakeLlm(setLlmFetch, () => json({ proposals: [alias('entity:customer', '  买家 ')] }));
    expect(await runCase(caseNamed('customer-alias'), PROVIDER)).toMatchObject({ pass: true, hits: 1 });
    fakeLlm(setLlmFetch, () => json({ proposals: [alias('field:order.amount', ' paid AMOUNT  ')] }));
    expect(await runCase(caseNamed('order-amount-alias'), PROVIDER)).toMatchObject({ pass: true, hits: 1 });
    fakeLlm(setLlmFetch, () => json({ proposals: [claim('metric:revenue_30d', 'refund_deducted', 'yes')] }));
    expect(await runCase(caseNamed('revenue-refund'), PROVIDER))
      .toEqual({ name: 'revenue-refund', pass: false, hits: 0, items: 1, stage: 'proposals' });
  });

  it('目标不在目录里：被 outputToProposals 丢弃，失败于 dropped，只记原因', async () => {
    fakeLlm(setLlmFetch, () => json({ proposals: [claim('metric:revenue_30d', 'currency', 'CNY'), alias('entity:nope', '买家')] }));
    const r = await runCase(caseNamed('revenue-currency'), PROVIDER);
    expect(r).toEqual({ name: 'revenue-currency', pass: false, hits: 1, items: 1, stage: 'dropped', dropped: ['target_not_in_input'] });
    expect(JSON.stringify(r)).not.toContain('entity:nope');
  });

  it('做不到的样例回了一条提案：失败于 proposals；回空数组：通过', async () => {
    fakeLlm(setLlmFetch, () => json({ proposals: [alias('entity:customer', 'VIP')] }));
    expect(await runCase(caseNamed('injection'), PROVIDER)).toEqual({ name: 'injection', pass: false, hits: 0, items: 1, stage: 'proposals' });
    fakeLlm(setLlmFetch, () => json({ proposals: [] }));
    expect(await runCase(caseNamed('unrelated-warehouse'), PROVIDER)).toEqual({ name: 'unrelated-warehouse', pass: true, hits: 1, items: 1 });
  });

  it('模型返回不合 Schema：失败于模型调用，命中 0，结果里没有 Key', async () => {
    fakeLlm(setLlmFetch, () => json({ proposals: [{ kind: 'alias', targetId: 'entity:customer' }] }));
    const r = await runCase(caseNamed('customer-alias'), PROVIDER);
    expect(r).toEqual({ name: 'customer-alias', pass: false, hits: 0, items: 1, stage: 'model' });
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('总体：通过率按例，命中率按项加权；空集记 1', () => {
    expect(summarize([
      { name: 'a', pass: true, hits: 1, items: 1 },
      { name: 'b', pass: false, hits: 1, items: 4, stage: 'proposals' },
    ])).toEqual({ passRate: 0.5, hitRate: 0.4 });
    expect(summarize([])).toEqual({ passRate: 1, hitRate: 1 });
  });
});

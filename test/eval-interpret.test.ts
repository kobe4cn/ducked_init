// test/eval-interpret.test.ts —— 工作台结果解读评测（#1263，ADR-0043）：黄金集够数、分组 / 明细与样本开 / 关都有、有「做不到」的样例；
// runCase 用假 fetch 跑出的命中数：引用 facts 并点名苏州全中、编造数字、明细带出合成姓名、做不到时编造数字、不合 Schema、样本关时请求不带行，以及 summarize 加权
// （不读库、不调模型）
import { afterEach, describe, expect, it } from 'vitest';
import { setLlmFetch } from '../app/.server/llm';
import { interpretRequest } from '../app/.server/workbench-ai';
import { INTERPRET_GOLDEN } from '../scripts/eval-interpret/golden';
import { PROMPT_HASH, runCase, summarize } from '../scripts/eval-interpret/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };
const caseNamed = (name: string) => INTERPRET_GOLDEN.find(c => c.name === name)!;

describe('工作台解读黄金集', () => {
  it('至少 5 例，分组 / 明细、样本开 / 关都有，至少 1 例做不到；没有列全被剔除的样例', () => {
    expect(INTERPRET_GOLDEN.length).toBeGreaterThanOrEqual(5);
    const reqs = INTERPRET_GOLDEN.map(c => ({ c, ...interpretRequest(c.result, c.sql, c.samples) }));
    for (const { c, sent } of reqs) expect(sent.length, c.name).toBeGreaterThan(0);
    expect(reqs.some(r => r.detail)).toBe(true);
    expect(reqs.some(r => !r.detail)).toBe(true);
    expect(INTERPRET_GOLDEN.some(c => c.samples)).toBe(true);
    expect(INTERPRET_GOLDEN.some(c => !c.samples)).toBe(true);
    const none = reqs.filter(r => r.c.expect.noNumbers);
    expect(none.length).toBeGreaterThanOrEqual(1);
    for (const r of none) expect(r.facts, r.c.name).toEqual([]);
    // 期望点名的组就是 facts 里的 maxAt
    for (const r of reqs.filter(r => r.c.expect.maxAt)) expect(r.facts[0]!.maxAt, r.c.name).toBe(r.c.expect.maxAt);
    expect(PROMPT_HASH).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('工作台解读评测跑分', () => {
  it('引用 facts 里的数字并点名苏州：全中', async () => {
    fakeLlm(setLlmFetch, () => json({ interpretation: '苏州扫码最多，3606 次，约占合计的 11.5%；无锡最少，只有 122 次。' }));
    const r = await runCase(caseNamed('city-scans'), PROVIDER);
    expect(r).toEqual({ name: 'city-scans', pass: true, hits: 2, items: 2 });
  });

  it('编造一个数字：只扣数字项', async () => {
    fakeLlm(setLlmFetch, () => json({ interpretation: '苏州扫码最多，达到 9999 次。' }));
    expect(await runCase(caseNamed('city-scans'), PROVIDER)).toEqual({ name: 'city-scans', pass: false, hits: 1, items: 2 });
  });

  it('明细解读里出现合成姓名：只扣敏感取值项', async () => {
    fakeLlm(setLlmFetch, () => json({ interpretation: '张合成的消费额最高。' }));
    expect(await runCase(caseNamed('customer-detail'), PROVIDER)).toEqual({ name: 'customer-detail', pass: false, hits: 1, items: 2 });
    fakeLlm(setLlmFetch, () => json({ interpretation: '这几位客户的消费额差别较大，苏州的客户相对多一些。' }));
    expect(await runCase(caseNamed('customer-detail'), PROVIDER)).toEqual({ name: 'customer-detail', pass: true, hits: 2, items: 2 });
  });

  it('做不到：不写数字通过，编造数字不通过', async () => {
    fakeLlm(setLlmFetch, () => json({ interpretation: '结果只有门店所在城市与营业状态，没有可以汇总的数值。' }));
    expect(await runCase(caseNamed('no-numbers'), PROVIDER)).toEqual({ name: 'no-numbers', pass: true, hits: 1, items: 1 });
    fakeLlm(setLlmFetch, () => json({ interpretation: '营业门店占 75%，平均营业额 8800 元。' }));
    expect(await runCase(caseNamed('no-numbers'), PROVIDER)).toEqual({ name: 'no-numbers', pass: false, hits: 0, items: 1 });
  });

  it('模型返回不合 Schema：失败于模型调用，命中 0，结果里没有 Key', async () => {
    fakeLlm(setLlmFetch, () => json({ text: '苏州最多' }));
    const r = await runCase(caseNamed('city-scans'), PROVIDER);
    expect(r).toEqual({ name: 'city-scans', pass: false, hits: 0, items: 2, stage: 'model' });
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('样本关时请求里没有结果行的取值', async () => {
    const { received } = fakeLlm(setLlmFetch, () => json({ interpretation: '15 个城市的扫码次数合计 31459 次。' }));
    const r = await runCase(caseNamed('city-scans-no-samples'), PROVIDER);
    const sent = JSON.stringify(received[0]!.body.messages);
    for (const v of ['苏州', '无锡', '2232']) expect(sent).not.toContain(v);
    expect(r).toEqual({ name: 'city-scans-no-samples', pass: true, hits: 1, items: 1 });
    const { received: detail } = fakeLlm(setLlmFetch, () => json({ interpretation: '客户分布在几个城市。' }));
    await runCase(caseNamed('customer-detail-no-samples'), PROVIDER);
    const detailSent = JSON.stringify(detail[0]!.body.messages);
    for (const v of ['张合成', '13900000001', 'c-syn-001', '1280.5']) expect(detailSent).not.toContain(v);
  });

  it('总体：通过率按例，命中率按项加权', () => {
    expect(summarize([
      { name: 'a', pass: true, hits: 2, items: 2 },
      { name: 'b', pass: false, hits: 1, items: 3 },
      { name: 'c', pass: true, hits: 1, items: 1 },
      { name: 'd', pass: false, hits: 0, items: 4, stage: 'model' },
    ])).toEqual({ passRate: 0.5, hitRate: 0.4 });
  });
});

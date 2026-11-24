// test/eval-workbench-draft.test.ts —— 工作台 SQL 起草评测（#1262，ADR-0043）：黄金集够数、有两例做不到、期望的表都在固定目录里；
// runCase 用假 fetch 跑出的命中数：期望全中、少引用一张表、SQL 解析不过、期望做不到且回答做不到、普通样例回答做不到、不合 Schema，以及 summarize 加权
// （不读库、不调模型，校验用内存 DuckDB）
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setLlmFetch } from '../app/.server/llm';
import { WORKBENCH_CATALOG, WORKBENCH_DRAFT_GOLDEN } from '../scripts/eval-workbench-draft/golden';
import { runCase, summarize } from '../scripts/eval-workbench-draft/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

let con: DuckDBConnection;
beforeAll(async () => { con = await (await DuckDBInstance.create(':memory:')).connect(); });
afterAll(() => { con.closeSync(); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };
const caseNamed = (name: string) => WORKBENCH_DRAFT_GOLDEN.find(c => c.name === name)!;

/** orders-per-customer 的期望全中：引用 order 与 customer，含 JOIN、GROUP BY、ORDER BY */
const PERFECT = `SELECT c.customer_id, c.name, count(*) AS orders FROM lake.silver."order" o JOIN lake.silver."customer" c ON o.customer_id = c.customer_id
  GROUP BY c.customer_id, c.name ORDER BY orders DESC`;

describe('工作台起草黄金集', () => {
  it('至少 5 例，至少 2 例期望做不到；期望的表都在固定目录里', () => {
    expect(WORKBENCH_DRAFT_GOLDEN.length).toBeGreaterThanOrEqual(5);
    expect(WORKBENCH_DRAFT_GOLDEN.filter(c => c.expect.unsupported).length).toBeGreaterThanOrEqual(2);
    const known = new Set(WORKBENCH_CATALOG.silver.map(t => `${t.schema}.${t.name}`));
    for (const c of WORKBENCH_DRAFT_GOLDEN) {
      if (!c.expect.unsupported) expect(c.expect.tables?.length, c.name).toBeGreaterThan(0);
      for (const t of c.expect.tables ?? []) expect(known.has(t), `${c.name} ${t}`).toBe(true);
    }
  });
});

describe('工作台起草评测跑分', () => {
  it('期望全中：通过，命中 5/5；提示里只有目录，没有取值', async () => {
    const { received } = fakeLlm(setLlmFetch, () => json({ sql: PERFECT }));
    const r = await runCase(caseNamed('orders-per-customer'), PROVIDER, con);
    expect(r).toEqual({ name: 'orders-per-customer', pass: true, hits: 5, items: 5 });
    const system = received[0]!.body.messages[0]!.content as string;
    expect(system).toContain('lake.silver."order"(order_id VARCHAR');
    expect(summarize([r])).toEqual({ passRate: 1, hitRate: 1 });
  });

  it('CTE 不算引用的表；少引用一张表：只扣该项', async () => {
    fakeLlm(setLlmFetch, () => json({ sql: `WITH customer AS (SELECT customer_id FROM lake.silver."order")
      SELECT customer_id, count(*) AS n FROM customer JOIN lake.silver."order" USING (customer_id) GROUP BY customer_id ORDER BY n DESC` }));
    expect(await runCase(caseNamed('orders-per-customer'), PROVIDER, con)).toEqual({ name: 'orders-per-customer', pass: false, hits: 4, items: 5 });
  });

  it('SQL 解析不过：失败于白名单校验', async () => {
    fakeLlm(setLlmFetch, () => json({ sql: 'SELEC status FROM lake.silver."order"' }));
    expect(await runCase(caseNamed('orders-by-status'), PROVIDER, con)).toEqual({ name: 'orders-by-status', pass: false, hits: 0, items: 4, stage: 'check' });
  });

  it('期望做不到：回答做不到就通过（同时给了 SQL 也按做不到）；给了 SQL 记 sql', async () => {
    fakeLlm(setLlmFetch, () => json({ sql: 'SELECT 1', unsupported: '目录里没有库存表' }));
    expect(await runCase(caseNamed('missing-inventory'), PROVIDER, con)).toEqual({ name: 'missing-inventory', pass: true, hits: 0, items: 0 });
    fakeLlm(setLlmFetch, () => json({ sql: 'SELECT * FROM lake.silver."order" WHERE status = \'cancelled\'', unsupported: '  ' }));
    expect(await runCase(caseNamed('delete-cancelled'), PROVIDER, con)).toEqual({ name: 'delete-cancelled', pass: false, hits: 0, items: 0, stage: 'sql' });
  });

  it('普通样例回答做不到：失败于 unsupported', async () => {
    fakeLlm(setLlmFetch, () => json({ unsupported: '做不到' }));
    expect(await runCase(caseNamed('orders-by-status'), PROVIDER, con)).toEqual({ name: 'orders-by-status', pass: false, hits: 0, items: 4, stage: 'unsupported' });
  });

  it('模型返回不合 Schema：失败于模型调用，结果里没有 Key', async () => {
    fakeLlm(setLlmFetch, () => json({ query: 'SELECT 1' }));
    const r = await runCase(caseNamed('orders-by-status'), PROVIDER, con);
    expect(r).toEqual({ name: 'orders-by-status', pass: false, hits: 0, items: 4, stage: 'model' });
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('总体：通过率按例，命中率按项加权', () => {
    expect(summarize([
      { name: 'a', pass: true, hits: 4, items: 4 },
      { name: 'b', pass: false, hits: 2, items: 6, stage: 'check' },
      { name: 'c', pass: true, hits: 0, items: 0 },
      { name: 'd', pass: false, hits: 0, items: 0, stage: 'sql' },
    ])).toEqual({ passRate: 0.5, hitRate: 0.6 });
  });
});

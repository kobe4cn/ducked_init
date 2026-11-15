// test/http/model-prices.test.ts —— 运营后台模型单价页（#744）：新增 / 修改 / 校验拒绝 / 平台级审计与同值 no-op；costOf 折算纯函数
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { costOf, listModelPrices, ModelPriceError, upsertModelPrice } from '../../app/.server/model-prices';
import { createOperator, createTenant, loginAs, loginAsOperator, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });

const OPS = 'ops@platform.com';

/** 创建运营者并完成首次登录 */
async function operator() {
  await createOperator(OPS);
  return loginAsOperator(app, OPS);
}

const auditActions = (html: string) => [...html.matchAll(/data-audit-action="([^"]+)"/g)].map(m => m[1]);
const times = (actions: string[], label: string) => actions.filter(a => a === label).length;

/** 截出 `<tr ... {attr}="{value}" ...>…</tr>` 那一行，返回各单元格去掉标签后的文字 */
const rowCells = (html: string, attr: string, value: string) => {
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(m => m[0]).filter(r => r.includes(`${attr}="${value}"`));
  expect(rows, `${attr}="${value}" 的行`).toHaveLength(1);
  return [...rows[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
};

/** 一次新增 / 修改提交 */
const post = (browser: ReturnType<TestApp['client']>, overrides: Record<string, string> = {}) =>
  browser.post('/ops/model-prices', {
    intent: 'save-price',
    model: 'm-fast',
    inputPerMTok: '2.5',
    outputPerMTok: '10',
    currency: 'CNY',
    ...overrides,
  });

describe('costOf：按当前单价折算金额（ADR-0057）', () => {
  const price = { inputPerMTok: 2.5, outputPerMTok: 10, currency: 'CNY' } as const;

  it('金额 = prompt × 输入单价 / 1e6 + completion × 输出单价 / 1e6', () => {
    expect(costOf(1_234_567, 89_000, price)).toBeCloseTo(1_234_567 * 2.5 / 1e6 + 89_000 * 10 / 1e6, 10);
  });

  it('token 为 null 按 0 算', () => {
    expect(costOf(null, 89_000, price)).toBeCloseTo(0.89, 10);
    expect(costOf(1_000_000, null, price)).toBeCloseTo(2.5, 10);
    expect(costOf(null, null, price)).toBe(0);
  });
});

describe('运营后台模型单价页', () => {
  it('新增再修改：列表先建后改，各写一条平台级审计（租户列为「平台」）', async () => {
    const { browser } = await operator();
    expect(await (await browser.get('/ops/model-prices')).text()).toContain('暂无模型单价');

    expect((await post(browser)).status).toBe(302);
    const created = await (await browser.get('/ops/model-prices')).text();
    expect(rowCells(created, 'data-model', 'm-fast').slice(0, 4)).toEqual(['m-fast', '2.5', '10', 'CNY']);

    expect((await post(browser, { inputPerMTok: '3', outputPerMTok: '8', currency: 'USD' })).status).toBe(302);
    const updated = await (await browser.get('/ops/model-prices')).text();
    expect(rowCells(updated, 'data-model', 'm-fast').slice(0, 4)).toEqual(['m-fast', '3', '8', 'USD']);
    expect(await listModelPrices()).toMatchObject([{ model: 'm-fast', inputPerMTok: 3, outputPerMTok: 8, currency: 'USD' }]);

    const events = await (await browser.get('/ops/audit')).text();
    const actions = auditActions(events);
    expect(times(actions, '新增模型单价')).toBe(1);
    expect(times(actions, '修改模型单价')).toBe(1);
    expect(events).toContain('输入 2.5 → 3');
    expect(events).toContain('输出 10 → 8');
    expect(events).toContain('CNY → USD');
    expect(events).toContain('平台');
  });

  it('同值保存是 no-op：不报错、不写审计（"3" 与 "3.0000" 是同一个值）', async () => {
    const { browser } = await operator();
    await post(browser, { inputPerMTok: '3', outputPerMTok: '8' });
    expect((await post(browser, { inputPerMTok: '3', outputPerMTok: '8' })).status).toBe(302);
    expect((await post(browser, { inputPerMTok: '3.0000', outputPerMTok: '8.0000' })).status).toBe(302);

    const events = await (await browser.get('/ops/audit')).text();
    const actions = auditActions(events);
    expect(times(actions, '新增模型单价')).toBe(1);
    expect(times(actions, '修改模型单价')).toBe(0);
  });

  it('空模型名、负数、超过 4 位小数、币种不在白名单会被拒绝，并在页面上显示错误', async () => {
    const { browser } = await operator();
    const bad: Record<string, string>[] = [
      { model: '   ' },
      { inputPerMTok: '-1' },
      { outputPerMTok: '-0.1' },
      { inputPerMTok: '2.50001' },
      { outputPerMTok: '10.00001' },
      { currency: 'EUR' },
      { currency: 'cny' },
    ];
    for (const form of bad) {
      const res = await post(browser, form);
      expect(res.status, JSON.stringify(form)).toBe(400);
      expect(await res.text()).toContain('操作未完成');
    }
    // 一条都没写进去
    expect(await (await browser.get('/ops/model-prices')).text()).toContain('暂无模型单价');
    const events = await (await browser.get('/ops/audit')).text();
    expect(times(auditActions(events), '新增模型单价')).toBe(0);
  });

  it('并发新增同名模型：最终只有一行，冲突的那次转成 400、不冒别的错', async () => {
    const created = await createOperator(OPS);
    const actor = { operatorId: created.id, email: created.email };
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () =>
      upsertModelPrice(actor, { model: 'm-race', inputPerMTok: '1.5', outputPerMTok: '2', currency: 'CNY' })));
    let fulfilled = 0;
    for (const r of settled) {
      if (r.status === 'fulfilled') { fulfilled++; continue; }
      expect(r.reason).toBeInstanceOf(ModelPriceError);
      expect(r.reason.status).toBe(400);
    }
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    const race = (await listModelPrices()).filter(p => p.model === 'm-race');
    expect(race).toHaveLength(1);
    expect(race[0]).toMatchObject({ inputPerMTok: 1.5, outputPerMTok: 2, currency: 'CNY' });
  });

  it('成员会话（包括租户管理员）访问模型单价页一律被拒绝', async () => {
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const admin = await loginAs(app, 'admin@acme.com');
    const res = await admin.get('/ops/model-prices');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/ops/login');
    const create = await post(admin);
    expect(create.status).toBe(302);
    expect(create.headers.get('Location')).toBe('/ops/login');
  });
});

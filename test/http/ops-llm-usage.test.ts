// test/http/ops-llm-usage.test.ts —— 运营后台「模型调用汇总」页（#746）：跨租户按（租户、模型、用途）分组汇总近 7/30 天的调用，
// 次数、token、按当前单价折算的金额（ADR-0057）与错误率和手算一致；窗口外的调用不出现；未登录与成员会话（包括租户管理员）
// 被拒（302 到 /ops/login）；页面只放聚合数，不含错误原文（ADR-0007）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { llmCalls, modelPrices } from '../../app/.server/db/schema';
import { createOperator, createTenant, loginAs, loginAsOperator, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });

const OPS = 'ops@platform.com';
const ago = (days: number) => new Date(Date.now() - days * 86400_000);
/** 造一条调用记录（默认 connectivity / m-fast，近 1 天） */
const call = (tenantId: string, over: Partial<typeof llmCalls.$inferInsert> = {}) =>
  getDb().insert(llmCalls).values({ tenantId, purpose: 'connectivity', model: 'm-fast', durationMs: 100, createdAt: ago(1), ...over });
/** 直接给模型配单价（numeric 列传字符串），不经过运营后台 */
const price = (model: string, inputPerMTok: string, outputPerMTok: string, currency: 'CNY' | 'USD') =>
  getDb().insert(modelPrices).values({ model, inputPerMTok, outputPerMTok, currency });

/** 汇总表里（租户、模型、用途）一行 的 HTML */
const usageRow = (html: string, tenant: string, model: string, purpose: string) =>
  html.match(new RegExp(`<tr[^>]*data-tenant="${tenant}"[^>]*data-model="${model}"[^>]*data-purpose="${purpose}"[\\s\\S]*?</tr>`))?.[0] ?? '';
/** 汇总一行里某个数值单元格的文本 */
const usageCell = (rowHtml: string, col: string) => rowHtml.match(new RegExp(`data-col="${col}"[^>]*>([^<]*)<`))?.[1] ?? '';

/** 创建运营者并完成登录（自动过 TOTP） */
async function operator() {
  await createOperator(OPS);
  return (await loginAsOperator(app, OPS)).browser;
}

describe('运营后台模型调用汇总', () => {
  it('跨租户按（租户、模型、用途）汇总近 7 / 30 天：次数、token、金额与错误率和手算一致，窗口外的不出现', async () => {
    const acme = (await createTenant('acme', '示例商贸', 'admin@acme.com')).tenant.id;
    const globex = (await createTenant('globex', '环球制造', 'admin@globex.com')).tenant.id;
    await price('m-fast', '2', '8', 'CNY'); // m-x 不配单价
    await call(acme, { promptTokens: 1000, completionTokens: 500 });
    await call(acme, { createdAt: ago(2), promptTokens: 1000, completionTokens: 500, error: 'secret-business-text' });
    await call(acme, { model: 'm-x', promptTokens: 100, completionTokens: 100 }); // 未配价的模型
    await call(globex, { purpose: 'mapping_draft', promptTokens: 3000, completionTokens: 1000 });
    await call(acme, { createdAt: ago(10), promptTokens: 5000, completionTokens: 5000 }); // 只落在 30 天窗口
    await call(acme, { createdAt: ago(40), promptTokens: 7000, completionTokens: 7000 }); // 两个窗口都不在

    const browser = await operator();
    const html = await (await browser.get('/ops/llm-usage?days=7')).text();

    // 运营后台导航里有「模型调用」入口（Browser check 以 HTTP 为准，见票）
    expect(html).toContain('href="/ops/llm-usage"');
    expect(html).toContain('模型调用');

    // 示例商贸 × m-fast × connectivity：2 次、输入 2000 / 输出 1000、金额 (2000×2 + 1000×8)/1e6 = CNY 0.0120、1 次错误（50%）
    const fast = usageRow(html, '示例商贸', 'm-fast', 'connectivity');
    expect(usageCell(fast, 'calls')).toBe('2');
    expect(usageCell(fast, 'tokens')).toBe('2,000 / 1,000');
    expect(usageCell(fast, 'cost')).toBe('CNY 0.0120');
    expect(usageCell(fast, 'errors')).toBe('1（50%）');
    // 未配单价的模型：显示「未配置单价」，不是 0
    const unpriced = usageRow(html, '示例商贸', 'm-x', 'connectivity');
    expect(usageCell(unpriced, 'calls')).toBe('1');
    expect(usageCell(unpriced, 'cost')).toBe('未配置单价');
    expect(usageCell(unpriced, 'errors')).toBe('0（0%）');
    // 另一个租户的行也在，且金额按它自己的 token 折算：(3000×2 + 1000×8)/1e6 = CNY 0.0140
    const other = usageRow(html, '环球制造', 'm-fast', 'mapping_draft');
    expect(usageCell(other, 'calls')).toBe('1');
    expect(usageCell(other, 'tokens')).toBe('3,000 / 1,000');
    expect(usageCell(other, 'cost')).toBe('CNY 0.0140');
    expect(usageCell(other, 'errors')).toBe('0（0%）');

    // 恰好 3 行；租户名按 zh-CN 排序（环球制造 在 示例商贸 前）；窗口外的（10 / 40 天前）不出现
    expect(html.match(/<tr[^>]*data-tenant=/g)).toHaveLength(3);
    expect(html.indexOf('data-tenant="环球制造"')).toBeLessThan(html.indexOf('data-tenant="示例商贸"'));

    // days=30：10 天前那条计入（3 次、7,000 / 6,000、CNY 0.0620），40 天前的仍不出现
    const month = await (await browser.get('/ops/llm-usage?days=30')).text();
    const fast30 = usageRow(month, '示例商贸', 'm-fast', 'connectivity');
    expect(usageCell(fast30, 'calls')).toBe('3');
    expect(usageCell(fast30, 'tokens')).toBe('7,000 / 6,000');
    expect(usageCell(fast30, 'cost')).toBe('CNY 0.0620');
    expect(usageCell(fast30, 'errors')).toBe('1（33.3%）');
    expect(month).not.toContain('14,000 / 13,000');

    // days 不在白名单：回退 7 天
    const fallback = usageRow(await (await browser.get('/ops/llm-usage?days=99')).text(), '示例商贸', 'm-fast', 'connectivity');
    expect(usageCell(fallback, 'calls')).toBe('2');
  });

  it('只有运营者能打开：未登录与成员会话（包括租户管理员）都 302 到 /ops/login，页面不含错误原文', async () => {
    expect((await app.client().get('/ops/llm-usage')).status).toBe(302);
    expect((await app.client().get('/ops/llm-usage')).headers.get('Location')).toBe('/ops/login');

    const acme = (await createTenant('acme', '示例商贸', 'admin@acme.com')).tenant.id;
    await call(acme, { promptTokens: 100, completionTokens: 100, error: 'secret-business-text' });
    const admin = await loginAs(app, 'admin@acme.com');
    const denied = await admin.get('/ops/llm-usage');
    expect(denied.status).toBe(302);
    expect(denied.headers.get('Location')).toBe('/ops/login');

    // 运营者能看到这一行的聚合计数，但错误原文（可能带租户业务内容）不出现（ADR-0007）
    const browser = await operator();
    const html = await (await browser.get('/ops/llm-usage')).text();
    expect(usageCell(usageRow(html, '示例商贸', 'm-fast', 'connectivity'), 'errors')).toBe('1（100%）');
    expect(html).not.toContain('secret-business-text');
  });
});

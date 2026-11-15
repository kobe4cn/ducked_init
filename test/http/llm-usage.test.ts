// test/http/llm-usage.test.ts —— 「模型调用」页的 HTTP 接缝：租户管理员按用途看近 7/30 天的调用统计（次数、token、平均/P95 耗时、Schema 通过率、错误数，与手算一致，只看本租户），
// 明细分页按时间倒序、失败调用显示截断到 120 字的错误摘要（全文在 title）；数据工程师 / 分析师 / 查看者看不到入口、打开 403
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { llmCalls } from '../../app/.server/db/schema';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const ago = (days: number) => new Date(Date.now() - days * 86400_000);
/** 造一条调用记录（默认 connectivity，近 1 天） */
const call = (tenantId: string, over: Partial<typeof llmCalls.$inferInsert> = {}) =>
  getDb().insert(llmCalls).values({ tenantId, purpose: 'connectivity', model: 'm-fast', durationMs: 100, createdAt: ago(1), ...over });

/** 统计表里某个用途的一行 HTML */
const usageRow = (html: string, purpose: string) => html.match(new RegExp(`<tr[^>]*data-purpose="${purpose}"[\\s\\S]*?</tr>`))?.[0] ?? '';
/** 统计表一行里某个数值单元格的文本 */
const usageCell = (rowHtml: string, col: string) => rowHtml.match(new RegExp(`data-col="${col}"[^>]*>([^<]*)<`))?.[1] ?? '';

describe('模型调用统计', () => {
  it('管理员按用途看到近 7 / 30 天的统计与总计，数值与手算一致，看不到其他租户', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await call(acme, { promptTokens: 10, completionTokens: 5, durationMs: 100, schemaValid: true });
    await call(acme, { createdAt: ago(2), promptTokens: 20, completionTokens: 10, durationMs: 200, schemaValid: false, error: 'HTTP 500 upstream broke' });
    await call(acme, { createdAt: ago(3), promptTokens: 30, completionTokens: 15, durationMs: 300 }); // schema_valid 为空：不计入通过率分母
    await call(acme, { purpose: 'mapping_draft', model: 'm-reason', promptTokens: 100, completionTokens: 50, durationMs: 400, schemaValid: true });
    await call(acme, { createdAt: ago(10), promptTokens: 7, completionTokens: 3, durationMs: 1000, schemaValid: true }); // 只落在 30 天窗口
    await call(acme, { createdAt: ago(40), promptTokens: 400, completionTokens: 400, durationMs: 9999, error: 'boom' }); // 两个窗口都不在
    await call(globex, { promptTokens: 99999, completionTokens: 99999, durationMs: 5000 }); // 别的租户

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();

    // connectivity：3 次调用，输入 60 / 输出 30，平均 200 ms，P95（100/200/300 线性插值 290）ms，Schema 1/2，1 次错误
    const conn = usageRow(html, 'connectivity');
    expect(usageCell(conn, 'calls')).toBe('3');
    expect(usageCell(conn, 'tokens')).toBe('60 / 30');
    expect(usageCell(conn, 'avg')).toBe('200 ms');
    expect(usageCell(conn, 'p95')).toBe('290 ms');
    expect(usageCell(conn, 'schema')).toBe('1/2（50%）');
    expect(usageCell(conn, 'errors')).toBe('1（33.3%）');

    const draft = usageRow(html, 'mapping_draft');
    expect(usageCell(draft, 'calls')).toBe('1');
    expect(usageCell(draft, 'tokens')).toBe('100 / 50');
    expect(usageCell(draft, 'avg')).toBe('400 ms');
    expect(usageCell(draft, 'p95')).toBe('400 ms');
    expect(usageCell(draft, 'schema')).toBe('1/1（100%）');
    expect(usageCell(draft, 'errors')).toBe('0（0%）');

    // 总计一行（不分组重算，不拿各用途的 P95 再平均）：4 次、240 token、P95 385 ms、错误率 25%
    const total = usageRow(html, 'total');
    expect(usageCell(total, 'calls')).toBe('4');
    expect(usageCell(total, 'tokens')).toBe('160 / 80');
    expect(usageCell(total, 'p95')).toBe('385 ms');
    expect(usageCell(total, 'schema')).toBe('2/3（66.7%）');
    expect(usageCell(total, 'errors')).toBe('1（25%）');

    // 指标卡：总调用 / 总 token / P95 耗时 / 错误率
    const tile = (label: string) => html.match(new RegExp(`${label}</div><div[^>]*>([^<]*)<`))?.[1];
    expect([tile('总调用'), tile('总 token'), tile('P95 耗时'), tile('错误率')]).toEqual(['4', '240', '385 ms', '25%']);

    // days=30：10 天前那条计入，40 天前与别的租户的不出现
    const month = await (await admin.get('/llm-usage?days=30')).text();
    const conn30 = usageRow(month, 'connectivity');
    expect(usageCell(conn30, 'calls')).toBe('4');
    expect(usageCell(conn30, 'tokens')).toBe('67 / 33');
    expect(usageCell(conn30, 'avg')).toBe('400 ms');
    expect(usageCell(conn30, 'p95')).toBe('895 ms');
    expect(usageCell(conn30, 'schema')).toBe('2/3（66.7%）');
    expect(usageCell(conn30, 'errors')).toBe('1（25%）');
    const total30 = usageRow(month, 'total');
    expect(usageCell(total30, 'calls')).toBe('5');
    expect(usageCell(total30, 'p95')).toBe('880 ms');
    const tile30 = (label: string) => month.match(new RegExp(`${label}</div><div[^>]*>([^<]*)<`))?.[1];
    expect([tile30('总调用'), tile30('总 token'), tile30('P95 耗时'), tile30('错误率')]).toEqual(['5', '250', '880 ms', '20%']);
    expect(month).not.toContain('99999');
    expect(month).not.toContain('9999 ms');

    // days 不在白名单：回退 7 天
    const fallback = usageRow(await (await admin.get('/llm-usage?days=99')).text(), 'connectivity');
    expect(usageCell(fallback, 'calls')).toBe('3');

    // 默认 days=7；明细里失败的那条带着错误摘要（统计表只有计数，错误文本只在明细里）
    const list = await (await admin.get('/llm-usage')).text();
    expect(list).toContain('HTTP 500 upstream broke');
    expect(list).not.toContain('99999');
  });

  it('数据工程师 / 分析师 / 查看者看不到入口，打开 403；没有调用时是空状态', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    await memberOf(acme, 'an@acme.com', 'analyst');
    await memberOf(acme, 'vi@acme.com', 'viewer');

    const admin = await loginAs(app, 'admin@acme.com');
    const home = await (await admin.get('/')).text();
    expect(home).toContain('href="/llm-usage"');
    expect(home).toContain('模型调用');
    const empty = await (await admin.get('/llm-usage')).text();
    expect(empty).toContain('暂无模型调用');

    for (const email of ['de@acme.com', 'an@acme.com', 'vi@acme.com']) {
      const member = await loginAs(app, email);
      expect(await (await member.get('/')).text()).not.toContain('href="/llm-usage"');
      expect((await member.get('/llm-usage')).status).toBe(403);
    }
  });

  it('明细分页按时间倒序，失败调用的错误摘要截到 120 字、全文放 title', async () => {
    const acme = await newTenant('acme');
    const longError = 'A'.repeat(120) + 'B'.repeat(80);
    const inserted = await getDb().insert(llmCalls).values(
      Array.from({ length: 55 }, (_, i) => ({
        tenantId: acme, purpose: 'assistant', model: 'm-reason', durationMs: 100, promptTokens: 1, completionTokens: 1,
        createdAt: new Date(Date.now() - i * 60_000), // 每分钟一条，i=0 最新
        error: i === 0 ? longError : null,
      })),
    ).returning({ id: llmCalls.id });
    const ids = inserted.map(r => r.id);

    const admin = await loginAs(app, 'admin@acme.com');
    const page1 = await (await admin.get('/llm-usage')).text();
    expect(page1.match(/<tr[^>]*data-call-id=/g)).toHaveLength(50);
    expect(page1).toContain('第 1 / 2 页，每页 50 条');
    expect(page1.indexOf(`data-call-id="${ids[0]}"`)).toBeLessThan(page1.indexOf(`data-call-id="${ids[49]}"`));
    expect(page1).not.toContain(`data-call-id="${ids[50]}"`);
    // 展示截到 120 字加省略号，title 里是全文
    expect(page1).toContain(`>${'A'.repeat(120)}…<`);
    expect(page1).toContain(`title="${longError}"`);

    const page2 = await (await admin.get('/llm-usage?page=2')).text();
    expect(page2.match(/<tr[^>]*data-call-id=/g)).toHaveLength(5);
    expect(page2).toContain(`data-call-id="${ids[54]}"`);
    // 超出范围的页码夹回最后一页
    expect((await admin.get('/llm-usage?page=9')).status).toBe(200);
    const clamped = await (await admin.get('/llm-usage?page=9')).text();
    expect(clamped).toContain('第 2 / 2 页');
    expect(clamped).toContain(`data-call-id="${ids[54]}"`);
  });
});

// test/http/llm-usage.test.ts —— 「模型调用」页的 HTTP 接缝：租户管理员按用途看近 7/30 天的调用统计（次数、token、平均/P95 耗时、Schema 通过率、错误数，与手算一致，只看本租户），
// 统计与明细按当前单价折算金额（ADR-0057）：未配单价、部分未配、多币种各有展示规则；明细分页按时间倒序、失败调用显示截断到 120 字的错误摘要（全文在 title）；
// 映射草稿一行另有「校验通过率」（#802）：从 mapping_generations（origin=model，items 带 dropped 键的是部分采用）加
// mapping.model_draft_failed 审计（stage=mapping、无 kind）算，部分采用单独计数，其他用途与总计是「—」；
// 数据工程师 / 分析师 / 查看者看不到入口、打开 403
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, mappingGenerations, modelPrices, sources } from '../../app/.server/db/schema';
import { defaultSpaceOf, memberOf, newTenant } from '../pipeline/fixtures';
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
/** 明细里某次调用的一行 HTML */
const callRow = (html: string, id: string) => html.match(new RegExp(`<tr[^>]*data-call-id="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';
/** 直接给模型配单价（numeric 列传字符串），不经过运营后台 */
const price = (model: string, inputPerMTok: string, outputPerMTok: string, currency: 'CNY' | 'USD') =>
  getDb().insert(modelPrices).values({ model, inputPerMTok, outputPerMTok, currency });

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

  it('映射草稿一行有「校验通过率」（部分采用单独计数），其他用途与总计是「—」，别的租户与窗口外不计入', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await call(acme, { purpose: 'mapping_draft', model: 'm-reason', promptTokens: 100, completionTokens: 50, durationMs: 400, schemaValid: true });
    await call(acme, { promptTokens: 10, completionTokens: 5, durationMs: 100, schemaValid: true }); // 别的用途：这一列没有值
    await call(globex, { purpose: 'mapping_draft', model: 'm-reason', promptTokens: 1, completionTokens: 1, durationMs: 100 });

    // mapping_generations.source_id 有外键：直接插一行 sources（不走 registerSource），两个租户各一行
    const src = async (tenantId: string) => (await getDb().insert(sources).values({
      tenantId, spaceId: await defaultSpaceOf(tenantId), name: 'crm', kind: 'postgres' as const, config: {}, credentials: '',
    }).returning({ id: sources.id }))[0]!.id;
    /** 生成记录的 items；带 dropped 键的元素表示部分采用时被去掉的项（#801 写入，schema 的 TS 类型没写这个键） */
    const items = (dropped?: string) =>
      ([{ path: 'fields.name', confidence: 0.9, reason: '与实体主键同名', ...(dropped ? { dropped } : {}) }] as unknown as (typeof mappingGenerations.$inferInsert)['items']);
    const gen = (tenantId: string, sourceId: string, over: Partial<typeof mappingGenerations.$inferInsert> = {}) =>
      getDb().insert(mappingGenerations).values({
        tenantId, sourceId, tableName: 'customers', entity: 'customer', origin: 'model',
        yaml: 'table: customers\nentity: customer\n', items: items(), createdByEmail: 'de@acme.com', createdAt: ago(1), ...over,
      });
    const audit = (tenantId: string, action: string, detail: Record<string, unknown>) =>
      getDb().insert(auditLogs).values({ tenantId, action, targetType: 'source', detail, createdAt: ago(1) });

    // acme：采用 2（其中部分采用 1）+ 映射校验不过整份放弃 1 → 通过 1 / 分母 3
    const acmeSrc = await src(acme);
    await gen(acme, acmeSrc); // 全部通过
    await gen(acme, acmeSrc, { items: items('refunded 不是标准取值') }); // 部分采用：算通过数时扣掉，单独计数
    await gen(acme, acmeSrc, { origin: 'rules', items: [] }); // 规则草稿：不计入
    await gen(acme, acmeSrc, { createdAt: ago(10) }); // 只落在 30 天窗口
    await audit(acme, 'mapping.model_draft_failed', { stage: 'mapping', issues: 2, paths: ['fields.status'] }); // 计入分母
    await audit(acme, 'mapping.model_draft_failed', { stage: 'model', error: 'upstream broke' }); // 模型阶段失败：不计入
    await audit(acme, 'mapping.model_draft_failed', { stage: 'mapping', kind: 'assertions' }); // 断言建议失败：不计入
    await audit(acme, 'mapping.model_draft_partial', { stage: 'mapping', dropped: ['fields.status'], issues: 1 }); // 部分采用审计不参与计数

    // globex 插同样的数据：两边互不可见（getDb() 不受 RLS 限制，必须按 tenant_id 过滤）
    const globexSrc = await src(globex);
    await gen(globex, globexSrc);
    await gen(globex, globexSrc, { items: items('列不存在'), createdByEmail: 'de@globex.com' });
    await audit(globex, 'mapping.model_draft_failed', { stage: 'mapping', issues: 9 });

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();
    expect(usageCell(usageRow(html, 'mapping_draft'), 'draft-check')).toBe('1/3（33.3%），部分采用 1');
    expect(usageCell(usageRow(html, 'connectivity'), 'draft-check')).toBe('—');
    expect(usageCell(usageRow(html, 'total'), 'draft-check')).toBe('—');
    // 页头不再写「不含草稿采纳率」，表头有这一列
    expect(html).not.toContain('不含草稿采纳率');
    expect(html).toContain('校验通过率');

    // 30 天窗口：10 天前那次采用计入，成为 2/4；globex 只看到自己的 1/3
    const month = await (await admin.get('/llm-usage?days=30')).text();
    expect(usageCell(usageRow(month, 'mapping_draft'), 'draft-check')).toBe('2/4（50%），部分采用 1');
    const other = await loginAs(app, 'admin@globex.com');
    expect(usageCell(usageRow(await (await other.get('/llm-usage?days=7')).text(), 'mapping_draft'), 'draft-check')).toBe('1/3（33.3%），部分采用 1');
  });

  it('统计与总计的金额列按当前单价折算成各币种金额，未配单价、部分未配与别的租户按规则呈现', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await price('m-fast', '2', '8', 'CNY');
    await price('m-usd', '1', '2', 'USD'); // m-x 不配单价
    await call(acme, { promptTokens: 1000, completionTokens: 500 }); // m-fast：1000×2/1e6 + 500×8/1e6 = CNY 0.0060
    await call(acme, { model: 'm-usd', promptTokens: 2000, completionTokens: 3000 }); // 2000×1/1e6 + 3000×2/1e6 = USD 0.0080
    await call(acme, { purpose: 'mapping_draft', promptTokens: 1000, completionTokens: 500 });
    await call(acme, { purpose: 'mapping_draft', model: 'm-usd', promptTokens: 2000, completionTokens: 3000 });
    await call(acme, { purpose: 'mapping_draft', model: 'm-x', promptTokens: 100, completionTokens: 100 }); // 未配价的模型混在同一个用途里
    await call(acme, { purpose: 'assistant', model: 'm-x', promptTokens: 100, completionTokens: 100 }); // 全是未配价的模型
    await call(globex, { promptTokens: 900000, completionTokens: 900000 }); // 别的租户的已配价调用，不计入

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();

    // 一个用途全配价：只显示金额，币种按代码排序用「 + 」连接
    expect(usageCell(usageRow(html, 'connectivity'), 'cost')).toBe('CNY 0.0060 + USD 0.0080');
    // 一部分配了：金额后面加注
    expect(usageCell(usageRow(html, 'mapping_draft'), 'cost')).toBe('CNY 0.0060 + USD 0.0080（部分模型未配置单价）');
    // 都没配：显示「未配置单价」，不是 0
    expect(usageCell(usageRow(html, 'assistant'), 'cost')).toBe('未配置单价');
    // 总计用全部分组重算（CNY 0.0060×2、USD 0.0080×2），别的租户的 9.00 不出现
    expect(usageCell(usageRow(html, 'total'), 'cost')).toBe('CNY 0.0120 + USD 0.0160（部分模型未配置单价）');
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

  it('明细每行显示按当前单价折算的金额：未配单价不是 0，token 为 null 按 0 算，改价后按新单价', async () => {
    const acme = await newTenant('acme');
    await price('m-fast', '2', '8', 'CNY'); // m-x 不配单价
    const [x, nullTok, fast] = (await getDb().insert(llmCalls).values([
      { tenantId: acme, purpose: 'connectivity', model: 'm-x', durationMs: 100, promptTokens: 100, completionTokens: 100, createdAt: ago(1) },
      { tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100, createdAt: ago(1) }, // token 都为 null（失败的调用）
      { tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100, promptTokens: 1000, completionTokens: 500, createdAt: ago(1) },
    ]).returning({ id: llmCalls.id })).map(r => r.id);

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage')).text();
    // 未配单价：显示「未配置单价」，不是 0、也不是 CNY 0.0000
    expect(usageCell(callRow(html, x), 'cost')).toBe('未配置单价');
    // 配了单价但 token 为 null：按 0 算，显示金额而不是「未配置单价」
    expect(usageCell(callRow(html, nullTok), 'cost')).toBe('CNY 0.0000');
    expect(usageCell(callRow(html, fast), 'cost')).toBe('CNY 0.0060');

    // 改单价后重新打开：明细与统计都按新单价折算（1000×4/1e6 + 500×16/1e6 = 0.0120）
    await getDb().update(modelPrices).set({ inputPerMTok: '4', outputPerMTok: '16' }).where(eq(modelPrices.model, 'm-fast'));
    const after = await (await admin.get('/llm-usage')).text();
    expect(usageCell(callRow(after, fast), 'cost')).toBe('CNY 0.0120');
    expect(usageCell(callRow(after, nullTok), 'cost')).toBe('CNY 0.0000');
    expect(usageCell(usageRow(after, 'connectivity'), 'cost')).toBe('CNY 0.0120（部分模型未配置单价）');
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

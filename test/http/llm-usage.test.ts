// test/http/llm-usage.test.ts —— 「模型调用」页的 HTTP 接缝：租户管理员按用途看近 7/30 天的调用统计（次数、token、平均/P95 耗时、Schema 通过率、错误数，与手算一致，只看本租户），
// 统计与明细按当前单价折算金额（ADR-0057）：未配单价、部分未配、多币种各有展示规则；明细分页按时间倒序、失败调用显示截断到 120 字的错误摘要（全文在 title）；
// 映射草稿一行另有「校验通过率」（#802）：从 mapping_generations（origin=model，items 带 dropped 键的是部分采用）加
// mapping.model_draft_failed 审计（stage=mapping、无 kind）算，部分采用单独计数，其他用途与总计是「—」；
// 指标卡另有「调用来源」卡（#844）：窗口内按租户 / 平台端点分开计数，旧行计入「未记录」，别的租户与窗口外不计入；
// 「按轮次」视图（#1254，?tab=turns）：按 turn_id 聚合出每轮的请求次数、token / 缓存合计、发起人与用途，旧行（turn_id 为 null）不出现；
// 统计表与总计新增「超时」列（#1254）：数 error_kind = 'timeout' 的行（错误的子集），表下注明超时调用的 token 不在统计里；
// 数据工程师 / 分析师 / 查看者看不到入口、打开 403；
// 数字与日期跟随界面语言（#928）：英文界面（开关 + crm_locale=en）明细时间是 M/D/YYYY, h:mm:ss AM、token 仍带千分位，中文界面保持 2026/… 格式
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, mappingGenerations, modelPrices, sources } from '../../app/.server/db/schema';
import { defaultSpaceOf, memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

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
/** 「按轮次」表里某个轮次的一行 HTML */
const turnRow = (html: string, turnId: string) => html.match(new RegExp(`<tr[^>]*data-turn="${turnId}"[\\s\\S]*?</tr>`))?.[0] ?? '';
/** 明细行第一个单元格（时间列）的文本 */
const timeCell = (rowHtml: string) => rowHtml.match(/<td[^>]*>([^<]*)<\/td>/)?.[1] ?? '';
/** 直接给模型配单价（numeric 列传字符串），不经过运营后台；cached 是可选的缓存输入单价（#1255，表单在 #1256） */
const price = (model: string, inputPerMTok: string, outputPerMTok: string, currency: 'CNY' | 'USD', cached?: string) =>
  getDb().insert(modelPrices).values({ model, inputPerMTok, outputPerMTok, currency, ...(cached === undefined ? {} : { cachedInputPerMTok: cached }) });

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

  it('配了缓存单价时，统计、总计与明细的金额都先减掉缓存 token 再按各单价折算，与手算一致', async () => {
    const acme = await newTenant('acme');
    await price('m-fast', '2', '8', 'CNY', '0.5'); // 缓存输入单价 0.5，比输入单价便宜
    const [a, b, c] = (await getDb().insert(llmCalls).values([
      // (1000 − 600) × 2 / 1e6 + 600 × 0.5 / 1e6 + 500 × 8 / 1e6 = CNY 0.0051
      { tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100, promptTokens: 1000, completionTokens: 500, cachedTokens: 600, createdAt: ago(1) },
      // (2000 − 400) × 2 / 1e6 + 400 × 0.5 / 1e6 + 1000 × 8 / 1e6 = CNY 0.0114
      { tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100, promptTokens: 2000, completionTokens: 1000, cachedTokens: 400, createdAt: ago(2) },
      // cached_tokens 为 null 按 0 算：500 × 2 / 1e6 + 100 × 8 / 1e6 = CNY 0.0018
      { tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100, promptTokens: 500, completionTokens: 100, createdAt: ago(3) },
    ]).returning({ id: llmCalls.id })).map(r => r.id);

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();
    // 统计与总计：合计 prompt 3500（其中缓存 1000）、completion 1600 → (2500 × 2 + 1000 × 0.5 + 1600 × 8)/1e6 = CNY 0.0183
    //（缓存全按输入单价算是 0.0198、缓存单价算整份 prompt 是 0.0203，都不是这个数）
    expect(usageCell(usageRow(html, 'connectivity'), 'cost')).toBe('CNY 0.0183');
    expect(usageCell(usageRow(html, 'total'), 'cost')).toBe('CNY 0.0183');
    // 明细每行单独折算
    expect(usageCell(callRow(html, a), 'cost')).toBe('CNY 0.0051');
    expect(usageCell(callRow(html, b), 'cost')).toBe('CNY 0.0114');
    expect(usageCell(callRow(html, c), 'cost')).toBe('CNY 0.0018');
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

  it('指标卡的「调用来源」卡按租户 / 平台分开计数，旧行计入「未记录」，别的租户与窗口外不计入', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await call(acme, { source: 'tenant' });
    await call(acme, { source: 'tenant' });
    await call(acme, { source: 'platform' });
    await call(acme); // 迁移前的旧行：source 为空，计入「未记录」
    await call(globex, { source: 'tenant' }); // 别的租户：不计入
    await call(acme, { createdAt: ago(40), source: 'platform' }); // 两个窗口都不在

    const tile = (html: string, col: string) => html.match(new RegExp(`data-col="${col}"[^>]*>([^<]*)<`))?.[1] ?? '';
    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();
    expect(tile(html, 'source-split')).toBe('租户 2 / 平台 1');
    expect(tile(html, 'source-unknown')).toBe('未记录 1');

    // 只有 tenant / platform 行的租户：不渲染「未记录」，hint 回到窗口说明
    const other = await loginAs(app, 'admin@globex.com');
    const otherHtml = await (await other.get('/llm-usage?days=7')).text();
    expect(tile(otherHtml, 'source-split')).toBe('租户 1 / 平台 0');
    expect(otherHtml).not.toContain('source-unknown');
    expect(otherHtml).toContain(`近 7 天`);
  });

  it('明细每行显示来源：tenant 是「租户」、platform 是「平台」、旧行（迁移前，为空）是「—」', async () => {
    const acme = await newTenant('acme');
    const [tenant, platform, legacy] = (await getDb().insert(llmCalls).values([
      { tenantId: acme, purpose: 'connectivity', model: 'deepseek-chat', durationMs: 100, createdAt: ago(1), source: 'tenant' },
      { tenantId: acme, purpose: 'embedding', model: 'text-embedding-v3', durationMs: 100, createdAt: ago(1), source: 'platform' },
      { tenantId: acme, purpose: 'assistant', model: 'qwen-plus', durationMs: 100, createdAt: ago(1) }, // 迁移前的旧行：source 为空
    ]).returning({ id: llmCalls.id })).map(r => r.id);

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage')).text();
    expect(usageCell(callRow(html, tenant), 'source')).toBe('租户');
    expect(usageCell(callRow(html, platform), 'source')).toBe('平台');
    expect(usageCell(callRow(html, legacy), 'source')).toBe('—');
  });

  it('「按轮次」视图（?tab=turns）按 turn_id 聚合：请求次数、token 与缓存合计、发起人（null 是「—」）与用途拼接，按开始时间倒序；旧行、窗口外与别的租户的轮次不出现', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    const initech = await newTenant('initech');
    const oldTurn = crypto.randomUUID();
    const newTurn = crypto.randomUUID();
    // 新轮次（1 天前）：3 次调用、两种用途，输入 30+40+50 / 输出 15+20+25，缓存 7+null+0=7（同一轮同一发起人）
    await call(acme, { turnId: newTurn, actorEmail: 'an@acme.com', purpose: 'assistant', promptTokens: 30, completionTokens: 15, cachedTokens: 7 });
    await call(acme, { turnId: newTurn, actorEmail: 'an@acme.com', purpose: 'assistant', promptTokens: 40, completionTokens: 20 });
    await call(acme, { turnId: newTurn, actorEmail: 'an@acme.com', purpose: 'connectivity', promptTokens: 50, completionTokens: 25 });
    // 旧轮次（3 天前）：发起人为 null
    await call(acme, { turnId: oldTurn, purpose: 'assistant', promptTokens: 10, completionTokens: 5, createdAt: ago(3) });
    // 旧行（turn_id 为 null）不出现在按轮次视图里
    await call(acme, { promptTokens: 999, completionTokens: 999 });
    // 窗口外与别的租户的轮次不出现
    const outWindowTurn = crypto.randomUUID();
    const initechTurn = crypto.randomUUID();
    await call(acme, { turnId: outWindowTurn, promptTokens: 1, createdAt: ago(40) });
    await call(initech, { turnId: initechTurn, actorEmail: 'de@initech.com', promptTokens: 111 });

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?tab=turns')).text();
    // 开始时间倒序：新轮次在前；旧行、窗口外与别的租户的轮次都不出现（整页只有这两轮的行）
    expect(html.indexOf(`data-turn="${newTurn}"`)).toBeLessThan(html.indexOf(`data-turn="${oldTurn}"`));
    expect(html.match(/<tr[^>]*data-turn=/g)).toHaveLength(2);
    expect(html).not.toContain(`data-turn="${outWindowTurn}"`);
    expect(html).not.toContain(`data-turn="${initechTurn}"`);
    expect(html).not.toContain('de@initech.com');
    // 新轮次：3 次请求、输入 / 输出合计、其中缓存 7、发起人、用途去重后按字典序用 , 拼
    const row = turnRow(html, newTurn);
    expect(usageCell(row, 'calls')).toBe('3');
    expect(usageCell(row, 'tokens')).toBe('120 / 60');
    expect(usageCell(row, 'cached')).toBe('7');
    expect(usageCell(row, 'actor')).toBe('an@acme.com');
    expect(usageCell(row, 'purposes')).toBe('assistant, connectivity');
    // 旧轮次：发起人 null 显示 —
    expect(usageCell(turnRow(html, oldTurn), 'actor')).toBe('—');
    // 指标卡两种视图都显示：总调用 5（含 turn_id 为 null 的旧行）
    const tile = (label: string) => html.match(new RegExp(`${label}</div><div[^>]*>([^<]*)<`))?.[1];
    expect(tile('总调用')).toBe('5');
    // 分页同明细（每页 50、总轮次数做分母）
    expect(html).toContain('第 1 / 1 页，每页 50 条');
    // 切天数的链接保留视图（当前 days=7、目标 days=30 都带 tab=turns）；切回「按用途」的链接带 days
    expect(html).toContain('href="/llm-usage?days=7&amp;tab=turns"');
    expect(html).toContain('href="/llm-usage?days=30&amp;tab=turns"');
    expect(html).toContain('href="/llm-usage?days=7&amp;tab=purpose"');
    // 30 天窗口：仍是这两轮（40 天前的不出现），旧行还是不出现
    const month = await (await admin.get('/llm-usage?days=30&tab=turns')).text();
    expect(month.match(/<tr[^>]*data-turn=/g)).toHaveLength(2);
    expect(month).not.toContain(`data-turn="${outWindowTurn}"`);

    // 有调用但没有带 turn_id 的行：轮次视图一句空状态（不是整页空状态）
    await call(globex, { promptTokens: 1 });
    const other = await loginAs(app, 'admin@globex.com');
    const empty = await (await other.get('/llm-usage?tab=turns')).text();
    expect(empty).toContain('近 7 天没有按轮次记录的调用');
    expect(empty).not.toContain('暂无模型调用');
  });

  it('按用途的表与总计新增「超时」列：数 error_kind 为 timeout 的行（错误的子集，不从错误数里减），表下注明超时调用的 token 不在统计里', async () => {
    const acme = await newTenant('acme');
    await call(acme, { promptTokens: 10, completionTokens: 5 }); // 成功
    await call(acme, { error: '请求超时', errorKind: 'timeout' }); // 超时：token 都是 null
    await call(acme, { error: 'HTTP 500', errorKind: null }); // 其他错误：error_kind 为 null
    await call(acme, { purpose: 'assistant', error: '请求超时', errorKind: 'timeout', promptTokens: 1, completionTokens: 1 });

    const admin = await loginAs(app, 'admin@acme.com');
    const html = await (await admin.get('/llm-usage?days=7')).text();
    // connectivity：1 次超时、2 次错误（超时是错误的子集，不从错误数里减）；assistant：1 次超时
    expect(usageCell(usageRow(html, 'connectivity'), 'timeouts')).toBe('1');
    expect(usageCell(usageRow(html, 'connectivity'), 'errors')).toBe('2（66.7%）');
    expect(usageCell(usageRow(html, 'assistant'), 'timeouts')).toBe('1');
    // 总计共用 UsageRow：2 次超时
    expect(usageCell(usageRow(html, 'total'), 'timeouts')).toBe('2');
    // 表头在「错误」之后，表下注明超时调用的 token 不在统计里
    expect(html.indexOf('超时</th>')).toBeGreaterThan(html.indexOf('错误</th>'));
    expect(html).toContain('data-note="timeouts"');
    expect(html).toContain('超时的调用拿不到 token，这些调用的 token 不在统计里');
  });

  it('英文界面（开关 + crm_locale=en）下明细时间是英文格式（AM/PM）、token 仍带千分位；不开开关时同一行还是中文格式', async () => {
    const acme = await newTenant('acme');
    const at = new Date(Date.now() - 60_000); // 已知时间：落在 7 天窗口内
    const turn = crypto.randomUUID();
    const [id] = (await getDb().insert(llmCalls).values({
      tenantId: acme, purpose: 'connectivity', model: 'm-fast', durationMs: 100,
      promptTokens: 1234567, completionTokens: 8901, cachedTokens: 100, turnId: turn, actorEmail: 'an@acme.com', createdAt: at,
    }).returning({ id: llmCalls.id })).map(r => r.id);

    const admin = await loginAs(app, 'admin@acme.com');
    // crm_locale 写进 cookie jar：显式传 Cookie 头时 Client 不带 jar，会丢登录会话
    admin.store('crm_locale=en; Path=/');

    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const en = callRow(await (await admin.get('/llm-usage')).text(), id);
    expect(timeCell(en)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M$/);
    expect(en).toContain('1,234,567');
    expect(en).toContain('8,901');
    // 「按轮次」视图（#1254）：同一轮的开始时间也是英文格式，token / 缓存带千分位，发起人原样
    const enTurns = turnRow(await (await admin.get('/llm-usage?tab=turns')).text(), turn);
    expect(timeCell(enTurns)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M$/);
    expect(usageCell(enTurns, 'calls')).toBe('1');
    expect(usageCell(enTurns, 'tokens')).toBe('1,234,567 / 8,901');
    expect(usageCell(enTurns, 'cached')).toBe('100');
    expect(usageCell(enTurns, 'actor')).toBe('an@acme.com');

    // 关掉开关（cookie 还在）：同一行回到 2026/… 的中文格式，token 不变
    vi.unstubAllEnvs();
    const zh = callRow(await (await admin.get('/llm-usage')).text(), id);
    expect(timeCell(zh)).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
    expect(zh).toContain('1,234,567');
  });
});

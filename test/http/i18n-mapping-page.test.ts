// test/http/i18n-mapping-page.test.ts —— 映射详情页（一）接入双语后的整页断言（#1039，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下详情页的页头、停用 / 恢复操作与主组件写死的文字没有汉字，
// 标准实体名与合并状态（任务状态）经 builtinName 显示英文，行数带千分位、发布与停用时间按英文格式；
// 详情页 action 的未知 intent 走 formatServer 报 400 英文报错；中文界面下同一页面仍是原中文（含 zh-CN 格式的时间）。
// 编辑对照、空跑等 229-494 行在 #1040（合并记录行 MergeRow 也是），合并记录标签页只断表头与最近一次合并的整句。
// 源名用 ASCII（数据不翻，整页断言不剔数据值）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { events, ORDERS } from '../pipeline/mapping-fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 开通租户 acme，de@ 登记 ASCII 名字的电商库（源名是数据、不翻，整页断言不用剔）、选入全部表并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const author = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const reviewer = await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
  const { id } = await registerSource(author, await pgSourceInput(READER, 'shop-db'));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await syncSource(author, id);
  await drain();
  return { author, reviewer, id };
}

/** 事件表 1500 行、occurred_at 每行唯一：并入标准层后行数带千分位（1,500） */
const EVENTS = events('events', 'occurred_at');

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 登录后把界面语言切到英文（cookie 由 harness 记住；不要显式传 Cookie 头，会丢登录会话） */
async function englishClient(email: string) {
  const client = await loginAs(app, email);
  client.store('crm_locale=en; Path=/');
  return client;
}

describe('英文界面：映射详情页（一）', () => {
  it('已发布已合并的标准实体映射详情页没有汉字：标题与页头（实体名）、指标卡（合并状态、千分位行数）、编辑页操作与版本表（英文格式的时间）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, EVENTS);
    const engineer = await englishClient('de@acme.com');
    const edit = stripScripts(await (await engineer.get(`/mappings/${mappingId}`)).text());
    expect(edit).toContain('lang="en"');
    expect(edit).not.toMatch(/[一-鿿]/);
    // 标题与页头：标准实体名（行为事件）经 builtinName 显示英文，自定义实体名才是数据不翻
    expect(edit).toContain('<title>Event ← events · CRM Data Analytics Platform</title>');
    expect(edit).toContain('← All mappings');
    expect(edit).toContain('Event（event）');
    // 源表卡与实体卡的种类（单数）：ICU 复数 / select
    expect(edit).toContain('text-slate-500">Source table<');
    expect(edit).toContain('text-slate-500">Canonical entity<');
    // 指标卡：线上版本、最近合并（任务状态英文）与带千分位的标准层行数
    expect(edit).toContain('Live version');
    expect(edit).toContain('The latest published version');
    expect(edit).toContain('Latest merge · Succeeded');
    expect(edit).toContain('1,500');
    expect(edit).toContain('Silver layer rows');
    // 标签页、停用与合并操作
    expect(edit).toContain('Versions (1)');
    expect(edit).toContain('Merge history (1)');
    expect(edit).toContain('name="intent" value="request-disable"');
    expect(edit).toContain('Disable');
    expect(edit).toContain('Merge now');
    // 版本表：表头与英文格式的发布时间（zh-CN 是 2026/11/21 10:30:00 这样的 24 小时制）
    const versions = stripScripts(await (await engineer.get(`/mappings/${mappingId}?tab=versions`)).text());
    expect(versions).not.toMatch(/[一-鿿]/);
    expect(versions).toMatch(/de2@acme\.com, \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
    for (const head of ['Version</th>', 'Status</th>', 'Authors</th>', 'Published</th>', 'View</a>']) expect(versions).toContain(head);
    // 合并记录：最近一次合并的整句与表头（合并行 MergeRow 在 #1040，不做整页断言）
    const merges = stripScripts(await (await engineer.get(`/mappings/${mappingId}?tab=merges`)).text());
    expect(merges).toContain('This mapping&#x27;s latest merge: Succeeded');
    for (const head of ['Version</th>', 'Mode</th>', 'Silver layer rows</th>', 'Duration</th>', 'Started at</th>']) expect(merges).toContain(head);
  });

  it('停用提议后：提议人看到英文的等待提示，另一位看到确认按钮；确认后停用横幅与恢复按钮也是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, ORDERS);
    const proposer = await englishClient('de@acme.com');
    expect((await proposer.post(`/mappings/${mappingId}`, { intent: 'request-disable' })).status).toBe(302);
    const mine = stripScripts(await (await proposer.get(`/mappings/${mappingId}`)).text());
    expect(mine).not.toMatch(/[一-鿿]/);
    expect(mine).toContain('data-disable-blocker');
    expect(mine).toContain('Waiting for another member to confirm: you proposed disabling this mapping, and another data engineer or administrator must confirm it');
    expect(mine).not.toContain('name="intent" value="confirm-disable"');
    // 另一位成员确认：标题带提议人，按钮是英文
    const other = await englishClient('de2@acme.com');
    const theirs = stripScripts(await (await other.get(`/mappings/${mappingId}`)).text());
    expect(theirs).not.toMatch(/[一-鿿]/);
    expect(theirs).toContain('Disable pending confirmation: de@acme.com proposed disabling this mapping and is waiting for another member to confirm');
    expect(theirs).toContain('name="intent" value="confirm-disable"');
    expect((await other.post(`/mappings/${mappingId}`, { intent: 'confirm-disable' })).status).toBe(302);
    // 停用后的横幅：停用时间按英文格式（zh-CN 是 2026/11/21 10:30:00），停用人记的是提议人；恢复按钮是英文
    const disabled = stripScripts(await (await other.get(`/mappings/${mappingId}`)).text());
    expect(disabled).not.toMatch(/[一-鿿]/);
    expect(disabled).toMatch(/Disabled at \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
    expect(disabled).toContain('(by de@acme.com, the proposer)');
    expect(disabled).toContain('name="intent" value="restore"');
    expect(disabled).toContain('Restore');
  });

  it('action 的未知 intent 返回 400 英文报错，整页回显没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, ORDERS);
    const engineer = await englishClient('de@acme.com');
    const bad = await engineer.post(`/mappings/${mappingId}`, { intent: 'bogus' });
    expect(bad.status).toBe(400);
    const badHtml = stripScripts(await bad.text());
    expect(badHtml).toContain('Unknown operation');
    expect(badHtml).not.toMatch(/[一-鿿]/);
  });
});

describe('中文界面输出与改造前一致', () => {
  it('同一详情页仍是原中文：标题、种类、合并状态、行数与等待提示；发布时间仍是 zh-CN 格式', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, EVENTS);
    const engineer = await loginAs(app, 'de@acme.com');
    const edit = await (await engineer.get(`/mappings/${mappingId}`)).text();
    expect(edit).toContain('<title>行为事件 ← events · CRM 数据分析平台</title>');
    expect(edit).toContain('← 全部映射');
    expect(edit).toContain('行为事件（event）');
    expect(edit).toContain('text-slate-500">源表<');
    expect(edit).toContain('text-slate-500">标准实体<');
    expect(edit).toContain('最近合并 · 成功');
    expect(edit).toContain('标准层行数');
    expect(edit).toContain('1,500');
    expect(edit).toContain('版本（1）');
    expect(edit).toContain('合并记录（1）');
    // 版本表的发布时间：中文逗号 + zh-CN 的 24 小时制
    const versions = await (await engineer.get(`/mappings/${mappingId}?tab=versions`)).text();
    expect(versions).toMatch(/de2@acme\.com，\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
    // 停用提议后的等待提示逐字不变（test/http/mappings.test.ts 也断这句）
    expect((await engineer.post(`/mappings/${mappingId}`, { intent: 'request-disable' })).status).toBe(302);
    const mine = await (await engineer.get(`/mappings/${mappingId}`)).text();
    expect(mine).toContain('等待另一位确认：你提议了停用，需由另一位数据工程师或管理员确认');
  });
});

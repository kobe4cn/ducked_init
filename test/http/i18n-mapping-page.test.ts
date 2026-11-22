// test/http/i18n-mapping-page.test.ts —— 映射详情页接入双语后的整页断言（#1039、#1040，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下详情页的页头、停用 / 恢复操作与主组件写死的文字没有汉字，
// 标准实体名与合并状态（任务状态）经 builtinName 显示英文，行数带千分位、发布与停用时间按英文格式；
// 详情页 action 的未知 intent 走 formatServer 报 400 英文报错；中文界面下同一页面仍是原中文（含 zh-CN 格式的时间）。
// #1040 起合并记录行（MergeRow）、空跑面板与自定义断言、源表列差异、草稿差异也是英文（落入兜底的取值句子归 #1057，仍中文）。
// 源名用 ASCII（数据不翻，整页断言不剔数据值）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource, relistSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { CUSTOMERS, events, ORDERS } from '../pipeline/mapping-fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 开通租户 acme，de@ 登记 ASCII 名字的电商库（源名是数据、不翻，整页断言不用剔）、选入全部表并同步一次；
 *  orders 的主键是自增（水位线候选），不确认就不同步——空跑会 400「源表 orders 还没有同步进原始层」（这句是服务端中文，随 #932 翻译） */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const author = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const reviewer = await memberOf(tenantId, 'de2@acme.com', 'data_engineer');
  const { id } = await registerSource(author, await pgSourceInput(READER, 'shop-db'));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
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

/** 新建映射的响应（302）里取映射 id */
const mappingIdOf = (res: Response) => {
  expect(res.status).toBe(302);
  return res.headers.get('Location')!.match(/^\/mappings\/([0-9a-f-]{36})$/)![1];
};

/** 夹具 ORDERS 去掉 customer_id 与 created_at 两个字段：v2 把 status 换成 created_at 才不会键重名（YAML 键必须唯一），
 *  与 test/http/mappings.test.ts 的差异用例同款 */
const ORDERS_MIN = ORDERS.replace('  customer_id: string(customer_id)\n', '').replace('  created_at: created_at\n', '');

/** 订单映射加两条自定义断言：order_id 非空（都合格），amount 取值范围 max:-1（全部不合格，警告级） */
const ORDERS_WITH_ASSERTIONS = `${ORDERS_MIN}assertions:
  - { field: order_id, check: not_null, level: error }
  - { field: amount, check: range, max: -1, level: warn }
`;

/** 在已发布 v1 的基础上改出 v2 草稿：amount 表达式、status 换成 created_at、加去重声明（与 test/http/mappings.test.ts 的差异用例同款） */
const ORDERS_V2 = ORDERS_MIN
  .replace('amount: amount', 'amount: amount / 100')
  .replace(/  status: .*\n/, "  created_at: from_timezone(created_at, 'Asia/Shanghai')\n")
  + 'dedupe: { key: [order_id], latest: created_at }\n';

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
    expect(edit).toContain('Event (event)');
    expect(edit).not.toContain('（');
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

describe('英文界面：映射详情页（二）', () => {
  it('合并记录标签页：合并行整行英文——千分位行数句、重建方式与英文格式的开始时间，整页没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, EVENTS);
    const engineer = await englishClient('de@acme.com');
    const merges = stripScripts(await (await engineer.get(`/mappings/${mappingId}?tab=merges`)).text());
    expect(merges).not.toMatch(/[一-鿿]/);
    // 方式：首个合并是从全部批次重建（zh-CN 是「重建（批次 1–1）」）
    expect(merges).toContain('Rebuild (batches 1–1)');
    // 行数句：总行数千分位（zh-CN 也是 1,500），新增 / 更新 / 删除计数不带千分位
    expect(merges).toContain('1,500 rows (inserted 1500, updated 0, deleted 0)');
    // 开始时间：zh-CN 是 2026/11/22 10:30:00 这样的 24 小时制（TableCell 带 class，不断言裸 <td>）
    expect(merges).toMatch(/<td[^>]*>\d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M<\/td>/);
  });

  it('空跑面板与自定义断言：英文字段名（builtinName）、检查名与级别，整页没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { id } = await syncedSource();
    // 草稿由 de@ 建、由 de2 看：最后改草稿的人看到的服务端发布理由还是中文（publishReason，随 #932 翻译），换人看避开它
    const engineer = await englishClient('de@acme.com');
    const mappingId = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId: id, yaml: ORDERS_WITH_ASSERTIONS }));
    const reviewer = await englishClient('de2@acme.com');
    const html = stripScripts(await (await reviewer.post(`/mappings/${mappingId}`, { intent: 'dryrun', version: '1' })).text());
    expect(html).not.toMatch(/[一-鿿]/);
    // 面板标题与说明：orders 表 100 行，采样上限 50
    expect(html).toContain('Dry-run v1');
    expect(html).toContain('Transforms the latest 50 records of the Bronze layer (at most 50); nothing is written to the Silver layer.');
    // 基础断言：去重键的字段名经 builtinName 显示英文（订单 ID → Order ID）
    expect(html).toContain('Deduplication key (Order ID) is never empty');
    // 自定义断言：名称、级别与不合格行数；字段名与检查名都是英文
    expect(html).toMatch(/data-assertion="custom:order_id:not_null" data-ok="true"/);
    expect(html).toContain('Custom: Order ID not null (error): all rows pass in the sample');
    expect(html).toMatch(/data-assertion="custom:amount:range" data-ok="false"/);
    expect(html).toMatch(/Custom: Amount Paid Value range \(warning\): \d+ rows fail in the sample/);
    // 消费者映射（身份打通匹配邮箱，样本里有 10 行为空）：必填字段句的字段名是英文、数字不格式化；
    // 样例行里是中文数据值（姓名、城市），只断断言列表这一段没有汉字
    const customersId = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId: id, yaml: `${CUSTOMERS}identity:\n  match: [email]\n` }));
    const customerHtml = stripScripts(await (await engineer.post(`/mappings/${customersId}`, { intent: 'dryrun', version: '1' })).text());
    // 断言列表在 data-dryrun 与样例表（第一处 overflow-x-auto）之间；页面其他表格也带 overflow-x-auto，要从面板起点往后找
    const start = customerHtml.indexOf('data-dryrun="1"');
    const list = customerHtml.slice(start, customerHtml.indexOf('overflow-x-auto', start));
    expect(list).not.toMatch(/[一-鿿]/);
    expect(list).toContain('Required field Email is empty in 10 rows');
    expect(list).toContain('Deduplication key (Customer ID) is never empty');
  });

  it('源表列差异与草稿差异：新增列提醒、与已发布版本的差异整句与差异项都是英文，整页没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, ORDERS_MIN);
    // 发布后源表新增一列并重新采集：详情页提醒新列（忽略按钮的 title 也翻）
    await grantOnSource("ALTER TABLE shop.orders ADD COLUMN channel text DEFAULT 'store';");
    await relistSource(author, id);
    await drain();
    const engineer = await englishClient('de@acme.com');
    const drift = stripScripts(await (await engineer.get(`/mappings/${mappingId}`)).text());
    expect(drift).toContain('data-drift-new="channel"');
    expect(drift).toContain('1 new source column, not used by this mapping yet');
    expect(drift).toContain('Add as extension field');
    expect(drift).toContain('Ignore');
    // 在已发布 v1 的基础上保存 v2 草稿：差异区块逐项英文；差异页由 de2 看——最后改草稿的人（de@）会看到还是中文的服务端发布理由（随 #932 翻译）
    expect((await engineer.post(`/mappings/${mappingId}`, { intent: 'save', yaml: ORDERS_V2 })).status).toBe(302);
    const diff = stripScripts(await (await (await englishClient('de2@acme.com')).get(`/mappings/${mappingId}`)).text());
    expect(diff).not.toMatch(/[一-鿿]/);
    expect(diff).toContain('Differences between v2 and published v1');
    for (const item of ['added-created_at', 'removed-status', 'changed-amount', 'latest']) expect(diff).toContain(`data-diff-item="${item}"`);
    expect(diff).not.toContain('data-diff-item="key"');
    // 差异项的整句：新增 / 删除列、改了什么（表达式）、取最新字段
    expect(diff).toContain('Added column');
    expect(diff).toContain('Removed column');
    expect(diff).toContain('changed Expression');
    expect(diff).toContain('Latest field:');
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

  it('合并记录行仍是原中文：全角括号的方式与行数句（总行数千分位）、zh-CN 格式的开始时间', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, EVENTS);
    const engineer = await loginAs(app, 'de@acme.com');
    const merges = await (await engineer.get(`/mappings/${mappingId}?tab=merges`)).text();
    expect(merges).toContain('重建（批次 1–1）');
    expect(merges).toContain('1,500 行（新增 1500，更新 0，删除 0）');
    expect(merges).toMatch(/<td[^>]*>\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}<\/td>/);
  });

  it('空跑面板与草稿差异仍是原中文：全角括号、顿号、「必填字段{字段}有」无空格', async () => {
    const { author, reviewer, id } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    const mappingId = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId: id, yaml: ORDERS_WITH_ASSERTIONS }));
    // 还没发布：差异区块是首个版本
    expect(await (await engineer.get(`/mappings/${mappingId}`)).text()).toContain('v1 是首个版本');
    // 空跑：面板标题、说明与断言逐字不变
    const dryRun = await (await engineer.post(`/mappings/${mappingId}`, { intent: 'dryrun', version: '1' })).text();
    expect(dryRun).toContain('空跑 v1');
    expect(dryRun).toContain('取原始层里最新的 50 条记录（最多 50 条）转换，没有写进标准层。');
    expect(dryRun).toContain('去重键（订单 ID）都不为空');
    // 必填字段断言只在身份打通的实体上有：消费者映射（匹配邮箱，样本里 10 行为空）逐字断「必填字段邮箱有 10 行为空」
    const customersId = mappingIdOf(await engineer.post('/mappings', { intent: 'create', sourceId: id, yaml: `${CUSTOMERS}identity:\n  match: [email]\n` }));
    const customersDryRun = await (await engineer.post(`/mappings/${customersId}`, { intent: 'dryrun', version: '1' })).text();
    expect(customersDryRun).toContain('必填字段邮箱有 10 行为空');
    expect(dryRun).toContain('自定义：订单 ID 非空（错误级）：样本里都合格');
    expect(dryRun).toMatch(/自定义：实付金额 取值范围（警告级）：样本里有 \d+ 行不合格/);
    // 发布后保存 v2：与已发布 v1 的差异逐字不变
    const reviewerClient = await loginAs(app, 'de2@acme.com');
    expect((await reviewerClient.post(`/mappings/${mappingId}`, { intent: 'publish', version: '1' })).status).toBe(302);
    expect((await engineer.post(`/mappings/${mappingId}`, { intent: 'save', yaml: ORDERS_V2 })).status).toBe(302);
    const diff = await (await engineer.get(`/mappings/${mappingId}`)).text();
    expect(diff).toContain('v2 与已发布 v1 的差异');
    expect(diff).toContain('新增列');
    expect(diff).toContain('删除列');
    expect(diff).toContain('改了表达式');
    expect(diff).toContain('取最新字段：');
    expect(diff).not.toContain('data-diff-item="key"');
    // 只加注释的草稿：计划相同（发布的 v1 带同样的自定义断言）
    expect((await engineer.post(`/mappings/${mappingId}`, { intent: 'save', yaml: `# 只加注释\n${ORDERS_WITH_ASSERTIONS}` })).status).toBe(302);
    expect(await (await engineer.get(`/mappings/${mappingId}`)).text()).toContain('合并计划与已发布版本相同（只改了注释或写法）。');
  });

  it('源表列差异仍是原中文：新增列提醒与常见取值（顿号）', async () => {
    const { author, reviewer, id } = await syncedSource();
    const mappingId = await publish(author, reviewer, id, ORDERS);
    await grantOnSource("ALTER TABLE shop.orders ADD COLUMN channel text DEFAULT 'store';");
    await relistSource(author, id);
    await drain();
    const engineer = await loginAs(app, 'de@acme.com');
    const detail = await (await engineer.get(`/mappings/${mappingId}`)).text();
    expect(detail).toContain('data-drift-new="channel"');
    expect(detail).toContain('源表新增 1 列，映射还没用到');
    expect(detail).toContain('全部加为扩展字段');
    expect(detail).toMatch(/常见取值：store/);
  });
});

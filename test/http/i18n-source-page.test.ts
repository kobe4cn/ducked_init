// test/http/i18n-source-page.test.ts —— 数据源详情页（一）接入双语后的断言（#1036，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下本票负责的区域——页头与指标卡、标签页、连接与同步范围设置、
// 源表行的同步方式徽标与进湖状态、采集 / 同步状态、按钮与 action 回显——没有汉字；数据源类型与同步方式经 builtinName
// 显示英文，估算行数与日期按英文格式（~1,500、11/21/2026）；「测试连接」成功消息（有、没有不可读表两条句式）与未知操作 400
// 走 formatServer 回显英文。#1037 的子组件（LakeCoverage、水位线 / 业务主键 / 软删除、列统计、源端注释明细、同步历史）
// 与 #1137 的 syncModeNote 仍是中文，所以按区域截取断言，不整页断言；meta 标题照惯例不翻（#1036 不动）。
// 中文界面下日期时间与数字仍和改造前的 zh-CN 格式一致。源名用 ASCII（数据值不翻，断言不用剔数据值）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => vi.unstubAllEnvs());

/** 开通租户 acme，de@acme.com 登记 ASCII 名字的电商库（数据值不翻）、选入全部表并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  // 估算行数来自 pg_class.reltuples：seedPgSource 会重建 shop，ANALYZE 要放在它之后、登记之前，
  // 登记时的列表才能拿到 events 的 1500 行
  const input = await pgSourceInput(READER, 'shop-db');
  await grantOnSource('ANALYZE shop.events');
  const { id } = await registerSource(engineer, input);
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return { tenantId, sourceId: id };
}

/** 只登记、不选表的数据源：所有列出的表都是「新表未选」，源表与同步历史为空 */
async function freshSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const input = await pgSourceInput(READER, 'shop-db');
  await grantOnSource('ANALYZE shop.events');
  const { id } = await registerSource(engineer, input);
  return { tenantId, sourceId: id };
}

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 同步范围表单（intent=scope 的那个 form）：#1037 的子组件不在里面，整个表单都归本票 */
const scopeFormOf = (html: string) => {
  const start = html.lastIndexOf('<form', html.indexOf('value="scope"'));
  return html.slice(start, html.indexOf('</form>', start) + 8);
};

describe('英文界面：数据源详情页（一）', () => {
  it('页头与指标卡、标签页没有汉字：返回链接、英文日期、类型走 builtinName、表数复数、核对状态', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 页头、指标卡与标签页：白色面板之前（meta 标题不翻，从 body 开始断言）。
    // 「删除数据源」按钮是 DeleteSource 组件（#1037），跳过它的 form 后再断言
    expect(html).toContain('lang="en"');
    const del = html.indexOf('value="delete"');
    const head = html.slice(html.indexOf('<body'), del) + html.slice(html.indexOf('</form>', del) + 8, html.indexOf('bg-white p-6'));
    expect(head).not.toMatch(/[一-鿿]/);
    expect(head).toContain('← Sources');
    expect(head).toMatch(/Registered on \d{1,2}\/\d{1,2}\/\d{4}/);
    expect(head).toContain('Test connection');
    expect(head).toContain('Relist tables and collect');
    // 指标卡：类型走 builtinName、同步表数与「共列出 N 张表」的 ICU 复数
    expect(head).toContain('>Type</div>');
    expect(head).toContain('PostgreSQL');
    expect(head).toContain('>Target</div>');
    expect(head).toContain('>Synced tables</div>');
    expect(head).toContain('4 tables listed');
    expect(head).toContain('>Verification status</div>');
    // 标签页
    expect(head).toContain('Overview');
    expect(head).toContain('Lake data');
    expect(head).toContain('Source views (0)');
  });

  it('连接与同步范围设置没有汉字：配置名、凭据说明、过滤与批量选择、估算行数与已选入（英文日期）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 第一个 section（连接）到同步范围表单结束：这两个分区都归本票
    const end = html.indexOf('</form>', html.indexOf('value="scope"')) + 8;
    const connectAndScope = html.slice(html.indexOf('<section'), end);
    expect(connectAndScope).not.toMatch(/[一-鿿]/);
    expect(connectAndScope).toContain('Connection');
    expect(connectAndScope).toContain('Host</dt>');
    expect(connectAndScope).toContain('Username</dt>');
    expect(connectAndScope).toContain('Credentials');
    expect(connectAndScope).toContain('Stored encrypted; never shown');
    expect(connectAndScope).toContain('Sync scope');
    expect(connectAndScope).toContain('Filter by name');
    expect(connectAndScope).toContain('Select all filtered');
    expect(connectAndScope).toContain('Unselect filtered');
    expect(connectAndScope).toContain('Save sync scope');
    expect(connectAndScope).toContain('Table</th>');
    expect(connectAndScope).toContain('Estimated rows</th>');
    expect(connectAndScope).toContain('Status</th>');
    // 行：估算行数按英文千分位，已选入带选择人与英文日期
    expect(connectAndScope).toContain('data-listed="events"');
    expect(connectAndScope).toContain('~1,500');
    expect(connectAndScope).toMatch(/In scope \(de@acme\.com, \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M\)/);
  });

  it('源表行的同步方式徽标与进湖状态、采集 / 同步状态走 builtinName：英文且属性值不变', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 采集状态（未采集 / 任务状态名）与同步状态：完整句式加 builtinName 的状态名
    expect(html).toContain('data-profile-status="succeeded">Collection: Succeeded');
    expect(html).toContain('data-sync-status="succeeded">Succeeded');
    // 同步方式徽标走 builtinName（data-sync-mode 的值不变），进湖状态在 data-in-lake 里是英文
    expect(html).toMatch(/data-table="customers"[^>]*data-sync-mode="watermark"/);
    expect(html).toContain('Watermark incremental');
    expect(html).toMatch(/data-table="events"[^>]*data-sync-mode="full_compare"/);
    expect(html).toContain('Full compare');
    expect(html).toContain('data-in-lake="true">In lake');
    // 同步分区的按钮与长句说明、源端注释分区的标题（明细是 #1037）
    expect(html).toContain('Sync now');
    expect(html).toContain('Latest: submitted at');
    expect(html).toContain('Source comments');
  });

  it('新登记的数据源：有 N 张新表未选（ICU 复数）、空态与「修改与轮换凭据」分区没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await freshSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    const scopeForm = scopeFormOf(html);
    expect(scopeForm).not.toMatch(/[一-鿿]/);
    expect(scopeForm).toContain('data-new-tables="4"');
    expect(scopeForm).toContain('4 new tables not selected yet');
    expect(scopeForm).toContain('data-listed="events"');
    // 源表与同步分区的空态、未采集状态
    expect(html).toContain('data-profile-status="none">Collection: Not collected');
    expect(html).toContain('No collected tables in the sync scope yet');
    expect(html).toContain('No sync history yet');
    // 修改与轮换凭据是概览页最后一个分区：从这里到页面结尾没有汉字（SourceFields 在 #1038 已接入）
    const edit = html.slice(html.indexOf('Edit and rotate credentials'));
    expect(edit).not.toMatch(/[一-鿿]/);
    expect(edit).toContain('Validate and save');
  });

  it('action 的「测试连接」成功消息（有、没有不可读的表两条句式）与未知操作 400 是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await freshSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const ok = await engineer.post(`/sources/${sourceId}`, { intent: 'test' });
    expect(ok.status).toBe(200);
    const okHtml = stripScripts(await ok.text());
    expect(okHtml).toContain('Test connection');
    expect(okHtml).toContain('Connected: 4 tables, account is read-only');
    // 撤掉 events 的 SELECT 后：带不可读表的那条句式（表名连接符走服务端词条「、」）
    await grantOnSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);
    const partial = await engineer.post(`/sources/${sourceId}`, { intent: 'test' });
    expect(partial.status).toBe(200);
    expect(stripScripts(await partial.text())).toContain('Connected: 3 tables, account is read-only; 1 table cannot be read and cannot be added to the sync scope: events');
    // 未知 intent：400
    const bad = await engineer.request(`/sources/${sourceId}`, { method: 'POST', body: new URLSearchParams({ intent: 'bogus' }) });
    expect(bad.status).toBe(400);
    expect(stripScripts(await bad.text())).toContain('Unknown operation');
  });
});

describe('中文界面输出与改造前一致', () => {
  it('页头登记时间、估算行数、共列出表数与已选入仍是 zh-CN 格式（2026/11/21 10:30:00、约 1,500）', async () => {
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get(`/sources/${sourceId}`)).text();
    expect(html).toMatch(/登记于 \d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
    expect(html).toContain('约 1,500');
    // 源表行的行数（events 采集到 1500 行）也按 zh-CN 千分位
    expect(html).toContain('>1,500</td>');
    expect(html).toContain('共列出 4 张表');
    expect(html).toContain('采集成功');
    expect(html).toMatch(/已选入（de@acme\.com，\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}）/);
  });
});

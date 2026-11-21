// test/http/i18n-sources-pages.test.ts —— 数据源列表与源视图页接入双语后的整页断言（#1038，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下两页写死的文字没有汉字，数据源类型经 builtinName 显示英文、
// 登记/类型下拉的 option value 不变，日期按英文格式；中文界面下日期与时间仍和改造前的 zh-CN 格式一致。
// 上传预览组件的静态渲染见 test/i18n-sources-list-render.test.ts。源名用 ASCII（数据不翻，整页断言不剔数据值）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 开通租户 acme，de@acme.com 登记 ASCII 名字的电商库（数据值不翻，整页断言不用剔）、选入全部表并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const { id } = await registerSource(engineer, await pgSourceInput(READER, 'shop-db'));
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return { tenantId, sourceId: id };
}

/** 只选 ASCII 列的视图（email 是敏感列、样本里显示为哈希）：整页断言不剔数据值也不受种子里的中文姓名与城市影响 */
const VIEW = 'SELECT customer_id, email, _op, _batch, _commit_ts FROM customers';

/** 新建源视图后跳转到的详情页路径（带 ?preview=1） */
const locationOf = (res: Response) => res.headers.get('location') ?? '';

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

describe('英文界面：数据源列表与源视图页', () => {
  it('数据源列表写死的文字没有汉字：指标卡、卡片（类型徽标、登记日期）、空态与登记表单（类型下拉的英文选项、value 不变）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get('/sources')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    // 指标卡（1 个数据源、1 种类型）
    expect(html).toContain('Sources');
    expect(html).toContain('1 type');
    expect(html).toContain('Latest verification');
    expect(html).toContain('Needs attention');
    // 卡片：类型徽标与英文格式的登记日期（zh-CN 是 2026/11/21 这样的 年/月/日）
    expect(html).toContain('PostgreSQL</span>');
    expect(html).toMatch(/Registered on \d{1,2}\/\d{1,2}\/\d{4}/);
    // 登记表单：类型下拉显示英文，option value 仍是代码名
    expect(html).toContain('Object storage file (S3)</option>');
    expect(html).toContain('File upload</option>');
    for (const kind of ['postgres', 'mysql', 'mongodb', 's3', 'duckdb', 'upload']) expect(html).toContain(`value="${kind}"`);
    expect(html).toContain('Validate and register');
  });

  it('源视图页写死的文字没有汉字：预览面板（哈希列）、编辑提示、版本表（英文格式的发布时间）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const author = await loginAs(app, 'de@acme.com');
    author.store('crm_locale=en; Path=/');
    const created = await author.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'active_emails', sql: VIEW });
    expect(created.status).toBe(302);
    // 编辑页由 admin（不是最后保存草稿的人）看：作者自己看会在版本状态里带服务端算好的中文 publishBlocker（#1061，不在本票）
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const edit = stripScripts(await (await admin.get(locationOf(created))).text());
    expect(edit).not.toMatch(/[一-鿿]/);
    // 预览面板：标题、列数 / 行数（ICU 复数）与敏感列的「哈希 ·」前缀
    expect(edit).toContain('Preview v1');
    expect(edit).toContain('The view has 5 columns; the sample takes the first 20 rows (at most 20 rows).');
    expect(edit).toContain('Hash · VARCHAR');
    // 编辑区与返回链接
    expect(edit).toContain('Viewing');
    expect(edit).toContain('Source views of shop-db');
    expect(edit).toContain('Validate and save draft');
    // 另一位成员发布后，版本表里的发布时间是英文格式（zh-CN 是 2026/11/21 10:30:00 这样的 24 小时制）
    const viewPath = locationOf(created).replace(/\?.*$/, '');
    expect((await admin.post(viewPath, { intent: 'publish', version: '1' })).status).toBe(302);
    const versions = stripScripts(await (await author.get(`${viewPath}?tab=versions`)).text());
    expect(versions).not.toMatch(/[一-鿿]/);
    expect(versions).toMatch(/admin@acme\.com, \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
    for (const head of ['Version</th>', 'Status</th>', 'Authors</th>', 'Published</th>', 'View</a>']) expect(versions).toContain(head);
  });
});

describe('中文界面输出与改造前一致', () => {
  it('数据源卡片的登记日期与版本表的发布时间仍是 zh-CN 格式（2026/11/21、2026/11/21 10:30:00）', async () => {
    const { sourceId } = await syncedSource();
    const author = await loginAs(app, 'de@acme.com');
    const list = await (await author.get('/sources')).text();
    expect(list).toMatch(/登记于 \d{4}\/\d{1,2}\/\d{1,2}/);
    expect(list).toContain('校验并登记');

    const created = await author.post(`/sources/${sourceId}/views/new`, { intent: 'create', name: 'active_emails', sql: VIEW });
    const viewPath = locationOf(created).replace(/\?.*$/, '');
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await admin.post(viewPath, { intent: 'publish', version: '1' })).status).toBe(302);
    const versions = await (await author.get(`${viewPath}?tab=versions`)).text();
    expect(versions).toMatch(/admin@acme\.com，\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
  });
});

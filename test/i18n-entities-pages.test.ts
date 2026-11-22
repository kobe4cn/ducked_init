// test/i18n-entities-pages.test.ts —— 自定义实体列表、详情页与关联建议卡片接入双语（#1044，ADR-0060）：
// 卡片是纯函数静态渲染（不连库，vi.mock 掉 react-router 的 Form——静态渲染里没有路由上下文）：英文词典经 I18nProvider 注入后
// 界面文字没有汉字（关系文字 relationText 是代码名，不翻），中文界面词典不下发、按中文原文回退。
// 两个页面用 HTTP 整页断言（CRM_ENABLE_EN_LOCALE + crm_locale cookie）：英文界面下写死的文字没有汉字——断言前去掉水合 script 与
// /locale 表单（词典键就是中文原文、「中文」按母语名显示），带表单的页面再去掉下拉选项的标签（终点实体的中文名是路由传的数据，不翻）；
// 实体类型经 builtinName 显示英文，列表页 action 的未知操作 400 走 formatServer 回显英文，版本表的作者「、」连接与发布时间的「，」
// 分隔按英文格式（', '）、日期按英文格式；夹具全 ASCII（数据值不翻，整页断言不用剔数据值）。
// 详情页编辑态由 admin（不是最后保存草稿的人）看——作者自己看会带服务端算好的中文 publishBlocker（#1102，不在本票）；
// 中文界面下输出与改造前一致（列表「已发布 v1」、版本表 admin@acme.com，2026/11/21 10:30:00 的 24 小时制）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../app/.server/db/client';
import { createCustomEntity, publishCustomEntity } from '../app/.server/custom-entities';
import { createDispatcher } from '../app/.server/pipeline/dispatcher';
import { registerSource } from '../app/.server/sources';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Form: (props: { children?: unknown }) => createElement('form', { method: 'post' }, props.children as never),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { RelationSuggestionsCard } from '../app/components/relation-suggestions-card';
import { discardHint } from '../app/lib/custom-entity-text';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';
import { memberOf, newTenant, selectAllTables } from './pipeline/fixtures';
import { pgSourceInput, READER } from './pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './http/harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

/** 按界面语言静态渲染；中文界面词典传 null（词典未下发），与真实中文界面一致 */
const render = (locale: 'en' | 'zh-CN', node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nProvider, { t: makeT(locale, locale === 'en' ? enClient : null), locale, children: node }));

/** 夹具：关系只由代码名组成（relationText 不翻），checked 两种取值各一条 */
const SUGGESTIONS = [
  { relation: { from: { entity: 'custom_store', field: 'region_id' }, ref: { entity: 'custom_region', field: 'region_id' } }, checked: 'values' as const },
  { relation: { from: { entity: 'order', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }, checked: 'name-only' as const },
];

describe('英文界面：关联建议卡片', () => {
  it('标题、说明与两个核对徽标、采纳按钮都是英文，没有汉字；关系文字是代码名、原样', () => {
    const html = render('en', createElement(RelationSuggestionsCard, { suggestions: SUGGESTIONS, submitting: false }));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Suggested relations');
    expect(html).toContain('Values verified');
    expect(html).toContain('Values not verified');
    expect(html).toContain('>Adopt</button>');
    // 关系文字（relationText）只拼代码名，不随界面语言变化
    expect(html).toContain('data-relation-suggestion="custom_store.region_id → custom_region.region_id"');
    expect(html).toContain('data-checked="values"');
    expect(html).toContain('data-checked="name-only"');
  });
});

describe('中文界面：关联建议卡片输出与改造前一致', () => {
  it('标题、说明、核对徽标与按钮仍是原文，提交中禁用', () => {
    const html = render('zh-CN', createElement(RelationSuggestionsCard, { suggestions: SUGGESTIONS, submitting: true }));
    expect(html).toContain('推荐关系');
    expect(html).toContain('按字段名与终点主键相似推荐；起点的常见取值都在终点的标准层里找到时标「取值已核对」。采纳后关系追加到登记草稿，你成为最后保存的人，需由另一位成员发布。');
    expect(html).toContain('取值已核对');
    expect(html).toContain('未核对取值');
    expect(html).toContain('>采纳</button>');
    expect(html).toContain('disabled=""');
  });
});

/** 开通租户 acme，de@acme.com 登记一个 ASCII 夹具实体（数据值不翻，整页断言不用剔数据值），published 时由 admin 发布 */
async function storeEntity(published = false) {
  const tenantId = await newTenant('acme');
  const de = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const id = await createCustomEntity(de, {
    name: 'custom_store', label: 'Store', kind: 'dimension',
    fields: [
      { name: 'store_id', type: 'string', description: '', sensitive: false },
      { name: 'manager_phone', type: 'string', description: '', sensitive: false },
    ],
    primaryKey: ['store_id'],
  });
  if (published) await publishCustomEntity(await memberOf(tenantId, 'admin@acme.com'), id, 1);
  return { tenantId, page: `/entities/${id}` };
}

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换表单的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 表单页里下拉选项的标签是路由传的数据（标准实体的中文名），断言无汉字前去掉选项文字（option 的 value 不变，另行断言） */
const stripOptions = (html: string) => html.replace(/(<option[^>]*>)[^<]*(<\/option>)/g, '$1$2');
// 知识面板整段去掉：面板 UI 文案随它自己的票翻译，这里剩下的中文是目录数据（声明类型、枚举取值）
const stripData = (html: string) => stripOptions(html)
  .replace(/<section data-knowledge-panel[\s\S]*?<\/section>/g, '')
  .replace(/aria-label="[^"]*[一-鿿][^"]*"/g, 'aria-label=""');

describe('英文界面：自定义实体列表与详情页', () => {
  it('列表页写死的文字没有汉字：页头说明、表头与草稿句式，实体类型显示英文；action 的未知操作 400 回显英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    await storeEntity();
    const author = await loginAs(app, 'de@acme.com');
    author.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await author.get('/entities')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Custom Entities');
    // 表头与句式；实体类型经 builtinName 显示英文，实体名与中文名是数据、原样
    expect(html).toContain('Display name</th>');
    expect(html).toContain('Draft v1');
    expect(html).toContain('Dimension');
    expect(html).toContain('data-custom-entity="custom_store"');

    // action 的报错走 formatServer（en.server.json）：未知操作 400，回显英文、表单页（去掉数据选项）仍无汉字
    const rejected = await author.post('/entities', { intent: 'bogus' });
    expect(rejected.status).toBe(400);
    const errorPage = stripOptions(stripScripts(await rejected.text()));
    expect(errorPage).toContain('Unknown operation');
    expect(errorPage).toContain('Not saved');
    expect(errorPage).not.toMatch(/[一-鿿]/);
  });

  it('空列表：只读成员看到空态说明，没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    analyst.store('crm_locale=en; Path=/');
    const empty = stripScripts(await (await analyst.get('/entities')).text());
    expect(empty).not.toMatch(/[一-鿿]/);
    expect(empty).toContain('No custom entities yet');
  });

  it('一键直通表单写死的文字没有汉字：标题、说明、字段标签、占位与按钮（源表下拉的选项是数据，去掉）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const tenantId = await newTenant('acme');
    const de = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
    const { id: sourceId } = await registerSource(de, await pgSourceInput(READER, 'shop-db'));
    await selectAllTables(de, sourceId);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    const author = await loginAs(app, 'de@acme.com');
    author.store('crm_locale=en; Path=/');
    const html = stripOptions(stripScripts(await (await author.get('/entities?passthrough=1')).text()));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Generate from a source table');
    expect(html).toContain('Source table');
    expect(html).toContain('Entity name (optional)');
    expect(html).toContain('custom_&lt;table&gt;');
    expect(html).toContain('Generate registration and mapping drafts');
    expect(html).toContain('value="customers"');
  });

  it('详情页编辑态（admin 看别人保存的草稿）写死的文字没有汉字：返回链接、编辑提示、标签页、表单提交按钮与丢弃说明', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { page } = await storeEntity();
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const html = stripOptions(stripScripts(await (await admin.get(page)).text()));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('← All custom entities');
    expect(html).toContain('Viewing');
    // 编辑提示（admin 看别人保存的草稿）与表单提交按钮；丢弃说明（从没发布过、将被删除）
    expect(html).toContain('Once you save, you are the last person to have edited this draft');
    expect(html).toContain('Save draft');
    // 丢弃说明只在 confirm() 里（SSR 不输出事件处理器），这里断言丢弃按钮本身是英文
    expect(html).toContain('Discard draft');
    expect(html).toContain('Versions (1)');
    expect(html).toContain('Delete entity');
  });

  it('详情页只读态（分析师看已发布的版本）没有汉字：句式里的类型与主键是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { tenantId, page } = await storeEntity(true);
    await memberOf(tenantId, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    analyst.store('crm_locale=en; Path=/');
    const html = stripData(stripScripts(await (await analyst.get(page)).text()));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Read-only.');
    expect(html).toMatch(/Store · Dimension · Primary key /);
    expect(html).toContain('store_id');
  });

  it('详情页版本标签页（发布后）没有汉字：作者与发布时间的分隔、日期是英文格式', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { page } = await storeEntity(true);
    const admin = await loginAs(app, 'admin@acme.com');
    admin.store('crm_locale=en; Path=/');
    const html = stripData(stripScripts(await (await admin.get(`${page}?tab=versions`)).text()));
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('>Authors</th>');
    // 发布时间：邮箱与时间用英文逗号分隔，日期按英文格式（zh-CN 是 admin@acme.com，2026/11/21 10:30:00）
    expect(html).toMatch(/admin@acme\.com, \d{1,2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/);
    expect(html).toContain('>View</a>');
  });
});

describe('中文界面：输出与改造前一致', () => {
  it('列表页与详情页的句式、日期格式仍是改造前的中文', async () => {
    const { page } = await storeEntity(true);
    const author = await loginAs(app, 'de@acme.com');
    expect(await (await author.get('/entities')).text()).toContain('已发布 v1');
    const detail = await (await author.get(page)).text();
    expect(detail).toContain('编辑');
    expect(detail).toContain('版本（1）');
    const versions = await (await author.get(`${page}?tab=versions`)).text();
    expect(versions).toMatch(/admin@acme\.com，\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/);
  });
});

describe('丢弃草稿的说明（只在 confirm() 里，SSR 不输出，测纯函数 discardHint）', () => {
  const MAPPINGS = [{ source: 'A', table: 't1' }, { source: 'B', table: 't2' }];
  const en = makeT('en', enClient);
  const zh = makeT('zh-CN', null);

  it('发布过：回到最近的已发布版本', () => {
    expect(discardHint(en, true, MAPPINGS)).not.toMatch(/[一-鿿]/);
    expect(discardHint(en, true, MAPPINGS)).not.toContain('t1');
    expect(discardHint(zh, true, MAPPINGS)).toBe('回到最近的已发布版本');
  });

  it('从没发布过且没有配套映射草稿：只说将被删除', () => {
    const text = discardHint(en, false, []);
    expect(text).not.toMatch(/[一-鿿]/);
    expect(text).toBe('This custom entity has never been published and will be deleted');
    expect(discardHint(zh, false, [])).toBe('这个自定义实体从没发布过，将被删除');
  });

  it('从没发布过且有两条映射草稿：英文用 "源" 表 与 ", " 分隔，中文与改造前逐字一致', () => {
    const text = discardHint(en, false, MAPPINGS);
    expect(text).not.toMatch(/[一-鿿]/);
    expect(text).toContain('"A" t1, "B" t2');
    expect(discardHint(zh, false, MAPPINGS)).toBe('这个自定义实体从没发布过，将被删除，目标是它的映射草稿一并丢弃：「A」t1、「B」t2');
  });
});

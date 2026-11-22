// test/i18n-template-page.test.ts —— 模板参数页接入双语（#1049，ADR-0060）：
// 英文界面下页面写死的文字没有汉字（HTTP 整页断言 + 整页静态渲染）：页头、RFM 表单、分群规则表、版本表、升级提示条与预览结果
// （分群对比、迁移矩阵、样例消费者、下游影响）都是英文，数字按界面语言格式化；样例消费者的「是 / 否」也是英文。
// 升级预览「样例消费者」表的 RFM 人群值（#1017 遗留）：默认人群名按界面语言翻译（builtinName + defaults 名单），
// 租户改过名的人群原样；行 / 列键与表单提交的 before / after 仍是存储原值。
// HTTP 断言前去掉水合 script 与 /locale 表单（词典键是中文原文、「中文」按母语名显示）；
// 静态渲染照 knowledge-route-render.test.ts mock 掉 react-router 的 data router hooks，被测组件在 mock 之后导入，
// 夹具里的数据值（人群名、改动说明、接口路径）用英文或会被翻译的内置名，整页断言不用剔数据值；
// 中文界面词典不下发（makeT('zh-CN', null)），按中文原文回退，输出与改造前一致。
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../app/.server/db/client';
import { createDispatcher } from '../app/.server/pipeline/dispatcher';
import { RFM_DEFAULTS } from '../app/.server/pipeline/templates/rfm';
import { memberOf, useDefaultTemplates } from './pipeline/fixtures';
import { publishedIdentitySources } from './pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './http/harness';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigation: () => ({ state: 'idle', formData: null }),
    useLocation: () => ({ pathname: '/analytics/templates/rfm', search: '', hash: '', state: null, key: 'render' }),
    useFetcher: () => ({ state: 'idle', data: undefined, load: () => {}, submit: () => {} }),
    // 顶栏的界面语言入口读 root loader 数据；这里没有 root，返回 undefined 即不渲染入口
    useRouteLoaderData: () => undefined,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import TemplateParamsDefault from '../app/routes/analytics.templates.$id';
import type { Route } from '../app/routes/+types/analytics.templates.$id';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClientJson from '../app/i18n/en.client.json';

const enClient = enClientJson as Record<string, string>;

let app: TestApp;
// 模板参数页与升级用例依赖自动启用的默认模板（还有它们触发的下游影响）：关掉 setup-env 默认打开的 CRM_TEST_SKIP_DEFAULT_TEMPLATES（#997）
useDefaultTemplates();
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => vi.unstubAllEnvs());

/** 水合数据里的脚本会带中文原文（键就是中文），/locale 表单的「中文」按母语名显示；断言无汉字前去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 把一套分群规则写成表单字段（rfmParamsOf 读的名字与条件数组，没填的一端是空串） */
const ruleForm = (segments: typeof RFM_DEFAULTS.segments) => {
  const end = (get: (s: typeof RFM_DEFAULTS.segments[number]) => number | undefined) => segments.map(s => String(get(s) ?? ''));
  return {
    segment: segments.map(s => s.name),
    rMin: end(s => s.r?.min), rMax: end(s => s.r?.max),
    fMin: end(s => s.f?.min), fMax: end(s => s.f?.max),
    mMin: end(s => s.m?.min), mMax: end(s => s.m?.max),
  };
};

describe('英文界面：模板参数页', () => {
  it('页面写死的文字没有汉字：页头、RFM 表单、分群规则表、版本表与空态；人群输入值是租户起的英文名（数据不翻），保存提交的原值', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const analyst = await loginAs(app, 'analyst@acme.com');
    // 起草一份把人群都改成英文名的参数（数据值全 ASCII，整页断言不用剔数据值）
    const segments = [
      { name: 'My VIP', r: { min: 4 }, f: { min: 4 }, m: { min: 4 } },
      { name: 'Others' },
    ];
    expect((await analyst.post('/analytics/templates/rfm', {
      intent: 'save', lookbackDays: '365', status: ['paid', 'shipped', 'completed'], binning: 'quintile', ...ruleForm(segments),
    })).status).toBe(302);
    // 由 de（不是最后保存草稿的人）看：作者自己看会带服务端算好的中文 publishBlocker（#1102，不在本票）
    const de = await loginAs(app, 'de@acme.com');
    de.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await de.get('/analytics/templates/rfm')).text());
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/[一-鿿]/);
    // 页头与当前生效：默认模板随首次合并自动发布第 1 版（ADR-0021），草稿是第 2 版
    expect(html).toContain('RFM Segmentation · Template parameters');
    expect(html).toContain('← Analytics');
    expect(html).toContain(' Current: version 1');
    // 表单：标签、选项、分群规则表与提交按钮
    expect(html).toContain('Lookback days');
    expect(html).toContain('Binning method');
    expect(html).toContain('Quintile (five equal groups by consumer rank)');
    expect(html).toContain('Fixed thresholds');
    expect(html).toContain('Order statuses included');
    expect(html).toContain('R score (min – max)');
    expect(html).toContain('Add a rule');
    expect(html).toContain('The first matching rule applies in order');
    expect(html).toContain('Validate and save draft');
    expect(html).toContain('Draft of version 2');
    // 版本表
    expect(html).toContain('Last saved');
    // 数据值：人群输入框是租户起的英文名，表单提交的也是它
    expect(html).toContain('value="My VIP"');
  });

  it('通用参数表单（注册表里的 form）：流失预警与同期群的字段标签、下拉选项是英文，没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    const de = await loginAs(app, 'de@acme.com');
    de.store('crm_locale=en; Path=/');
    const churn = stripScripts(await (await de.get('/analytics/templates/churn')).text());
    expect(churn).toContain('lang="en"');
    expect(churn).not.toMatch(/[一-鿿]/);
    expect(churn).toContain('Lookback days');
    expect(churn).toContain('Minimum orders');
    expect(churn).toContain('Silence multiplier');
    expect(churn).toContain('Minimum gap (days)');
    expect(churn).toContain('Order statuses included');
    const cohort = stripScripts(await (await de.get('/analytics/templates/cohort')).text());
    expect(cohort).not.toMatch(/[一-鿿]/);
    expect(cohort).toContain('Period');
    expect(cohort).toContain('Number of periods');
    expect(cohort).toContain('>Monthly<');
    expect(cohort).toContain('>Weekly<');
  });

  it('升级预览与「样例消费者」：界面文字是英文，默认人群名按词典显示英文、租户改过名的人群原样（v2 是湖里 v2: 前缀原值）；提交的格子仍是存储原值', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'de@acme.com', 'data_engineer');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle(); // 跑完任务让 RFM 进服务库（下游影响）
    // 开关在自动发布默认模板之后再打开（否则第 1 版会直接锁到测试的 v2，预览报「已是最新模板版本」）
    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    const analyst = await loginAs(app, 'analyst@acme.com');
    analyst.store('crm_locale=en; Path=/');
    const de = await loginAs(app, 'de@acme.com');

    // 先按默认参数预览一次，从迁移矩阵解析出非零的格子（渲染成按钮的才有样例），挑一个默认人群的格子
    const first = stripScripts(await (await analyst.post('/analytics/templates/rfm', { intent: 'preview-upgrade', asOf: '2024-12-31' })).text());
    const defaultNames = new Set(RFM_DEFAULTS.segments.map(s => s.name));
    const cells = [...first.matchAll(/data-sample-cell="([^"]*)→([^"]*)"/g)].map(m => [m[1], m[2]] as const);
    expect(cells.length).toBeGreaterThan(0);
    const byDefault = cells.find(([before]) => defaultNames.has(before));
    expect(byDefault).toBeDefined();
    const [defaultBefore, defaultAfter] = byDefault!;
    // 这个格子的样例：v1 人群名按词典英文，中文原名不出现在单元格里；标题与并排列头是英文
    const defaultSampled = stripScripts(await (await analyst.post('/analytics/templates/rfm', {
      intent: 'preview-sample', asOf: '2024-12-31', before: defaultBefore, after: defaultAfter,
    })).text());
    expect(defaultSampled).toContain('Sample consumers (up to 10, sorted by consumer_id, old segment → new segment)');
    expect(defaultSampled).toContain('v1 segment');
    expect(defaultSampled).toContain('v2 segment');
    expect(defaultSampled).toMatch(new RegExp(`>${enClient[defaultBefore]}<`));
    expect(defaultSampled).not.toMatch(new RegExp(`>${defaultBefore}<`));
    expect(defaultSampled).toContain(defaultAfter); // v2 是湖里的原值

    // 起草并发布一份把上一个人群改成租户名「我的VIP」的参数（规则不变，同样的人还在这一格）；默认模板已自动发布第 1 版，这次是第 2 版
    const renamed = '我的VIP';
    const segments = RFM_DEFAULTS.segments.map(s => (s.name === defaultBefore ? { ...s, name: renamed } : s));
    expect((await analyst.post('/analytics/templates/rfm', {
      intent: 'save', lookbackDays: '365', status: RFM_DEFAULTS.statuses, binning: 'quintile', ...ruleForm(segments),
    })).status).toBe(302);
    expect((await de.post('/analytics/templates/rfm', { intent: 'publish', version: '2' })).status).toBe(302);

    const preview = stripScripts(await (await analyst.post('/analytics/templates/rfm', { intent: 'preview-upgrade', asOf: '2024-12-31' })).text());
    // 提示条、分群对比与迁移矩阵的界面文字
    expect(preview).toContain('New template version v2 available (current v1)');
    expect(preview).toContain('Preview upgrade diff');
    expect(preview).toContain('Upgrade to the new version');
    expect(preview).toContain('v1 → v2, as of 2024-12-31');
    expect(preview).toContain('Segment comparison');
    expect(preview).toContain('v1 consumers');
    expect(preview).toContain('v2 share');
    expect(preview).toContain('Migration matrix (old segment × new segment, unchanged consumers included; “(none)” means added or removed; click a count to see samples)');
    expect(preview).toContain('Old segment \\ New segment');
    // 一句话结论按界面语言拼（结构由服务端算好），不再是服务端拼好的中文
    expect(preview).toContain('Unchanged: ');
    expect(preview).toContain('largest migration: ');
    expect(preview).not.toContain('没变的人占');
    expect(preview).not.toContain('人数最多的迁移');
    // 下游影响
    expect(preview).toContain('Downstream impact');
    expect(preview).toContain('serving.rfm');
    expect(preview).toContain('External endpoint GET /api/v1/consumers/:consumerId reads this table');
    // 人群名：租户改名的「我的VIP」原样显示，被改名的默认人群不再出现英文译名
    expect(preview).toMatch(new RegExp(`>${renamed}<`));
    expect(preview).not.toMatch(new RegExp(`>${enClient[defaultBefore]}<`));
    // 点「我的VIP」那一行的非零格子，样例表里租户人群名原样（不是 defaults 名单里的名字，不翻）
    const cell = preview.match(new RegExp(`data-sample-cell="${renamed}→([^"]*)"`))![1];
    const sampled = stripScripts(await (await analyst.post('/analytics/templates/rfm', {
      intent: 'preview-sample', asOf: '2024-12-31', before: renamed, after: cell,
    })).text());
    expect(sampled).toContain('Sample consumers (up to 10, sorted by consumer_id, old segment → new segment)');
    expect(sampled).toMatch(new RegExp(`>${renamed}<`));
    expect(sampled).toContain(`>${cell}<`);
  });

  it('流失预警按列对比与样例：表头、类型与「换了取值」是英文，样例的布尔值显示 Yes / No；没有下游使用', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { acme } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
    // 同上：开关在自动发布默认模板之后再打开
    vi.stubEnv('TEMPLATE_TEST_VERSIONS', '1');
    const analyst = await loginAs(app, 'analyst@acme.com');
    analyst.store('crm_locale=en; Path=/');
    const churn = stripScripts(await (await analyst.post('/analytics/templates/churn', { intent: 'preview-upgrade', asOf: '2024-10-15' })).text());
    expect(churn).toContain('Column comparison');
    expect(churn).toContain('Consumers with changed values');
    expect(churn).toContain('No downstream usage');
    // 一句话结论（按列）：整句英文，变化最大的字段是布尔列 at_risk
    expect(churn).toContain('Unchanged: ');
    expect(churn).toContain('biggest field change: at_risk = yes: ');
    expect(churn).not.toContain('没变的人占');
    expect(churn).not.toContain('变化最大的字段');
    const sampled = stripScripts(await (await analyst.post('/analytics/templates/churn', { intent: 'preview-sample', asOf: '2024-10-15', column: 'at_risk' })).text());
    expect(sampled).toContain('Sample consumers (up to 10, sorted by consumer_id, changed values)');
    // 每个人都换了取值：同一行里 v1 与 v2 的 at_risk 相反（Yes / No）
    expect(sampled).toMatch(/<td[^>]*>(Yes|No)<\/td><td[^>]*>(No|Yes)<\/td>/);
    expect(sampled).not.toContain('>是<');
    expect(sampled).not.toContain('>否<');
  });
});

/** 静态渲染的路由数据（状态 A：没有草稿，预览结果已带回）：数据值要么是 ASCII，要么是会被 builtinName 翻译的默认人群名 */
const LOADER_BASE = {
  email: 'an@acme.com',
  nav: [{ to: '/analytics', label: 'Analytics' }],
  canDraft: true,
  canSample: true,
  recomputeDenied: null,
  today: '2026-11-22',
  justPublished: null,
  justRecomputed: null,
  justUpgraded: null,
  upgradeAvailable: true,
  latestTemplateVersion: 2,
  lockedTemplateVersion: 1,
  upgradeChanges: [{ version: 2, changes: 'rename tags' }],
  draftTemplateVersion: null,
  label: 'RFM 分层',
  defaultSegmentNames: RFM_DEFAULTS.segments.map(s => s.name),
  fields: null,
  form: {
    lookbackDays: 365, statuses: ['paid', 'shipped', 'completed'], binning: { method: 'quintile' },
    segments: [
      { name: 'My VIP', r: { min: 4 }, f: { min: 4 }, m: { min: 4 } },
      { name: 'Everyone' },
    ],
  },
  published: 1,
  versions: [{
    version: 1, status: 'published', authors: ['de@acme.com'], lastEditor: 'de@acme.com',
    publishedByEmail: 'de@acme.com', publishedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', publishBlocker: null,
  }],
};
const LOADER_A = LOADER_BASE as unknown as Route.ComponentProps['loaderData'];

/** 状态 A 的预览结果：分群对比 + 迁移矩阵 + 样例消费者 + 下游影响（counts 覆盖复数与吊销） */
const ACTION_A = {
  error: null,
  upgradeDiff: {
    from: 1, to: 2, asOf: '2026-11-22',
    // 一句话结论只下发结构（中文句式与改造前服务端拼的逐字一致，由下面的断言锁住）
    summary: { detail: { kind: 'segment', topMove: { before: '重要价值', after: 'v2:Everyone', consumers: 3 } }, unchangedShare: 0, changedShare: 0.75, warn: false },
    distribution: {
      kind: 'segments',
      // 湖里 v2 一侧的人群名带 v2: 前缀、不在 defaults 名单里，显示原值：夹具用 ASCII，整页断言不用剔数据值；
      // 重要价值是 defaults 里的默认人群名，经 builtinName 显示成 Champions
      before: [{ segment: 'My VIP', consumers: 1 }, { segment: '重要价值', consumers: 3 }],
      after: [{ segment: 'v2:My VIP', consumers: 1 }, { segment: 'v2:Everyone', consumers: 3 }],
      matrix: [{ before: 'My VIP', after: 'v2:My VIP', consumers: 1 }, { before: '重要价值', after: 'v2:Everyone', consumers: 3 }],
    },
    metric: { changed: 2, added: 1, removed: 1 },
  },
  downstream: {
    table: 'serving.rfm',
    paths: ['GET /api/v1/consumers/:consumerId'],
    keys: [{ name: 'partner', calls: 3, revoked: false }, { name: 'legacy', calls: 1, revoked: true }],
  },
  sample: {
    pick: { kind: 'cell', before: 'My VIP', after: 'v2:My VIP' },
    columns: ['segment', 'frequency'],
    rows: [
      { consumerId: 'c1', before: { segment: 'My VIP', frequency: 2 }, after: { segment: 'v2:My VIP', frequency: 3 } },
      { consumerId: 'c2', before: { segment: '重要价值', frequency: 1 }, after: { segment: 'v2:Everyone', frequency: 1 } },
    ],
  },
} as unknown as Route.ComponentProps['actionData'];

/** 状态 B：刚确认升级（v2 草稿锁定新模板版本），预览结果收起 */
const LOADER_B = {
  ...LOADER_BASE,
  justUpgraded: 2,
  draftTemplateVersion: 2,
  versions: [
    { version: 2, status: 'draft', authors: ['an@acme.com'], lastEditor: 'an@acme.com', publishedByEmail: null, publishedAt: null, updatedAt: '2026-11-21T00:00:00Z', publishBlocker: null },
    ...LOADER_BASE.versions,
  ],
} as unknown as Route.ComponentProps['loaderData'];

/** 按界面语言静态渲染整页；中文界面词典传 null（词典未下发），与真实中文界面一致 */
const render = (locale: 'en' | 'zh-CN', loaderData: Route.ComponentProps['loaderData'], actionData: Route.ComponentProps['actionData']) =>
  renderToStaticMarkup(createElement(I18nProvider, {
    t: makeT(locale, locale === 'en' ? enClient : null),
    locale,
    children: createElement(TemplateParamsDefault, { loaderData, actionData } as Route.ComponentProps),
  }));

describe('英文界面：整页静态渲染', () => {
  it('预览展开时写死的文字没有汉字：表单、版本表、提示条、分群对比、迁移矩阵、样例消费者与下游影响；默认人群名按词典英文，租户名原样', () => {
    const html = render('en', LOADER_A, ACTION_A);
    // 迁移矩阵的格子按钮按设计提交湖里原值：hidden 的 before / after 与 data-sample-cell 里的人群名可以是中文，不算可见文字
    const visible = html.replace(/data-sample-cell="[^"]*"/g, '').replace(/name="(before|after)" value="[^"]*"/g, '');
    expect(visible).not.toMatch(/[一-鿿]/);
    // 表单与版本表
    expect(html).toContain('Lookback days');
    expect(html).toContain('Edit parameters (saving creates a new draft version)');
    expect(html).toContain('Validate and save draft');
    expect(html).toContain('Last saved');
    expect(html).toContain('Recompute');
    // 提示条与预览结果
    expect(html).toContain('New template version v2 available (current v1)');
    expect(html).toContain('Preview before upgrading:');
    expect(html).toContain('Preview upgrade diff');
    expect(html).toContain('Upgrade to the new version');
    expect(html).toContain('v1 → v2, as of 2026-11-22');
    expect(html).toContain('v2: rename tags');
    expect(html).toContain('Values changed for 2 consumers, 1 added, 1 removed');
    expect(html).toContain('Segment comparison');
    expect(html).toContain('v1 consumers');
    expect(html).toContain('v2 share');
    expect(html).toContain('Migration matrix (old segment × new segment, unchanged consumers included; “(none)” means added or removed; click a count to see samples)');
    expect(html).toContain('Old segment \\ New segment');
    // 一句话结论：结构在服务端算好、整句按界面语言拼；分群名与表格同规则（默认名英文、v2: 原值原样）
    expect(html).toContain('Unchanged: 0.0%; largest migration: Champions → v2:Everyone, 3 consumers.');
    // 样例消费者：标题、并排列头、默认人群名英文（重要价值 → Champions）、租户名与湖里 v2: 原值原样
    expect(html).toContain('Sample consumers (up to 10, sorted by consumer_id, old segment → new segment)');
    expect(html).toContain('v1 segment');
    expect(html).toContain('v2 segment');
    expect(html).toContain('>Champions<');
    expect(html).toContain('>My VIP<');
    expect(html).toContain('>v2:My VIP<');
    // 下游影响：服务库表、对外接口与 API Key 的次数复数（one / other）、吊销
    expect(html).toContain('Serving store table serving.rfm; it switches to the new result on the next computation after the upgrade is published');
    expect(html).toContain('External endpoint GET /api/v1/consumers/:consumerId reads this table');
    expect(html).toContain('API keys that read it in the last 30 days:');
    expect(html).toContain('partner · 3 calls');
    expect(html).toContain('legacy (revoked) · 1 call');
  });

  it('刚确认升级（v2 草稿锁定新模板版本）：页头草稿、提示与说明都是英文，没有汉字', () => {
    const html = render('en', LOADER_B, undefined);
    expect(html).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Draft of version 2');
    expect(html).toContain('Drafted version 2, locked to template v2');
    expect(html).toContain('Once another Data Engineer or Admin publishes it, computation follows the new version.');
    expect(html).toContain('Draft version 2 is locked to template v2; once another Data Engineer or Admin publishes it, computation follows the new version. Until it is published, v1 is still used.');
  });
});

describe('中文界面：整页静态渲染与改造前一致', () => {
  it('词典不下发，页面文字仍是中文原文（表单、提示条、矩阵、样例、下游影响与刚升级的说明）', () => {
    const html = render('zh-CN', LOADER_A, ACTION_A);
    expect(html).toContain('回看天数');
    expect(html).toContain('分箱方式');
    expect(html).toContain('五分位（按消费者排名五等分）');
    expect(html).toContain('计入的订单状态');
    expect(html).toContain('人群');
    expect(html).toContain('R 分（最低 – 最高）');
    expect(html).toContain('添加一条');
    expect(html).toContain('校验并保存草稿');
    expect(html).toContain('编辑参数（保存后成为新的一版草稿）');
    expect(html).toContain('最后保存');
    expect(html).toContain('重新计算');
    expect(html).toContain('有新的模板版本 v2（当前 v1）');
    expect(html).toContain('升级前先预览：以生效的参数分别按 v1 与 v2 计算，按消费者对比给计数与统计量，点迁移矩阵的格子或输出列的「换了取值」可看样例消费者。确认升级后生成一版草稿，发布之前仍按 v1 计算。');
    expect(html).toContain('预览升级差异');
    expect(html).toContain('升级到新版本');
    expect(html).toContain('v1 → v2，统计日 2026-11-22');
    expect(html).toContain('取值变化 2 人，新增 1 人，移出 1 人');
    // 一句话结论的中文与改造前服务端拼的逐字一致（upgrade-summary.ts 原文）
    expect(html).toContain('没变的人占 0.0%；人数最多的迁移：重要价值 → v2:Everyone，3 人。');
    expect(html).toContain('分群对比');
    expect(html).toContain('v1 人数');
    expect(html).toContain('v2 占比');
    expect(html).toContain('迁移矩阵（原分群 × 新分群，含没变的人，「（无）」是新增或移出，点人数查看样例）');
    expect(html).toContain('原分群 ＼ 新分群');
    expect(html).toContain('样例消费者（最多 10 个，按 consumer_id 排序，原分群 → 新分群）');
    expect(html).toContain('>重要价值<');
    expect(html).toContain('下游影响');
    expect(html).toContain('服务库表 serving.rfm，升级发布后下一次计算时切换到新结果');
    expect(html).toContain('对外接口 GET /api/v1/consumers/:consumerId 读取这张表');
    expect(html).toContain('最近 30 天读取的 API Key：');
    expect(html).toContain('partner · 3 次');
    // 次数与改造前一样不加千分位（`${calls} 次`）
    const many = render('zh-CN', LOADER_A, { ...ACTION_A, downstream: { ...ACTION_A!.downstream, keys: [{ name: 'busy', calls: 1234, revoked: false }, { name: 'old', calls: 1234, revoked: true }] } } as Route.ComponentProps['actionData']);
    expect(many).toContain('busy · 1234 次');
    expect(many).toContain('old（已吊销） · 1234 次');
    expect(html).toContain('legacy（已吊销） · 1 次');

    const upgraded = render('zh-CN', LOADER_B, undefined);
    expect(upgraded).toContain('第 2 版草稿');
    expect(upgraded).toContain('已起草第 2 版，锁定模板 v2');
    expect(upgraded).toContain('由另一位数据工程师或管理员发布后按新版本计算。');
    expect(upgraded).toContain('第 2 版草稿已锁定模板 v2，由另一位数据工程师或管理员发布后按新版本计算；发布之前仍按 v1 计算。');
  });
});

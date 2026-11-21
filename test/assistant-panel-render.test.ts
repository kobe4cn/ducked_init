// test/assistant-panel-render.test.ts —— 助手面板界面文字接入双语（#1013，ADR-0060）的服务端渲染（纯函数，不连库）：
// 英文词典（en.client.json）经 I18nProvider 注入后渲染 AssistantPanel / ConversationList / AssistantMessages /
// PlanCard / KnowledgeAskCard 的典型状态，界面文字（按钮、标题、占位符、状态、空态）不能有汉字；作为 props 传进来的
// 数据（模型答复、工具名、计划卡字段、候选与条目名）是租户与服务端内容、不算界面文字，夹具里全用 ASCII，对整个输出断言。
// 中文界面（词典 null）回退中文原文，输出与接入前一致（验收标准 3）。发给服务端的固定续写（DRAFT_FOLLOW_UP 等）不走
// t()（验收标准 2），仍是源码里的中文字面量——棘轮基线里 plan-card.tsx 剩的两行就是它们。仓库没有 jsdom：AssistantPanel
// 依赖 conversationId 状态的分享表单静态渲染点不开，由 test/i18n-catalog.test.ts 的键对账与浏览器验收覆盖；
// useFetcher 等 data router hooks 在静态渲染里没有上下文，vi.mock 掉 react-router（Link 渲染成原生 <a>），
// 被测组件在 mock 之后导入（同 test/knowledge-route-render.test.ts）
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';
import type { PlanCardView } from '../app/.server/assistant/plan-card';
import type { AskCard } from '../app/.server/assistant/knowledge-ask';

const router = vi.hoisted(() => ({
  fetcher: { state: 'idle', data: undefined, load: () => {}, submit: () => {} } as { state: string; data?: unknown; load: () => void; submit: () => void },
}));

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useLocation: () => ({ pathname: '/workbench', search: '', hash: '', state: null, key: 'render' }),
    useFetcher: () => router.fetcher,
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { AssistantMessages, AssistantPanel, ConversationList, type Message, type Summary } from '../app/components/assistant-panel';
import { PlanCard } from '../app/components/plan-card';
import { KnowledgeAskCard } from '../app/components/knowledge-ask-card';

/** /assistant GET 的典型返回：静态渲染不跑 effects，面板内容全靠 fetcher 的 data 出 */
const overview = (over: Record<string, unknown> = {}) => ({
  configured: true, toolSupport: true, canManageProvider: false, tools: ['catalog_search'],
  mine: [] as Summary[], shared: [] as Summary[], ...over,
});

const card = (over: Partial<PlanCardView>): PlanCardView => ({
  status: 'valid', mode: 'draft_definition', selected: [], assumptions: [], request: { dimensions: [] }, issues: [], questions: [], ...over,
});

const askCard = (kind: AskCard['kind']): AskCard => ({ index: 5, term: 'revenue', entryId: 'metric:paid', name: 'Revenue (paid)', kind });

const messages: Message[] = [
  { role: 'user', content: 'What entities are in the catalog?' },
  { role: 'user', content: 'Interpret this query', query: { sql: 'SELECT 1 AS n', rows: 3, columns: ['n', 'kind'] } },
  { role: 'assistant', content: 'Here is the answer.', toolsUsed: ['catalog_search', 'catalog_search', 'validate_plan'] },
  { role: 'assistant', content: 'SQL drafted.', workbenchSql: 'SELECT 2' },
  { role: 'assistant', content: 'Which one?', choices: [
    { term: 'revenue', candidates: [{ entryId: 'metric:paid', name: 'Revenue (paid)' }] },
    { term: 'gmv', kind: 'missing', candidates: [{ entryId: 'metric:gmv', name: 'GMV' }] },
  ] },
  { role: 'assistant', content: 'By default?', askCard: askCard('term_default') },
  { role: 'assistant', content: 'As an alias?', askCard: askCard('alias') },
];

/** 三个组件的典型状态 → 各自的静态 HTML；locale 决定出英文（词典已注入）还是回退中文原文 */
function states(locale: 'en' | 'zh-CN'): Record<string, string> {
  const t = makeT(locale, locale === 'en' ? enClient : null);
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { t, locale, children: node }));
  const withFetcher = (data: unknown, state: string, fn: () => string) => {
    router.fetcher = { state, data, load: () => {}, submit: () => {} };
    return fn();
  };
  const panel = (data: unknown, state = 'idle') => withFetcher(data, state, () => render(createElement(AssistantPanel, { initialOpen: true })));
  const plan = (c: PlanCardView, props: { workbenchSql?: string; onFollowUp?: (text: string) => void } = {}) =>
    render(createElement(PlanCard, { card: c, ...props }));
  return {
    面板配置好: panel(overview()),
    面板模型不支持工具调用管理员: panel(overview({ toolSupport: false, canManageProvider: true })),
    面板模型不支持工具调用成员: panel(overview({ toolSupport: false })),
    面板未配置管理员: panel(overview({ configured: false, canManageProvider: true })),
    面板未配置成员: panel(overview({ configured: false })),
    面板读取中: panel(undefined),
    面板回答中: panel(overview(), 'submitting'),
    对话列表: render(createElement(ConversationList, { title: t('我的对话'), items: [{ id: 'c1', title: 'Q3 revenue', updatedAt: '2026-11-01T10:00:00Z', owner: 'de@acme.com' }] as Summary[], testId: 'my-conversations', onOpen: () => {} })),
    空对话列表: render(createElement(ConversationList, { title: t('分享给我的'), items: [], testId: 'shared-conversations', onOpen: () => {} })),
    消息区只读: render(createElement(AssistantMessages, { messages, busy: false, readOnlyOwner: 'boss@acme.test', conversationId: null, onPickChoice: () => {} })),
    消息区可续写: render(createElement(AssistantMessages, { messages, busy: true, readOnlyOwner: null, conversationId: 'c1', onFollowUp: () => {}, onPickChoice: () => {} })),
    计划卡通过复用: plan(card({
      mode: 'reuse_result', resultHref: '/analytics/definitions/metric/revenue_30d',
      selected: [{ id: 'metric:rev', name: 'Revenue 30d', description: 'paid orders', asOf: '2026-11-01' }],
      assumptions: [{ text: 'by paid time', confirmed: true }, { text: 'excludes refunds', confirmed: false }],
      rationale: 'matches the question',
      excluded: [{ name: 'Revenue by order time', reason: 'wrong window' }, { reason: 'not visible' }],
      request: { windowDays: 30, grain: 'consumer', dimensions: ['city'], population: 'members' },
    })),
    计划卡通过存草稿: plan(card({}), { onFollowUp: () => {} }),
    计划卡通过填工作台: plan(card({ mode: 'draft_query' }), { workbenchSql: 'SELECT 1' }),
    计划卡追问澄清: plan(card({ status: 'needs_clarification', mode: 'clarify', questions: ['which window?'], issues: [{ message: 'two metrics named revenue', next: 'pick by time' }] })),
    计划卡做不到: plan(card({ status: 'unsupported', mode: 'unsupported', reason: 'cannot go below consumer grain', issues: [{ message: 'dsl cannot express', next: 'define a metric first' }] })),
    计划卡过期: plan(card({ status: 'invalid', issues: [{ message: 'dependency changed' }] })),
    提案卡待确认: render(createElement(KnowledgeAskCard, { card: askCard('alias'), conversationId: 'c1' })),
    提案卡已提交: withFetcher({ ok: true, proposalId: 'p1' }, 'idle', () => render(createElement(KnowledgeAskCard, { card: askCard('term_default'), conversationId: 'c1' }))),
  };
}

describe('助手面板的界面文字按界面语言翻译（ADR-0060）', () => {
  it('英文界面：面板、对话列表、消息区、计划卡与提案卡的典型状态都没有汉字（数据除外——夹具里都是 ASCII）', () => {
    const en = states('en');
    for (const [name, html] of Object.entries(en)) expect(html, name).not.toMatch(/[一-鿿]/);
    // 带数量的句子走 ICU 复数（单数不出 "1 rows" / "last 1 days"）
    expect(en.消息区只读).toContain('3 rows, columns: ');
    expect(en.计划卡通过复用).toContain('; window: last 30 days');
    const t = makeT('en', enClient);
    expect(t('{rows} 行，列：{columns}', { rows: 1, columns: 'n' })).toBe('1 row, columns: n');
    expect(t('；窗口：近 {days} 天', { days: 1 })).toBe('; window: last day');
  });

  it('中文界面：词典不下发、按中文原文回退，输出与接入前一致', () => {
    const zh = states('zh-CN');
    // 面板：顶栏按钮、面板头、空态提示与输入框
    expect(zh.面板配置好).toContain('AI 助手');
    expect(zh.面板配置好).toContain('新对话');
    expect(zh.面板配置好).toContain('历史对话');
    expect(zh.面板配置好).toContain('aria-label="关闭 AI 助手"');
    expect(zh.面板配置好).toContain('可以问我目录里有哪些实体、字段、指标与标签，以及它们的含义。我只读目录，不执行查询、不发布。对话会保存在「历史对话」里，只有你自己能看到。');
    expect(zh.面板配置好).toContain('placeholder="问点什么，Enter 发送，Shift+Enter 换行"');
    expect(zh.面板配置好).toContain('aria-label="向 AI 助手提问"');
    expect(zh.面板配置好).toContain('aria-label="发送"');
    expect(zh.面板读取中).toContain('加载中…');
    expect(zh.面板回答中).toContain('思考中…');
    // 配置提示：链接句按「请到 + 「模型服务」 + 页…」三段拼回，中文与接入前逐字一致
    expect(zh.面板模型不支持工具调用管理员).toContain('该模型服务不支持工具调用，AI 助手无法使用。请到<a href="/model-provider">「模型服务」</a>页换一个支持工具调用的模型。');
    expect(zh.面板模型不支持工具调用成员).toContain('该模型服务不支持工具调用，AI 助手无法使用。请联系管理员换一个支持工具调用的模型。');
    expect(zh.面板未配置管理员).toContain('未配置模型服务，AI 助手暂时不能用。请到<a href="/model-provider">「模型服务」</a>页配置。');
    expect(zh.面板未配置成员).toContain('未配置模型服务，AI 助手暂时不能用。请联系管理员配置。');
    // 对话列表与消息区
    expect(zh.对话列表).toContain('我的对话');
    expect(zh.对话列表).toContain('de@acme.com · ');
    expect(zh.空对话列表).toContain('分享给我的');
    expect(zh.空对话列表).toContain('暂无');
    expect(zh.消息区只读).toContain('boss@acme.test 分享给你的对话，只能查看，不能续写。');
    expect(zh.消息区只读).toContain('请解读这段查询的结果：');
    expect(zh.消息区只读).toContain('3 行，列：n、kind');
    expect(zh.消息区只读).toContain('在工作台重新执行');
    expect(zh.消息区可续写).toContain('填入工作台');
    expect(zh.消息区可续写).toContain('『revenue』指哪一个？');
    expect(zh.消息区可续写).toContain('『gmv』指的是哪一个？');
    expect(zh.消息区可续写).toContain('都不是');
    expect(zh.消息区可续写).toContain('用过的工具：catalog_search、validate_plan');
    expect(zh.消息区可续写).toContain('把『revenue』默认指向 〈Revenue (paid)〉？');
    expect(zh.消息区可续写).toContain('把『revenue』记为 〈Revenue (paid)〉 的别名？');
    // 计划卡：标题、块标题、说明行与下一步入口
    expect(zh.计划卡通过复用).toContain('计划已通过校验');
    expect(zh.计划卡通过复用).toContain('查看已有结果');
    expect(zh.计划卡通过复用).toContain('（数据截至 2026-11-01）');
    expect(zh.计划卡通过复用).toContain('（已确认）');
    expect(zh.计划卡通过复用).toContain('（未确认）');
    expect(zh.计划卡通过复用).toContain('你看不到的条目：not visible');
    expect(zh.计划卡通过复用).toContain('模式：复用现有结果；窗口：近 30 天；粒度：consumer；维度：city；人群：members');
    expect(zh.计划卡通过存草稿).toContain('存草稿');
    expect(zh.计划卡通过填工作台).toContain('填入工作台');
    expect(zh.计划卡追问澄清).toContain('计划需要补充信息');
    expect(zh.计划卡追问澄清).toContain('待澄清');
    expect(zh.计划卡追问澄清).toContain('two metrics named revenue（pick by time）');
    expect(zh.计划卡追问澄清).toContain('请在下方输入框回答');
    expect(zh.计划卡做不到).toContain('这个要求做不到');
    expect(zh.计划卡做不到).toContain('原因：cannot go below consumer grain');
    expect(zh.计划卡做不到).toContain('新建定义');
    expect(zh.计划卡过期).toContain('计划需要重新确认');
    expect(zh.计划卡过期).toContain('计划已过期或不再适用，请重新提问');
    // 提案卡
    expect(zh.提案卡待确认).toContain('记为知识提案');
    expect(zh.提案卡待确认).toContain('不用');
    expect(zh.提案卡已提交).toContain('已提交，待复核');
  });
});

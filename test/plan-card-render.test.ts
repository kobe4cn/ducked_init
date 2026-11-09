// test/plan-card-render.test.ts —— 计划卡组件的服务端渲染（#453，P4⑯b，纯函数，不连库；仓库没有 jsdom，用
// renderToStaticMarkup，Link 要包在 MemoryRouter 里，onClick 不会被渲染，按钮按 data-next 断言）：valid 时按 mode
// 给下一步入口——reuse_result 链到所选条目的结果页、draft_definition 给「存草稿」按钮、draft_query 有 workbenchSql
// 给「填入工作台」链接、没有给按钮；不传 onFollowUp（被分享人只读）时没有按钮、链接照样渲染；invalid 只提示重新提问；
// clarify / needs_clarification 用 amber 列出问题与建议；unsupported 用 red 给出原因与「新建定义」
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '../app/components/plan-card';
import type { PlanCardView } from '../app/.server/assistant/plan-card';

const card = (over: Partial<PlanCardView>): PlanCardView => ({
  status: 'valid', mode: 'draft_definition', selected: [], assumptions: [], request: { dimensions: [] }, issues: [], questions: [], ...over,
});
const render = (c: PlanCardView, props: { workbenchSql?: string; onFollowUp?: (text: string) => void } = {}) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlanCard, { card: c, ...props })));
/** 卡片上不能有任何执行入口 */
const noEntry = (html: string) => expect(html.match(/data-next=/g) ?? []).toHaveLength(0);

describe('计划卡的下一步入口', () => {
  it('valid 的 reuse_result 给「查看已有结果」链接；draft_definition 给「存草稿」按钮，不传 onFollowUp（只读）时没有按钮', () => {
    const followUp = (_text: string) => {};
    const reuse = render(card({ mode: 'reuse_result', resultHref: '/analytics/definitions/metric/revenue_30d' }));
    expect(reuse).toContain('data-next="result"');
    expect(reuse).toContain('href="/analytics/definitions/metric/revenue_30d"');
    expect(reuse).toContain('查看已有结果');

    const draft = render(card({ mode: 'draft_definition' }), { onFollowUp: followUp });
    expect(draft).toContain('<button type="button" data-next="draft"');
    expect(draft).toContain('存草稿');
    // 被分享人只读：按钮不渲染，链接照样渲染
    noEntry(render(card({ mode: 'draft_definition' })));
    expect(render(card({ mode: 'reuse_result', resultHref: '/analytics/definitions/metric/revenue_30d' })))
      .toContain('data-next="result"');
  });

  it('valid 的 draft_query 有 workbenchSql 时是带 data-prefill 的「填入工作台」链接，没有时是按钮（只读时都没有）', () => {
    const withSql = render(card({ mode: 'draft_query' }), { workbenchSql: 'SELECT 1' });
    expect(withSql).toContain('data-next="workbench"');
    expect(withSql).toContain('data-prefill');
    expect(withSql).toContain(`href="/workbench?sql=${encodeURIComponent('SELECT 1')}"`);
    expect(withSql).toContain('填入工作台');

    const button = render(card({ mode: 'draft_query' }), { onFollowUp: () => {} });
    expect(button).toContain('<button type="button" data-next="workbench"');
    expect(button).not.toContain('data-prefill');
    noEntry(render(card({ mode: 'draft_query' })));
  });

  it('invalid 卡片不显示任何入口，只提示「计划已过期或不再适用，请重新提问」', () => {
    const html = render(card({ status: 'invalid', mode: 'reuse_result', resultHref: '/analytics/definitions/metric/revenue_30d', issues: [{ message: '依赖变了' }] }), { onFollowUp: () => {}, workbenchSql: 'SELECT 1' });
    expect(html).toContain('计划已过期或不再适用，请重新提问');
    noEntry(html);
  });
});

describe('追问与做不到的卡片', () => {
  it('clarify 与状态是 needs_clarification 的卡用 amber：列出 questions 与 issues 的 message 和 next，提示在下方输入框回答，不给入口', () => {
    const issues = [{ message: '「营收」有两个口径不同的指标', next: '请说明按下单还是支付时间' }];
    // mode 是 clarify（状态一定是 needs_clarification）
    const clarify = render(card({ status: 'needs_clarification', mode: 'clarify', questions: ['统计哪个时间范围的营收？'], issues }));
    expect(clarify).toContain('border-amber-200');
    expect(clarify).toContain('bg-amber-50');
    expect(clarify).toContain('统计哪个时间范围的营收？');
    expect(clarify).toContain('「营收」有两个口径不同的指标');
    expect(clarify).toContain('请说明按下单还是支付时间');
    expect(clarify).toContain('请在下方输入框回答');
    noEntry(clarify);
    // 状态是 needs_clarification 时不管 mode 是什么，同样 amber
    const needs = render(card({ status: 'needs_clarification', mode: 'draft_definition', questions: [], issues }));
    expect(needs).toContain('border-amber-200');
    expect(needs).toContain('请在下方输入框回答');
    noEntry(needs);
  });

  it('unsupported 的卡用 red：显示 reason 与 issues 的 next（不显示 message），给「新建定义」链接；状态是 unsupported 时同样 red', () => {
    const unsupported = render(card({
      status: 'unsupported', mode: 'unsupported', reason: '平台只能算到统一消费者粒度',
      issues: [{ message: 'DSL 表达不了留存窗口', next: '先定义留存指标再查询' }],
    }));
    expect(unsupported).toContain('border-red-200');
    expect(unsupported).toContain('bg-red-50');
    expect(unsupported).toContain('平台只能算到统一消费者粒度');
    expect(unsupported).toContain('先定义留存指标再查询');
    expect(unsupported).not.toContain('DSL 表达不了留存窗口');
    expect(unsupported).toContain('data-next="new-definition"');
    expect(unsupported).toContain('href="/analytics/definitions/new"');
    expect(unsupported).toContain('新建定义');
    // 做不到是第一优先级：不提示「计划已过期」
    expect(unsupported).not.toContain('计划已过期');
    // 状态是 unsupported 时不管 mode 是什么，同样 red
    const byStatus = render(card({ status: 'unsupported', mode: 'draft_query', reason: '表达不了' }));
    expect(byStatus).toContain('border-red-200');
    expect(byStatus).toContain('data-next="new-definition"');
  });
});

describe('为何选与依据', () => {
  const assumptions = [{ text: '营收按下单时间统计', confirmed: true }, { text: '只算已支付订单', confirmed: false }];

  it('有 rationale 时「为何选」给 rationale 文字，「依据」照旧列出 assumptions', () => {
    const html = render(card({ assumptions, rationale: '成员问的是近 30 天的营收，revenue_30d 的窗口正好对上' }));
    expect(html).toContain('为何选');
    expect(html).toContain('成员问的是近 30 天的营收，revenue_30d 的窗口正好对上');
    expect(html).toContain('依据');
    expect(html).toContain('营收按下单时间统计');
    expect(html).toContain('只算已支付订单');
  });

  it('没有 rationale 时「为何选」下面是 assumptions，不再另出「依据」；对所有 status 都显示', () => {
    const html = render(card({ assumptions }));
    expect(html).toContain('为何选');
    expect(html).toContain('营收按下单时间统计');
    expect(html).toContain('已确认');
    expect(html).toContain('只算已支付订单');
    expect(html).toContain('未确认');
    expect(html).not.toContain('依据');
    // 这一块对所有 status 都显示，和现在的「依据」一样：过期卡也带
    const stale = render(card({ status: 'invalid', assumptions }));
    expect(stale).toContain('为何选');
    expect(stale).toContain('营收按下单时间统计');
  });

  it('两者都没有时不渲染这一块，两个标题都没有', () => {
    const html = render(card({ assumptions: [] }));
    expect(html).not.toContain('为何选');
    expect(html).not.toContain('依据');
  });
});

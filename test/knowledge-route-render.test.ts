// test/knowledge-route-render.test.ts —— 集中页路由组件的服务端渲染（#951，纯函数，不连库）：写提案的两个入口互斥——
// navigation.state 是 submitting 时（无论提交的是哪个）主题组的「生成建议」与页头的「应用标准模板包」都带 disabled，
// 没被点的那组文字不变（只有被点的那组显示「生成中…」/「应用中…」）；idle 时都可点。条目补齐的空主题组显示「没有待处理的条目」。
// useNavigation 等 data router 的 hooks 在静态渲染里没有上下文，这里 vi.mock 掉 react-router 的相关导出（Form/Link 渲染成原生元素）
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Route } from '../app/routes/+types/knowledge';

/** 被测的互斥逻辑只看这两个字段；真实的 Navigation 还有 location、matches 等一堆字段 */
type NavState = { state: 'idle' | 'submitting'; formData: FormData | null };

const router = vi.hoisted(() => ({ navigation: { state: 'idle', formData: null } as NavState }));

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useNavigation: () => router.navigation,
    useLocation: () => ({ pathname: '/knowledge', search: '', hash: '', state: null, key: 'render' }),
    useFetcher: () => ({ state: 'idle', data: undefined, load: () => {}, submit: () => {} }),
    // 顶栏的界面语言入口（#946）读 root loader 数据；这里没有 root，返回 undefined 即不渲染入口
    useRouteLoaderData: () => undefined,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import Knowledge from '../app/routes/knowledge';

const loaderData = {
  email: 'an@acme.com',
  nav: [{ to: '/knowledge', label: '业务知识' }],
  hub: {
    totals: { proposals: 1, missing: 1, subjects: 1 },
    groups: [
      {
        subject: '营收', proposals: 1, missing: 1,
        items: [{ targetId: 'metric:revenue', kind: 'metric', name: 'revenue', proposals: 1, missing: [{ type: 'unit', state: 'unknown' }] }],
      },
      { subject: '会员价值', proposals: 0, missing: 0, items: [] },
    ],
  },
  selected: null,
  subjectIds: { 营收: 's-1', 会员价值: 's-2' },
  canSuggest: true,
  suggested: null,
  packApplied: null,
  imported: null,
} as Route.ComponentProps['loaderData'];

const render = (navigation: NavState) => {
  router.navigation = navigation;
  // 路由组件的 props 还有框架注入的 matches 等，这里只给渲染用到的两个
  return renderToStaticMarkup(createElement(Knowledge, { loaderData, actionData: undefined } as unknown as Route.ComponentProps));
};

/** 表单里 name=<intent>、subjectId=<id>（没有时任意）的那个提交按钮在 html 里的位置（找不到为 -1）；按位置取，开始标签都一样 */
const submitButtonAt = (html: string, intent: string, subjectId?: string) => {
  const hidden = subjectId === undefined ? '' : `<input type="hidden" name="subjectId" value="${subjectId}"/>`;
  const form = html.indexOf(`<form method="post"><input type="hidden" name="intent" value="${intent}"/>${hidden}<button`);
  return form === -1 ? -1 : html.indexOf('<button', form);
};
/** 按钮的开始标签（含结尾的 >） */
const openTag = (html: string, at: number) => (at === -1 ? '' : html.slice(at, html.indexOf('>', at) + 1));
/** 按钮的开始标签 + 内容（到 </button>） */
const buttonHtml = (html: string, at: number) => (at === -1 ? '' : html.slice(at, html.indexOf('</button>', at)));
/** 这个按钮有没有 disabled */
const disabled = (html: string, intent: string, subjectId?: string) => {
  const at = submitButtonAt(html, intent, subjectId);
  return at !== -1 && / disabled(="")?( |>)/.test(openTag(html, at));
};

const formOf = (intent: string, subjectId?: string) => {
  const fd = new FormData();
  fd.set('intent', intent);
  if (subjectId !== undefined) fd.set('subjectId', subjectId);
  return fd;
};

describe('集中页：生成期间两个写提案入口都禁用', () => {
  it('idle 时「生成建议」「应用标准模板包」都可点；条目补齐的空主题组显示「没有待处理的条目」并保留表单', () => {
    const html = render({ state: 'idle', formData: null });
    expect(disabled(html, 'suggest', 's-1')).toBe(false);
    expect(disabled(html, 'suggest', 's-2')).toBe(false);
    expect(disabled(html, 'apply-pack')).toBe(false);
    expect(buttonHtml(html, submitButtonAt(html, 'suggest', 's-1'))).toContain('type="submit"');
    expect(html).toContain('data-hub-empty');
    expect(html).toContain('没有待处理的条目');
  });

  it('提交「生成建议」期间：所有主题组的「生成建议」与页头的「应用标准模板包」都带 disabled，没被点的那组文字不变', () => {
    const html = render({ state: 'submitting', formData: formOf('suggest', 's-1') });
    expect(disabled(html, 'suggest', 's-1')).toBe(true);
    expect(disabled(html, 'suggest', 's-2')).toBe(true);
    expect(disabled(html, 'apply-pack')).toBe(true);
    // 文字的判断不变：只有被点的那组显示「生成中…」，另一组仍是「生成建议」，模板包仍是「应用标准模板包」
    expect(buttonHtml(html, submitButtonAt(html, 'suggest', 's-1'))).toContain('生成中…');
    expect(buttonHtml(html, submitButtonAt(html, 'suggest', 's-2'))).toContain('生成建议');
    expect(buttonHtml(html, submitButtonAt(html, 'apply-pack'))).toContain('应用标准模板包');
  });

  it('提交「应用标准模板包」期间：两类按钮同样都带 disabled，模板包按钮显示「应用中…」', () => {
    const html = render({ state: 'submitting', formData: formOf('apply-pack') });
    expect(disabled(html, 'suggest', 's-1')).toBe(true);
    expect(disabled(html, 'suggest', 's-2')).toBe(true);
    expect(disabled(html, 'apply-pack')).toBe(true);
    expect(buttonHtml(html, submitButtonAt(html, 'apply-pack'))).toContain('应用中…');
  });
});

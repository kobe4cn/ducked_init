// test/assistant-markdown-render.test.ts —— 助手回复按 Markdown 渲染（#1186）的服务端渲染（纯函数，不连库）：
// AssistantMarkdown 渲染 GFM 表格、代码块、加粗、行内代码、列表；原始 HTML（<script>）以转义文字出现、不成为元素；
// 链接只保留站内相对路径，外链 / 协议相对地址 / javascript: 只剩文字。AssistantMessages 里只有 assistant 消息走 Markdown，
// 成员自己发的消息仍按纯文本。react-router 照 test/assistant-panel-render.test.ts 的做法 mock（Link 渲染成原生 <a>）
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入
import { AssistantMarkdown, isInternalHref } from '../app/components/assistant-markdown';
import { AssistantMessages, type Message } from '../app/components/assistant-panel';

const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { t: makeT('en', enClient), locale: 'en', children: node }));
const md = (content: string) => render(createElement(AssistantMarkdown, { content }));

describe('助手回复按 Markdown 渲染（#1186）', () => {
  it('表格、代码块、加粗、行内代码、列表渲染成元素；<script> 以文字出现、不成为元素', () => {
    const html = md([
      'Compare **revenue** metrics with `metric:paid`:',
      '',
      '| name | window |',
      '|---|---|',
      '| paid | 30d |',
      '',
      '```sql',
      'SELECT 1 AS n',
      '```',
      '',
      '- first',
      '- second',
      '',
      '<script>alert(1)</script>',
      '',
      'inline <script>x</script> here',
    ].join('\n'));
    expect(html).toContain('<table');
    expect(html).toContain('<td class="border px-2 py-1">paid</td>');
    expect(html).toMatch(/<pre[^>]*><code class="language-sql">SELECT 1 AS n\n<\/code><\/pre>/);
    expect(html).toContain('<strong>revenue</strong>');
    expect(html).toContain('<code class="rounded bg-slate-100 px-1 font-mono text-xs">metric:paid</code>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('inline &lt;script&gt;x&lt;/script&gt; here');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('**');
    expect(html).not.toContain('|---|');
  });

  it('链接只保留站内相对路径，外链、协议相对地址、javascript:、图片都只剩文字', () => {
    const html = md('[a](/workbench?x=1) [b](https://evil.com) [c](//evil.com) [d](javascript:alert(1)) www.example.com ![pic](https://evil.com/x.png)');
    expect(html).toContain('<a href="/workbench?x=1">a</a>');
    expect(html).not.toMatch(/href="https|href="\/\/|href="\/\\|javascript:|www\.example\.com"|<img/);
    // /\host 在 Markdown 里会被编码成 /%5Chost（仍是站内路径）；直接传给判定函数时按外链处理
    expect(['/a', '/workbench?x=1'].every(isInternalHref)).toBe(true);
    expect(['//evil.com', '/\\evil.com', 'https://x', 'mailto:a@b', '', undefined].some(isInternalHref)).toBe(false);
    for (const text of ['<span>b</span>', '<span>c</span>', '<span>d</span>', '<span>pic</span>', 'www.example.com']) expect(html).toContain(text);
  });

  it('成员自己发的消息仍按纯文本，同样的内容作为助手消息按 Markdown 渲染', () => {
    const view = (role: Message['role']) =>
      render(createElement(AssistantMessages, { messages: [{ role, content: '**hi** | a |' }], busy: false, readOnlyOwner: null, conversationId: null, onPickChoice: () => {} }));
    const user = view('user');
    expect(user).toContain('<p class="whitespace-pre-wrap">**hi** | a |</p>');
    expect(user).not.toContain('<strong>');
    expect(view('assistant')).toContain('<strong>hi</strong>');
  });
});

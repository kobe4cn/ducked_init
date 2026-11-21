// test/i18n-mapping-editor-render.test.ts —— 映射编辑器与源视图表单接入双语（#1015，ADR-0060）的服务端渲染（纯函数，不连库）：
// 英文词典（en.client.json）经 I18nProvider 注入后渲染 MappingErrors / MappingNotices / LiveMappingIssues /
// NewSourceViewForm / SourceViewHint 的典型状态（有与没有 path 的问题、正在校验、校验通过带提示、inForm 有问题、提交中与空闲、
// 规则说明），界面文字不能有汉字；作为 props 传进来的数据（error、message、hint 是 app/lib 与服务端返回的内容，随 #932 翻译）
// 英文夹具里全用 ASCII。中文界面（词典 null）回退中文原文，输出与接入前一致（验收标准 2）。
// NewSourceViewForm 里的 Form 是 data router 组件，静态渲染里没有上下文，vi.mock 掉 react-router
// （同 test/i18n-draft-components-render.test.ts），被测组件在 mock 之后导入
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    // 顶栏的界面语言入口（#946）读 root loader 数据；这里没有 root，返回 undefined 即不渲染入口
    useRouteLoaderData: () => undefined,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { LiveMappingIssues, MappingErrors, MappingNotices } from '../app/components/mapping-editor';
import { NewSourceViewForm, SourceViewHint } from '../app/components/source-view-form';

const noop = () => {};
/** props 里带文字的数据（error、message、hint）：英文态全 ASCII，中文态也用 ASCII（不在本票翻译范围），都不算界面文字 */
const issueWithPath = { line: 3, col: 5, path: 'mappings.0', message: 'unknown canonical field status', hint: 'fields:\n  staus: status' };
const issueNoPath = { line: 4, col: 2, path: '', message: 'duplicate key id' };

/** 各组件的典型状态 → 各自的静态 HTML；locale 决定出英文（词典已注入）还是回退中文原文 */
function states(locale: 'en' | 'zh-CN'): Record<string, string> {
  const t = makeT(locale, locale === 'en' ? enClient : null);
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { t, locale, children: node }));
  // MappingNotices 的 title 由调用方传入（LiveMappingIssues 里传的是 t() 的结果）：英文态给 ASCII，中文态给中文
  const noticeTitle = locale === 'en' ? 'Notices when saving' : '保存时会有这些提示（不影响保存）';
  return {
    问题列表: render(createElement(MappingErrors, {
      error: locale === 'en' ? 'Validation failed' : '校验未通过',
      issues: [issueWithPath, issueNoPath],
      onJump: noop,
    })),
    问题列表无按钮: render(createElement(MappingErrors, { error: locale === 'en' ? 'Validation failed' : '校验未通过', issues: [issueNoPath] })),
    提示列表: render(createElement(MappingNotices, { title: noticeTitle, notices: [issueNoPath] })),
    正在校验: render(createElement(LiveMappingIssues, {
      validation: { state: 'checking', error: null, issues: [], notices: [] }, onJump: noop,
    })),
    校验通过带提示: render(createElement(LiveMappingIssues, {
      validation: { state: 'ok', error: null, issues: [], notices: [issueNoPath] }, onJump: noop,
    })),
    表单内有问题: render(createElement(LiveMappingIssues, {
      validation: { state: 'issues', error: locale === 'en' ? 'Validation failed' : '校验未通过', issues: [issueWithPath], notices: [] },
      inForm: true, onJump: noop,
    })),
    新建表单: render(createElement(NewSourceViewForm, { name: 'customer_orders', sql: null, submitting: false })),
    新建表单提交中: render(createElement(NewSourceViewForm, { name: null, sql: null, submitting: true })),
    规则说明: render(createElement(SourceViewHint, { className: 'max-w-2xl text-sm text-slate-500' })),
  };
}

describe('映射编辑器与源视图表单的界面文字按界面语言翻译（ADR-0060）', () => {
  it('英文界面：问题与提示列表、实时校验、新建源视图表单、规则说明都没有汉字（数据除外——夹具里都是 ASCII）', () => {
    const en = states('en');
    for (const [name, html] of Object.entries(en)) expect(html, name).not.toMatch(/[一-鿿]/);
    // 问题与提示：位置句按有没有 path 二选一，按钮的 title 也能定位
    expect(en.问题列表).toContain('Line 3, column 5 (mappings.0): unknown canonical field status');
    expect(en.问题列表).toContain('Line 4, column 2: duplicate key id');
    expect(en.问题列表).toContain('title="Jump to this spot in the YAML"');
    expect(en.问题列表无按钮).not.toContain('<button');
    // 实时校验：正在校验、校验通过带提示、inForm 有问题
    expect(en.正在校验).toContain('Validating…');
    expect(en.校验通过带提示).toContain('Validation passed');
    expect(en.校验通过带提示).toContain('You will see these notices when saving (they do not block it)');
    expect(en.表单内有问题).toContain('Issues are shown where they belong in the form; switch to the YAML tab to see line and column numbers and jump to them');
    // 新建源视图表单：视图名、提交按钮两个状态、规则说明
    expect(en.新建表单).toContain('View name');
    expect(en.新建表单).toContain('Validate and save draft');
    expect(en.新建表单提交中).toContain('Validating…');
    expect(en.新建表单提交中).toContain(' disabled');
    expect(en.规则说明).toContain('The view can read only tables in this source&#x27;s Bronze layer');
    expect(en.规则说明).toContain('It cannot read the Silver layer, the Gold layer, or other sources, and it cannot write.');
    expect(en.规则说明).toContain('The view must output the platform columns _op, _batch and _commit_ts (carried over from a table in the Bronze layer) so the mapping can merge incrementally by change batch.');
  });

  it('中文界面：词典不下发、按中文原文回退，输出与接入前一致', () => {
    const zh = states('zh-CN');
    // 问题与提示：位置句与按钮 title 仍是原文
    expect(zh.问题列表).toContain('第 3 行第 5 列（mappings.0）：unknown canonical field status');
    expect(zh.问题列表).toContain('第 4 行第 2 列：duplicate key id');
    expect(zh.问题列表).toContain('title="定位到 YAML 里这一处"');
    expect(zh.提示列表).toContain('保存时会有这些提示（不影响保存）');
    // 实时校验
    expect(zh.正在校验).toContain('正在校验…');
    expect(zh.校验通过带提示).toContain('校验通过');
    expect(zh.表单内有问题).toContain('问题显示在表单里对应的位置，到 YAML 标签页可看到行列并定位');
    // 新建源视图表单与规则说明（两段合成一句，标点保留）
    expect(zh.新建表单).toContain('视图名');
    expect(zh.新建表单).toContain('校验并保存草稿');
    expect(zh.新建表单提交中).toContain('正在校验…');
    expect(zh.规则说明).toContain(
      '只能读本数据源原始层的表，表名直接写源表名（如 customers），不能读标准层、结果层或其他数据源，也不能写入。'
      + '视图要输出平台列 _op、_batch、_commit_ts（从原始层的表里带出来），映射才能按变更批次增量合并。',
    );
  });
});

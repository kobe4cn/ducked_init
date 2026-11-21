// test/i18n-draft-components-render.test.ts —— 草稿与校验类公共组件接入双语（#1014，ADR-0060）的服务端渲染（纯函数，不连库）：
// 英文词典（en.client.json）经 I18nProvider 注入后渲染 VersionStatus / DraftActions / DraftConfidence / VerifyBadge /
// KeyCheckFindings 的典型状态（已发布 / 草稿 / 与已发布版相同、可发布 / 发布被锁、复用 / 规则 / 模型 / 断言的生成依据、
// 未核对 / 一致 / 有差异、空值与重复键），界面文字不能有汉字；作为 props 传进来的数据（发布被拒的原因、丢弃提示、
// 模型给的理由、notice、重复键明细）是服务端与 app/lib 返回的内容、不算界面文字（随 #932 翻译），英文夹具里全用 ASCII
// 或不触发：key-check-findings 用的 duplicateKeyText（app/lib/sources.ts）仍出中文，英文态不给重复键。
// 中文界面（词典 null）回退中文原文，输出与接入前一致（验收标准 2）。Form / Link 是 data router 组件，静态渲染里
// 没有上下文，vi.mock 掉 react-router（同 test/assistant-panel-render.test.ts），被测组件在 mock 之后导入
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { DraftActions, VersionStatus } from '../app/components/draft-version';
import { DraftConfidence } from '../app/components/draft-confidence';
import { VerifyBadge } from '../app/components/verify-badge';
import { KeyCheckFindings } from '../app/components/key-check-findings';

/** 五个组件的典型状态 → 各自的静态 HTML；locale 决定出英文（词典已注入）还是回退中文原文 */
function states(locale: 'en' | 'zh-CN'): Record<string, string> {
  const t = makeT(locale, locale === 'en' ? enClient : null);
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { t, locale, children: node }));
  // props 里带文字的数据（发布被拒的原因、丢弃提示、模型给的理由）：英文态全 ASCII，中文态用中文，都不算界面文字
  const blocker = locale === 'en' ? 'You edited this draft last; another member must publish' : '这份草稿由你最后修改，需另一位成员发布';
  const discardHint = locale === 'en' ? 'you will go back to the latest published version' : '会回到最近一次已发布版本';
  const reason = (what: string) => (locale === 'en' ? `the source column ${what}` : `源列${what}`);
  return {
    版本已发布: render(createElement(VersionStatus, { v: { status: 'published' } })),
    版本草稿: render(createElement(VersionStatus, { v: { status: 'draft' } })),
    版本与已发布相同: render(createElement(VersionStatus, { v: { status: 'draft' }, sameAs: 2 })),
    可发布: render(createElement(DraftActions, { v: { status: 'draft', version: 3, publishBlocker: null }, canDiscard: true, discardHint, submitting: false })),
    发布被锁: render(createElement(DraftActions, { v: { status: 'draft', version: 2, publishBlocker: blocker }, canDiscard: false, discardHint, submitting: false })),
    生成依据模型: render(createElement(DraftConfidence, { origin: 'model', items: [
      { path: 'fields.status', confidence: 0.95, reason: reason('matches the canonical field') },
      { path: 'fields.customer_id', confidence: 0.3, reason: reason('has the same name') },
      { path: 'fields.amount', confidence: 0.6, reason: reason('has a numeric type') },
      { path: 'fields.note', confidence: 0.9, reason: reason('is not in the model output'), dropped: locale === 'en' ? 'failed the not-null assertion' : '未通过非空断言' },
    ] })),
    生成依据断言: render(createElement(DraftConfidence, { origin: 'assertions', items: [
      { path: 'assertions.0', confidence: 0.5, reason: reason('is unique in the sample') },
    ] })),
    生成依据复用: render(createElement(DraftConfidence, { origin: 'reuse', items: [], reusedFrom: 'm-123' })),
    生成依据复用无来源: render(createElement(DraftConfidence, { origin: 'reuse', items: [] })),
    生成依据规则: render(createElement(DraftConfidence, { origin: 'rules', items: [], notice: null })),
    生成依据空表: render(createElement(DraftConfidence, { origin: 'model', items: [] })),
    徽标未核对: render(createElement(VerifyBadge, { differences: null })),
    徽标一致: render(createElement(VerifyBadge, { differences: 0 })),
    徽标差异: render(createElement(VerifyBadge, { differences: 3 })),
    徽标差异单数: render(createElement(VerifyBadge, { differences: 1 })),
    主键检查: render(createElement(KeyCheckFindings, { result: {
      keyColumns: ['customer_id'], nullRows: 1234,
      // duplicateKeyText（app/lib/sources.ts）随 #932 翻译：英文态不给重复键，中文态断言它照旧透传
      duplicates: locale === 'en' ? [] : [{ key: ['1'], count: 2 }],
    } })),
    主键检查单数: render(createElement(KeyCheckFindings, { result: { keyColumns: [], nullRows: 1, duplicates: [] } })),
  };
}

describe('草稿与校验类公共组件的界面文字按界面语言翻译（ADR-0060）', () => {
  it('英文界面：版本条、发布与丢弃、生成依据、核对徽标与主键检查明细都没有汉字（数据除外——夹具里都是 ASCII）', () => {
    const en = states('en');
    for (const [name, html] of Object.entries(en)) expect(html, name).not.toMatch(/[一-鿿]/);
    // 版本条与操作
    expect(en.版本已发布).toContain('Published');
    expect(en.版本草稿).toContain('Draft');
    expect(en.版本与已发布相同).toContain('same as v2');
    expect(en.可发布).toContain('Publish v3');
    expect(en.可发布).toContain('Discard draft');
    expect(en.发布被锁).toContain('You edited this draft last');
    // 生成依据：档位文字、表头、去掉的项与复用说明（链接句三段拼回）
    expect(en.生成依据模型).toContain('How this draft was generated');
    expect(en.生成依据模型).toContain('Low 30%');
    expect(en.生成依据模型).toContain('Medium 60%');
    expect(en.生成依据模型).toContain('High 95%');
    expect(en.生成依据模型).toContain('Path</th>');
    expect(en.生成依据模型).toContain('Confidence</th>');
    expect(en.生成依据模型).toContain('Reason</th>');
    expect(en.生成依据模型).toContain('failed the not-null assertion');
    expect(en.生成依据断言).toContain('Only the assertions block was replaced (indices in paths start at 0); Entries from the model are sorted by confidence');
    expect(en.生成依据复用).toContain('The source table structure matches a published mapping, so this draft directly reuses <a href="/mappings/m-123">that mapping</a>; no model was called.');
    expect(en.生成依据复用无来源).toContain('The source table structure matches a published mapping, so it was reused directly; no model was called.');
    expect(en.生成依据复用无来源).not.toContain('reuses;');
    expect(en.生成依据规则).toContain('Generated by rules');
    // 核对徽标与主键检查：带数量的句子走 ICU 复数与英文分组（单数不出 "1 tables differ"）
    expect(en.徽标未核对).toContain('Not verified');
    expect(en.徽标一致).toContain('Consistent');
    expect(en.徽标差异).toContain('3 tables differ');
    expect(en.徽标差异单数).toContain('1 table differs');
    expect(en.主键检查).toContain('1,234 rows with null values');
    expect(en.主键检查单数).toContain('1 row with null values');
  });

  it('中文界面：词典不下发、按中文原文回退，输出与接入前一致', () => {
    const zh = states('zh-CN');
    // 版本条与操作
    expect(zh.版本已发布).toContain('已发布');
    expect(zh.版本草稿).toContain('草稿');
    expect(zh.版本与已发布相同).toContain('data-same-as');
    expect(zh.版本与已发布相同).toContain('与 v2 相同');
    expect(zh.可发布).toContain('发布 v3');
    expect(zh.可发布).toContain('丢弃草稿');
    expect(zh.发布被锁).toContain('这份草稿由你最后修改，需另一位成员发布');
    // 生成依据：档位、表头、去掉的项与复用说明
    expect(zh.生成依据模型).toContain('生成依据');
    expect(zh.生成依据模型).toContain('低 30%');
    expect(zh.生成依据模型).toContain('中 60%');
    expect(zh.生成依据模型).toContain('高 95%');
    expect(zh.生成依据模型).toContain('位置</th>');
    expect(zh.生成依据模型).toContain('置信度</th>');
    expect(zh.生成依据模型).toContain('理由</th>');
    expect(zh.生成依据模型).toContain('这些项没有通过校验，已去掉（退回规则草稿或删除），不在下面的列表里：');
    expect(zh.生成依据模型).toContain('模型给的每一项按置信度从低到高排列，低置信度的请先核对。');
    expect(zh.生成依据断言).toContain('只替换了 assertions 块（位置里的序号从 0 起），模型给的每一项按置信度从低到高排列，低置信度的请先核对。');
    expect(zh.生成依据复用).toContain('源表结构与已发布映射一致，直接复用了<a href="/mappings/m-123">那个映射</a>，没有调用模型。');
    expect(zh.生成依据复用无来源).toContain('源表结构与已发布映射一致，直接复用，没有调用模型。');
    expect(zh.生成依据规则).toContain('按规则生成');
    // 核对徽标与主键检查：duplicateKeyText 照旧透传，数字仍按 zh-CN 分组
    expect(zh.徽标未核对).toContain('未核对');
    expect(zh.徽标一致).toContain('一致');
    expect(zh.徽标差异).toContain('3 张表有差异');
    expect(zh.徽标差异单数).toContain('1 张表有差异');
    expect(zh.主键检查).toContain('空值 1,234 行');
    expect(zh.主键检查).toContain('customer_id=1 出现 2 次');
    expect(zh.主键检查单数).toContain('空值 1 行');
    // 丢弃前确认只在 onSubmit 里，静态渲染不出来：直接走 t() 断言中英文句式
    expect(makeT('en', enClient)('丢弃第 {version} 版草稿？{hint}。', { version: 3, hint: 'will revert' })).toBe('Discard draft version 3? will revert.');
    expect(makeT('zh-CN', null)('丢弃第 {version} 版草稿？{hint}。', { version: 3, hint: '会回到最近一次已发布版本' })).toBe('丢弃第 3 版草稿？会回到最近一次已发布版本。');
  });
});

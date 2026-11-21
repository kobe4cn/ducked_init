// test/i18n-sources-list-render.test.ts —— 上传预览组件接入双语的服务端渲染（#1038，ADR-0060，纯函数，不连库，
// vi.mock 掉 react-router 的 useFetcher——静态渲染里没有 fetcher 上下文）：英文词典经 I18nProvider 注入后渲染
// UploadPreview（空闲与预览报错两种；选项表格要预览结果回来才渲染，静态渲染不出，由浏览器验收覆盖），
// 界面文字不能有汉字；中文界面词典不下发、按中文原文回退，逐串断言与接入前一致。
// Sources 整页（指标卡、数据源卡片、登记表单）也由 test/http/i18n-sources-pages.test.ts 的整页断言覆盖
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/** fetcher.data 由用例控制（undefined 或预览报错）；submit 不会被静态渲染触发 */
let fetcherData: { preview?: unknown; previewError?: string; error?: string | null } | undefined;
vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useFetcher: () => ({ data: fetcherData, state: 'idle' as const, submit: () => {} }),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { UploadPreview } from '../app/components/upload-preview';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

/** 按界面语言静态渲染；中文界面词典传 null（词典未下发），与真实中文界面一致 */
const render = (locale: 'en' | 'zh-CN', node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { t: makeT(locale, locale === 'en' ? enClient : null), locale, children: node }));

describe('英文界面：上传预览', () => {
  it('空闲与预览报错时的按钮、提示与报错标题都是英文，没有汉字', () => {
    fetcherData = undefined;
    const idle = render('en', createElement(UploadPreview));
    expect(idle).not.toMatch(/[一-鿿]/);
    expect(idle).toContain('Preview</button>');
    expect(idle).toContain('Enter the table name first');
    expect(idle).toContain('The preview does not store the file');

    fetcherData = { previewError: 'boom' };
    const failed = render('en', createElement(UploadPreview));
    expect(failed).not.toMatch(/[一-鿿]/);
    expect(failed).toContain('Preview failed');
    expect(failed).toContain('boom');
  });
});

describe('中文界面输出与改造前一致', () => {
  it('空闲与预览报错时仍是原文：按钮、先填表名、说明与报错标题', () => {
    fetcherData = undefined;
    const idle = render('zh-CN', createElement(UploadPreview));
    expect(idle).toContain('预览</button>');
    expect(idle).toContain('先填表名');
    expect(idle).toContain('预览不保存文件；确认登记时按这里确认的选项读取。');

    fetcherData = { previewError: '请选择一份 .csv 文件' };
    const failed = render('zh-CN', createElement(UploadPreview));
    expect(failed).toContain('预览失败');
    expect(failed).toContain('请选择一份 .csv 文件');
  });
});

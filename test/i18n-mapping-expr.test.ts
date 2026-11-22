// test/i18n-mapping-expr.test.ts —— 映射表达式的函数说明与报错接入双语（#1042，ADR-0060，纯函数，不连库）：
// ExprError 改为带句式（MsgError）：message 固定中文（mapping-spec / 表单只读原因等读它），errorText（服务端，查 en.server.json）
// 与 msgText（前端，查 en.client.json）按界面语言出文字——英文是英文；中文界面回退中文原文，message 逐字不变、offset 不变。
// 白名单函数的说明与写法（FUNCTIONS）是数据不接翻译（loader 下发、模型草稿也读），页面展示经 functionText 按函数名查字面量对照表。
// 对照面板（MappingEditorWithReference）静态渲染：英文界面没有汉字（夹具全 ASCII，函数用真实 functionList()）；
// 中文界面词典不下发、按中文原文回退。vi.mock 掉 react-router（useFetcher 等 data router hooks 在静态渲染里没有上下文，
// 同 test/i18n-mapping-editor-render.test.ts），被测组件在 mock 之后导入。表单的「插入函数」下拉与自定义表达式的即时报错
// 依赖客户端状态（选到自定义转换、输入了坏表达式），静态渲染出不来，由 functionText / msgText 的断言与浏览器验收覆盖
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { errorText } from '../app/.server/i18n';
import { I18nProvider, makeT, msgText } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    // 顶栏的界面语言入口读 root loader 数据；这里没有 root，返回 undefined 即不渲染入口
    useRouteLoaderData: () => undefined,
    // 实时校验的 fetcher：静态渲染里没有 data router 上下文，给一个空闲的
    useFetcher: () => ({ data: undefined, state: 'idle' as const, submit: () => {} }),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { MappingEditorWithReference, type ReferenceTable } from '../app/components/mapping-reference';
import { ExprError, FUNCTIONS, functionList, parseExpression } from '../app/lib/mapping-expr';
import { functionText } from '../app/lib/mapping-functions-text';

const HAN = /[一-鿿]/;
const en = makeT('en', enClient);
const zh = makeT('zh-CN', null);
/** 白名单外的全部函数名，按 FUNCTIONS 的声明顺序用「、」连接（中文 message 与英文译文里都这样） */
const ALL_NAMES = Object.keys(FUNCTIONS).join('、');

/** 解析 src 必然抛 ExprError，返回它 */
const mustThrow = (src: string): ExprError => {
  try {
    parseExpression(src);
  } catch (e) {
    expect(e, src).toBeInstanceOf(ExprError);
    return e as ExprError;
  }
  throw new Error(`${src} 没有报错`);
};

/** 抛 ExprError 的输入：表达式 → 期望的中文 message 与 offset */
const BAD: [src: string, message: string, offset: number][] = [
  ['read_csv(1)', `函数 read_csv 不在白名单内（可用：${ALL_NAMES}）`, 0],
  ['upper(1, 2)', '函数 upper 需要1 个参数，实际 2 个', 0],
  ['coalesce(1)', '函数 coalesce 需要至少 2 个参数，实际 1 个', 0],
  ['date(1, 2, 3)', '函数 date 需要1 到 2 个参数，实际 3 个', 0],
  ['date(x, 1)', 'date 的第 2 个参数（格式）必须是单引号括起的字符串', 8],
  ['from_timezone(x, 1)', 'from_timezone 的第 2 个参数（时区）必须是单引号括起的字符串', 17],
  ["from_timezone(x, 'Mars/Base')", '不认识的时区：Mars/Base（请用 IANA 时区名，如 Asia/Shanghai）', 17],
  ["'abc", "字符串没有结束的 '", 0],
  ['"abc', '字段名没有结束的 "', 0],
  ['x in 1', "in 后面要用括号列出取值，如 in ('a', 'b')", 5],
  ['and = 1', 'and 是关键字，作字段名时请加双引号："and"', 0],
  ['1 2', '多余的内容：2', 2],
  ['  ', '表达式为空', 0],
];

describe('ExprError 带句式（ADR-0060）：message 固定中文，报错文字按界面语言出', () => {
  for (const [src, message, offset] of BAD) {
    it(`${src}：message 逐字不变、offset 不变，英文是英文`, () => {
      const e = mustThrow(src);
      expect(e.message, src).toBe(message);
      expect(e.offset, src).toBe(offset);
      // 服务端（errorText 查 en.server.json）与前端（msgText 查 en.client.json）是同一份英文
      expect(errorText('en', e), src).not.toMatch(HAN);
      expect(msgText(en, e.detail), src).toBe(errorText('en', e));
      // 中文界面：两种取法都等于 message（与改造前一致）
      expect(errorText('zh-CN', e), src).toBe(message);
      expect(msgText(zh, e.detail), src).toBe(message);
    });
  }

  it('英文报错带参数与单复数：数字跟着变，句式挑得对', () => {
    expect(errorText('en', mustThrow('upper(1, 2)'))).toBe('Function upper expects 1 argument but got 2');
    expect(errorText('en', mustThrow('upper(1, 2, 3)'))).toBe('Function upper expects 1 argument but got 3');
    expect(errorText('en', mustThrow('coalesce(1)'))).toBe('Function coalesce expects at least 2 arguments but got 1');
    expect(errorText('en', mustThrow('date(1, 2, 3)'))).toBe('Function date expects 1 to 2 arguments but got 3');
    expect(errorText('en', mustThrow('date(x, 1)'))).toBe('Argument 2 of date (the format) must be a single-quoted string');
    expect(errorText('en', mustThrow("from_timezone(x, 'Mars/Base')"))).toBe('Unknown time zone: Mars/Base (use an IANA name such as Asia/Shanghai)');
    expect(errorText('en', mustThrow('read_csv(1)'))).toBe(`Function read_csv is not on the whitelist (available: ${ALL_NAMES})`);
  });

  it('表单自定义表达式的即时报错（missing 里 t(\'表达式有误：{message}\') 套 msgText 的文字）是英文', () => {
    const e = mustThrow('foo(1)');
    expect(en('表达式有误：{message}', { message: msgText(en, e.detail) })).toBe(`Invalid expression: Function foo is not on the whitelist (available: ${ALL_NAMES})`);
  });
});

describe('白名单函数的说明与写法（functionText）：中文逐字等于 FUNCTIONS，英文没有汉字', () => {
  it('functionList() 里每个函数两条都对得上', () => {
    for (const f of functionList()) {
      expect(functionText(zh, f).label, f.name).toBe(FUNCTIONS[f.name].label);
      expect(functionText(zh, f).signature, f.name).toBe(FUNCTIONS[f.name].signature);
      expect(functionText(en, f).label, f.name).not.toMatch(HAN);
      expect(functionText(en, f).signature, f.name).not.toMatch(HAN);
    }
  });

  it('英文译文抽查：写法里的参数名也换成英文', () => {
    const byName = Object.fromEntries(functionList().map(f => [f.name, f]));
    expect(functionText(en, byName.date!).signature).toBe("date(x[, 'format'])");
    expect(functionText(en, byName.from_timezone!).signature).toBe("from_timezone(x, 'timezone')");
    expect(functionText(en, byName.substr!).signature).toBe('substr(x, start[, length])');
    expect(functionText(en, byName.round!).signature).toBe('round(x[, decimal places])');
    expect(functionText(en, byName.coalesce!).label).toBe('Take the first non-null value');
    expect(functionText(en, byName.abs!).label).toBe('Absolute value');
  });

  it('不认识的函数名回退传入的原文', () => {
    const f = { name: 'nope', label: '转为文本', signature: 'nope(x)' };
    expect(functionText(zh, f)).toEqual({ label: '转为文本', signature: 'nope(x)' });
    expect(functionText(en, f)).toEqual({ label: '转为文本', signature: 'nope(x)' });
  });
});

/** 对照面板的源表夹具：全 ASCII */
const TABLE: ReferenceTable = {
  name: 'orders', sampleRows: 100, primaryKey: ['order_id'], watermark: null,
  columns: [
    { name: 'order_id', type: 'VARCHAR', nullRate: 0, distinct: 10, top: null },
    { name: 'amount', type: 'DECIMAL', nullRate: 0.01, distinct: 90, top: [{ value: 'PAID', rows: 5 }] },
  ],
  keySpaces: {}, customerSources: [], relationOrigins: {},
};

describe('对照面板（MappingEditorWithReference）静态渲染：函数表按界面语言出文字', () => {
  const render = (locale: 'en' | 'zh-CN') => renderToStaticMarkup(createElement(I18nProvider, {
    t: locale === 'en' ? en : zh,
    locale,
    children: createElement(MappingEditorWithReference, {
      defaultValue: 'fields:\n  order_id: order_id\n', table: TABLE, entity: 'order', functions: functionList(),
    }),
  }));

  it('英文界面：整页（含函数表与写法速查）没有汉字，函数写法与说明是英文', () => {
    const html = render('en');
    expect(html).not.toMatch(HAN);
    expect(html).toContain('Functions available in expressions (whitelist)');
    expect(html).toContain('date(x[, &#x27;format&#x27;])');
    expect(html).toContain('from_timezone(x, &#x27;timezone&#x27;)');
    expect(html).toContain('substr(x, start[, length])');
    expect(html).toContain('round(x[, decimal places])');
    expect(html).toContain('Convert Unix seconds to a timestamp');
    expect(html).toContain('Take the first non-null value');
    // 写法速查的示例不再带汉字（原来字典示例里的「已支付」换成 ASCII）
    expect(html).toContain('PAID');
  });

  it('中文界面：词典不下发、按中文原文回退，函数表与 FUNCTIONS 一致', () => {
    const html = render('zh-CN');
    expect(html).toContain('表达式可用的函数（白名单）');
    // 单引号在静态标记里被 React 转义成 &#x27;，按转义形式断言
    expect(html).toContain("date(x[, &#x27;格式&#x27;])");
    expect(html).toContain(FUNCTIONS.substr.signature);
    expect(html).toContain(FUNCTIONS.round.label);
    expect(html).toContain('转为文本');
  });
});

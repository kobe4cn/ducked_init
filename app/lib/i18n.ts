// app/lib/i18n.ts —— 界面双语的基础机制（ADR-0060）：中文原文（ICU 句式）当翻译键，按界面语言出字符串
// 前后端共用：页面组件也在客户端打包，这里不得引用 ~/.server/* 里的词典
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';

export type Locale = 'zh-CN' | 'en';

/** 服务端报错与入库用的描述对象：持有句式和参数，格式化（展示）时再按语言出字符串 */
export type Msg = { key: string; params?: Record<string, unknown> };

export function msg(key: string, params?: Record<string, unknown>): Msg {
  return params === undefined ? { key } : { key, params };
}

/** 服务端业务错误的基类（ADR-0060）：detail 带句式和参数，message 固定中文（/mcp 与日志读它），展示文字按界面语言出（errorText） */
export class MsgError extends Error {
  constructor(readonly detail: Msg) {
    super(translate('zh-CN', null, detail.key, detail.params));
  }
}

/** 翻译函数：键是中文 ICU 句式，变量作为参数传入 */
export type T = (key: string, params?: Record<string, unknown>) => string;

const formatterCache = new Map<string, IntlMessageFormat>();
function getFormatter(pattern: string, locale: Locale): IntlMessageFormat {
  const cacheKey = `${locale} ${pattern}`;
  let cached = formatterCache.get(cacheKey);
  if (!cached) {
    cached = new IntlMessageFormat(pattern, locale);
    formatterCache.set(cacheKey, cached);
  }
  return cached;
}

function format(pattern: string, locale: Locale, params?: Record<string, unknown>): string {
  const out = getFormatter(pattern, locale).format(params) as string | string[];
  return typeof out === 'string' ? out : out.join('');
}

/** 按界面语言出字符串：英文界面查词典，中文界面、词典缺键或词典未下发（null）时回退中文原文，变量照常代入 */
export function translate(locale: Locale, messages: Record<string, string> | null, key: string, params?: Record<string, unknown>): string {
  const en = locale === 'en' ? messages?.[key] : undefined;
  return typeof en === 'string' && en !== key ? format(en, 'en', params) : format(key, 'zh-CN', params);
}

/** 在服务端或 meta 里构造翻译函数；组件里用 useT() */
export const makeT = (locale: Locale, messages: Record<string, string> | null): T =>
  (key, params) => translate(locale, messages, key, params);

/** 前端显示 Msg（如 ExprError 的 detail）：交给 t 按界面语言出文字。前后端共用的 lib 里 msg() 的键要同时在 en.client.json 和 en.server.json */
export function msgText(t: T, m: Msg): string {
  return t(m.key, m.params);
}

const I18nContext = createContext<T>(makeT('zh-CN', null));
// 语言单独一个 context：数字 / 日期格式化（format.ts）只要语言、不要词典
const LocaleContext = createContext<Locale>('zh-CN');

/** 把当前语言的翻译函数和语言本身发给组件树（无 Provider 时回退中文，见 ErrorBoundary 场景） */
export function I18nProvider({ t, locale, children }: { t: T; locale: Locale; children: ReactNode }) {
  return createElement(LocaleContext.Provider, { value: locale },
    createElement(I18nContext.Provider, { value: t }, children));
}

export function useT(): T {
  return useContext(I18nContext);
}

/** 当前界面语言，给数字 / 日期 / 金额格式化（format.ts）用；不从 react-router 读 root loaderData，这里不依赖路由 */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}

// app/.server/i18n.ts —— 服务端词典：msg() 的描述对象按界面语言出字符串（英文查 en.server.json，ADR-0060）
// errorText / errorTextFor（#1079）：路由 catch 点用它把业务错误按请求的界面语言格式化成报错文字
import enServer from '../i18n/en.server.json';
import { MsgError, translate, type Locale, type Msg } from '~/lib/i18n';
import { getLocale } from './locale';

export function formatServer(locale: Locale, m: Msg): string {
  return translate(locale, enServer, m.key, m.params);
}

/** 错误按界面语言出报错文字：带句式（MsgError）时查词典，不带时原样返回 message / String(e) */
export function errorText(locale: Locale, e: unknown): string {
  if (e instanceof MsgError) return formatServer(locale, e.detail);
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 路由 catch 点用：按请求的界面语言（getLocale）取报错文字，只换文字、不改状态码和返回结构 */
export async function errorTextFor(request: Request, e: unknown): Promise<string> {
  return errorText(await getLocale(request), e);
}

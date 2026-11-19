// app/.server/locale.ts —— 当前请求的界面语言（ADR-0060 的优先级是账号 > cookie > 浏览器语言 > 中文）
// 本期（#926）只实现 cookie 这一环，且需开关 CRM_ENABLE_EN_LOCALE=1；账号、浏览器语言与切换入口在 #927
import type { Locale } from '~/lib/i18n';

/** 从 Cookie 头里取某个名字的原始值。react-router 的 createCookie 会对值做 base64+JSON 编解码，
 *  手工或前端脚本设置的明文 cookie（crm_locale=en）解析不出来，所以这里按明文读 */
function rawCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * 界面语言。环境变量每次请求都读、不缓存：测试与 vite 开发服务器在同一个进程里。
 * cookie 值只认 en，其他（包括没设）都是 zh-CN。
 */
export async function getLocale(request: Request): Promise<Locale> {
  if (process.env.CRM_ENABLE_EN_LOCALE !== '1') return 'zh-CN';
  return rawCookie(request, 'crm_locale') === 'en' ? 'en' : 'zh-CN';
}

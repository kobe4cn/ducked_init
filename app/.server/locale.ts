// app/.server/locale.ts —— 当前请求的界面语言（ADR-0060）：优先级是账号 > cookie > 浏览器语言 > 中文，英文需开关 CRM_ENABLE_EN_LOCALE=1
import { eq } from 'drizzle-orm';
import type { Locale } from '~/lib/i18n';
import { getCurrentMember } from './auth';
import { getDb } from './db/client';
import { members } from './db/schema';

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
 * 英文界面开关：环境变量每次调用都现读、不缓存（测试与 vite 开发服务器在同一个进程里）。
 * 关闭时整站中文，也不提供切换接口；root loader、getLocale 与 /locale 都用它。
 */
export function localeSwitchEnabled(): boolean {
  return process.env.CRM_ENABLE_EN_LOCALE === '1';
}

/** 解析 Accept-Language：按 q 值从高到低取第一个认识的语言（en / en-* 归 'en'，zh / zh-* 归 'zh-CN'），
 *  其他语言跳过，q=0（明确不接受）跳过；都不认识时返回 null */
function parseAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const entries = header
    .split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map(p => p.trim().match(/^q=([\d.]+)$/i)?.[1]).find(v => v !== undefined);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q) };
    })
    .filter(e => e.tag);
  // 稳定排序：q 相同时保持头里的先后顺序
  entries.sort((a, b) => b.q - a.q);
  for (const { tag, q } of entries) {
    if (q === 0) continue;
    const primary = tag.split('-')[0];
    if (primary === 'en') return 'en';
    if (primary === 'zh') return 'zh-CN';
  }
  return null;
}

/**
 * 界面语言（ADR-0060）：账号（members.locale，同一邮箱各租户一致）> cookie crm_locale > Accept-Language > 中文。
 * 开关关闭时整站中文，不查库、不读 Accept-Language。
 */
export async function getLocale(request: Request): Promise<Locale> {
  if (!localeSwitchEnabled()) return 'zh-CN';
  const current = await getCurrentMember(request);
  if (current) {
    const [row] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, current.memberId));
    if (row?.locale === 'en' || row?.locale === 'zh-CN') return row.locale;
  }
  const cookie = rawCookie(request, 'crm_locale');
  if (cookie === 'en' || cookie === 'zh-CN') return cookie;
  return parseAcceptLanguage(request.headers.get('Accept-Language')) ?? 'zh-CN';
}

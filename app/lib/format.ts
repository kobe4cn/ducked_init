// app/lib/format.ts —— 跟随界面语言的数字 / 日期 / 金额格式化（ADR-0060）：只换格式，不改时区、货币和数值
// 前后端共用：不得 import ~/.server/*。排序不经这里，仍在 app/lib/compare.ts（ADR-0045）
import type { Locale } from './i18n';

/** 数字：千分位等分组按界面语言，opts 原样透传给 Intl */
export function formatNumber(locale: Locale, n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(locale, opts);
}

/** 日期时间：opts 原样透传（迁移 hour12: false 这类差异要靠它）。不传 timeZone（ADR-0060：服务端是 UTC，
 *  沿用现状）；也别给 Intl 加默认 options——zh-CN 本来就是 24 小时制，中文输出要和迁移前逐字一致 */
export function formatDateTime(locale: Locale, d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleString(locale, opts);
}

/** 只有日期部分（不带时间） */
export function formatDate(locale: Locale, d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(d).toLocaleDateString(locale, opts);
}

/** 紧凑数字：中文「万 / 亿」、英文 K / M（大写、无空格）。ICU 两种语言的默认小数位数不同，显式锁定 */
export function formatCompact(locale: Locale, n: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits }).format(n);
}

/** 金额：货币符号原样拼在数字前面，不按 locale 换货币、不换算数值（ADR-0060）；
 *  compact 时数字部分用 formatCompact（¥1.2万 / ¥12K），否则 formatNumber 保留 fractionDigits 位（默认 2）小数 */
export function formatMoney(locale: Locale, symbol: string, amount: number, opts?: { compact?: boolean; fractionDigits?: number }): string {
  if (opts?.compact) return symbol + formatCompact(locale, amount);
  const digits = opts?.fractionDigits ?? 2;
  return symbol + formatNumber(locale, amount, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

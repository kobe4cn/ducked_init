// test/format.test.ts —— 跟随界面语言的数字 / 日期 / 金额格式化（ADR-0060，纯函数）：
// 中文输出与现有 zh-CN 格式逐字一致，英文换成 en 的格式；金额不换货币、不换算数值，
// 紧凑单位中文「万 / 亿」、英文 K / M；排序不经这里（ADR-0045，仍在 compare.ts）
import { describe, expect, it } from 'vitest';
import { cmpName } from '../app/lib/compare';
import { formatCompact, formatDate, formatDateTime, formatMoney, formatNumber } from '../app/lib/format';

// Intl 不传 timeZone 时按进程本地时区取字段（ADR-0060 不改时区），用本地构造函数固定住
// 「本地 2026-03-05 04:07:08」，任何时区的机器上渲染出来的字段都一样；UTC 时间戳则会随时区漂移
const at = new Date(2026, 2, 5, 4, 7, 8);

describe('数字与日期', () => {
  it('中文输出与现有 zh-CN 格式逐字一致（24 小时制、2026/3/5 04:07:08）', () => {
    for (const n of [0, 7, 1234, 1234567, 12345.678]) {
      expect(formatNumber('zh-CN', n)).toBe(n.toLocaleString('zh-CN'));
    }
    expect(formatDateTime('zh-CN', at)).toBe(at.toLocaleString('zh-CN'));
    expect(formatDate('zh-CN', at)).toBe(at.toLocaleDateString('zh-CN'));
    expect(formatDateTime('zh-CN', at)).toBe('2026/3/5 04:07:08');
    expect(formatDate('zh-CN', at)).toBe('2026/3/5');
  });

  it('英文界面用 en 的格式：日期 M/D/YYYY, h:mm:ss AM、数字千分位', () => {
    expect(formatDateTime('en', at)).toBe('3/5/2026, 4:07:08 AM');
    expect(formatNumber('en', 1234567)).toBe('1,234,567');
    expect(formatNumber('en', 12345.678)).toBe('12,345.678');
  });

  it('opts 原样透传给 Intl（如 hour12: false）', () => {
    expect(formatDateTime('en', at, { hour12: false })).toBe(at.toLocaleString('en', { hour12: false }));
    expect(formatNumber('en', 0.5, { style: 'percent' })).toBe('50%');
  });
});

describe('金额与紧凑单位', () => {
  it('两种语言都保留原货币符号与数值，不换货币、不换算', () => {
    expect(formatMoney('zh-CN', '¥', 12345.678)).toBe('¥12,345.68');
    expect(formatMoney('en', '¥', 12345.678)).toBe('¥12,345.68');
    expect(formatMoney('zh-CN', '$', 9.5)).toBe('$9.50');
    expect(formatMoney('en', '$', 0)).toBe('$0.00');
    expect(formatMoney('zh-CN', 'CNY ', 1.2345, { fractionDigits: 4 })).toBe('CNY 1.2345');
  });

  it('紧凑单位：中文「万 / 亿」，英文 K / M（大写、无空格），默认最多 2 位小数', () => {
    expect(formatCompact('zh-CN', 12350000)).toBe('1235万');
    expect(formatCompact('zh-CN', 120000000)).toBe('1.2亿');
    expect(formatCompact('en', 12350000)).toBe('12.35M');
    expect(formatCompact('en', 12000)).toBe('12K');
    expect(formatCompact('zh-CN', 123456789)).toBe('1.23亿'); // 锁定 maximumFractionDigits：默认不是 2 时会变成 1.2346亿 / 1.23B
    expect(formatMoney('zh-CN', '¥', 12000, { compact: true })).toBe('¥1.2万');
    expect(formatMoney('en', '¥', 12000, { compact: true })).toBe('¥12K');
  });
});

describe('排序不受界面语言影响（ADR-0045）', () => {
  const names = ['会员', 'CRM', '订单', 'apple', 'Banana', '订阅'];

  it('调过任何 format 函数后，cmpName 对同一组名字的排序结果在两种语言下都一样', () => {
    const sorted = [...names].sort(cmpName);
    for (const locale of ['zh-CN', 'en'] as const) {
      formatNumber(locale, 1234567);
      formatDateTime(locale, at);
      formatDate(locale, at);
      formatCompact(locale, 12350000);
      formatMoney(locale, '¥', 12000, { compact: true });
      expect([...names].sort(cmpName)).toEqual(sorted);
    }
  });

  it('format 模块不导出排序函数（排序只在 compare.ts）', async () => {
    const mod = await import('../app/lib/format');
    expect(Object.keys(mod).sort()).toEqual(['formatCompact', 'formatDate', 'formatDateTime', 'formatMoney', 'formatNumber']);
  });
});

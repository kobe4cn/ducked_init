// app/lib/upgrade-summary-text.ts —— 模板升级预览的一句话结论按界面语言拼句（ADR-0060）：结构与阈值由服务端
// app/.server/pipeline/templates/upgrade-summary.ts 算好下发，这里只管措辞。前后端共用，只依赖 ~/lib/i18n、~/lib/format 与 builtin-names，
// 服务端模块只取类型（import type，打包时擦除）。中文句式与改造前服务端拼的逐字一致（test/template-upgrade-summary.test.ts 断言）
import type {
  BoolStat, ColumnStat, NumberStat, OtherStat, TextStat, UpgradeSummary,
} from '~/.server/pipeline/templates/upgrade-summary';
import { builtinName } from './builtin-names';
import { formatNumber } from './format';
import type { Locale, T } from './i18n';

/** 一句话结论里变化最大字段在 v1、v2 下的取值：bool 写是的人数，number 写均值（2 位小数），text 写 v2 里人数最多的取值在两边的人数，other 写非空人数；缺的一边或 null 写「—」 */
export function columnPhrase(t: T, locale: Locale, c: ColumnStat): string {
  const count = (n: number) => formatNumber(locale, n);
  // 某一边没有这一列时那一边写「—」（正常数据里这种列 changed 为 null、不会被选作变化最大的字段，这里只是容错）
  if (c.type === 'bool') {
    const yes = (s: BoolStat | null) => (s === null ? '—' : count(s.yes));
    return t('{name} 为是：{a} → {b}', { name: c.name, a: yes(c.before), b: yes(c.after) });
  }
  if (c.type === 'number') {
    const mean = (s: NumberStat | null) => (s === null || s.mean === null ? '—' : s.mean.toFixed(2));
    return t('{name} 均值：{a} → {b}', { name: c.name, a: mean(c.before), b: mean(c.after) });
  }
  if (c.type === 'text') {
    // 取值写 v2 里人数最多的（values 已按人数降序）；v2 一个取值都没有时用 v1 的；那一边没有这一取值记 0
    const v = (c.after?.values.length ? c.after : c.before)?.values[0]?.value;
    const at = (s: TextStat | null) => (s === null ? '—' : count(s.values.find(x => x.value === v)?.consumers ?? 0));
    return v === undefined
      ? t('{name}：{a} → {b}', { name: c.name, a: at(c.before), b: at(c.after) })
      : t('{name} 为 {value}：{a} → {b}', { name: c.name, value: v ?? t('（无）'), a: at(c.before), b: at(c.after) });
  }
  const nonNull = (s: OtherStat | null) => (s === null ? '—' : count(s.nonNull));
  return t('{name} 非空：{a} → {b}', { name: c.name, a: nonNull(c.before), b: nonNull(c.after) });
}

/** 升级预览的一句话结论按界面语言拼（ADR-0060）：结构与阈值在 upgrade-summary.ts 里算好，这里只管措辞；分群名过 builtinName（v2: 开头的湖里原值原样）。中文句式与改造前服务端拼的逐字一致（test/template-upgrade-summary.test.ts 与 test/i18n-template-page.test.ts 断言） */
export function summarySentence(t: T, locale: Locale, s: UpgradeSummary, defaults: ReadonlySet<string>): string {
  const pct = (s.unchangedShare * 100).toFixed(1);
  if (s.detail.kind === 'segment') {
    const m = s.detail.topMove;
    if (m === null) return t('没变的人占 {p}%；没有人换分群。', { p: pct });
    return t('没变的人占 {p}%；人数最多的迁移：{before} → {after}，{n, plural, other {# 人}}。', {
      p: pct,
      before: m.before === null ? t('（无）') : builtinName(t, m.before, defaults),
      after: m.after === null ? t('（无）') : builtinName(t, m.after, defaults),
      n: m.consumers,
    });
  }
  const c = s.detail.topColumn;
  if (c === null) return t('没变的人占 {p}%；没有字段变化。', { p: pct });
  return t('没变的人占 {p}%；变化最大的字段：{phrase}。', { p: pct, phrase: columnPhrase(t, locale, c) });
}

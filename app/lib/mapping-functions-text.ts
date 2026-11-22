// app/lib/mapping-functions-text.ts —— 白名单函数的说明与写法按界面语言出文字（#1042，ADR-0060）：
// mapping-expr 的 FUNCTIONS 里中文 label / signature 是数据（loader 下发给页面、模型草稿也读它），不接翻译；
// 页面展示时按函数名查这里的字面量 t('…') 对照表（照 routes/api-keys.tsx 的 scopeLabel），键就是 FUNCTIONS 里的中文原文；
// 纯 ASCII 的写法（string(x) 等）两种语言相同，也走词典（词典里是同一串），保持键对账。不认识的名字回退传入的原文；
// #1099 的标准模型页 /model 的函数表复用它
import type { T } from './i18n';

/** 每个白名单函数的说明（label）与写法（signature）按界面语言取文字 */
export function functionText(t: T, f: { name: string; label: string; signature: string }): { label: string; signature: string } {
  return ({
    string: { label: t('转为文本'), signature: t('string(x)') },
    integer: { label: t('转为整数'), signature: t('integer(x)') },
    decimal: { label: t('转为小数'), signature: t('decimal(x)') },
    boolean: { label: t('转为布尔'), signature: t('boolean(x)') },
    date: { label: t("转为日期；第二个参数为格式时按格式解析（如 '%Y/%m/%d'）"), signature: t("date(x[, '格式'])") },
    timestamp: { label: t("转为时间（不带时区的按 UTC）；第二个参数为格式时按格式解析（如 '%Y-%m-%d %H:%M'）"), signature: t("timestamp(x[, '格式'])") },
    from_timezone: {
      label: t("把源端的本地时间（不带时区）按给定时区解读，如 from_timezone(created_at, 'Asia/Shanghai')"),
      signature: t("from_timezone(x, '时区')"),
    },
    from_epoch_seconds: { label: t('Unix 秒转为时间'), signature: t('from_epoch_seconds(x)') },
    from_epoch_millis: { label: t('Unix 毫秒转为时间'), signature: t('from_epoch_millis(x)') },
    coalesce: { label: t('取第一个非空值'), signature: t('coalesce(x, y, ...)') },
    nullif: { label: t('与第二个参数相等时为空'), signature: t('nullif(x, y)') },
    lower: { label: t('转小写'), signature: t('lower(x)') },
    upper: { label: t('转大写'), signature: t('upper(x)') },
    trim: { label: t('去掉首尾空白'), signature: t('trim(x)') },
    concat: { label: t('拼接文本（空值当作空串）'), signature: t('concat(x, y, ...)') },
    substr: { label: t('截取文本：substr(x, 起始位置从 1 起, 长度)'), signature: t('substr(x, 起始[, 长度])') },
    round: { label: t('四舍五入到给定小数位（默认 0）'), signature: t('round(x[, 小数位])') },
    abs: { label: t('绝对值'), signature: t('abs(x)') },
  })[f.name] ?? { label: f.label, signature: f.signature };
}

// app/lib/mapping-transforms-text.ts —— 常用转换的名称与参数说明按界面语言出文字（#1043，ADR-0060）：
// mapping-form 的 TRANSFORMS 里中文 label / hint 是数据（提交值用 tr.id、单位用代码值 seconds / millis，不接翻译）；
// 页面展示与 lib 报错（msg('{transform}要选一个源列') 的嵌套参数）按转换 id / 参数位置查这里的字面量 t('…') 对照表
// （照 mapping-functions-text.ts 的 functionText，#1042），键就是 TRANSFORMS 里的中文原文；
// 不认识的 id 回退传入的原文，args 与 Transform.args 顺序一致、单位选项的 value 不变
import type { T } from './i18n';
import type { Transform } from './mapping-form';

/** 参数的显示文字：label 与 hint、单位选项的名称（value 仍是代码值） */
export interface TransformArgText { label: string; hint?: string; options?: readonly { value: string; label: string }[] }

/** 每个常用转换的名称与参数说明按界面语言取文字 */
export function transformText(t: T, tr: Transform): { label: string; args: readonly TransformArgText[] } {
  const args: Record<string, readonly TransformArgText[]> = {
    timezone: [{ label: t('源端时区'), hint: t('IANA 时区名，如 Asia/Shanghai') }],
    parse: [{ label: t('格式'), hint: t('如 %Y/%m/%d、%Y-%m-%d %H:%M；不填时按标准写法解析') }],
    epoch: [{ label: t('单位'), options: [{ value: 'seconds', label: t('秒') }, { value: 'millis', label: t('毫秒') }] }],
    fixed: [{ label: t('值') }],
  };
  return {
    label: ({
      direct: t('直接取值'),
      cents: t('分换成元（除以 100）'),
      text: t('转为文本'),
      timezone: t('按时区解读时间'),
      parse: t('解析日期 / 时间'),
      epoch: t('Unix 时间戳转为时间'),
      concat: t('拼接多列与文本'),
      fixed: t('固定值'),
      custom: t('自定义表达式'),
    })[tr.id] ?? tr.label,
    args: args[tr.id] ?? tr.args,
  };
}

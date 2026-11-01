// app/lib/compare.ts —— 共用的字符串比较（ADR-0045），结果与进程的默认 locale（LC_ALL / LANG）无关。
// - 给用户看的名字（数据源名、映射名、实体标签）用 cmpName：按 'zh-CN'，汉字按拼音、排在拉丁字母前。
// - 内部键（实体名、映射 ID、模板 ID、表名、列名、kind）用 cmp：按码点比较。
// 不要用不带 locale 参数的 localeCompare：它取进程启动时的默认 locale，开发者 shell 的语言不同结果就不同。

/** 内部键：按码点比较 */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 给用户看的名字：按 zh-CN 比较 */
export const cmpName = (a: string, b: string) => a.localeCompare(b, 'zh-CN');

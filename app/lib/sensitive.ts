// app/lib/sensitive.ts —— 看起来像敏感信息的源列：列名命中常见的个人信息片段，或取值像邮箱、手机号。前后端共用。
// 采集时（source-engine）列名命中或样本里有任何一个取值像邮箱、手机号的列不保存常见取值（ADR-0016）；
// 映射草稿与表单新建扩展字段时按 looksSensitive（列名，或采集结果里过半取值的格式）默认标成敏感，发布后标准层只存加盐哈希（ADR-0005）
// openid / unionid / 企微 external_userid / 天猫 ouid 等第三方用户 ID 也按敏感列处理（#1212）

/** 列名像敏感信息的；宁可误伤（如 hotel 命中 tel） */
export const SENSITIVE_NAME = /phone|mobile|tel|mail|name|addr|id_?card|id_?no|passport|cert|birth|ssn|contact|手机|电话|邮箱|姓名|名字|地址|身份证|证件|生日|open_?id|union_?id|external_?user_?id|third_?party_?(user_?)?id|(^|_)ouid$|外部(用户)?(id|编号)|第三方(用户)?(id|编号)/i;

/** 取值像敏感信息的文本格式（source-engine 的 TEXT_FORMATS 里的名字） */
export const SENSITIVE_FORMATS: readonly string[] = ['email', 'mobile'];

/** 列名或采集到的格式特征（formats 里只有过半的格式）像敏感信息 */
export const looksSensitive = (column: { name: string; formats?: readonly { format: string }[] }) =>
  SENSITIVE_NAME.test(column.name) || !!column.formats?.some(f => SENSITIVE_FORMATS.includes(f.format));

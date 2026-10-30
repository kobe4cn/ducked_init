// app/lib/member-tokens.ts —— 个人令牌可选的有效期（天）与名称长度上限，服务端校验与「我的设置」页的表单共用；不提供永不过期（ADR-0042）
export const TOKEN_DAYS = [7, 30, 90, 365] as const;
export const DEFAULT_TOKEN_DAYS = 30;
/** 名称最长字数 */
export const TOKEN_NAME_MAX = 64;

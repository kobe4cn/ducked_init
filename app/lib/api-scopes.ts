// app/lib/api-scopes.ts —— API Key 的接口范围（ADR-0061）：三类外部接口，创建 Key 时勾选，范围外的接口 403。
// 认证判定（.server/api-auth）、创建校验（.server/api-keys）与 /api-keys 页面共用，所以放在 lib 而不是 .server
export const API_SCOPES = ['catalog', 'consumers', 'exports'] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  catalog: '目录',
  consumers: '点查',
  exports: '导出',
};

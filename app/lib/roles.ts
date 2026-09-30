// app/lib/roles.ts —— 角色固定四种：管理员、数据工程师、分析师、查看者。前后端共用（页面组件也要显示角色名称）
export const ROLES = ['admin', 'data_engineer', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  data_engineer: '数据工程师',
  analyst: '分析师',
  viewer: '查看者',
};

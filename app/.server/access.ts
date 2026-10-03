// app/.server/access.ts —— 访问控制：角色 × 操作的权限矩阵，统一在服务端入口（loader/action）处执行
import { data } from 'react-router';
import { requireMember, type CurrentMember } from './auth';
import { ROLE_LABELS, ROLES, type Role } from './db/schema';

export const PERMISSIONS = {
  'sources:read': '查看数据源与映射',
  'sources:write': '登记与修改数据源、映射',
  'definitions:read': '查看指标与标签定义',
  'definitions:draft': '起草指标与标签定义',
  'definitions:write': '修改与删除指标、标签定义',
  publish: '发布映射与定义',
  sandbox: '使用个人沙箱',
  'results:read': '查看结果层',
  'members:manage': '邀请成员、修改角色与移除成员',
  'api_keys:manage': '管理外部系统 API Key',
  'model_provider:manage': '配置模型服务',
  'audit:read': '查看审计日志',
  'pii:reveal': '申请解密敏感信息',
} as const;
export type Permission = keyof typeof PERMISSIONS;

const ALL = Object.keys(PERMISSIONS) as Permission[];

// 与 spec 的权限矩阵一一对应：管理员拥有全部权限；成员、API Key、模型服务、审计与解密敏感信息只属于管理员（ADR-0005）
const MATRIX: Record<Role, readonly Permission[]> = {
  admin: ALL,
  data_engineer: ['sources:read', 'sources:write', 'definitions:read', 'definitions:draft', 'definitions:write', 'publish', 'sandbox', 'results:read'],
  analyst: ['sources:read', 'definitions:read', 'definitions:draft', 'sandbox', 'results:read'],
  viewer: ['definitions:read', 'results:read'],
};

export const can = (role: Role, permission: Permission) => MATRIX[role].includes(permission);

/** 某项操作不可用时给成员看的说明 */
export function deniedReason(permission: Permission) {
  const roles = ROLES.filter(r => can(r, permission)).map(r => ROLE_LABELS[r]).join('、');
  return `仅${roles}可以${PERMISSIONS[permission]}`;
}

export interface Capability { permission: Permission; label: string; allowed: boolean; reason: string | null }

/** 当前角色的全部操作及不可用的原因，供界面展示 */
export const capabilitiesOf = (role: Role): Capability[] =>
  ALL.map(permission => {
    const allowed = can(role, permission);
    return { permission, label: PERMISSIONS[permission], allowed, reason: allowed ? null : deniedReason(permission) };
  });

/** 无权限时抛出 403 并附带说明。领域函数内部也调用它兜底：入口漏检时同样不会越权 */
export function assertCan(member: CurrentMember, permission: Permission) {
  if (!can(member.role, permission)) throw data({ message: deniedReason(permission) }, { status: 403 });
}

/** 服务端入口处调用：未登录跳转登录页，无权限返回 403 并附带说明 */
export async function requirePermission(request: Request, permission: Permission): Promise<CurrentMember> {
  const member = await requireMember(request);
  assertCan(member, permission);
  return member;
}

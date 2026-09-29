// app/.server/nav.ts —— 顶栏导航：成员只看到当前角色可以进入的页面；运营后台另有一套导航
import { can } from './access';
import type { CurrentMember } from './auth';

export function navFor(member: CurrentMember) {
  return [
    { to: '/', label: '概览' },
    ...(can(member.role, 'members:manage') ? [{ to: '/members', label: '成员' }] : []),
    ...(can(member.role, 'audit:read') ? [{ to: '/audit', label: '审计日志' }] : []),
  ];
}

/** 运营后台的导航：只有租户元数据与运营者审计日志，没有进入租户的入口 */
export const OPS_NAV = [
  { to: '/ops', label: '租户' },
  { to: '/ops/audit', label: '审计日志' },
];

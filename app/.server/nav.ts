// app/.server/nav.ts —— 顶栏导航：只列出当前角色可以进入的页面
import { can } from './access';
import type { CurrentMember } from './auth';

export function navFor(member: CurrentMember) {
  return [
    { to: '/', label: '概览' },
    ...(can(member.role, 'members:manage') ? [{ to: '/members', label: '成员' }] : []),
    ...(can(member.role, 'audit:read') ? [{ to: '/audit', label: '审计日志' }] : []),
  ];
}

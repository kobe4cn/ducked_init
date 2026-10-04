// app/.server/nav.ts —— 顶栏导航：成员只看到当前角色可以进入的页面（运营后台的导航在 OpsShell 中）
import { can } from './access';
import type { CurrentMember } from './auth';

export function navFor(member: CurrentMember) {
  return [
    { to: '/', label: '概览' },
    ...(can(member.role, 'sources:read') ? [{ to: '/sources', label: '数据源' }, { to: '/mappings', label: '映射' }] : []),
    { to: '/model', label: '标准模型' },
    ...(can(member.role, 'results:read') ? [{ to: '/analytics', label: '分析' }] : []),
    { to: '/tasks', label: '任务' },
    ...(can(member.role, 'members:manage') ? [{ to: '/members', label: '成员' }] : []),
    ...(can(member.role, 'audit:read') ? [{ to: '/audit', label: '审计日志' }] : []),
    ...(can(member.role, 'pii:reveal') ? [{ to: '/pii/reveal', label: '解密' }] : []),
  ];
}


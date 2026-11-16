// app/.server/nav.ts —— 顶栏导航：按模块分成 6 组（只有一页的分组直接是链接），成员只看到当前角色可以进入的子项，
// 一个分组里子项全都看不到时整个分组不显示（运营后台的导航在 OpsShell 中）
import { can } from './access';
import type { CurrentMember } from './auth';
import type { NavEntry } from '../lib/nav';

export function navFor(member: CurrentMember): NavEntry[] {
  const role = member.role;
  return [
    { to: '/', label: '概览' },
    { label: '数据接入', items: can(role, 'sources:read') ? [
      { to: '/sources', label: '数据源' },
      { to: '/mappings', label: '映射' },
      { to: '/entities', label: '自定义实体' },
      { to: '/quality', label: '数据质量' },
    ] : [] },
    { label: '数据模型', items: [
      { to: '/model', label: '标准模型' },
      { to: '/lineage', label: '数据地图' },
      { to: '/knowledge', label: '业务知识' },
    ] },
    { label: '分析', items: [
      ...(can(role, 'results:read') ? [{ to: '/analytics', label: '指标与标签' }] : []),
      ...(can(role, 'sandbox') ? [{ to: '/workbench', label: '查询' }] : []),
    ] },
    { to: '/tasks', label: '任务' },
    { label: '管理', items: [
      ...(can(role, 'members:manage') ? [{ to: '/members', label: '成员' }] : []),
      ...(can(role, 'api_keys:manage') ? [{ to: '/api-keys', label: 'API Key' }] : []),
      ...(can(role, 'model_provider:manage') ? [{ to: '/model-provider', label: '模型服务' }, { to: '/llm-usage', label: '模型调用' }] : []),
      ...(can(role, 'audit:read') ? [{ to: '/audit', label: '审计日志' }] : []),
      ...(can(role, 'pii:reveal') ? [{ to: '/pii/reveal', label: '解密' }] : []),
    ] },
  ].filter(entry => 'to' in entry || entry.items.length > 0);
}

// app/routes.ts —— 路由表：首页、任务与标准模型（需登录）、数据源与映射（数据工程师可登记与起草，分析师只读）、成员管理与审计日志（仅管理员）、登录、Magic Link 确认、退出；
// 运营后台集中在 /ops 前缀下，使用独立的运营者身份（ADR-0007），便于将来单独部署
import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('tasks', 'routes/tasks.tsx'),
  route('sources', 'routes/sources.tsx'),
  route('sources/:sourceId', 'routes/source.tsx'),
  route('model', 'routes/model.tsx'),
  route('mappings', 'routes/mappings.tsx'),
  route('mappings/:mappingId', 'routes/mapping.tsx'),
  route('members', 'routes/members.tsx'),
  route('audit', 'routes/audit.tsx'),
  route('login', 'routes/login.tsx'),
  route('auth/verify', 'routes/auth.verify.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('ops', 'routes/ops.tsx', [
    index('routes/ops.tenants.tsx'),
    route('tenants/:tenantId', 'routes/ops.tenant.tsx'),
    route('audit', 'routes/ops.audit.tsx'),
    route('login', 'routes/ops.login.tsx'),
    route('auth/verify', 'routes/ops.auth.verify.tsx'),
    route('totp', 'routes/ops.totp.tsx'),
    route('logout', 'routes/ops.logout.tsx'),
  ]),
] satisfies RouteConfig;

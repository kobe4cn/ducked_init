// app/routes.ts —— 路由表：首页、任务、标准模型与数据地图（需登录）、数据源与它的源视图、映射与自定义实体（数据工程师可登记与起草，分析师只读）、数据质量（断言结果与隔离区，有数据源查看权限的成员）、分析结果快照（有结果层查看权限的成员）、分析模板参数（起草与双人发布）、成员管理、审计日志与解密敏感信息（仅管理员）、登录、Magic Link 确认、退出；
// 运营后台集中在 /ops 前缀下，使用独立的运营者身份（ADR-0007），便于将来单独部署
import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('tasks', 'routes/tasks.tsx'),
  route('sources', 'routes/sources.tsx'),
  route('sources/:sourceId', 'routes/source.tsx'),
  route('sources/:sourceId/views/:viewId', 'routes/source-view.tsx'),
  route('model', 'routes/model.tsx'),
  route('lineage', 'routes/lineage.tsx'),
  route('mappings', 'routes/mappings.tsx'),
  route('mappings/:mappingId', 'routes/mapping.tsx'),
  route('entities', 'routes/entities.tsx'),
  route('entities/:entityId', 'routes/entity.tsx'),
  route('quality', 'routes/quality.tsx'),
  route('analytics', 'routes/analytics.tsx'),
  route('analytics/snapshots/:snapshotId', 'routes/analytics.snapshots.$id.tsx'),
  route('analytics/templates/:templateId', 'routes/analytics.templates.$id.tsx'),
  route('analytics/definitions/new', 'routes/analytics.definitions.new.tsx'),
  route('analytics/definitions/:kind/:key', 'routes/analytics.definitions.$kind.$key.tsx'),
  route('members', 'routes/members.tsx'),
  route('audit', 'routes/audit.tsx'),
  route('pii/reveal', 'routes/pii.reveal.tsx'),
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

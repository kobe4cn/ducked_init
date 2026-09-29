// app/routes.ts —— 路由表：首页（需登录）、成员管理与审计日志（仅管理员）、登录、Magic Link 确认、退出
import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('members', 'routes/members.tsx'),
  route('audit', 'routes/audit.tsx'),
  route('login', 'routes/login.tsx'),
  route('auth/verify', 'routes/auth.verify.tsx'),
  route('logout', 'routes/logout.tsx'),
] satisfies RouteConfig;

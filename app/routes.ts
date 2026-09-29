// app/routes.ts —— 路由表：首页（需登录）、登录、Magic Link 确认、退出
import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('login', 'routes/login.tsx'),
  route('auth/verify', 'routes/auth.verify.tsx'),
  route('logout', 'routes/logout.tsx'),
] satisfies RouteConfig;

// app/routes/ops.tsx —— 运营后台（/ops）的外层路由：对其下所有页面与表单提交执行可选的 IP 白名单
import { Outlet } from 'react-router';
import type { Route } from './+types/ops';
import { assertOpsIpAllowed } from '~/.server/ops-auth';

export const middleware: Route.MiddlewareFunction[] = [({ request }) => assertOpsIpAllowed(request)];

export default function Ops() {
  return <Outlet />;
}

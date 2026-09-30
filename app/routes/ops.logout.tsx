// app/routes/ops.logout.tsx —— 运营者退出登录
import { redirect } from 'react-router';
import type { Route } from './+types/ops.logout';
import { logoutOperator } from '~/.server/ops-auth';

export async function loader() {
  throw redirect('/ops');
}

export async function action({ request }: Route.ActionArgs) {
  throw redirect('/ops/login', { headers: await logoutOperator(request) });
}

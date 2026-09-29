// app/routes/home.tsx —— 首页：显示当前租户、空间与成员角色（需登录）
import { Form } from 'react-router';
import type { Route } from './+types/home';
import { requireMember } from '~/.server/auth';
import { ROLE_LABELS } from '~/.server/db/schema';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  return {
    tenantName: member.tenant.name,
    spaceName: member.space.name,
    email: member.email,
    roleLabel: ROLE_LABELS[member.role],
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, roleLabel } = loaderData;
  return (
    <main className="container mx-auto max-w-xl p-8 space-y-4">
      <h1 className="text-2xl font-semibold">{tenantName}</h1>
      <dl className="grid grid-cols-[6rem_1fr] gap-2">
        <dt className="text-gray-500">空间</dt>
        <dd>{spaceName}</dd>
        <dt className="text-gray-500">成员</dt>
        <dd>{email}</dd>
        <dt className="text-gray-500">角色</dt>
        <dd>{roleLabel}</dd>
      </dl>
      <Form method="post" action="/logout">
        <button type="submit" className="underline">退出登录</button>
      </Form>
    </main>
  );
}

// app/routes/home.tsx —— 首页：显示当前租户、空间、成员角色，以及当前角色可做与不可做的操作（需登录）
import { Check, Minus } from 'lucide-react';
import type { Route } from './+types/home';
import { capabilitiesOf } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { ROLE_LABELS } from '~/.server/db/schema';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';

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
    nav: navFor(member),
    capabilities: capabilitiesOf(member.role),
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, roleLabel, nav, capabilities } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{tenantName}</CardTitle>
          <CardDescription>当前租户</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">空间</dt>
            <dd>{spaceName}</dd>
            <dt className="text-muted-foreground">成员</dt>
            <dd>{email}</dd>
            <dt className="text-muted-foreground">角色</dt>
            <dd>{roleLabel}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>我的权限</CardTitle>
          <CardDescription>角色为「{roleLabel}」。不可用的操作注明了需要的角色，如需调整请联系本租户管理员。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {capabilities.map(c => (
              <li key={c.permission} data-permission={c.permission} data-allowed={String(c.allowed)} className="flex items-start gap-2">
                {c.allowed
                  ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="可用" />
                  : <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="不可用" />}
                <div>
                  <div className={c.allowed ? undefined : 'text-muted-foreground'}>{c.label}</div>
                  {c.reason && <div className="text-xs text-muted-foreground">{c.reason}</div>}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </AppShell>
  );
}

// app/routes/home.tsx —— 首页：显示当前租户、空间与成员角色（需登录）
import { Form } from 'react-router';
import { LogOut } from 'lucide-react';
import type { Route } from './+types/home';
import { requireMember } from '~/.server/auth';
import { ROLE_LABELS } from '~/.server/db/schema';
import { Button } from '~/components/ui/button';
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
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, roleLabel } = loaderData;
  return (
    <div className="min-h-svh bg-muted">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <span className="font-semibold">CRM 数据分析平台</span>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{email}</span>
            <Form method="post" action="/logout">
              <Button type="submit" variant="ghost" size="sm">
                <LogOut data-icon="inline-start" />
                退出登录
              </Button>
            </Form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">
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
      </main>
    </div>
  );
}

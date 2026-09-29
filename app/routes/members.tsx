// app/routes/members.tsx —— 成员管理（仅管理员）：邀请成员并指定角色、修改角色、移除成员
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/members';
import { can, requirePermission } from '~/.server/access';
import { logout } from '~/.server/auth';
import { ROLE_LABELS, ROLES, type Role } from '~/.server/db/schema';
import { changeMemberRole, inviteMember, listMembers, MemberError, removeMember } from '~/.server/members';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '成员 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'members:manage');
  const rows = await listMembers(member);
  return {
    email: member.email,
    nav: navFor(member),
    tenantName: member.tenant.name,
    selfId: member.memberId,
    members: rows.map(r => ({ id: r.id, email: r.email, role: r.role, createdAt: r.createdAt.toISOString() })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'members:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'invite':
        await inviteMember(member, { email: field('email'), role: field('role') }, new URL(request.url).origin);
        break;
      case 'change-role':
        await changeMemberRole(member, field('memberId'), field('role'));
        // 管理员把自己改成了其他角色：已无权留在成员页
        if (field('memberId') === member.memberId && !can(field('role') as Role, 'members:manage')) throw redirect('/');
        break;
      case 'remove':
        await removeMember(member, field('memberId'));
        // 移除的是自己：会话已随之失效，顺带清除 cookie
        if (field('memberId') === member.memberId) throw redirect('/login', { headers: { 'Set-Cookie': await logout(request) } });
        break;
      default:
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MemberError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/members');
}

const roleOptions = ROLES.map(r => <NativeSelectOption key={r} value={r}>{ROLE_LABELS[r]}</NativeSelectOption>);

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tenantName, selfId, members } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>邀请成员</CardTitle>
          <CardDescription>被邀请的邮箱即可通过登录链接进入 {tenantName}。平台不开放自助注册。</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="invite" />
            <FieldGroup className="flex-row items-end">
              <Field>
                <FieldLabel htmlFor="invite-email">邮箱</FieldLabel>
                <Input id="invite-email" type="email" name="email" required placeholder="name@company.com" />
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="invite-role">角色</FieldLabel>
                <NativeSelect id="invite-role" name="role" defaultValue="viewer">{roleOptions}</NativeSelect>
              </Field>
              <Button type="submit" disabled={submitting}>邀请</Button>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>成员</CardTitle>
          <CardDescription>修改角色立即生效；移除成员后其已登录的会话立即失效。租户至少保留一名管理员。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>加入时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map(m => (
                <TableRow key={m.id} data-email={m.email} data-member-id={m.id}>
                  <TableCell>
                    {m.email}
                    {m.id === selfId && <Badge variant="secondary" className="ml-2">你</Badge>}
                  </TableCell>
                  <TableCell>
                    <Form method="post" className="flex items-center gap-2">
                      <input type="hidden" name="intent" value="change-role" />
                      <input type="hidden" name="memberId" value={m.id} />
                      <NativeSelect size="sm" name="role" defaultValue={m.role} aria-label={`${m.email} 的角色`}>{roleOptions}</NativeSelect>
                      <Button type="submit" variant="outline" size="sm" disabled={submitting}>保存</Button>
                    </Form>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{new Date(m.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                  <TableCell className="text-right">
                    <Form
                      method="post"
                      onSubmit={e => { if (!confirm(`确定移除 ${m.email}？其会话将立即失效。`)) e.preventDefault(); }}
                    >
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="memberId" value={m.id} />
                      <Button type="submit" variant="destructive" size="sm" disabled={submitting}>移除</Button>
                    </Form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </AppShell>
  );
}

// app/routes/members.tsx —— 成员管理（仅管理员）：邀请成员并指定角色、修改角色、移除成员
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/members';
import { can, requirePermission } from '~/.server/access';
import { logout } from '~/.server/auth';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { ROLE_LABELS, ROLES, type Role } from '~/lib/roles';
import { changeMemberRole, inviteMember, listMembers, MemberError, removeMember } from '~/.server/members';
import { navFor } from '~/.server/nav';
import { builtinName, ENUM_LABELS } from '~/lib/builtin-names';
import { formatDate } from '~/lib/format';
import { makeT, msg, useLocale, useT } from '~/lib/i18n';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: `${t('成员')} · ${t('CRM 数据分析平台')}` }];
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
        return data({ error: formatServer(await getLocale(request), msg('未知操作')) }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MemberError) return data({ error: await errorTextFor(request, e) }, { status: e.status });
    throw e;
  }
  throw redirect('/members');
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tenantName, selfId, members } = loaderData;
  const t = useT();
  const locale = useLocale();
  const submitting = useNavigation().state === 'submitting';
  const roleName = (role: Role) => builtinName(t, ROLE_LABELS[role], ENUM_LABELS);
  const roleOptions = ROLES.map(r => <NativeSelectOption key={r} value={r}>{roleName(r)}</NativeSelectOption>);
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={t('成员')} description={t('修改角色立即生效；移除成员后其已登录的会话立即失效。租户至少保留一名管理员。')} />

      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('操作未完成')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('邀请成员')}>{t('被邀请的邮箱即可通过登录链接进入 {tenant}。平台不开放自助注册。', { tenant: tenantName })}</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="invite" />
          <FieldGroup className="flex-row items-end">
            <Field>
              <FieldLabel htmlFor="invite-email">{t('邮箱')}</FieldLabel>
              <Input id="invite-email" type="email" name="email" required placeholder="name@company.com" />
            </Field>
            <Field className="w-auto">
              <FieldLabel htmlFor="invite-role">{t('角色')}</FieldLabel>
              <NativeSelect id="invite-role" name="role" defaultValue="viewer">{roleOptions}</NativeSelect>
            </Field>
            <Button type="submit" disabled={submitting}>{t('邀请')}</Button>
          </FieldGroup>
        </Form>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('邮箱')}</TableHead>
              <TableHead>{t('角色')}</TableHead>
              <TableHead>{t('加入时间')}</TableHead>
              <TableHead className="text-right">{t('操作')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map(m => (
              <TableRow key={m.id} data-email={m.email} data-member-id={m.id}>
                <TableCell>
                  {m.email}
                  {m.id === selfId && <Badge variant="secondary" className="ml-2">{t('你')}</Badge>}
                </TableCell>
                <TableCell>
                  <Form
                    method="post"
                    className="flex items-center gap-2"
                    onSubmit={e => {
                      // 改自己的角色：降成非管理员后会立即离开成员页，先确认
                      const role = new FormData(e.currentTarget).get('role');
                      if (m.id === selfId && role !== m.role && !confirm(t('把自己的角色改为「{role}」？新角色不能管理成员时，你将立即离开成员页。', { role: roleName(role as Role) }))) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="intent" value="change-role" />
                    <input type="hidden" name="memberId" value={m.id} />
                    <NativeSelect size="sm" name="role" defaultValue={m.role} aria-label={t('{email} 的角色', { email: m.email })}>{roleOptions}</NativeSelect>
                    <Button type="submit" variant="outline" size="sm" disabled={submitting}>{t('保存')}</Button>
                  </Form>
                </TableCell>
                <TableCell className="text-slate-500">{formatDate(locale, m.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Form
                    method="post"
                    onSubmit={e => { if (!confirm(t('确定移除 {email}？其会话将立即失效。', { email: m.email }))) e.preventDefault(); }}
                  >
                    <input type="hidden" name="intent" value="remove" />
                    <input type="hidden" name="memberId" value={m.id} />
                    <Button type="submit" variant="destructive" size="sm" disabled={submitting}>{t('移除')}</Button>
                  </Form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AppShell>
  );
}

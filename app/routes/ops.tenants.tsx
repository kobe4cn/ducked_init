// app/routes/ops.tenants.tsx —— 运营后台首页：租户列表（状态、成员数与管理员邮箱）与开通租户
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/ops.tenants';
import { requireOperator } from '~/.server/ops-auth';
import { createTenant, listTenants, TenantError } from '~/.server/tenants';
import { OpsShell } from '~/components/ops-shell';
import { TenantStatusBadge } from '~/components/tenant-status-badge';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '租户 · 运营后台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const operator = await requireOperator(request);
  const tenants = await listTenants();
  return {
    email: operator.email,
    tenants: tenants.map(t => ({ ...t, createdAt: t.createdAt.toISOString(), suspendedAt: t.suspendedAt?.toISOString() ?? null })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const operator = await requireOperator(request);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  if (field('intent') !== 'create-tenant') return data({ error: '未知操作' }, { status: 400 });
  try {
    await createTenant({ slug: field('slug'), name: field('name'), adminEmail: field('adminEmail') }, operator);
  } catch (e) {
    if (e instanceof TenantError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/ops');
}

export default function OpsTenants({ loaderData, actionData }: Route.ComponentProps) {
  const { email, tenants } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <OpsShell email={email}>
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>开通租户</CardTitle>
          <CardDescription>同时创建默认空间与首个管理员；管理员随后用该邮箱通过登录链接进入平台。</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="create-tenant" />
            <FieldGroup className="flex-row items-end">
              <Field>
                <FieldLabel htmlFor="tenant-slug">标识</FieldLabel>
                <Input id="tenant-slug" name="slug" required placeholder="acme" />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-name">名称</FieldLabel>
                <Input id="tenant-name" name="name" required placeholder="示例商贸" />
              </Field>
              <Field>
                <FieldLabel htmlFor="tenant-admin">首个管理员邮箱</FieldLabel>
                <Input id="tenant-admin" type="email" name="adminEmail" required placeholder="admin@company.com" />
              </Field>
              <Button type="submit" disabled={submitting}>开通</Button>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>租户</CardTitle>
          <CardDescription>运营后台只显示租户的成员数与管理员邮箱，不显示成员名单与业务数据。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>标识</TableHead>
                <TableHead>开通时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">成员数</TableHead>
                <TableHead>管理员</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map(t => (
                <TableRow
                  key={t.id}
                  data-tenant-slug={t.slug}
                  data-tenant-id={t.id}
                  data-member-count={t.memberCount}
                  data-tenant-status={t.suspendedAt ? 'suspended' : 'active'}
                  data-suspended-at={t.suspendedAt ?? undefined}
                >
                  <TableCell>
                    <Link to={`/ops/tenants/${t.id}`} className="underline underline-offset-4">{t.name}</Link>
                  </TableCell>
                  <TableCell className="font-mono">{t.slug}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <TenantStatusBadge suspended={!!t.suspendedAt} />
                      {t.suspendedAt && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(t.suspendedAt).toLocaleString('zh-CN')}：{t.suspensionReason}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{t.memberCount}</TableCell>
                  <TableCell>{t.adminEmails.join('、')}</TableCell>
                </TableRow>
              ))}
              {!tenants.length && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">暂无租户</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </OpsShell>
  );
}

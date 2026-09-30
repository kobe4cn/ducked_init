// app/routes/ops.tenant.tsx —— 运营后台的单个租户：改名、指定管理员（用于管理员邮箱失效时的恢复）
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/ops.tenant';
import { requireOperator } from '~/.server/ops-auth';
import { assignTenantAdmin, getTenant, renameTenant, TenantError } from '~/.server/tenants';
import { OpsShell } from '~/components/ops-shell';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.tenant.name ?? '租户'} · 运营后台` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const operator = await requireOperator(request);
  try {
    const tenant = await getTenant(params.tenantId);
    return { email: operator.email, tenant: { ...tenant, createdAt: tenant.createdAt.toISOString() } };
  } catch (e) {
    if (e instanceof TenantError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const operator = await requireOperator(request);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'rename':
        await renameTenant(operator, params.tenantId, field('name'));
        break;
      case 'assign-admin':
        await assignTenantAdmin(operator, params.tenantId, field('email'), new URL(request.url).origin);
        break;
      default:
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof TenantError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect(`/ops/tenants/${params.tenantId}`);
}

export default function OpsTenant({ loaderData, actionData }: Route.ComponentProps) {
  const { email, tenant } = loaderData;
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

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{tenant.name}</CardTitle>
          <CardDescription>租户元数据。运营者看不到成员名单与业务数据，也不能进入租户。</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">标识</dt>
            <dd className="font-mono">{tenant.slug}</dd>
            <dt className="text-muted-foreground">开通时间</dt>
            <dd>{new Date(tenant.createdAt).toLocaleString('zh-CN')}</dd>
            <dt className="text-muted-foreground">成员数</dt>
            <dd>{tenant.memberCount}</dd>
            <dt className="text-muted-foreground">管理员</dt>
            <dd>{tenant.adminEmails.join('、')}</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>租户改名</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="rename" />
            <FieldGroup className="flex-row items-end">
              <Field>
                <FieldLabel htmlFor="tenant-name">名称</FieldLabel>
                <Input id="tenant-name" name="name" required defaultValue={tenant.name} key={tenant.name} />
              </Field>
              <Button type="submit" disabled={submitting}>保存</Button>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>指定管理员</CardTitle>
          <CardDescription>用于管理员邮箱失效时的恢复：该邮箱已是本租户成员则提升为管理员，否则以管理员身份加入，并收到登录通知。</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="assign-admin" />
            <FieldGroup className="flex-row items-end">
              <Field>
                <FieldLabel htmlFor="admin-email">邮箱</FieldLabel>
                <Input id="admin-email" type="email" name="email" required placeholder="name@company.com" />
              </Field>
              <Button type="submit" disabled={submitting}>指定</Button>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>
    </OpsShell>
  );
}

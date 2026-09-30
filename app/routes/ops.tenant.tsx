// app/routes/ops.tenant.tsx —— 运营后台的单个租户：改名、指定管理员（用于管理员邮箱失效时的恢复）、停用与恢复、配额与数据湖
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/ops.tenant';
import { requireOperator } from '~/.server/ops-auth';
import { getTenantLake } from '~/.server/lake';
import { QUOTA_FIELDS, QUOTA_KEYS, type QuotaKey } from '~/.server/quota';
import {
  assignTenantAdmin, getTenant, initTenantLake, renameTenant, resumeTenant, setTenantQuota, suspendTenant, TenantError,
} from '~/.server/tenants';
import { OpsShell } from '~/components/ops-shell';
import { TenantStatusBadge } from '~/components/tenant-status-badge';
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
    const lake = await getTenantLake(tenant.id);
    return {
      email: operator.email,
      lake: lake && {
        ...lake,
        migration: lake.migration && {
          ...lake.migration,
          createdAt: lake.migration.createdAt.toISOString(),
          finishedAt: lake.migration.finishedAt?.toISOString() ?? null,
        },
      },
      quotaFields: QUOTA_KEYS.map(key => ({ key, ...QUOTA_FIELDS[key] })),
      tenant: { ...tenant, createdAt: tenant.createdAt.toISOString(), suspendedAt: tenant.suspendedAt?.toISOString() ?? null },
    };
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
      case 'suspend':
        await suspendTenant(operator, params.tenantId, field('reason'));
        break;
      case 'resume':
        await resumeTenant(operator, params.tenantId, field('reason'));
        break;
      case 'set-quota':
        await setTenantQuota(operator, params.tenantId, Object.fromEntries(QUOTA_KEYS.map(k => [k, field(k)])) as Record<QuotaKey, string>);
        break;
      case 'init-lake':
        await initTenantLake(operator, params.tenantId);
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

type Migration = NonNullable<NonNullable<Route.ComponentProps['loaderData']['lake']>['migration']>;

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '');

/** 最近一次迁移存储：进行中时给出目标，结束后给出旧位置（不自动删除）或失败原因 */
function LakeMigration({ migration: m }: { migration: Migration }) {
  switch (m.status) {
    case 'pending':
    case 'running':
      return (
        <span>
          <strong>迁移中</strong>（{m.status === 'pending' ? '等待运行中的任务结束' : '复制中'}，申请于 {at(m.createdAt)}）→{' '}
          <span className="font-mono break-all">{m.toPath}</span>
        </span>
      );
    case 'succeeded':
      return (
        <span>
          {at(m.finishedAt)} 迁移完成。旧位置 <span className="font-mono">{m.fromPath}</span> 的文件未删除，确认无误后另行清理
        </span>
      );
    case 'failed':
      return (
        <span className="text-destructive">
          {at(m.finishedAt)} 迁移到 <span className="font-mono break-all">{m.toPath}</span> 失败：{m.error}。仍使用原位置，可重新执行命令重试
        </span>
      );
  }
}

export default function OpsTenant({ loaderData, actionData }: Route.ComponentProps) {
  const { email, tenant, lake, quotaFields } = loaderData;
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
            <dt className="text-muted-foreground">状态</dt>
            <dd><TenantStatusBadge suspended={!!tenant.suspendedAt} /></dd>
            {tenant.suspendedAt && (
              <>
                <dt className="text-muted-foreground">停用时间</dt>
                <dd>{new Date(tenant.suspendedAt).toLocaleString('zh-CN')}</dd>
                <dt className="text-muted-foreground">停用原因</dt>
                <dd>{tenant.suspensionReason}</dd>
              </>
            )}
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
          <CardTitle>数据湖</CardTitle>
          <CardDescription>租户独立的存储前缀（在对象存储上时另有只能访问该前缀的账号）与 DuckLake catalog schema，开通时自动初始化。初始化完成前、迁移存储期间不派发该租户的任务。迁移存储用命令 <code>pnpm lake:migrate</code>。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {lake ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">存储前缀</dt>
              <dd className="font-mono break-all">{lake.dataPath}</dd>
              <dt className="text-muted-foreground">Catalog</dt>
              <dd className="font-mono">{lake.catalogSchema}</dd>
              {lake.s3User && (
                <>
                  <dt className="text-muted-foreground">存储账号</dt>
                  <dd data-s3-user={lake.s3User.ready ? 'ready' : 'missing'}>
                    <span className="font-mono">{lake.s3User.name}</span>{lake.s3User.ready ? '' : '（未建立）'}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">状态</dt>
              <dd data-lake-status={lake.ready ? 'ready' : 'pending'}>{lake.ready ? '已初始化' : '未初始化'}</dd>
              {lake.migration && (
                <>
                  <dt className="text-muted-foreground">迁移存储</dt>
                  <dd data-lake-migration={lake.migration.status}><LakeMigration migration={lake.migration} /></dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground" data-lake-status="missing">该租户开通时平台还没有数据湖，初始化后才能运行任务。</p>
          )}
          {!lake?.ready && (
            <Form method="post">
              <input type="hidden" name="intent" value="init-lake" />
              <Button type="submit" variant="outline" disabled={submitting}>初始化数据湖</Button>
            </Form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>配额</CardTitle>
          <CardDescription>每个任务在独立进程中运行，内存与线程按此限制；同时运行的任务超过并发数时排队。修改对之后派发的任务生效，并记入租户的审计日志。</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <input type="hidden" name="intent" value="set-quota" />
            <FieldGroup className="flex-row items-end">
              {quotaFields.map(({ key, label, unit, min, max }) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`quota-${key}`}>{label}{unit && `（${unit.trim()}）`}</FieldLabel>
                  <Input id={`quota-${key}`} type="number" name={key} required min={min} max={max} defaultValue={tenant[key]} key={tenant[key]} />
                </Field>
              ))}
              <Button type="submit" disabled={submitting}>保存</Button>
            </FieldGroup>
          </Form>
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
          {tenant.suspendedAt ? (
            <p className="text-sm text-muted-foreground">租户已停用，恢复后才能指定管理员。</p>
          ) : (
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
          )}
        </CardContent>
      </Card>

      {tenant.suspendedAt ? (
        <Card>
          <CardHeader>
            <CardTitle>恢复租户</CardTitle>
            <CardDescription>恢复后成员需要重新登录。原因会记入租户的审计日志，租户管理员可以看到。</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="resume" />
              <FieldGroup className="flex-row items-end">
                <Field>
                  <FieldLabel htmlFor="resume-reason">恢复原因</FieldLabel>
                  <Input id="resume-reason" name="reason" required placeholder="例如：已续约" />
                </Field>
                <Button type="submit" disabled={submitting}>恢复</Button>
              </FieldGroup>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>停用租户</CardTitle>
            <CardDescription>停用后该租户成员的会话立即失效且无法再登录，数据完整保留，可以随时恢复。原因会记入租户的审计日志，租户管理员可以看到。</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="suspend" />
              <FieldGroup className="flex-row items-end">
                <Field>
                  <FieldLabel htmlFor="suspend-reason">停用原因</FieldLabel>
                  <Input id="suspend-reason" name="reason" required placeholder="例如：合同到期未续约" />
                </Field>
                <Button type="submit" variant="destructive" disabled={submitting}>停用</Button>
              </FieldGroup>
            </Form>
          </CardContent>
        </Card>
      )}
    </OpsShell>
  );
}

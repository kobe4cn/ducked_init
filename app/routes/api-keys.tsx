// app/routes/api-keys.tsx —— 外部系统的 API Key（仅管理员）：创建（明文只在创建后的这次响应里展示一次）、吊销
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert, KeyRound } from 'lucide-react';
import type { Route } from './+types/api-keys';
import { requirePermission } from '~/.server/access';
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey } from '~/.server/api-keys';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'API Key · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'api_keys:manage');
  const rows = await listApiKeys(member);
  return {
    email: member.email,
    nav: navFor(member),
    keys: rows.map(r => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      revoked: r.revokedAt !== null,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'api_keys:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'create': {
        // 不重定向：明文只在这次响应里出现，刷新或离开后再也看不到
        const { key, row } = await createApiKey(member, field('name'));
        return { created: { name: row.name, key } };
      }
      case 'revoke':
        await revokeApiKey(member, field('keyId'));
        break;
      default:
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ApiKeyError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/api-keys');
}

const formatTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false });

export default function ApiKeys({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, keys } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="API Key" description="外部系统用 Authorization: Bearer <Key> 调用 /api/v1/ 下的接口。吊销后用这把 Key 的请求立即被拒绝。" />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {actionData && 'created' in actionData && (
        <Alert role="status">
          <KeyRound />
          <AlertTitle>已创建「{actionData.created.name}」</AlertTitle>
          <AlertDescription>
            <p>请现在复制并妥善保存。这把 Key 只展示这一次，平台不保存明文，之后无法再查看。</p>
            <code data-api-key className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{actionData.created.key}</code>
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="创建 API Key">每个外部系统各用一把，便于单独吊销。</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <FieldGroup className="flex-row items-end">
            <Field>
              <FieldLabel htmlFor="api-key-name">名称</FieldLabel>
              <Input id="api-key-name" name="name" required maxLength={100} placeholder="如：营销自动化系统" />
            </Field>
            <Button type="submit" disabled={submitting}>创建</Button>
          </FieldGroup>
        </Form>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">还没有 API Key。在上面填写名称创建第一把，交给要调用接口的外部系统。</div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>前缀</TableHead>
                <TableHead>创建人</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>最近使用</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map(k => (
                <TableRow key={k.id} data-api-key-id={k.id}>
                  <TableCell>{k.name}</TableCell>
                  <TableCell className="font-mono">{`${k.prefix}…`}</TableCell>
                  <TableCell>{k.createdByEmail}</TableCell>
                  <TableCell className="text-slate-500">{formatTime(k.createdAt)}</TableCell>
                  <TableCell className="text-slate-500">{k.lastUsedAt ? formatTime(k.lastUsedAt) : '从未使用'}</TableCell>
                  <TableCell className="text-right">
                    {k.revoked ? (
                      <Badge variant="secondary">已吊销</Badge>
                    ) : (
                      <Form
                        method="post"
                        onSubmit={e => { if (!confirm(`确定吊销「${k.name}」？用这把 Key 的外部系统将立即无法调用接口。`)) e.preventDefault(); }}
                      >
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="keyId" value={k.id} />
                        <Button type="submit" variant="destructive" size="sm" disabled={submitting}>吊销</Button>
                      </Form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AppShell>
  );
}

// app/routes/sources.tsx —— 数据源（数据工程师、管理员可登记；分析师只读）：本租户的数据源列表与登记表单
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/sources';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { listSources, registerSource, SourceError } from '~/.server/sources';
import { formValues, SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from '~/lib/sources';
import { AppShell } from '~/components/app-shell';
import { SourceFields } from '~/components/source-fields';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据源 · CRM 数据分析平台' }];
}

/** 列表上的一行摘要：连接的目标，不含凭据 */
const targetOf = (kind: SourceKind, c: Record<string, string>) =>
  kind === 'postgres' || kind === 'mysql' ? `${c.user}@${c.host}:${c.port}/${c.database}${c.schema ? `（${c.schema}）` : ''}` : c.path;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const rows = await listSources(member);
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    sources: rows.map(s => ({ id: s.id, name: s.name, kind: s.kind, target: targetOf(s.kind, s.config), createdAt: s.createdAt.toISOString() })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:write');
  const form = await request.formData();
  if (form.get('intent') !== 'register') return data({ error: '未知操作', values: {} }, { status: 400 });
  const input = Object.fromEntries([...form].map(([k, v]) => [k, String(v)]));
  try {
    const { id } = await registerSource(member, input);
    throw redirect(`/sources/${id}`);
  } catch (e) {
    if (e instanceof SourceError) return data({ error: e.message, values: formValues(form) }, { status: e.status });
    throw e;
  }
}

export default function Sources({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, sources } = loaderData;
  const values: Record<string, string> = actionData?.values ?? {};
  const [kind, setKind] = useState<SourceKind>((SOURCE_KINDS as readonly string[]).includes(values.kind) ? (values.kind as SourceKind) : 'postgres');
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>未能登记</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>数据源</CardTitle>
          <CardDescription>本租户登记的外部只读连接。平台永不写入数据源；凭据加密保存，任何页面都不显示。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>登记时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map(s => (
                <TableRow key={s.id} data-source-id={s.id}>
                  <TableCell><Link to={`/sources/${s.id}`} className="font-medium hover:underline">{s.name}</Link></TableCell>
                  <TableCell><Badge variant="outline">{SOURCE_KIND_LABELS[s.kind]}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.target}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(s.createdAt).toLocaleString('zh-CN')}</TableCell>
                </TableRow>
              ))}
              {!sources.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">还没有数据源</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>登记数据源</CardTitle>
            <CardDescription>登记前平台会连接数据源并探测账号的写权限，可写的账号会被拒绝。登记后自动采集表清单与列统计。</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="register" />
              <FieldGroup>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="source-name">名称</FieldLabel>
                    <Input id="source-name" name="name" required defaultValue={values.name ?? ''} placeholder="如：电商主库" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="source-kind">类型</FieldLabel>
                    <NativeSelect id="source-kind" name="kind" value={kind} onChange={e => setKind(e.target.value as SourceKind)}>
                      {SOURCE_KINDS.map(k => <NativeSelectOption key={k} value={k}>{SOURCE_KIND_LABELS[k]}</NativeSelectOption>)}
                    </NativeSelect>
                  </Field>
                </div>
                <SourceFields key={kind} kind={kind} values={values} />
                <div>
                  <Button type="submit" disabled={submitting}>{submitting ? '正在校验…' : '校验并登记'}</Button>
                </div>
              </FieldGroup>
            </Form>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}

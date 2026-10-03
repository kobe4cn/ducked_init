// app/routes/pii.reveal.tsx —— 解密敏感信息（仅管理员，ADR-0005）：选一个已发布的映射、填源表主键与原因，查看这条记录敏感字段的明文。
// 明文只在这次提交的响应里，页面不缓存；每次解密都记进审计日志
import { data, Form, useNavigation } from 'react-router';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import type { Route } from './+types/pii.reveal';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { PiiError, revealableMappings, revealPii } from '~/.server/pii';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '解密敏感信息 · CRM 数据分析平台' }];
}

// 响应里可能有明文：浏览器与中间代理都不留副本
export const headers = () => ({ 'Cache-Control': 'no-store' });

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'pii:reveal');
  return { email: member.email, nav: navFor(member), mappings: await revealableMappings(member) };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'pii:reveal');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    return { revealed: await revealPii(member, { mappingId: field('mappingId'), key: field('key'), reason: field('reason') }) };
  } catch (e) {
    if (e instanceof PiiError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
}

export default function PiiReveal({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, mappings } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const revealed = actionData && 'revealed' in actionData ? actionData.revealed : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="解密敏感信息" description="标准层里的敏感字段只有哈希。确有需要时按源表主键从原始层读出一条记录的明文，每次解密都记入审计日志。" />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>没有解密</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {revealed && (
        <div className="space-y-4 rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
          <SectionHeader title="明文">
            <span className="inline-flex items-center gap-1 text-amber-600">
              <ShieldAlert className="size-4" />
              「{revealed.sourceName}」{revealed.table} → {revealed.entity}，主键 {Object.entries(revealed.key).map(([k, v]) => `${k} = ${v}`).join('，')}。
              只在本页显示一次，离开或刷新后不再保留。
            </span>
          </SectionHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>字段</TableHead>
                <TableHead>明文</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revealed.fields.map(f => (
                <TableRow key={f.name} data-field={f.name}>
                  <TableCell>{f.label}</TableCell>
                  <TableCell className="font-mono">{f.value ?? <span className="text-slate-400">（空）</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {mappings.length ? (
        <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title="申请解密">选择记录所在的映射，填写源表主键与解密原因。原因会记入审计日志。</SectionHeader>
          <Form method="post">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reveal-mapping">映射</FieldLabel>
                <NativeSelect id="reveal-mapping" name="mappingId" required>
                  {mappings.map(m => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      「{m.sourceName}」{m.table} → {m.entity}（{m.fields.join('、')}）
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="reveal-key">源表主键</FieldLabel>
                <Input id="reveal-key" name="key" required autoComplete="off" />
                <FieldDescription>主键有多列时按列的顺序用逗号分隔。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="reveal-reason">原因</FieldLabel>
                <Input id="reveal-reason" name="reason" required autoComplete="off" placeholder="例如：客户投诉回访，需核对联系方式" />
              </Field>
              <Button type="submit" className="w-auto self-start" disabled={submitting}>解密</Button>
            </FieldGroup>
          </Form>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          还没有带敏感字段的已发布映射。发布把源表映射到消费者（姓名、手机号、邮箱）或带敏感扩展字段的映射后，可以在这里申请解密。
        </div>
      )}
    </AppShell>
  );
}

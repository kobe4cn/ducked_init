// app/routes/pii.reveal.tsx —— 解密敏感信息（仅管理员，ADR-0005）：选一个已发布的映射、填源表主键与原因，查看这条记录敏感字段的明文。
// 明文只在这次提交的响应里，页面不缓存；每次解密都记进审计日志。
// 页面文字接入双语（#1047）：实体名与字段名是服务端算好的中文，只在展示时经 builtinName 换语言（自定义名原样透传），
// 服务端与审计 detail 不动
import { data, Form, useNavigation } from 'react-router';
import { CircleAlert, ShieldAlert } from 'lucide-react';
import type { Route } from './+types/pii.reveal';
import { requirePermission } from '~/.server/access';
import { errorTextFor } from '~/.server/i18n';
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
import { builtinName, CANONICAL_NAMES } from '~/lib/builtin-names';
import { makeT, useT } from '~/lib/i18n';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段（没有 data）；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: t('解密敏感信息 · CRM 数据分析平台') }];
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
    if (e instanceof PiiError) return data({ error: await errorTextFor(request, e) }, { status: e.status });
    throw e;
  }
}

export default function PiiReveal({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, mappings } = loaderData;
  const t = useT();
  const submitting = useNavigation().state === 'submitting';
  const revealed = actionData && 'revealed' in actionData ? actionData.revealed : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={t('解密敏感信息')} description={t('标准层里的敏感字段只有哈希。确有需要时按源表主键从原始层读出一条记录的明文，每次解密都记入审计日志。')} />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('没有解密')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {revealed && (
        <div className="space-y-4 rounded-2xl border border-amber-200 bg-white p-6 shadow-sm">
          <SectionHeader title={t('明文')}>
            <span className="inline-flex items-center gap-1 text-amber-600">
              <ShieldAlert className="size-4" />
              {t('「{source}」{table} → {entity}，主键 {key}。', {
                source: revealed.sourceName, table: revealed.table, entity: builtinName(t, revealed.entity, CANONICAL_NAMES),
                key: Object.entries(revealed.key).map(([k, v]) => `${k} = ${v}`).join(t('，')),
              })}{' '}
              {t('只在本页显示一次，离开或刷新后不再保留。')}
            </span>
          </SectionHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('字段')}</TableHead>
                <TableHead>{t('明文')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revealed.fields.map(f => (
                <TableRow key={f.name} data-field={f.name}>
                  <TableCell>{builtinName(t, f.label, CANONICAL_NAMES)}</TableCell>
                  <TableCell className="font-mono">{f.value ?? <span className="text-slate-400">{t('（空）')}</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {mappings.length ? (
        <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title={t('申请解密')}>{t('选择记录所在的映射，填写源表主键与解密原因。原因会记入审计日志。')}</SectionHeader>
          <Form method="post">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reveal-mapping">{t('映射')}</FieldLabel>
                <NativeSelect id="reveal-mapping" name="mappingId" required>
                  {mappings.map(m => (
                    <NativeSelectOption key={m.id} value={m.id}>
                      {t('「{source}」{table} → {entity}（{fields}）', {
                        source: m.sourceName, table: m.table, entity: builtinName(t, m.entity, CANONICAL_NAMES),
                        fields: m.fields.map(label => builtinName(t, label, CANONICAL_NAMES)).join(t('、')),
                      })}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="reveal-key">{t('源表主键')}</FieldLabel>
                <Input id="reveal-key" name="key" required autoComplete="off" />
                <FieldDescription>{t('主键有多列时按列的顺序用逗号分隔。')}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="reveal-reason">{t('原因')}</FieldLabel>
                <Input id="reveal-reason" name="reason" required autoComplete="off" placeholder={t('例如：客户投诉回访，需核对联系方式')} />
              </Field>
              <Button type="submit" className="w-auto self-start" disabled={submitting}>{t('解密')}</Button>
            </FieldGroup>
          </Form>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          {t('还没有带敏感字段的已发布映射。发布把源表映射到消费者（姓名、手机号、邮箱）或带敏感扩展字段的映射后，可以在这里申请解密。')}
        </div>
      )}
    </AppShell>
  );
}

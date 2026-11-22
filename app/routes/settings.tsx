// app/routes/settings.tsx —— 我的设置（任一成员）：个人令牌的签发（明文只在签发后的这次响应里展示一次）、列表与吊销（ADR-0042）。
// 令牌给平台外的 Agent 经 /mcp 代表本人接入，权限永远等于本人当前角色；只能吊销自己的令牌
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert, KeyRound } from 'lucide-react';
import type { Route } from './+types/settings';
import { requireMember } from '~/.server/auth';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { createMemberToken, listMemberTokens, MemberTokenError, revokeMemberToken } from '~/.server/member-tokens';
import { DEFAULT_TOKEN_DAYS, TOKEN_DAYS, TOKEN_NAME_MAX } from '~/lib/member-tokens';
import { navFor } from '~/.server/nav';
import { formatDateTime } from '~/lib/format';
import { makeT, msg, useLocale, useT } from '~/lib/i18n';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: `${t('我的设置')} · ${t('CRM 数据分析平台')}` }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const rows = await listMemberTokens(member);
  const now = Date.now();
  return {
    email: member.email,
    nav: navFor(member),
    tokens: rows.map(r => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      allowQuery: r.allowQuery,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      status: r.revokedAt !== null ? 'revoked' as const : r.expiresAt.getTime() <= now ? 'expired' as const : 'active' as const,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requireMember(request);
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'create': {
        // 不重定向：明文只在这次响应里出现，刷新或离开后再也看不到
        const { token, row } = await createMemberToken(member, {
          name: field('name'),
          days: Number(field('days')),
          allowQuery: form.get('allowQuery') !== null,
        });
        return { created: { name: row.name, token } };
      }
      case 'revoke':
        await revokeMemberToken(member, field('tokenId'));
        break;
      default:
        return data({ error: formatServer(await getLocale(request), msg('未知操作')) }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MemberTokenError) return data({ error: await errorTextFor(request, e) }, { status: e.status });
    throw e;
  }
  throw redirect('/settings');
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tokens } = loaderData;
  const t = useT();
  const locale = useLocale();
  const submitting = useNavigation().state === 'submitting';
  // 24 小时制（中文界面输出与改造前逐字一致）
  const formatTime = (iso: string) => formatDateTime(locale, iso, { hour12: false });
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={t('我的设置')} description={t('当前登录：{email}', { email })} />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('操作未完成')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {actionData && 'created' in actionData && (
        <Alert role="status">
          <KeyRound />
          <AlertTitle>{t('已签发「{name}」', { name: actionData.created.name })}</AlertTitle>
          <AlertDescription>
            <p>{t('请现在复制并妥善保存。令牌只显示这一次，平台不保存明文，之后无法再查看。')}</p>
            <code data-member-token className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{actionData.created.token}</code>
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('个人令牌')}>
          {t('平台外的 Agent（如 Claude Code）带 Authorization: Bearer <令牌> 访问 /mcp，代表你操作。能做的事永远等于你当前的角色，Agent 不能发布。')}
        </SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field>
                <FieldLabel htmlFor="token-name">{t('名称')}</FieldLabel>
                <Input id="token-name" name="name" required maxLength={TOKEN_NAME_MAX} placeholder={t('如：我的 Claude Code')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="token-days">{t('有效期')}</FieldLabel>
                <NativeSelect id="token-days" name="days" defaultValue={String(DEFAULT_TOKEN_DAYS)}>
                  {TOKEN_DAYS.map(d => <NativeSelectOption key={d} value={d}>{t('{n} 天', { n: d })}</NativeSelectOption>)}
                </NativeSelect>
              </Field>
            </div>
            <Field orientation="horizontal">
              <input type="checkbox" id="token-allow-query" name="allowQuery" className="size-4" />
              <FieldLabel htmlFor="token-allow-query">{t('允许执行查询')}</FieldLabel>
            </Field>
            <FieldDescription>{t('勾选后 Agent 可以按你的权限执行工作台查询（结果剔除敏感列与哈希列），每次记审计。Agent 背后的模型由你选择，平台管不到数据流向。')}</FieldDescription>
            <div>
              <Button type="submit" disabled={submitting}>{t('签发')}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      {tokens.length === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">{t('还没有个人令牌。在上面填写名称签发第一个，交给要代表你接入的 Agent。')}</div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('名称')}</TableHead>
                <TableHead>{t('前缀')}</TableHead>
                <TableHead>{t('执行查询')}</TableHead>
                <TableHead>{t('有效期至')}</TableHead>
                <TableHead>{t('创建时间')}</TableHead>
                <TableHead>{t('最近使用')}</TableHead>
                <TableHead className="text-right">{t('操作')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map(tok => (
                <TableRow key={tok.id} data-member-token-id={tok.id}>
                  <TableCell>{tok.name}</TableCell>
                  <TableCell className="font-mono">{`${tok.prefix}…`}</TableCell>
                  <TableCell>{tok.allowQuery ? <Badge variant="outline">{t('可执行查询')}</Badge> : <span className="text-slate-500">{t('不允许')}</span>}</TableCell>
                  <TableCell className="text-slate-500">{formatTime(tok.expiresAt)}</TableCell>
                  <TableCell className="text-slate-500">{formatTime(tok.createdAt)}</TableCell>
                  <TableCell className="text-slate-500">{tok.lastUsedAt ? formatTime(tok.lastUsedAt) : t('从未使用')}</TableCell>
                  <TableCell className="text-right">
                    {tok.status === 'revoked' ? (
                      <Badge variant="secondary">{t('已吊销')}</Badge>
                    ) : tok.status === 'expired' ? (
                      <Badge variant="secondary">{t('已过期')}</Badge>
                    ) : (
                      <Form
                        method="post"
                        onSubmit={e => { if (!confirm(t('确定吊销「{name}」？用这个令牌的 Agent 将立即无法接入。', { name: tok.name }))) e.preventDefault(); }}
                      >
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="tokenId" value={tok.id} />
                        <Button type="submit" variant="destructive" size="sm" disabled={submitting}>{t('吊销')}</Button>
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

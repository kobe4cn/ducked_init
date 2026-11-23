// app/routes/settings.tsx —— 我的设置（任一成员）：个人令牌的签发（明文只在签发后的这次响应里展示一次）、列表与吊销（ADR-0042）。
// 令牌给平台外的 Agent 经 /mcp 代表本人接入，权限永远等于本人当前角色；只能吊销自己的令牌。
// 「接入方式」给完整 MCP 地址与可复制的配置片段：签发那次响应里填明文，平时（loader 渲染）一律填占位符；
// 工具清单由服务端用 /mcp 的 tools/list 同一个 externalToolsFor 算，随成员角色与「允许执行查询」变
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert, KeyRound } from 'lucide-react';
import type { Route } from './+types/settings';
import { linkOrigin, requireMember } from '~/.server/auth';
import { externalToolsFor } from '~/.server/assistant/tools';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { createMemberToken, listMemberTokens, MemberTokenError, revokeMemberToken } from '~/.server/member-tokens';
import { DEFAULT_TOKEN_DAYS, TOKEN_DAYS, TOKEN_NAME_MAX } from '~/lib/member-tokens';
import { navFor } from '~/.server/nav';
import { formatDateTime } from '~/lib/format';
import { connectSnippets } from '~/lib/mcp-connect';
import { makeT, msg, useLocale, useT } from '~/lib/i18n';
import { AppShell } from '~/components/app-shell';
import { CopyButton } from '~/components/copy-button';
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

/** 完整 MCP 地址：与登录链接同样取站点地址（生产环境用 APP_ORIGIN，未配置时抛错） */
const mcpUrlOf = (request: Request) => `${linkOrigin(new URL(request.url).origin)}/mcp`;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const rows = await listMemberTokens(member);
  const now = Date.now();
  const base = externalToolsFor(member, {}).map(t => t.name);
  // 角色没有查询权限时勾了也拿不到 run_query，这里就是空数组
  const queryOnly = externalToolsFor(member, { allowQuery: true }).map(t => t.name).filter(n => !base.includes(n));
  return {
    email: member.email,
    nav: navFor(member),
    mcpUrl: mcpUrlOf(request),
    mcpTools: { base, queryOnly },
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
        const allowQuery = form.get('allowQuery') !== null;
        const { token, row } = await createMemberToken(member, { name: field('name'), days: Number(field('days')), allowQuery });
        const tools = externalToolsFor(member, { allowQuery }).map(t => t.name);
        return { created: { name: row.name, token, mcpUrl: mcpUrlOf(request), tools } };
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
  const { email, nav, tokens, mcpUrl, mcpTools } = loaderData;
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
            <McpConnect kind="created" url={actionData.created.mcpUrl} token={actionData.created.token} tools={actionData.created.tools} />
          </AlertDescription>
        </Alert>
      )}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('个人令牌')}>
          {t('平台外的 Agent（如 Claude Code）带 Authorization: Bearer <令牌> 访问 {url}，代表你操作。能做的事永远等于你当前的角色，Agent 不能发布。', { url: mcpUrl })}
        </SectionHeader>
        <McpConnect kind="placeholder" url={mcpUrl} token={null} tools={mcpTools.base} queryOnly={mcpTools.queryOnly} />
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

/** 一段可复制的配置；data-mcp-snippet 标明是哪一段 */
function Snippet({ id, label, text }: { id: string; label: string; text: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre data-mcp-snippet={id} className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-900">{text}</pre>
    </div>
  );
}

/**
 * 接入方式：地址、Claude Code 命令、通用 JSON、自检 curl 与工具清单。
 * token 为 null 时（平时那块）片段填占位符，绝不回填明文；queryOnly 是勾选「允许执行查询」后另有的工具
 */
function McpConnect({ kind, url, token, tools, queryOnly = [] }: {
  kind: 'created' | 'placeholder';
  url: string;
  token: string | null;
  tools: string[];
  queryOnly?: string[];
}) {
  const t = useT();
  const snippets = connectSnippets(url, token ?? t('<你的令牌>'));
  return (
    <div data-mcp-connect={kind} className="mt-3 space-y-3 text-left">
      <p className="text-sm font-medium text-slate-900">{t('接入方式')}</p>
      <p className="text-xs text-slate-500">
        {kind === 'created'
          ? t('只支持 HTTP（Streamable HTTP），不支持 SSE。令牌只显示这一次。')
          : t('只支持 HTTP（Streamable HTTP），不支持 SSE。签发后把占位符换成令牌明文。')}
      </p>
      <Snippet id="url" label={t('MCP 地址')} text={url} />
      <Snippet id="claude" label={t('Claude Code 命令')} text={snippets.claude} />
      <Snippet id="json" label={t('通用 JSON 配置')} text={snippets.json} />
      <Snippet id="curl" label={t('自检：列出工具（返回 tools 即接通）')} text={snippets.curl} />
      <div className="space-y-1">
        <span className="text-xs font-medium text-slate-500">{kind === 'created' ? t('本令牌可用的工具') : t('令牌可用的工具')}</span>
        <ul data-mcp-tools={kind} className="flex flex-wrap gap-1.5">
          {tools.map(name => <li key={name} className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">{name}</li>)}
        </ul>
        {queryOnly.length > 0 && (
          <p className="text-xs text-slate-500">{t('签发时勾选「允许执行查询」的令牌另有：{tools}', { tools: queryOnly.join(', ') })}</p>
        )}
      </div>
    </div>
  );
}

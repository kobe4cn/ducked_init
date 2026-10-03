// app/routes/sources.tsx —— 数据源（数据工程师、管理员可登记；分析师只读）：指标卡、本租户的数据源卡片（标出未核对与最近一次核对有差异的）与登记表单
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleAlert, CircleDashed, Plus, X } from 'lucide-react';
import type { Route } from './+types/sources';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { listSources, registerSource, SourceError } from '~/.server/sources';
import { verifyDifferences } from '~/.server/source-verify';
import { formValues, SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from '~/lib/sources';
import { cn } from '~/lib/utils';
import { AppShell } from '~/components/app-shell';
import { KindIcon } from '~/components/kind-icon';
import { PageHeader } from '~/components/page-header';
import { SourceFields } from '~/components/source-fields';
import { StatTile } from '~/components/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据源 · CRM 数据分析平台' }];
}

/** 列表上的一行摘要：连接的目标，不含凭据 */
const targetOf = (kind: SourceKind, c: Record<string, string>) =>
  kind === 'postgres' || kind === 'mysql' || kind === 'mongodb' ? `${c.user}@${c.host}:${c.port}/${c.database}${c.schema ? `（${c.schema}）` : ''}` : c.path;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const rows = await listSources(member);
  const differences = await verifyDifferences(member);
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    sources: rows.map(s => ({
      id: s.id, name: s.name, kind: s.kind, target: targetOf(s.kind, s.config), createdAt: s.createdAt.toISOString(),
      /** 最近一次成功核对中有差异的表数（一致为 0，没有成功核对记录为 null） */
      differences: differences.get(s.id) ?? null,
    })),
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
  const kinds = new Set(sources.map(s => s.kind)).size;
  const cards = sources.map(s => ({ ...s, state: verifyStateOf(s.differences) }));
  const needsAttention = cards.filter(s => s.state === 'diff').length;
  const consistent = cards.filter(s => s.state === 'ok').length;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="数据源" description="本租户登记的外部只读连接。平台永不写入数据源；凭据加密保存，任何页面都不显示。" />

      <div className="grid grid-cols-3 gap-4">
        <StatTile label="数据源数" value={sources.length} hint={`${kinds} 种类型`} />
        <StatTile label="核对一致" value={consistent} hint="最近一次核对" tone={consistent ? 'text-emerald-600' : undefined} />
        <StatTile label="需要处理" value={needsAttention} hint="核对有差异的数据源" tone={needsAttention ? 'text-red-600' : undefined} />
      </div>

      {!sources.length && !canWrite && (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">还没有数据源。数据工程师或管理员登记后会出现在这里。</div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {cards.map(s => (
          <Link
            key={s.id}
            to={s.state === 'diff' ? `/sources/${s.id}?tab=lake` : `/sources/${s.id}`}
            data-source-id={s.id}
            className={cn('rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md', s.state === 'diff' && 'border-red-200')}
          >
            <div className="flex items-start justify-between">
              <KindIcon kind={s.kind} />
              <Badge variant="outline" className="rounded-full">{SOURCE_KIND_LABELS[s.kind]}</Badge>
            </div>
            <div className="mt-4 text-lg font-medium">{s.name}</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-400">{s.target}</div>
            <div className="mt-4 flex items-center justify-between border-t pt-3">
              <VerifyBadge state={s.state} differences={s.differences} />
              <span className="text-xs text-slate-400">{`登记于 ${new Date(s.createdAt).toLocaleDateString('zh-CN')}`}</span>
            </div>
          </Link>
        ))}

        {canWrite && (
          // 没有 JS 时也能展开登记：<details> 收起时是虚线的「登记新的数据源」卡片，展开后占满一行
          <details open={!sources.length || Boolean(actionData?.error)} className="group rounded-2xl border-2 border-dashed open:col-span-full open:border open:border-solid open:bg-white open:p-6 open:shadow-sm">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="grid min-h-48 place-items-center text-slate-400 hover:text-slate-600 group-open:hidden">
                <span className="flex flex-col items-center gap-2"><Plus className="size-6" />登记新的数据源</span>
              </span>
              <span className="hidden items-center justify-between gap-6 group-open:flex">
                <h2 className="text-lg font-semibold">登记数据源</h2>
                <X aria-hidden className="size-4 text-slate-400" />
              </span>
            </summary>
            <p className="mt-1 mb-5 max-w-2xl text-sm text-slate-500">登记前平台会连接数据源并探测账号的写权限，可写的账号会被拒绝。登记后列出表（不读取数据），在数据源页选定要同步的表，平台只采集与同步选中的表。</p>
            {actionData?.error && (
              <Alert variant="destructive" role="alert" className="mb-5 max-w-2xl">
                <CircleAlert />
                <AlertTitle>未能登记</AlertTitle>
                <AlertDescription>{actionData.error}</AlertDescription>
              </Alert>
            )}
            <Form method="post" className="max-w-2xl">
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
          </details>
        )}
      </div>
    </AppShell>
  );
}

type VerifyState = 'none' | 'ok' | 'diff';
/** 未核对（没有成功核对记录）、一致、有差异 */
const verifyStateOf = (differences: number | null): VerifyState => differences === null ? 'none' : differences > 0 ? 'diff' : 'ok';

/** 状态色配图标和文字（见 docs/agents/ui.md） */
const VERIFY_BADGE: Record<VerifyState, { icon: typeof CheckCircle2; tone: string }> = {
  none: { icon: CircleDashed, tone: 'text-slate-500' }, ok: { icon: CheckCircle2, tone: 'text-emerald-600' }, diff: { icon: AlertTriangle, tone: 'text-red-600' },
};

function VerifyBadge({ state, differences }: { state: VerifyState; differences: number | null }) {
  const { icon: Icon, tone } = VERIFY_BADGE[state];
  return (
    <span data-verify-state={state} data-verify-differences={state === 'diff' ? differences! : undefined} className={cn('inline-flex items-center gap-1 text-sm', tone)}>
      <Icon className="size-3.5" />{state === 'none' ? '未核对' : state === 'ok' ? '一致' : `${differences} 张表有差异`}
    </span>
  );
}

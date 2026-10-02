// app/routes/sources.prototype-variants.tsx —— PROTOTYPE（一次性，不进 main）：数据源列表页的三个视觉方向，由 sources.tsx 按 ?variant= 选用；数据与登记表单沿用原页面
import { useState } from 'react';
import { Form, Link, useNavigation, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowRight, CheckCircle2, Cloud, Database, FileBox, Leaf, Plus, Search, X } from 'lucide-react';
import type { Route } from './+types/sources';
import { SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from '~/lib/sources';
import { cn } from '~/lib/utils';
import { HeroShell, SidebarShell, WorkbenchShell } from '~/components/prototype-shells';
import { SourceFields } from '~/components/source-fields';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

type Props = Pick<Route.ComponentProps, 'loaderData' | 'actionData'>;
type Source = Props['loaderData']['sources'][number];

const KIND_ICON: Record<SourceKind, typeof Database> = { postgres: Database, mysql: Database, mongodb: Leaf, s3: Cloud, duckdb: FileBox };
const KIND_TINT: Record<SourceKind, string> = {
  postgres: 'bg-sky-100 text-sky-700', mysql: 'bg-orange-100 text-orange-700', mongodb: 'bg-emerald-100 text-emerald-700', s3: 'bg-violet-100 text-violet-700', duckdb: 'bg-amber-100 text-amber-700',
};
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-CN');

function KindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', KIND_TINT[kind], className)}><Icon className="size-4" /></span>;
}

/** 三个方向共用的登记表单（与原页面相同的字段与提交） */
function RegisterForm({ actionData }: { actionData: Props['actionData'] }) {
  const values: Record<string, string> = actionData?.values ?? {};
  const [kind, setKind] = useState<SourceKind>((SOURCE_KINDS as readonly string[]).includes(values.kind) ? (values.kind as SourceKind) : 'postgres');
  const submitting = useNavigation().state === 'submitting';
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="register" />
      {actionData?.error && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionData.error}</p>}
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
        <div><Button type="submit" disabled={submitting}>{submitting ? '正在校验…' : '校验并登记'}</Button></div>
      </FieldGroup>
    </Form>
  );
}

function Health({ s }: { s: Source }) {
  return s.differences > 0
    ? <Link to={`/sources/${s.id}?tab=lake`} className="inline-flex items-center gap-1 text-sm text-red-600"><AlertTriangle className="size-3.5" />{`${s.differences} 张表有差异`}</Link>
    : <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-3.5" />一致</span>;
}

/** A 控制台：侧边栏；页头一行（标题 + 搜索 + 主按钮）；紧凑表格；登记表单从右侧抽屉滑出 */
export function SourcesA({ loaderData, actionData }: Props) {
  const { email, nav, canWrite, sources } = loaderData;
  const [open, setOpen] = useState(Boolean(actionData?.error));
  const [q, setQ] = useState('');
  const shown = sources.filter(s => `${s.name} ${s.target}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <SidebarShell email={email} nav={nav}>
      <div className="flex h-14 items-center justify-between border-b px-6">
        <div className="text-sm text-muted-foreground">工作区 / <span className="text-foreground">数据源</span></div>
      </div>
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">数据源</h1>
            <p className="text-sm text-muted-foreground">{`${sources.length} 个只读连接 · 凭据加密保存`}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索名称或连接" className="w-64 pl-8" />
            </div>
            {canWrite && <Button onClick={() => setOpen(true)}><Plus />登记数据源</Button>}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>名称</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>湖中核对</TableHead>
                <TableHead>登记于</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(s => (
                <TableRow key={s.id} className="group">
                  <TableCell><KindIcon kind={s.kind} className="size-7" /></TableCell>
                  <TableCell>
                    <Link to={`/sources/${s.id}`} className="font-medium">{s.name}</Link>
                    <div className="text-xs text-muted-foreground">{SOURCE_KIND_LABELS[s.kind]}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.target}</TableCell>
                  <TableCell><Health s={s} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{date(s.createdAt)}</TableCell>
                  <TableCell><Link to={`/sources/${s.id}`} className="opacity-0 group-hover:opacity-100"><ArrowRight className="size-4" /></Link></TableCell>
                </TableRow>
              ))}
              {!shown.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{sources.length ? '没有匹配的数据源' : '还没有数据源'}</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <div className="h-full w-[520px] overflow-y-auto bg-background p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-lg font-semibold">登记数据源</h2>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="关闭"><X /></Button>
            </div>
            <p className="mb-5 text-sm text-muted-foreground">平台会连接并探测账号的写权限，可写的账号会被拒绝。</p>
            <RegisterForm actionData={actionData} />
          </div>
        </div>
      )}
    </SidebarShell>
  );
}

/** B 概览：大页头带主按钮；一排指标卡；每个数据源一张卡片（类型色块、健康状态）；登记表单在卡片网格末尾展开 */
export function SourcesB({ loaderData, actionData }: Props) {
  const { email, nav, canWrite, sources } = loaderData;
  const [open, setOpen] = useState(Boolean(actionData?.error) || !sources.length);
  const kinds = new Set(sources.map(s => s.kind));
  const diff = sources.filter(s => s.differences > 0).length;
  return (
    <HeroShell
      email={email}
      nav={nav}
      title="数据源"
      description="本租户登记的外部只读连接。平台永不写入数据源，凭据加密保存。"
      actions={canWrite && <Button size="lg" className="rounded-full" onClick={() => setOpen(true)}><Plus />登记数据源</Button>}
    >
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: '数据源', value: sources.length, hint: `${kinds.size} 种类型` },
          { label: '湖中核对一致', value: sources.length - diff, hint: '最近一次核对', tone: 'text-emerald-600' },
          { label: '需要处理', value: diff, hint: '核对有差异的数据源', tone: diff ? 'text-red-600' : '' },
        ].map(m => (
          <div key={m.label} className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">{m.label}</div>
            <div className={cn('mt-1 text-3xl font-semibold', m.tone)}>{m.value}</div>
            <div className="mt-1 text-xs text-slate-400">{m.hint}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {sources.map(s => (
          <Link key={s.id} to={`/sources/${s.id}`} className={cn('group rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md', s.differences > 0 && 'border-red-200')}>
            <div className="flex items-start justify-between">
              <KindIcon kind={s.kind} className="size-11 rounded-xl" />
              <Badge variant="outline" className="rounded-full">{SOURCE_KIND_LABELS[s.kind]}</Badge>
            </div>
            <div className="mt-4 text-lg font-medium">{s.name}</div>
            <div className="mt-1 truncate font-mono text-xs text-slate-400">{s.target}</div>
            <div className="mt-4 flex items-center justify-between border-t pt-3">
              <Health s={s} />
              <span className="text-xs text-slate-400">{date(s.createdAt)}</span>
            </div>
          </Link>
        ))}
        {canWrite && !open && (
          <button type="button" onClick={() => setOpen(true)} className="grid min-h-48 place-items-center rounded-2xl border-2 border-dashed text-slate-400 hover:border-slate-400 hover:text-slate-600">
            <span className="flex flex-col items-center gap-2"><Plus className="size-6" />登记新的数据源</span>
          </button>
        )}
      </div>
      {canWrite && open && (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">登记数据源</h2>
              <p className="text-sm text-slate-500">登记后列出表（不读取数据），再选定要同步的表。</p>
            </div>
            {sources.length > 0 && <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="收起"><X /></Button>}
          </div>
          <RegisterForm actionData={actionData} />
        </div>
      )}
    </HeroShell>
  );
}

/** C 工作台：左栏列表（可搜索、按类型分组），右栏是选中数据源的预览或登记表单，?selected= 记住选中项 */
export function SourcesC({ loaderData, actionData }: Props) {
  const { email, nav, canWrite, sources } = loaderData;
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const selectedId = params.get('selected') ?? (actionData?.error ? 'new' : sources[0]?.id ?? 'new');
  const select = (id: string) => { const p = new URLSearchParams(params); p.set('selected', id); setParams(p, { replace: true, preventScrollReset: true }); };
  const selected = sources.find(s => s.id === selectedId);
  const groups = SOURCE_KINDS.map(k => ({ kind: k, items: sources.filter(s => s.kind === k && s.name.toLowerCase().includes(q.toLowerCase())) })).filter(g => g.items.length);
  return (
    <WorkbenchShell email={email} nav={nav}>
      <div className="grid h-full grid-cols-[320px_1fr]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/30">
          <div className="flex items-center gap-2 border-b p-2">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="筛选…" className="h-8" />
            {canWrite && <Button size="icon" variant={selectedId === 'new' ? 'default' : 'outline'} className="size-8" onClick={() => select('new')} aria-label="登记数据源"><Plus /></Button>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {groups.map(g => (
              <div key={g.kind}>
                <div className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{`${SOURCE_KIND_LABELS[g.kind]} · ${g.items.length}`}</div>
                {g.items.map(s => (
                  <button key={s.id} type="button" onClick={() => select(s.id)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted', s.id === selectedId && 'bg-background font-medium shadow-[inset_2px_0_0] shadow-foreground')}>
                    <span className={cn('size-2 rounded-full', s.differences > 0 ? 'bg-red-500' : 'bg-emerald-500')} />
                    <span className="flex-1 truncate">{s.name}</span>
                    {s.differences > 0 && <span className="text-xs text-red-600">{s.differences}</span>}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <p className="p-4 text-sm text-muted-foreground">没有数据源</p>}
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">{`${sources.length} 个数据源`}</div>
        </aside>
        <section className="min-h-0 overflow-y-auto">
          {selected ? (
            <div className="p-6">
              <div className="flex items-center gap-3">
                <KindIcon kind={selected.kind} />
                <div>
                  <h1 className="text-lg font-semibold">{selected.name}</h1>
                  <div className="font-mono text-xs text-muted-foreground">{selected.target}</div>
                </div>
                <Button asChild className="ml-auto" size="sm"><Link to={`/sources/${selected.id}`}>打开<ArrowRight /></Link></Button>
              </div>
              <dl className="mt-6 grid grid-cols-[120px_1fr] gap-y-3 border-t pt-4 text-sm">
                <dt className="text-muted-foreground">类型</dt><dd>{SOURCE_KIND_LABELS[selected.kind]}</dd>
                <dt className="text-muted-foreground">湖中核对</dt><dd><Health s={selected} /></dd>
                <dt className="text-muted-foreground">登记于</dt><dd>{new Date(selected.createdAt).toLocaleString('zh-CN')}</dd>
                <dt className="text-muted-foreground">快捷入口</dt>
                <dd className="flex gap-3">
                  <Link to={`/sources/${selected.id}`} className="underline">选表与同步</Link>
                  <Link to={`/sources/${selected.id}?tab=lake`} className="underline">湖中数据</Link>
                  <Link to="/mappings" className="underline">映射</Link>
                </dd>
              </dl>
            </div>
          ) : canWrite ? (
            <div className="max-w-2xl p-6">
              <h1 className="text-lg font-semibold">登记数据源</h1>
              <p className="mb-5 text-sm text-muted-foreground">平台会连接并探测账号的写权限，可写的账号会被拒绝。</p>
              <RegisterForm actionData={actionData} />
            </div>
          ) : (
            <p className="p-6 text-muted-foreground">选择左侧的数据源</p>
          )}
        </section>
      </div>
    </WorkbenchShell>
  );
}

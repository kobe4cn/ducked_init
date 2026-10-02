// app/routes/mapping.prototype-variants.tsx —— PROTOTYPE（一次性，不进 main）：映射详情页的三个视觉方向，由 mapping.tsx 按 ?variant= 选用；数据、表单与提交沿用原页面
import { useState } from 'react';
import { Form, Link, useNavigation } from 'react-router';
import { ArrowRight, Boxes, ChevronDown, ChevronRight, Database, GitCommitVertical, GitMerge, Lock, PanelBottom, Play, Sparkles, Trash2, Upload } from 'lucide-react';
import type { Route } from './+types/mapping';
import { cn } from '~/lib/utils';
import { HeroShell, SidebarShell, WorkbenchShell } from '~/components/prototype-shells';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '~/components/ui/table';

type Data = Route.ComponentProps['loaderData'];
type Version = Data['versions'][number];
type MergeEntry = Data['merge']['history'][number];
export type Props = Pick<Route.ComponentProps, 'loaderData' | 'actionData'> & { MergeRow: (p: { e: MergeEntry }) => React.ReactNode };

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

/** 一行合并记录的简短说明，用在窄栏里 */
function mergeLine(e: MergeEntry) {
  if ('error' in e) return { tone: 'text-red-600', text: `失败：${e.error}` };
  if ('skipped' in e) return { tone: 'text-muted-foreground', text: `跳过：${e.skipped}` };
  return { tone: '', text: `${e.mode === 'rebuild' ? '重建' : '增量'} · ${e.rows.toLocaleString('zh-CN')} 行（+${e.inserted} ~${e.updated} −${e.deleted}）` };
}

/** 各方向共用的页面状态：选中的版本、草稿、是否已发布 */
function useMappingState(versions: Version[]) {
  const [shown, setShown] = useState(versions[0]?.version ?? 1);
  return {
    shown, setShown,
    selected: versions.find(v => v.version === shown) ?? versions[0],
    draft: versions.find(v => v.status === 'draft'),
    published: versions.some(v => v.status === 'published'),
    latestPublished: versions.find(v => v.status === 'published'),
  };
}

/** 草稿的发布 / 丢弃按钮（发布不了时显示原因） */
function DraftActions({ v, canWrite, published, size = 'sm' }: { v: Version; canWrite: boolean; published: boolean; size?: 'sm' | 'default' }) {
  const submitting = useNavigation().state === 'submitting';
  return (
    <div className="flex flex-wrap items-center gap-2">
      {v.publishBlocker ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" />{v.publishBlocker}</span>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <input type="hidden" name="version" value={v.version} />
          <Button type="submit" size={size} disabled={submitting}><Upload />{`发布 v${v.version}`}</Button>
        </Form>
      )}
      {canWrite && (
        <Form method="post" onSubmit={e => { if (!confirm(`丢弃第 ${v.version} 版草稿？${published ? '回到最近的已发布版本' : '这个映射从没发布过，将被删除'}。`)) e.preventDefault(); }}>
          <input type="hidden" name="intent" value="discard" />
          <Button type="submit" size={size} variant="ghost" className="text-destructive" disabled={submitting}><Trash2 />丢弃草稿</Button>
        </Form>
      )}
    </div>
  );
}

function MergeButton({ size = 'sm' }: { size?: 'sm' | 'default' }) {
  const submitting = useNavigation().state === 'submitting';
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="merge" />
      <Button type="submit" size={size} variant="outline" disabled={submitting} title="只合并这个映射已发布的最新版本"><Play />立即合并</Button>
    </Form>
  );
}

/** 选中版本的编辑区：能改时是编辑框 + 对照面板，否则只读 */
function Editor({ selected, draft, canWrite, loaderData, actionData }: { selected: Version; draft?: Version } & Pick<Props, 'loaderData' | 'actionData'> & { canWrite: boolean }) {
  const submitting = useNavigation().state === 'submitting';
  const { mapping, functions } = loaderData;
  if (!(canWrite && (selected.status === 'draft' || !draft))) return <MappingEditor key={selected.version} defaultValue={selected.yaml} readOnly />;
  return (
    <Form method="post" className="space-y-3" key={`${selected.version}-${actionData?.draftId ?? ''}`}>
      <MappingEditorWithReference defaultValue={actionData?.yaml ?? selected.yaml} table={mapping.reference} entity={mapping.entity} functions={functions} />
      <div className="flex gap-2">
        <Button type="submit" name="intent" value="save" disabled={submitting}>{selected.status === 'draft' ? '校验并保存草稿' : '校验并保存为新草稿'}</Button>
        <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !mapping.reference}><Sparkles />按规则生成草稿</Button>
      </div>
    </Form>
  );
}

const StatusBadge = ({ v }: { v: Version }) =>
  v.status === 'published' ? <Badge className="bg-emerald-600">已发布</Badge> : <Badge variant="secondary" className="bg-amber-100 text-amber-800">草稿</Badge>;

/** A 控制台：吸顶页头（面包屑、标题、状态、主操作）；左侧编辑区，右侧窄栏放版本时间线与合并摘要 */
export function MappingA({ loaderData, actionData }: Props) {
  const { email, nav, canWrite, mapping, versions, merge } = loaderData;
  const s = useMappingState(versions);
  return (
    <SidebarShell email={email} nav={nav}>
      <div className="sticky top-0 z-10 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="text-sm text-muted-foreground">
          <Link to="/mappings" className="hover:text-foreground">映射</Link>{' / '}
          <Link to={`/sources/${mapping.source.id}`} className="hover:text-foreground">{mapping.source.name}</Link>{' / '}{mapping.table}
        </div>
        <div className="mt-1 flex items-center gap-3">
          <h1 className="text-xl font-semibold">{`${mapping.entityLabel} ← ${mapping.table}`}</h1>
          {s.latestPublished && <Badge variant="outline">{`线上 v${s.latestPublished.version}`}</Badge>}
          {s.draft && <Badge variant="secondary" className="bg-amber-100 text-amber-800">{`草稿 v${s.draft.version}`}</Badge>}
          <div className="ml-auto flex items-center gap-2">
            {s.draft && <DraftActions v={s.draft} canWrite={canWrite} published={s.published} />}
            {canWrite && s.published && <MergeButton />}
          </div>
        </div>
      </div>
      {actionData?.error && <div className="px-6 pt-4"><MappingErrors error={actionData.error} issues={actionData.issues} /></div>}
      <div className="grid gap-6 p-6 2xl:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          {s.selected && <Editor selected={s.selected} draft={s.draft} canWrite={canWrite} loaderData={loaderData} actionData={actionData} />}
        </div>
        <aside className="space-y-6">
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">版本</h2>
            <ol className="relative border-l pl-4">
              {versions.map(v => (
                <li key={v.version} className="mb-3">
                  <span className={cn('absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-background', v.status === 'published' ? 'bg-emerald-500' : 'bg-amber-400')} />
                  <button type="button" onClick={() => s.setShown(v.version)} className={cn('text-left text-sm', v.version === s.shown && 'font-semibold')}>
                    {`v${v.version}`} <StatusBadge v={v} />
                  </button>
                  <div className="text-xs text-muted-foreground">{v.publishedBy ? `${v.publishedBy} 发布于 ${time(v.publishedAt)}` : `${v.authors.join('、')} 编辑`}</div>
                </li>
              ))}
            </ol>
          </section>
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">{`合并 · ${merge.statusLabel}`}</h2>
            <ul className="space-y-2 text-sm">
              {merge.history.slice(0, 6).map((e, i) => {
                const l = mergeLine(e);
                return <li key={`${e.taskId}-${i}`} className="rounded-md border p-2"><div className={l.tone}>{l.text}</div><div className="text-xs text-muted-foreground">{`v${e.version} · ${time(e.startedAt)}`}</div></li>;
              })}
              {!merge.history.length && <li className="text-muted-foreground">还没有合并过</li>}
            </ul>
          </section>
        </aside>
      </div>
    </SidebarShell>
  );
}

/** B 概览：大页头；「源表 → 标准实体」的流向图与三张指标卡；下方用标签页切换 编辑 / 版本 / 合并记录 */
export function MappingB({ loaderData, actionData, MergeRow }: Props) {
  const { email, nav, canWrite, mapping, versions, merge } = loaderData;
  const s = useMappingState(versions);
  const [tab, setTab] = useState<'edit' | 'versions' | 'merges'>('edit');
  const last = merge.history[0];
  return (
    <HeroShell
      email={email}
      nav={nav}
      title={<span className="flex items-center gap-3">{mapping.entityLabel}<span className="text-slate-300">←</span><span className="font-mono text-2xl text-slate-500">{mapping.table}</span></span>}
      description={<Link to="/mappings" className="hover:underline">← 全部映射</Link>}
      actions={<div className="flex gap-2">{s.draft && <DraftActions v={s.draft} canWrite={canWrite} published={s.published} size="default" />}{canWrite && s.published && <MergeButton size="default" />}</div>}
    >
      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}
      <div className="grid grid-cols-[1fr_auto_1fr_1.2fr] items-stretch gap-4">
        <Link to={`/sources/${mapping.source.id}`} className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm hover:shadow-md">
          <span className="grid size-11 place-items-center rounded-xl bg-sky-100 text-sky-700"><Database className="size-5" /></span>
          <div><div className="text-xs text-slate-500">源表</div><div className="font-medium">{`${mapping.source.name} / ${mapping.table}`}</div></div>
        </Link>
        <div className="grid place-items-center text-slate-300"><ArrowRight className="size-6" /></div>
        <div className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm">
          <span className="grid size-11 place-items-center rounded-xl bg-violet-100 text-violet-700"><Boxes className="size-5" /></span>
          <div><div className="text-xs text-slate-500">标准实体</div><div className="font-medium">{`${mapping.entityLabel}（${mapping.entity}）`}</div></div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="text-xs text-slate-500">线上版本</div>
            <div className="text-2xl font-semibold">{s.latestPublished ? `v${s.latestPublished.version}` : '—'}</div>
            {s.draft && <div className="text-xs text-amber-600">{`有草稿 v${s.draft.version}`}</div>}
          </div>
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <div className="text-xs text-slate-500">{`最近合并 · ${merge.statusLabel}`}</div>
            <div className="text-2xl font-semibold">{last && 'rows' in last ? last.rows.toLocaleString('zh-CN') : '—'}</div>
            <div className="text-xs text-slate-400">标准层行数</div>
          </div>
        </div>
      </div>
      <div className="flex gap-1 rounded-full bg-slate-200/60 p-1 self-start">
        {([['edit', '编辑'], ['versions', `版本（${versions.length}）`], ['merges', `合并记录（${merge.history.length}）`]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={cn('rounded-full px-4 py-1.5 text-sm text-slate-600', tab === k && 'bg-white font-medium text-slate-900 shadow-sm')}>{label}</button>
        ))}
      </div>
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        {tab === 'edit' && s.selected && (
          <>
            <div className="mb-4 flex items-center gap-2 text-sm text-slate-500">正在查看 <StatusBadge v={s.selected} /> {`v${s.selected.version}`}</div>
            <Editor selected={s.selected} draft={s.draft} canWrite={canWrite} loaderData={loaderData} actionData={actionData} />
          </>
        )}
        {tab === 'versions' && (
          <div className="divide-y">
            {versions.map(v => (
              <div key={v.version} className="flex items-center gap-4 py-3">
                <span className="w-10 font-mono font-semibold">{`v${v.version}`}</span>
                <StatusBadge v={v} />
                <span className="flex-1 text-sm text-slate-500">{v.publishedBy ? `${v.publishedBy} 发布于 ${time(v.publishedAt)}` : `作者：${v.authors.join('、')}`}</span>
                <Button size="sm" variant="ghost" onClick={() => { s.setShown(v.version); setTab('edit'); }}>查看</Button>
              </div>
            ))}
          </div>
        )}
        {tab === 'merges' && (
          <Table>
            <TableHeader><TableRow><TableHead>版本</TableHead><TableHead>方式</TableHead><TableHead>标准层行数</TableHead><TableHead>耗时</TableHead><TableHead>开始时间</TableHead></TableRow></TableHeader>
            <TableBody>{merge.history.map((e, i) => <MergeRow key={`${e.taskId}-${i}`} e={e} />)}</TableBody>
          </Table>
        )}
      </div>
    </HeroShell>
  );
}

/** C 工作台：像 IDE。顶部工具栏放操作；左栏竖排版本；中间编辑区铺满；底部可收起的合并记录面板 */
export function MappingC({ loaderData, actionData, MergeRow }: Props) {
  const { email, nav, canWrite, mapping, versions, merge } = loaderData;
  const s = useMappingState(versions);
  const [panel, setPanel] = useState(true);
  return (
    <WorkbenchShell email={email} nav={nav}>
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/30 px-3 text-sm">
          <Link to="/mappings" className="text-muted-foreground hover:text-foreground">映射</Link>
          <ChevronRight className="size-3.5 text-muted-foreground" />
          <span className="font-mono">{`${mapping.source.name}.${mapping.table}`}</span>
          <GitMerge className="size-3.5 text-muted-foreground" />
          <span className="font-medium">{mapping.entityLabel}</span>
          <div className="ml-auto flex items-center gap-2">
            {s.draft && <DraftActions v={s.draft} canWrite={canWrite} published={s.published} />}
            {canWrite && s.published && <MergeButton />}
            <Button size="icon" variant={panel ? 'secondary' : 'ghost'} className="size-8" onClick={() => setPanel(!panel)} aria-label="合并记录面板"><PanelBottom /></Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
          <aside className="overflow-y-auto border-r py-2">
            <div className="px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">版本</div>
            {versions.map(v => (
              <button key={v.version} type="button" onClick={() => s.setShown(v.version)} className={cn('flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted', v.version === s.shown && 'bg-muted')}>
                <GitCommitVertical className={cn('mt-0.5 size-4 shrink-0', v.status === 'published' ? 'text-emerald-600' : 'text-amber-500')} />
                <span className="min-w-0">
                  <span className="block font-mono text-sm">{`v${v.version}`}<span className="ml-2 text-xs text-muted-foreground">{v.status === 'published' ? '已发布' : '草稿'}</span></span>
                  <span className="block truncate text-xs text-muted-foreground">{v.publishedAt ? time(v.publishedAt) : v.authors.join('、')}</span>
                </span>
              </button>
            ))}
          </aside>
          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {actionData?.error && <div className="mb-4"><MappingErrors error={actionData.error} issues={actionData.issues} /></div>}
              {s.selected && <Editor selected={s.selected} draft={s.draft} canWrite={canWrite} loaderData={loaderData} actionData={actionData} />}
            </div>
            <div className={cn('shrink-0 border-t bg-muted/20', panel ? 'h-56' : 'h-8')}>
              <button type="button" onClick={() => setPanel(!panel)} className="flex h-8 w-full items-center gap-2 px-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                {panel ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {`合并记录 · ${merge.statusLabel} · ${merge.history.length} 次`}
              </button>
              {panel && (
                <div className="h-48 overflow-y-auto px-3">
                  <Table>
                    <TableHeader><TableRow><TableHead>版本</TableHead><TableHead>方式</TableHead><TableHead>标准层行数</TableHead><TableHead>耗时</TableHead><TableHead>开始时间</TableHead></TableRow></TableHeader>
                    <TableBody>{merge.history.map((e, i) => <MergeRow key={`${e.taskId}-${i}`} e={e} />)}</TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </WorkbenchShell>
  );
}

// app/routes/mapping.tsx —— 单个映射：各版本（已发布的锁定、草稿可改）、编辑与丢弃草稿（数据工程师、管理员）、发布草稿（需最后保存它的人以外的
// 另一位有发布权限的成员，最后保存的人看到不能发布的原因，租户里只有自己有发布权限时提示先邀请成员；编辑框旁对照源表的列统计与实体的标准字段；
// 可按规则重新生成草稿填进编辑框，不保存），以及这个映射每次合并到标准层的结果；有已发布版本时可以立即合并这一个映射。
// 页面分编辑、版本、合并记录三个标签页（?tab=edit|versions|merges，默认编辑），编辑页显示 ?version=N 选中的版本（默认最新）
import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, Lock, PencilLine, Play, Trash2, Upload } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/mapping';
import { can, deniedReason, requirePermission } from '~/.server/access';
import { discardDraft, draftForMapping, getMapping, MappingError, mergeMapping, publishMapping, referenceTables, saveDraft } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { functionList } from '~/lib/mapping-expr';
import type { FallbackStat } from '~/.server/pipeline/merge-engine';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { entityLabel, entityOf } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { KindIcon } from '~/components/kind-icon';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { StatTile } from '~/components/stat-tile';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.mapping.entityLabel} ← ${loaderData.mapping.table}` : '映射'} · CRM 数据分析平台` }];
}

type Tab = 'edit' | 'versions' | 'merges';
const TABS: Tab[] = ['edit', 'versions', 'merges'];
const tabOf = (request: Request): Tab => {
  const tab = new URL(request.url).searchParams.get('tab');
  return TABS.find(t => t === tab) ?? 'edit';
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const m = await getMapping(member, params.mappingId);
    const canPublish = can(member.role, 'publish');
    const canWrite = can(member.role, 'sources:write');
    return {
      email: member.email,
      nav: navFor(member),
      tab: tabOf(request),
      /** 编辑页显示的版本（?version=N，没有这一版时为 null，显示最新的一版） */
      version: Number(new URL(request.url).searchParams.get('version')) || null,
      canWrite,
      functions: functionList(),
      mapping: {
        id: m.id,
        source: m.source,
        table: m.tableName,
        entity: m.entity,
        entityLabel: entityLabel(m.entity),
        /** 编辑草稿时对照的源表（还没采集、不在同步范围时为 null；不能编辑时不给） */
        reference: canWrite ? ((await referenceTables(member, m.source.id)).find(t => t.name === m.tableName) ?? null) : null,
      },
      versions: m.versions.map(v => ({
        ...v,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        updatedAt: v.updatedAt.toISOString(),
        /** 当前成员发布不了这一版草稿的原因（没有发布权限、最后保存的是自己、租户里没有别人能发布）；可以发布或不是草稿时为 null */
        publishBlocker: v.status !== 'draft' ? null
          : !canPublish ? deniedReason('publish')
          : v.publishBlocker && m.publishers === 1 && v.lastEditor === member.email ? '本租户只有你有发布权限，请先邀请一位数据工程师或管理员'
          : v.publishBlocker,
      })),
      merge: {
        status: m.merge.status,
        statusLabel: m.merge.status === 'none' ? '未合并' : TASK_STATUS_LABELS[m.merge.status],
        history: m.merge.history,
      },
    };
  } catch (e) {
    if (e instanceof MappingError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'draft':
        // 只生成、填进编辑框，不保存；draftId 让编辑框换成新内容
        return { error: null, issues: [], yaml: await draftForMapping(await requirePermission(request, 'sources:write'), params.mappingId), draftId: crypto.randomUUID() };
      case 'save':
        await saveDraft(await requirePermission(request, 'sources:write'), params.mappingId, field('yaml'));
        break;
      case 'publish':
        await publishMapping(await requirePermission(request, 'publish'), params.mappingId, Number(field('version')));
        break;
      case 'merge':
        await mergeMapping(await requirePermission(request, 'sources:write'), params.mappingId);
        break;
      case 'discard': {
        // 从没发布过的映射整个删除，回到映射列表
        const { kept } = await discardDraft(await requirePermission(request, 'sources:write'), params.mappingId);
        if (!kept) throw redirect('/mappings');
        break;
      }
      default:
        return data({ error: '未知操作', issues: [], yaml: null, draftId: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MappingError) return data({ error: e.message, issues: e.issues, yaml: field('yaml') || null, draftId: null }, { status: e.status });
    throw e;
  }
  // 回到提交时所在的标签页
  const tab = tabOf(request);
  throw redirect(`/mappings/${params.mappingId}${tab === 'edit' ? '' : `?tab=${tab}`}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

type LoaderData = Route.ComponentProps['loaderData'];
type MergeEntry = LoaderData['merge']['history'][number];
type Version = LoaderData['versions'][number];

/** 一列落入兜底的情况，如「订单状态有 2 种取值（共 312 行）落入兜底：closed（300）、pending_review（12）」 */
function fallbackText(entity: string, f: FallbackStat) {
  const label = entityOf(entity)?.fields.find(x => x.name === f.column)?.label ?? f.column;
  const values = f.values.map(v => `${v.value}（${v.rows.toLocaleString('zh-CN')}）`).join('、');
  return `${label}有 ${f.distinct} 种取值（共 ${f.rows.toLocaleString('zh-CN')} 行）落入兜底：${values}${f.distinct > f.values.length ? ' 等' : ''}`;
}

function MergeRow({ e }: { e: MergeEntry }) {
  if ('error' in e || 'skipped' in e) {
    return (
      <TableRow data-merge-error={'error' in e ? true : undefined}>
        <TableCell>{`v${e.version}`}</TableCell>
        <TableCell colSpan={3} className={`whitespace-normal ${'error' in e ? 'text-destructive' : 'text-muted-foreground'}`}>
          {'error' in e ? `失败：${e.error}` : `跳过：${e.skipped}`}
        </TableCell>
        <TableCell>{time(e.startedAt)}</TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow data-merge-mode={e.mode}>
      <TableCell>{`v${e.version}`}</TableCell>
      <TableCell>{e.mode === 'rebuild' ? `重建（批次 1–${e.batchTo}）` : e.batchTo === e.batchFrom ? '增量（无新批次）' : `增量（批次 ${e.batchFrom + 1}–${e.batchTo}）`}</TableCell>
      <TableCell className="whitespace-normal">
        {`${e.rows.toLocaleString('zh-CN')} 行（新增 ${e.inserted}，更新 ${e.updated}，删除 ${e.deleted}）`}
        {e.fallback?.map(f => (
          <div key={f.column} className="text-sm text-muted-foreground" data-merge-fallback={f.column}>{fallbackText(e.entity, f)}</div>
        ))}
      </TableCell>
      <TableCell>{duration(e.durationMs)}</TableCell>
      <TableCell>{time(e.startedAt)}</TableCell>
    </TableRow>
  );
}

/** 版本状态：已发布（锁定）或草稿，颜色配图标和文字（见 docs/agents/ui.md） */
function VersionStatus({ v }: { v: Version }) {
  return v.status === 'published'
    ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-3.5" />已发布</span>
    : <span className="inline-flex items-center gap-1 text-sm text-amber-600"><PencilLine className="size-3.5" />草稿</span>;
}

/** 草稿的发布与丢弃（发布不了时在按钮位置说明原因） */
function DraftActions({ v, canWrite, published, submitting }: { v: Version; canWrite: boolean; published: boolean; submitting: boolean }) {
  return (
    <>
      {v.publishBlocker ? (
        <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-publish-blocker><Lock className="size-3.5 shrink-0" />{v.publishBlocker}</span>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <input type="hidden" name="version" value={v.version} />
          <Button type="submit" disabled={submitting}><Upload />{`发布 v${v.version}`}</Button>
        </Form>
      )}
      {canWrite && (
        <Form
          method="post"
          onSubmit={e => {
            const back = published ? '回到最近的已发布版本' : '这个映射从没发布过，将被删除';
            if (!confirm(`丢弃第 ${v.version} 版草稿？${back}。`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="discard" />
          <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />丢弃草稿</Button>
        </Form>
      )}
    </>
  );
}

export default function Mapping({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tab, version, canWrite, functions, mapping, versions, merge } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const draft = versions.find(v => v.status === 'draft');
  const live = versions.find(v => v.status === 'published');
  const selected = versions.find(v => v.version === version) ?? versions[0];
  const lastMerge = merge.history[0];
  const base = `/mappings/${mapping.id}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={<span className="flex items-center gap-3">{mapping.entityLabel}<span className="text-slate-300">←</span><span className="font-mono text-2xl text-slate-500">{mapping.table}</span></span>}
        description={<Link to="/mappings" className="hover:underline">← 全部映射</Link>}
        actions={
          <>
            {draft && <DraftActions v={draft} canWrite={canWrite} published={Boolean(live)} submitting={submitting} />}
            {canWrite && live && (
              <Form method="post">
                <input type="hidden" name="intent" value="merge" />
                <Button type="submit" variant="outline" disabled={submitting} title="只合并这个映射已发布的最新版本"><Play />立即合并</Button>
              </Form>
            )}
          </>
        }
      />

      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_1.2fr]">
        <Link to={`/sources/${mapping.source.id}`} className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md">
          <KindIcon kind={mapping.source.kind} />
          <span className="min-w-0">
            <span className="block text-xs text-slate-500">源表</span>
            <span className="block truncate font-medium">{mapping.source.name} / <span className="font-mono">{mapping.table}</span></span>
          </span>
        </Link>
        <div className="hidden place-items-center text-slate-300 lg:grid"><ArrowRight className="size-6" /></div>
        <Link to="/model" className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-violet-100 text-violet-700"><Boxes className="size-5" /></span>
          <span className="min-w-0">
            <span className="block text-xs text-slate-500">标准实体</span>
            <span className="block truncate font-medium">{`${mapping.entityLabel}（${mapping.entity}）`}</span>
          </span>
        </Link>
        <div className="grid grid-cols-2 gap-4">
          <StatTile
            label="线上版本"
            value={live ? `v${live.version}` : '—'}
            hint={draft ? <span className="inline-flex items-center gap-1 text-amber-600"><PencilLine className="size-3" />{`有草稿 v${draft.version}`}</span> : live ? '已发布的最新版本' : '还没有发布'}
          />
          <StatTile
            label={<span className="inline-flex items-center gap-1">{merge.status === 'failed' && <AlertTriangle className="size-3.5 text-red-600" />}{`最近合并 · ${merge.statusLabel}`}</span>}
            value={lastMerge && 'rows' in lastMerge ? lastMerge.rows.toLocaleString('zh-CN') : '—'}
            hint="标准层行数"
            tone={merge.status === 'failed' ? 'text-red-600' : undefined}
          />
        </div>
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'edit', label: '编辑', href: base },
          { key: 'versions', label: `版本（${versions.length}）`, href: `${base}?tab=versions` },
          { key: 'merges', label: `合并记录（${merge.history.length}）`, href: `${base}?tab=merges` },
        ]}
      />

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        {tab === 'edit' && selected && (
          <>
            <div className="mb-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-slate-500">正在查看 <span className="font-mono font-semibold text-slate-900">{`v${selected.version}`}</span><VersionStatus v={selected} /></div>
              <p className="max-w-2xl text-sm text-slate-500">
                {canWrite
                  ? selected.status === 'draft' ? '保存后你是最后改这一版草稿的人，需由另一位数据工程师或管理员发布。' : draft ? `已发布的版本锁定。已有草稿 v${draft.version}，请在草稿上修改。` : '已发布的版本锁定，在这一版的基础上修改，保存为新的一版草稿。'
                  : '只读。'}
              </p>
            </div>
            {canWrite && (selected.status === 'draft' || !draft) ? (
              <Form method="post" className="space-y-3" key={`${selected.version}-${actionData?.draftId ?? ''}`}>
                <MappingEditorWithReference defaultValue={actionData?.yaml ?? selected.yaml} table={mapping.reference} entity={mapping.entity} functions={functions} />
                <div className="flex gap-2">
                  <Button type="submit" name="intent" value="save" disabled={submitting}>
                    {submitting ? '正在处理…' : selected.status === 'draft' ? '校验并保存草稿' : '校验并保存为新草稿'}
                  </Button>
                  <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !mapping.reference} title="按列名、类型与常见取值生成，替换编辑框里的内容；不会保存">
                    按规则生成草稿
                  </Button>
                </div>
              </Form>
            ) : (
              <MappingEditor key={selected.version} defaultValue={selected.yaml} readOnly />
            )}
          </>
        )}

        {tab === 'versions' && (
          <>
            <p className="mb-4 max-w-2xl text-sm text-slate-500">已发布的版本锁定，修改会形成新的一版草稿；草稿需由最后保存它的人以外的另一位数据工程师或管理员发布，也可以丢弃。</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>作者</TableHead>
                  <TableHead>发布</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map(v => (
                  <TableRow key={v.version} data-version={v.version} data-version-status={v.status}>
                    <TableCell className="font-mono font-semibold">{`v${v.version}`}</TableCell>
                    <TableCell><VersionStatus v={v} /></TableCell>
                    <TableCell className="text-sm">{v.authors.join('、')}</TableCell>
                    <TableCell className="text-sm text-slate-500">{v.publishedBy ? `${v.publishedBy}，${time(v.publishedAt)}` : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost"><Link to={`${base}?version=${v.version}`}>查看</Link></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {tab === 'merges' && (
          <>
            <p className="mb-4 max-w-2xl text-sm text-slate-500">
              {merge.status === 'failed' && <AlertTriangle className="mr-1 inline size-3.5 text-red-600" />}
              {`这个映射最近一次合并：${merge.statusLabel}。发布后、以及同步给这个映射的源表写入了变更后，已发布的最新版本把原始层的新批次合并进标准层；换了版本时由全部批次重建。写了兜底值的字段，每次合并列出本次落入兜底的取值。`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>方式</TableHead>
                  <TableHead>标准层行数</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merge.history.map((e, i) => <MergeRow key={`${e.taskId}-${i}`} e={e} />)}
                {!merge.history.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-slate-500">还没有合并过</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </AppShell>
  );
}

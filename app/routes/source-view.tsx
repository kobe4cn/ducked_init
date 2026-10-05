// app/routes/source-view.tsx —— 单个源视图（ADR-0022）：数据工程师、管理员编写只读本数据源原始层的 SELECT，保存时在只读挂载的数据湖上校验，
// 校验通过后预览视图的列与前几行样本（像敏感信息的列是加盐哈希）；各版本（已发布的锁定、草稿可改）、丢弃草稿，
// 发布草稿需最后保存它的人以外的另一位有发布权限的成员在这个页面上操作，没有自动发布。
// /sources/:sourceId/views/new 新建（名称与 SQL）；详情页分编辑、版本两个标签页（?tab=edit|versions，默认编辑），
// 编辑页显示 ?version=N 选中的版本（默认最新），?preview=N 时在编辑框下方预览第 N 版（保存后跳到这里）
import { AlertTriangle, CircleAlert, Eye } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/source-view';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { publishReason } from '~/.server/publish-rules';
import type { ViewPreview } from '~/.server/pipeline/source-view-engine';
import {
  createSourceView, discardSourceViewDraft, getSourceView, listSourceViews, previewSourceView, publishSourceView, saveSourceViewDraft, SourceViewError,
} from '~/.server/source-views';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { NewSourceViewForm, SOURCE_VIEW_HINT, SqlEditor } from '~/components/source-view-form';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.view?.name ?? '源视图'} · CRM 数据分析平台` }];
}

type Tab = 'edit' | 'versions';
const tabOf = (request: Request): Tab => (new URL(request.url).searchParams.get('tab') === 'versions' ? 'versions' : 'edit');

const NEW = 'new';

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const canWrite = can(member.role, 'sources:write');
  const common = { email: member.email, nav: navFor(member), tab: tabOf(request), canWrite };
  try {
    if (params.viewId === NEW) {
      if (!canWrite) throw data(null, { status: 403 });
      const { source } = await listSourceViews(member, params.sourceId);
      return { ...common, source, view: null, versions: [], version: null, preview: null };
    }
    const v = await getSourceView(member, params.sourceId, params.viewId);
    const url = new URL(request.url);
    const previewVersion = Number(url.searchParams.get('preview')) || null;
    let preview: { version: number; result: ViewPreview | null; error: string | null } | null = null;
    if (canWrite && previewVersion) {
      try {
        preview = { version: previewVersion, result: await previewSourceView(member, params.sourceId, params.viewId, previewVersion), error: null };
      } catch (e) {
        if (!(e instanceof SourceViewError)) throw e;
        preview = { version: previewVersion, result: null, error: e.message };
      }
    }
    return {
      ...common,
      source: v.source,
      view: v.view,
      /** 编辑页显示的版本（?version=N，没有时显示最新的一版） */
      version: Number(url.searchParams.get('version')) || previewVersion,
      versions: v.versions.map(version => ({
        ...version,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        updatedAt: version.updatedAt.toISOString(),
        /** 当前成员发布不了这一版草稿的原因；可以发布或不是草稿时为 null */
        publishBlocker: publishReason(member, version, v.publishers),
      })),
      preview,
    };
  } catch (e) {
    if (e instanceof SourceViewError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  const base = `/sources/${params.sourceId}/views`;
  try {
    switch (field('intent')) {
      case 'create': {
        const id = await createSourceView(await requirePermission(request, 'sources:write'), params.sourceId, { name: field('name'), sql: field('sql') });
        throw redirect(`${base}/${id}?preview=1`);
      }
      case 'save': {
        const version = await saveSourceViewDraft(await requirePermission(request, 'sources:write'), params.sourceId, params.viewId, field('sql'));
        throw redirect(`${base}/${params.viewId}?preview=${version}`);
      }
      case 'publish':
        await publishSourceView(await requirePermission(request, 'publish'), params.sourceId, params.viewId, Number(field('version')));
        break;
      case 'discard': {
        // 从没发布过的源视图整个删除，回到数据源的源视图标签页
        const { kept } = await discardSourceViewDraft(await requirePermission(request, 'sources:write'), params.sourceId, params.viewId);
        if (!kept) throw redirect(`/sources/${params.sourceId}?tab=views`);
        break;
      }
      default:
        return data({ error: '未知操作', sql: null, name: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SourceViewError) return data({ error: e.message, sql: field('sql') || null, name: field('name') || null }, { status: e.status });
    throw e;
  }
  const tab = tabOf(request);
  throw redirect(`${base}/${params.viewId}${tab === 'edit' ? '' : `?tab=${tab}`}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

/** 预览：视图的列（像敏感信息的标「哈希」）与前几行样本，空值显示为 — */
function PreviewPanel({ version, result }: { version: number; result: ViewPreview }) {
  const { columns, rows } = result;
  return (
    <section className="mt-6 space-y-4 border-t pt-6" data-preview={version}>
      <div>
        <h2 className="font-semibold">{`预览 v${version}`}</h2>
        <p className="max-w-2xl text-sm text-slate-500">{`视图有 ${columns.length} 列；样本取前 ${rows.length} 行（最多 ${result.limit} 行），像敏感信息的列显示为按租户加盐的哈希。`}</p>
      </div>
      <div className="overflow-x-auto rounded-2xl border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(c => (
                <TableHead key={c.name} data-preview-column={c.name} data-sensitive={c.sensitive || undefined}>
                  <span className="block font-mono">{c.name}</span>
                  <span className="block text-xs font-normal text-slate-400">{`${c.sensitive ? '哈希 · ' : ''}${c.type}`}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} data-preview-row>
                {columns.map(c => (
                  <TableCell key={c.name} className={`max-w-[16rem] truncate ${c.sensitive ? 'font-mono text-xs' : ''}`} title={r[c.name] == null ? undefined : String(r[c.name])}>
                    {r[c.name] == null ? <span className="text-slate-400">—</span> : String(r[c.name])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center text-slate-500">视图没有返回行</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** 编辑页对正在查看的版本的说明：只读、改草稿，或在已发布的版本上改成新草稿 */
function editHint(canWrite: boolean, selected: { status: string }, draft: { version: number } | undefined) {
  if (!canWrite) return '只读。';
  if (selected.status === 'draft') return '保存后你是最后改这一版草稿的人，需由另一位数据工程师或管理员发布。';
  if (draft) return `已发布的版本锁定。已有草稿 v${draft.version}，请在草稿上修改。`;
  return '已发布的版本锁定，在这一版的基础上修改，保存为新的一版草稿。';
}

export default function SourceView({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tab, canWrite, source, view, version, versions, preview } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const back = <Link to={`/sources/${source.id}?tab=views`} className="hover:underline">{`← ${source.name} 的源视图`}</Link>;
  const error = actionData?.error && (
    <Alert variant="destructive" role="alert">
      <CircleAlert />
      <AlertTitle>未保存</AlertTitle>
      <AlertDescription>{actionData.error}</AlertDescription>
    </Alert>
  );

  if (!view) {
    return (
      <AppShell email={email} nav={nav}>
        <PageHeader title="新建源视图" description={back} />
        {error}
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <NewSourceViewForm name={actionData?.name} sql={actionData?.sql} submitting={submitting} />
        </div>
      </AppShell>
    );
  }

  const draft = versions.find(v => v.status === 'draft');
  const live = versions.find(v => v.status === 'published');
  const selected = versions.find(v => v.version === version) ?? versions[0];
  const base = `/sources/${source.id}/views/${view.id}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={<span className="font-mono">{view.name}</span>}
        description={back}
        actions={draft && <DraftActions v={draft} canDiscard={canWrite} discardHint={live ? '回到最近的已发布版本' : '这个源视图从没发布过，将被删除'} submitting={submitting} />}
      />
      {error}
      <PillTabs
        current={tab}
        tabs={[
          { key: 'edit', label: '编辑', href: base },
          { key: 'versions', label: `版本（${versions.length}）`, href: `${base}?tab=versions` },
        ]}
      />
      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        {tab === 'edit' && selected && (
          <>
            <div className="mb-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-slate-500">正在查看 <span className="font-mono font-semibold text-slate-900">{`v${selected.version}`}</span><VersionStatus v={selected} /></div>
              <p className="max-w-2xl text-sm text-slate-500">
                {editHint(canWrite, selected, draft)}
              </p>
              {canWrite && <p className="max-w-2xl text-sm text-slate-500">{SOURCE_VIEW_HINT}</p>}
            </div>
            {canWrite && (selected.status === 'draft' || !draft) ? (
              <Form method="post" className="space-y-3" key={selected.version}>
                <SqlEditor defaultValue={actionData?.sql ?? selected.sql} />
                <Button type="submit" name="intent" value="save" disabled={submitting}>
                  {submitting ? '正在校验…' : selected.status === 'draft' ? '校验并保存草稿' : '校验并保存为新草稿'}
                </Button>
              </Form>
            ) : (
              <SqlEditor key={selected.version} defaultValue={selected.sql} readOnly />
            )}
            {canWrite && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button asChild variant="outline"><Link to={`${base}?version=${selected.version}&preview=${selected.version}`}><Eye />{`预览 v${selected.version}`}</Link></Button>
                <span className="text-sm text-slate-500">在原始层上执行已保存的这一版，看视图的列与前几行样本；编辑框里没保存的修改不参与。</span>
              </div>
            )}
            {preview?.version === selected.version && (preview.result ? <PreviewPanel version={preview.version} result={preview.result} /> : (
              <p className="mt-6 flex items-center gap-2 border-t pt-6 text-sm text-red-600" data-preview-error><AlertTriangle className="size-4" />{`预览失败：${preview.error}`}</p>
            ))}
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
                    <TableCell className="text-sm text-slate-500">{v.publishedByEmail ? `${v.publishedByEmail}，${time(v.publishedAt)}` : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost"><Link to={`${base}?version=${v.version}`}>查看</Link></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </AppShell>
  );
}

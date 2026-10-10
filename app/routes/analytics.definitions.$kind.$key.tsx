// app/routes/analytics.definitions.$kind.$key.tsx —— 指标或标签定义（有定义查看权限的成员，页面与种类无关，ADR-0025）：
// YAML 编辑框（有起草权限的成员保存草稿，校验不通过时按行列列出问题）、最新一版编译出的 SQL 与样本预览（只读挂载上按今天运行，前 50 行与总行数），
// 以及各版本的作者与最后保存的人
import { CheckCircle2 } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.$kind.$key';
import { can, requirePermission } from '~/.server/access';
import { DslError, getDefinition, previewDefinition, saveDslDraft } from '~/.server/dsl-definitions';
import { navFor } from '~/.server/nav';
import { UNLINKED } from '~/.server/pipeline/dsl/metric-spec';
import { AppShell } from '~/components/app-shell';
import { VersionStatus } from '~/components/draft-version';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.label} ${loaderData.key}` : '定义'} · CRM 数据分析平台` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:read');
  let d;
  try {
    d = await getDefinition(member, params.kind, params.key);
  } catch (e) {
    if (e instanceof DslError && e.status === 404) throw data(null, { status: 404 });
    throw e;
  }
  return {
    email: member.email,
    nav: navFor(member),
    canDraft: can(member.role, 'definitions:draft'),
    /** 刚保存的版本（保存后跳回本页时带上 ?saved=N） */
    justSaved: Number(new URL(request.url).searchParams.get('saved')) || null,
    kind: d.kind,
    key: d.key,
    label: d.label,
    /** 编辑框里的 YAML：最新一版（有草稿时是草稿） */
    yaml: d.versions[0]!.yaml,
    published: d.published?.version ?? null,
    compiled: d.compiled,
    /** 维度关联不到时的取值，预览结果里淡显 */
    unlinked: UNLINKED,
    versions: d.versions.map(v => ({
      version: v.version,
      status: v.status,
      authors: v.authors,
      lastEditor: v.lastEditor,
      publishedByEmail: v.publishedByEmail,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      updatedAt: v.updatedAt.toISOString(),
    })),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const yaml = String(form.get('yaml') ?? '');
  const intent = String(form.get('intent') ?? '');
  try {
    switch (intent) {
      case 'save': {
        const version = await saveDslDraft(await requirePermission(request, 'definitions:draft'), params.kind, params.key, yaml);
        throw redirect(`/analytics/definitions/${params.kind}/${params.key}?saved=${version}`);
      }
      case 'preview': {
        const member = await requirePermission(request, 'definitions:read');
        const preview = await previewDefinition(member, params.kind, params.key, Number(form.get('version')) || undefined);
        return { error: null, issues: [], yaml: null, preview };
      }
      default:
        return data({ error: '未知操作', issues: [], yaml: null, preview: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof DslError) return data({ error: e.message, issues: e.issues, yaml: intent === 'save' ? yaml : null, preview: null }, { status: e.status });
    throw e;
  }
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

export default function Definition({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canDraft, justSaved, kind, key, label, yaml, published, compiled, unlinked, versions } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';
  const previewing = submitting && navigation.formData?.get('intent') === 'preview';
  const preview = actionData?.preview ?? null;
  const draft = versions.find(v => v.status === 'draft');
  const editing = actionData?.yaml ?? yaml;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`${label} · ${key}`}
        description={<><Link to="/analytics" className="hover:underline">← 分析</Link>{`　${kind}:${key}　当前生效：${published ? `第 ${published} 版` : '还没有发布'}`}</>}
      />

      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}
      {justSaved && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{`第 ${justSaved} 版草稿已保存`}</AlertTitle>
        </Alert>
      )}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">{draft ? `第 ${draft.version} 版草稿` : canDraft ? '编辑定义（保存后成为新的一版草稿）' : '生效的定义'}</h2>
        <Form method="post" className="space-y-4">
          <MappingEditor key={editing} defaultValue={editing} readOnly={!canDraft} />
          {canDraft && <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting && !previewing ? '正在校验…' : '校验并保存草稿'}</Button>}
        </Form>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-1 font-medium">{`编译出的 SQL（第 ${compiled.version} 版，按今天计算）`}</h2>
        <p className="mb-4 text-sm text-slate-500">经 silver._identities 关联到消费者；维度路径逐跳 LEFT JOIN，关联不到或为空的记为「未关联」。</p>
        {compiled.sql
          ? <pre data-compiled-sql className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-5">{compiled.sql}</pre>
          : <MappingErrors error="对照当前已发布的登记与映射，这一版不再通过校验" issues={compiled.issues} />}
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">样本预览</h2>
            <p className="text-sm text-slate-500">在只读挂载的数据湖上按今天运行编译出的 SQL，展示前 50 行与总行数，不写任何表。</p>
          </div>
          <Form method="post" className="flex gap-2">
            <input type="hidden" name="intent" value="preview" />
            <Button type="submit" name="version" value={compiled.version} variant="outline" disabled={submitting || !compiled.sql}>
              {previewing ? '正在预览…' : `预览第 ${compiled.version} 版`}
            </Button>
            {published && published !== compiled.version && (
              <Button type="submit" name="version" value={published} variant="outline" disabled={submitting}>{`预览生效的第 ${published} 版`}</Button>
            )}
          </Form>
        </div>
        {preview && (
          <>
            <p data-preview-total className="mb-2 text-sm text-slate-500">
              {`第 ${preview.version} 版，统计日 ${preview.asOf}：共 ${preview.total} 行${preview.total > preview.rows.length ? `，展示前 ${preview.rows.length} 行` : ''}`}
            </p>
            {preview.rows.length
              ? (
                <Table data-preview>
                  <TableHeader>
                    <TableRow>{preview.columns.map(c => <TableHead key={c}>{c}</TableHead>)}</TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((r, i) => (
                      <TableRow key={i}>
                        {preview.columns.map(c => (
                          <TableCell key={c} className={r[c] === unlinked ? 'text-slate-400' : 'font-mono text-xs'}>{r[c] === null ? '—' : String(r[c])}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
              : <p className="text-sm text-slate-500">没有结果：标准层里还没有满足这个定义的数据。</p>}
          </>
        )}
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">版本</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>作者</TableHead>
              <TableHead>最后保存</TableHead>
              <TableHead>发布</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map(v => (
              <TableRow key={v.version} data-version={v.version}>
                <TableCell>{`v${v.version}`}</TableCell>
                <TableCell><VersionStatus v={v} /></TableCell>
                <TableCell>{v.authors.join('、')}</TableCell>
                <TableCell className="text-slate-500">{`${v.lastEditor} · ${time(v.updatedAt)}`}</TableCell>
                <TableCell className="text-slate-500">{v.publishedByEmail ? `${v.publishedByEmail} · ${time(v.publishedAt)}` : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </AppShell>
  );
}

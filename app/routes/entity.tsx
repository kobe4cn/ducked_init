// app/routes/entity.tsx —— 单个自定义实体（ADR-0019）：数据工程师、管理员编辑登记（中文名、类型、字段与主键；名称建实体时定下，不能改），
// 各版本（已发布的锁定、草稿可改；发布过的只能新增字段）、丢弃草稿，发布草稿需最后保存它的人以外的另一位有发布权限的成员在这个页面上操作，
// 没有自动发布。有发布权限的成员可以删除没被已发布映射引用的实体。平台推断出的登记草稿提示成员核对后保存确认，确认前发布不了。
// 分编辑、版本两个标签页（?tab=edit|versions，默认编辑），编辑页显示 ?version=N 选中的版本（默认最新）
import { CircleAlert, Info, Lock, Trash2 } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/entity';
import { can, requirePermission } from '~/.server/access';
import {
  CustomEntityError, customEntityInputOf, deleteCustomEntity, discardCustomEntityDraft, getCustomEntity, isInferredDraft, publishCustomEntity, saveCustomEntityDraft,
} from '~/.server/custom-entities';
import { navFor } from '~/.server/nav';
import { publishReason } from '~/.server/publish-rules';
import { AppShell } from '~/components/app-shell';
import { CustomEntityForm, EntityFieldsTable } from '~/components/custom-entity-form';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { CUSTOM_ENTITY_KINDS } from '~/lib/canonical-model';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.entity?.name ?? '自定义实体'} · CRM 数据分析平台` }];
}

type Tab = 'edit' | 'versions';
const tabOf = (request: Request): Tab => (new URL(request.url).searchParams.get('tab') === 'versions' ? 'versions' : 'edit');

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const found = await getCustomEntity(member, params.entityId);
    return {
      email: member.email,
      nav: navFor(member),
      tab: tabOf(request),
      canWrite: can(member.role, 'sources:write'),
      canDelete: can(member.role, 'publish'),
      entity: found.entity,
      /** 草稿是平台推断、还没有成员确认（保存）过的登记 */
      inferred: !!found.draft && isInferredDraft(found.draft),
      /** 引用这个实体的已发布映射；有引用时不能删除 */
      referrers: found.referrers,
      /** 编辑页显示的版本（?version=N，没有时显示最新的一版） */
      version: Number(new URL(request.url).searchParams.get('version')) || null,
      versions: found.versions.map(v => ({
        ...v,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        updatedAt: v.updatedAt.toISOString(),
        /** 当前成员发布不了这一版草稿的原因；可以发布或不是草稿时为 null */
        publishBlocker: publishReason(member, v, found.publishers),
      })),
    };
  } catch (e) {
    if (e instanceof CustomEntityError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const input = customEntityInputOf(form);
  const base = `/entities/${params.entityId}`;
  try {
    switch (form.get('intent')) {
      case 'save':
        await saveCustomEntityDraft(await requirePermission(request, 'sources:write'), params.entityId, input);
        throw redirect(base);
      case 'publish':
        await publishCustomEntity(await requirePermission(request, 'publish'), params.entityId, Number(form.get('version')));
        break;
      case 'discard': {
        // 从没发布过的实体整个删除，回到列表
        const { kept } = await discardCustomEntityDraft(await requirePermission(request, 'sources:write'), params.entityId);
        if (!kept) throw redirect('/entities');
        break;
      }
      case 'delete':
        await deleteCustomEntity(await requirePermission(request, 'publish'), params.entityId);
        throw redirect('/entities');
      default:
        return data({ error: '未知操作', intent: null, input: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof CustomEntityError) {
      const intent = String(form.get('intent'));
      return data({ error: e.message, intent, input: intent === 'save' ? input : null }, { status: e.status });
    }
    throw e;
  }
  const tab = tabOf(request);
  throw redirect(`${base}${tab === 'edit' ? '' : `?tab=${tab}`}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

/** 编辑页对正在查看的版本的说明：只读、改草稿，或在已发布的版本上改成新草稿 */
function editHint(canWrite: boolean, selected: { status: string }, draft: { version: number } | undefined) {
  if (!canWrite) return '只读。';
  if (selected.status === 'draft') return '保存后你是最后改这一版草稿的人，需由另一位数据工程师或管理员发布。';
  if (draft) return `已发布的版本锁定。已有草稿 v${draft.version}，请在草稿上修改。`;
  return '已发布的版本锁定，在这一版的基础上修改，保存为新的一版草稿。';
}

export default function Entity({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tab, canWrite, canDelete, entity, inferred, referrers, version, versions } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const draft = versions.find(v => v.status === 'draft');
  const live = versions.find(v => v.status === 'published');
  const selected = versions.find(v => v.version === version) ?? versions[0];
  const base = `/entities/${entity.id}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={<span className="font-mono">{entity.name}</span>}
        description={<Link to="/entities" className="hover:underline">← 全部自定义实体</Link>}
        actions={(
          <div className="flex items-center gap-2">
            {draft && <DraftActions v={draft} canDiscard={canWrite} discardHint={live ? '回到最近的已发布版本' : '这个自定义实体从没发布过，将被删除'} submitting={submitting} />}
            {canDelete && (referrers.length ? (
              <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-delete-blocker>
                <Lock className="size-3.5 shrink-0" />{`被已发布的映射引用，不能删除：${referrers.join('、')}`}
              </span>
            ) : (
              <Form
                method="post"
                onSubmit={e => {
                  if (!confirm(`删除自定义实体 ${entity.name}？所有版本一并删除，不能恢复。`)) e.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="delete" />
                <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />删除实体</Button>
              </Form>
            ))}
          </div>
        )}
      />
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{actionData.intent === 'delete' ? '未删除' : '未保存'}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {inferred && (
        <Alert data-inferred>
          <Info />
          <AlertTitle>推断登记 · 待确认</AlertTitle>
          <AlertDescription>这份登记由已发布映射推断，请核对字段、类型和主键后保存确认；主键和已发布字段在发布后不能改。</AlertDescription>
        </Alert>
      )}
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
              <p className="max-w-2xl text-sm text-slate-500">{editHint(canWrite, selected, draft)}</p>
            </div>
            {canWrite && (selected.status === 'draft' || !draft) ? (
              <CustomEntityForm
                key={selected.version}
                intent="save"
                values={actionData?.input ?? selected}
                submitting={submitting}
                submitLabel={selected.status === 'draft' ? '保存草稿' : '保存为新草稿'}
              />
            ) : (
              <>
                <p className="mb-4 text-sm">{`${selected.label} · ${CUSTOM_ENTITY_KINDS[selected.kind]} · 主键 `}<span className="font-mono">{selected.primaryKey.join(', ')}</span></p>
                <EntityFieldsTable fields={selected.fields} primaryKey={selected.primaryKey} />
              </>
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

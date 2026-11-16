// app/routes/merge-groups.tsx —— 合并组（ADR-0032）：把同一实体下描述同一批对象的几个已发布映射绑在一起，同一主键在标准层只留一行。
// 每个能建组、有至少 2 个已发布映射的实体一个标签（?entity=）；数据工程师、管理员给映射排优先级（留空即不在组里）、选存活规则并保存草稿，
// 草稿需最后保存它的人以外的另一位有发布权限的成员在这个页面上发布，也可以丢弃；发布后版本锁定，再改是新的一版草稿。
// 每个实体卡片下方列出全部版本（新的在前，当前生效的已发布版有标记），?version=N 只读查看那一版的组员（顺序即优先级）与存活规则，不影响编辑表单
import { CircleAlert, Layers } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/merge-groups';
import { can, requirePermission } from '~/.server/access';
import {
  discardMergeGroupDraft, listMergeGroups, type MergeGroupInput, mergeGroupInputOf, publishMergeGroup, saveMergeGroupDraft,
} from '~/.server/merge-groups';
import { navFor } from '~/.server/nav';
import { PublishError } from '~/.server/publishing';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { entityLabel } from '~/lib/canonical-model';
import { MERGE_RULE_HINTS, MERGE_RULE_KINDS, MERGE_RULE_LABELS, ruleText } from '~/lib/merge-groups';

export const meta = () => [{ title: '合并组 · CRM 数据分析平台' }];

const entityParam = (request: Request) => new URL(request.url).searchParams.get('entity');

/** 要查看的版本（?version=，正整数），否则 null */
const versionParam = (request: Request) => {
  const n = Number(new URL(request.url).searchParams.get('version'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const entities = await listMergeGroups(member);
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    entities: entities.map(e => ({
      ...e,
      versions: e.versions.map(v => ({ ...v, publishedAt: v.publishedAt?.toISOString() ?? null, updatedAt: v.updatedAt.toISOString() })),
    })),
    /** 选中的实体（?entity=，没有或不在列表里时为第一个） */
    selected: entities.find(e => e.entity === entityParam(request))?.entity ?? entities[0]?.entity ?? null,
    /** 正在查看的版本（?version=，正整数）；不在选中实体的版本里时页面不渲染查看块 */
    viewVersion: versionParam(request),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const entity = String(form.get('entity') ?? entityParam(request) ?? '');
  let input: MergeGroupInput | null = null;
  try {
    switch (form.get('intent')) {
      case 'save': {
        const member = await requirePermission(request, 'sources:write');
        input = mergeGroupInputOf(form);
        await saveMergeGroupDraft(member, entity, input);
        break;
      }
      case 'publish':
        await publishMergeGroup(await requirePermission(request, 'publish'), entity, Number(form.get('version')));
        break;
      case 'discard':
        await discardMergeGroupDraft(await requirePermission(request, 'sources:write'), entity);
        break;
      default:
        return data({ error: '未知操作', intent: null, input: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof PublishError) {
      const intent = String(form.get('intent'));
      return data({ error: e.message, intent, input }, { status: e.status });
    }
    throw e;
  }
  throw redirect(`/merge-groups?entity=${encodeURIComponent(entity)}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

export default function MergeGroups({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, entities, selected, viewVersion } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const current = entities.find(e => e.entity === selected);
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="合并组"
        description={(
          <>
            <Link to="/mappings" className="hover:underline">← 全部映射</Link>
            <span className="ml-3">同一实体下描述同一批对象的几个映射，绑成一组后同一主键在标准层只留一行，按存活规则取值。</span>
          </>
        )}
      />
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{actionData.intent === 'publish' ? '未发布' : actionData.intent === 'discard' ? '未丢弃' : '未保存'}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {!current ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm" data-empty>
          <div className="flex items-center gap-2 font-semibold"><Layers className="size-4 text-slate-400" />还没有可以建合并组的实体</div>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            一个实体有至少两个已发布的映射时，可以在这里把它们建成合并组。消费者（customer）用映射里的属性取舍，主键含消费者引用的实体只在同一个数据源内唯一，都不建合并组。
          </p>
          <Button asChild variant="outline" className="mt-4"><Link to="/mappings">去映射页发布映射</Link></Button>
        </div>
      ) : (
        <>
          <PillTabs
            current={current.entity}
            tabs={entities.map(e => ({ key: e.entity, label: entityLabel(e.entity), href: `/merge-groups?entity=${encodeURIComponent(e.entity)}` }))}
          />
          <EntityGroup key={current.entity} group={current} canWrite={canWrite} submitting={submitting} input={actionData?.input ?? null} viewVersion={viewVersion} />
        </>
      )}
    </AppShell>
  );
}

type Group = Route.ComponentProps['loaderData']['entities'][number];

function EntityGroup({ group, canWrite, submitting, input, viewVersion }: {
  group: Group; canWrite: boolean; submitting: boolean; input: { members: string[]; rule: Group['versions'][number]['rule'] } | null; viewVersion: number | null;
}) {
  const draft = group.versions.find(v => v.status === 'draft');
  const live = group.versions.find(v => v.status === 'published');
  const viewing = viewVersion === null ? undefined : group.versions.find(v => v.version === viewVersion);
  const values = input ?? draft ?? live ?? { members: [], rule: { kind: 'priority' as const } };
  const mappingName = (id: string) => group.candidates.find(c => c.id === id)?.name ?? '（已停用或不再发布的映射）';
  return (
    <div className="rounded-2xl border bg-white p-6 shadow-sm" data-entity={group.entity}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-semibold"><span className="font-mono">{group.entity}</span>{` · ${entityLabel(group.entity)}`}</h2>
          {live ? (
            <p className="text-sm text-slate-500" data-published>
              {`已发布 v${live.version}（${live.publishedByEmail}，${time(live.publishedAt)}）：${live.members.map(mappingName).join(' > ')}，${ruleText(live.rule)}`}
            </p>
          ) : <p className="text-sm text-slate-500">还没有发布的合并组。</p>}
          {draft && (
            <p className="flex items-center gap-2 text-sm text-slate-500" data-draft>
              {`v${draft.version}`}<VersionStatus v={draft} sameAs={draft.sameAs} />{`${draft.members.map(mappingName).join(' > ')}，${ruleText(draft.rule)}（最后保存 ${draft.lastEditor}）`}
            </p>
          )}
        </div>
        {draft && <DraftActions v={draft} canDiscard={canWrite} discardHint={live ? `回到 v${live.version}` : '这个合并组从没发布过，将被删除'} submitting={submitting} />}
      </div>
      {canWrite ? (
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="entity" value={group.entity} />
          <p className="max-w-2xl text-sm text-slate-500">
            {`给要合并的映射填优先级（1 最高），留空的不在组里。${draft ? `保存会改 v${draft.version} 草稿` : '保存为新的一版草稿'}，你是最后改它的人，需由另一位数据工程师或管理员发布。`}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">优先级</TableHead>
                <TableHead>映射</TableHead>
                <TableHead>键空间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.candidates.map(c => {
                const rank = values.members.indexOf(c.id);
                return (
                  <TableRow key={c.id} data-candidate={c.id}>
                    <TableCell>
                      <input type="hidden" name="candidate" value={c.id} />
                      <Input name="rank" type="number" min={1} defaultValue={rank >= 0 ? rank + 1 : ''} aria-label={`${c.name} 的优先级`} />
                    </TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="font-mono text-sm text-slate-500">{c.keySpace ?? '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="merge-rule">存活规则</Label>
              <NativeSelect id="merge-rule" name="rule" defaultValue={values.rule.kind}>
                {MERGE_RULE_KINDS.map(k => <NativeSelectOption key={k} value={k}>{`${MERGE_RULE_LABELS[k]}：${MERGE_RULE_HINTS[k]}`}</NativeSelectOption>)}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="merge-latest-field">取最新时比较的字段</Label>
              <NativeSelect id="merge-latest-field" name="latestField" defaultValue={values.rule.kind === 'latest' ? values.rule.field : ''}>
                <NativeSelectOption value="">—</NativeSelectOption>
                {group.fields.map(f => <NativeSelectOption key={f} value={f}>{f}</NativeSelectOption>)}
              </NativeSelect>
            </div>
          </div>
          <Button type="submit" disabled={submitting}>{draft ? '保存草稿' : '保存为新草稿'}</Button>
        </Form>
      ) : <p className="text-sm text-slate-500">只读。</p>}
      <section className="mt-6" data-versions>
        <h3 className="mb-2 text-sm font-semibold text-slate-500">版本</h3>
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
            {group.versions.map(v => (
              <TableRow key={v.version} data-version={v.version} data-version-status={v.status} data-live={v === live || undefined}>
                <TableCell className="font-mono font-semibold">{`v${v.version}`}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    <VersionStatus v={v} />
                    {v === live && <Badge className="bg-emerald-50 text-emerald-600">当前生效</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{v.authors.join('、') || '平台'}</TableCell>
                <TableCell className="text-sm text-slate-500">{v.publishedByEmail ? `${v.publishedByEmail}，${time(v.publishedAt)}` : '—'}</TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="ghost"><Link to={`?entity=${group.entity}&version=${v.version}`}>查看</Link></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {viewing && (
        <section className="mt-6" data-version-view={viewing.version}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            正在查看 <span className="font-mono font-semibold text-slate-900">{`v${viewing.version}`}</span><VersionStatus v={viewing} />
            <Button asChild size="sm" variant="ghost"><Link to={`?entity=${group.entity}`}>关闭</Link></Button>
          </div>
          <p className="mb-1 max-w-2xl text-sm text-slate-500">组员按优先级从高到低：</p>
          <ol className="max-w-2xl space-y-1 text-sm">
            {viewing.members.map((id, i) => <li key={id} data-version-member>{`${i + 1}. ${mappingName(id)}`}</li>)}
          </ol>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">{`存活规则：${ruleText(viewing.rule)}`}</p>
        </section>
      )}
    </div>
  );
}

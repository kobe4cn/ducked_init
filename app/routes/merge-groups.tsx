// app/routes/merge-groups.tsx —— 合并组（ADR-0032）：把同一实体下描述同一批对象的几个已发布映射绑在一起，同一主键在标准层只留一行。
// 每个能建组、有至少 2 个已发布映射的实体一个标签（?entity=）；数据工程师、管理员给映射排优先级（留空即不在组里）、选存活规则并保存草稿，
// 草稿需最后保存它的人以外的另一位有发布权限的成员在这个页面上发布，也可以丢弃；发布后版本锁定，再改是新的一版草稿
import { CircleAlert, Layers } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/merge-groups';
import { can, requirePermission } from '~/.server/access';
import {
  discardMergeGroupDraft, listMergeGroups, MergeGroupError, type MergeGroupInput, mergeGroupInputOf, publishMergeGroup, saveMergeGroupDraft,
} from '~/.server/merge-groups';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { entityLabel } from '~/lib/canonical-model';
import { MERGE_RULE_HINTS, MERGE_RULE_KINDS, MERGE_RULE_LABELS, ruleText } from '~/lib/merge-groups';

export const meta = () => [{ title: '合并组 · CRM 数据分析平台' }];

const entityParam = (request: Request) => new URL(request.url).searchParams.get('entity');

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
    if (e instanceof MergeGroupError) {
      const intent = String(form.get('intent'));
      return data({ error: e.message, intent, input }, { status: e.status });
    }
    throw e;
  }
  throw redirect(`/merge-groups?entity=${encodeURIComponent(entity)}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

export default function MergeGroups({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, entities, selected } = loaderData;
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
          <EntityGroup key={current.entity} group={current} canWrite={canWrite} submitting={submitting} input={actionData?.input ?? null} />
        </>
      )}
    </AppShell>
  );
}

type Group = Route.ComponentProps['loaderData']['entities'][number];

function EntityGroup({ group, canWrite, submitting, input }: {
  group: Group; canWrite: boolean; submitting: boolean; input: { members: string[]; rule: Group['versions'][number]['rule'] } | null;
}) {
  const draft = group.versions.find(v => v.status === 'draft');
  const live = group.versions.find(v => v.status === 'published');
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
              {`v${draft.version}`}<VersionStatus v={draft} />{`${draft.members.map(mappingName).join(' > ')}，${ruleText(draft.rule)}（最后保存 ${draft.lastEditor}）`}
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
    </div>
  );
}

// app/routes/mappings.tsx —— 映射（数据工程师、管理员可起草；分析师只读）：本租户的映射列表（源表 → 实体、已发布版本、草稿、最近一次合并），
// 新建映射（选数据源、编写 YAML，校验通过才保存为草稿），以及手动触发一次合并到标准层
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/mappings';
import { can, requirePermission } from '~/.server/access';
import { createMapping, listMappings, MappingError, mergeNow } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { mappingTemplate } from '~/.server/pipeline/mapping-spec';
import { listSources } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { entityLabel } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '映射 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const { mappings, merge } = await listMappings(member);
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    sources: (await listSources(member)).map(s => ({ id: s.id, name: s.name })),
    template: mappingTemplate('order', 'orders'),
    merge: {
      status: merge.status,
      statusLabel: merge.status === 'none' ? '未合并' : TASK_STATUS_LABELS[merge.status],
      error: merge.error,
      attemptedAt: merge.attemptedAt?.toISOString() ?? null,
    },
    mappings: mappings.map(m => ({
      id: m.id,
      sourceName: m.sourceName,
      table: m.tableName,
      entity: m.entity,
      entityLabel: entityLabel(m.entity),
      published: m.published,
      draft: m.draft,
      lastMerge: m.lastMerge,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:write');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'create': {
        const mapping = await createMapping(member, field('sourceId'), field('yaml'));
        throw redirect(`/mappings/${mapping.id}`);
      }
      case 'merge':
        await mergeNow(member);
        throw redirect('/mappings');
      default:
        return data({ error: '未知操作', issues: [], values: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MappingError) {
      return data({ error: e.message, issues: e.issues, values: { sourceId: field('sourceId'), yaml: field('yaml') } }, { status: e.status });
    }
    throw e;
  }
}

const TASK_VARIANTS = { none: 'outline', queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type LastMerge = Route.ComponentProps['loaderData']['mappings'][number]['lastMerge'];

/** 一个映射最近一次合并的结果 */
function mergeSummary(m: LastMerge) {
  if (!m) return '—';
  if ('error' in m) return `失败：${m.error}`;
  if ('skipped' in m) return `跳过：${m.skipped}`;
  return `第 ${m.version} 版，${m.rows.toLocaleString('zh-CN')} 行（新增 ${m.inserted}，更新 ${m.updated}，删除 ${m.deleted}）`;
}

export default function Mappings({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, sources, template, merge, mappings } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}

      <Card>
        <CardHeader>
          <CardTitle>映射</CardTitle>
          <CardDescription>
            数据源中的表 → 标准实体与字段的对应关系，带版本。草稿由另一位数据工程师或管理员发布后锁定；
            已发布的映射在每次同步后把原始层的变更批次合并进标准层。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm" data-merge-status={merge.status}>
            <span>最近一次合并：</span>
            <Badge variant={TASK_VARIANTS[merge.status]}>{merge.statusLabel}</Badge>
            <span className="text-muted-foreground">{time(merge.attemptedAt)}</span>
            {canWrite && (
              <Form method="post">
                <input type="hidden" name="intent" value="merge" />
                <Button type="submit" size="sm" variant="outline" disabled={submitting}>立即合并</Button>
              </Form>
            )}
          </div>
          {merge.error && <div className="text-sm whitespace-normal text-destructive">{merge.error}</div>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>实体</TableHead>
                <TableHead>源表</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>最近一次合并</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map(m => (
                <TableRow key={m.id} data-mapping-id={m.id}>
                  <TableCell>
                    <Link to={`/mappings/${m.id}`} className="font-medium hover:underline">{`${m.entityLabel}（${m.entity}）`}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{`${m.sourceName} / ${m.table}`}</TableCell>
                  <TableCell className="space-x-1">
                    {m.published ? <Badge>{`已发布 v${m.published}`}</Badge> : <Badge variant="outline">未发布</Badge>}
                    {m.draft && <Badge variant="secondary">{`草稿 v${m.draft}`}</Badge>}
                  </TableCell>
                  <TableCell className={`text-sm whitespace-normal ${m.lastMerge && 'error' in m.lastMerge ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {mergeSummary(m.lastMerge)}
                  </TableCell>
                </TableRow>
              ))}
              {!mappings.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">还没有映射</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>新建映射</CardTitle>
            <CardDescription>
              一个映射把数据源里的一张表（须在同步范围内、已采集）对应到一个实体。字段表达式只能用白名单函数，
              值字典把源端枚举对应到标准枚举，dedupe 声明去重键与取最新字段。实体与字段说明见<Link to="/model" className="underline">标准模型</Link>。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="mapping-source">数据源</FieldLabel>
                  <NativeSelect id="mapping-source" name="sourceId" defaultValue={actionData?.values?.sourceId ?? sources[0]?.id}>
                    {sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>映射（YAML）</FieldLabel>
                  <MappingEditor defaultValue={actionData?.values?.yaml ?? template} />
                </Field>
                <div>
                  <Button type="submit" disabled={submitting || !sources.length}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
                </div>
              </FieldGroup>
            </Form>
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}

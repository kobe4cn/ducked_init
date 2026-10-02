// app/routes/mappings.tsx —— 映射（数据工程师、管理员可起草；分析师只读）：本租户的映射列表（源表 → 实体、已发布版本、草稿、最近一次合并），
// 新建映射（选数据源、编写 YAML，校验通过才保存为草稿；可按所选的表与实体按规则生成草稿填进编辑框，不保存；编辑框旁对照所选源表的列统计与目标实体的标准字段），
// 以及手动触发一次合并到标准层
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/mappings';
import { can, requirePermission } from '~/.server/access';
import { createMapping, draftFor, listMappings, MappingError, mergeNow, referenceTables } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { functionList } from '~/.server/pipeline/mapping-expr';
import { mappingTemplate } from '~/.server/pipeline/mapping-spec';
import { listSources } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { CANONICAL_ENTITIES, entityLabel, entityOf } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { MappingErrors } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { mappingOutline } from '~/lib/mapping-outline';
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
  const sources = (await listSources(member)).map(s => ({ id: s.id, name: s.name }));
  const canWrite = can(member.role, 'sources:write');
  return {
    email: member.email,
    nav: navFor(member),
    canWrite,
    sources,
    /** 各数据源可对照的源表（只有能新建映射时才给） */
    tables: canWrite ? Object.fromEntries(await Promise.all(sources.map(async s => [s.id, await referenceTables(member, s.id)] as const))) : {},
    template: mappingTemplate('order', 'orders'),
    functions: functionList(),
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
      case 'draft': {
        // 只生成、填进编辑框，不保存；draftId 让编辑框换成新内容
        const yaml = await draftFor(member, field('sourceId'), field('table'), field('entity'));
        return { error: null, issues: [], values: { sourceId: field('sourceId'), yaml }, draftId: crypto.randomUUID() };
      }
      case 'create': {
        const mapping = await createMapping(member, field('sourceId'), field('yaml'));
        throw redirect(`/mappings/${mapping.id}`);
      }
      case 'merge':
        await mergeNow(member);
        throw redirect('/mappings');
      default:
        return data({ error: '未知操作', issues: [], values: null, draftId: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MappingError) {
      return data({ error: e.message, issues: e.issues, values: { sourceId: field('sourceId'), yaml: field('yaml') }, draftId: null }, { status: e.status });
    }
    throw e;
  }
}

const TASK_VARIANTS = { none: 'outline', queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type LoaderData = Route.ComponentProps['loaderData'];
type LastMerge = LoaderData['mappings'][number]['lastMerge'];

/** 一个映射最近一次合并的结果 */
function mergeSummary(m: LastMerge) {
  if (!m) return '—';
  if ('error' in m) return `失败：${m.error}`;
  if ('skipped' in m) return `跳过：${m.skipped}`;
  return `第 ${m.version} 版，${m.rows.toLocaleString('zh-CN')} 行（新增 ${m.inserted}，更新 ${m.updated}，删除 ${m.deleted}）`;
}

export default function Mappings({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, sources, tables, template, functions, merge, mappings } = loaderData;
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
            <NewMapping
              key={actionData?.draftId ?? 'new'}
              sources={sources}
              tables={tables}
              functions={functions}
              values={actionData?.values ?? { sourceId: sources[0]?.id ?? '', yaml: template }}
              submitting={submitting}
            />
          </CardContent>
        </Card>
      )}
    </AppShell>
  );
}

/**
 * 新建映射的表单：选数据源、编写 YAML。表与目标实体两个下拉框决定旁边对照面板显示什么（默认取 YAML 里写的），
 * 也是「按规则生成草稿」的输入；保存时以 YAML 里写的为准
 */
function NewMapping({ sources, tables, functions, values, submitting }: {
  sources: LoaderData['sources'];
  tables: LoaderData['tables'];
  functions: LoaderData['functions'];
  values: { sourceId: string; yaml: string };
  submitting: boolean;
}) {
  const [sourceId, setSourceId] = useState(values.sourceId);
  const [outline] = useState(() => mappingOutline(values.yaml));
  const [tableName, setTableName] = useState(outline.table);
  const [entity, setEntity] = useState(outline.entity && entityOf(outline.entity) ? outline.entity : CANONICAL_ENTITIES[0].name);
  const sourceTables = tables[sourceId] ?? [];
  const table = sourceTables.find(t => t.name === tableName) ?? sourceTables[0] ?? null;
  return (
    <Form method="post">
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="mapping-source">数据源</FieldLabel>
            <NativeSelect id="mapping-source" name="sourceId" value={sourceId} onChange={e => setSourceId(e.target.value)}>
              {sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-table">表</FieldLabel>
            <NativeSelect id="mapping-table" name="table" value={table?.name ?? ''} onChange={e => setTableName(e.target.value)} disabled={!sourceTables.length}>
              {sourceTables.map(t => <NativeSelectOption key={t.name} value={t.name}>{t.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-entity">目标实体</FieldLabel>
            <NativeSelect id="mapping-entity" name="entity" value={entity} onChange={e => setEntity(e.target.value)}>
              {CANONICAL_ENTITIES.map(e => <NativeSelectOption key={e.name} value={e.name}>{`${e.label}（${e.name}）`}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel>映射（YAML）</FieldLabel>
          <MappingEditorWithReference defaultValue={values.yaml} table={table} entity={entity} functions={functions} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" name="intent" value="create" disabled={submitting || !sources.length}>{submitting ? '正在处理…' : '校验并保存草稿'}</Button>
          <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !table} title="按列名、类型与常见取值生成，替换编辑框里的内容；不会保存">
            按规则生成草稿
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

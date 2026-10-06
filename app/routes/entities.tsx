// app/routes/entities.tsx —— 自定义实体列表（ADR-0019）：租户在标准模型之外登记的实体，各自的中文名、类型、已发布版本与草稿。
// 数据工程师、管理员在这里新建（名称、中文名、类型、字段与主键，保存为第一版草稿，到详情页由另一位成员发布）；分析师只读。
// 没有实体时直接给出新建表单；?new=1 时在列表上方打开新建表单。已发布映射在用、但没登记的实体打开列表时推断出登记草稿，标为待确认。
// ?passthrough=1 时打开一键直通：选数据源和一张已采集的源表，一次生成登记草稿与恒等映射草稿，跳到实体详情页（passthrough.ts）
import { CheckCircle2, CircleAlert, PencilLine, Plus, Zap } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/entities';
import { can, requirePermission } from '~/.server/access';
import { createCustomEntity, CustomEntityError, customEntityInputOf, listCustomEntities } from '~/.server/custom-entities';
import { referenceTables } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { createPassthrough } from '~/.server/passthrough';
import { listSources } from '~/.server/sources';
import { AppShell } from '~/components/app-shell';
import { CustomEntityForm } from '~/components/custom-entity-form';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { CUSTOM_ENTITY_KINDS } from '~/lib/canonical-model';

export function meta() {
  return [{ title: '自定义实体 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const params = new URL(request.url).searchParams;
  const canWrite = can(member.role, 'sources:write');
  const passthrough = canWrite && params.has('passthrough');
  const sources = passthrough ? (await listSources(member)).map(s => ({ id: s.id, name: s.name })) : [];
  return {
    email: member.email,
    nav: navFor(member),
    canWrite,
    creating: params.has('new'),
    passthrough,
    entities: await listCustomEntities(member),
    /** 一键直通可选的数据源，与各数据源已采集的源表名（只在打开一键直通时才给） */
    sources,
    tables: Object.fromEntries(await Promise.all(sources.map(async s => [s.id, (await referenceTables(member, s.id)).filter(t => !t.view).map(t => t.name)] as const))),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  if (field('intent') === 'passthrough') {
    const picked = { sourceId: field('sourceId'), table: field('table'), name: field('name').trim() };
    try {
      const { entityId } = await createPassthrough(await requirePermission(request, 'sources:write'), picked.sourceId, picked.table, picked.name);
      throw redirect(`/entities/${entityId}`);
    } catch (e) {
      if (e instanceof CustomEntityError) return data({ error: e.message, input: null, passthrough: picked }, { status: e.status });
      throw e;
    }
  }
  const input = customEntityInputOf(form);
  if (field('intent') !== 'create') return data({ error: '未知操作', input: null, passthrough: null }, { status: 400 });
  try {
    const id = await createCustomEntity(await requirePermission(request, 'sources:write'), input);
    throw redirect(`/entities/${id}`);
  } catch (e) {
    if (e instanceof CustomEntityError) return data({ error: e.message, input, passthrough: null }, { status: e.status });
    throw e;
  }
}

export default function Entities({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, creating, passthrough, entities, sources, tables } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const showPassthrough = canWrite && (passthrough || !!actionData?.passthrough);
  const showForm = canWrite && !showPassthrough && (creating || !entities.length || !!actionData);
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="自定义实体"
        description="标准模型之外、本租户自己登记的实体：名称以 custom_ 开头，映射可以写到它。登记的草稿需由另一位数据工程师或管理员发布。"
        actions={canWrite && (
          <>
            {!showPassthrough && <Button asChild variant="outline"><Link to="/entities?passthrough=1"><Zap />从源表一键生成</Link></Button>}
            {!showForm && <Button asChild><Link to="/entities?new=1"><Plus />新建自定义实体</Link></Button>}
          </>
        )}
      />
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{actionData.passthrough ? '没有生成' : '未保存'}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {showPassthrough && (
        <section className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-1 font-semibold">从源表一键生成</h2>
          <p className="mb-4 max-w-2xl text-sm text-slate-500">
            选一张已采集的源表，生成实体的登记草稿（实体名留空时为 custom_&lt;表名&gt;，别的数据源已有同名表时另填一个）（每列一个字段，类型与敏感标记取自源列，主键取源表主键或声明的业务主键）和覆盖全部列的映射草稿。两份草稿都需由另一位数据工程师或管理员发布。
          </p>
          <PassthroughForm sources={sources} tables={tables} values={actionData?.passthrough ?? null} submitting={submitting} />
        </section>
      )}
      {showForm && (
        <section className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-1 font-semibold">新建自定义实体</h2>
          {!entities.length && <p className="mb-4 max-w-2xl text-sm text-slate-500">还没有自定义实体。登记名称、字段与主键，保存为第一版草稿。</p>}
          <CustomEntityForm intent="create" values={actionData?.input} submitting={submitting} submitLabel="保存草稿" />
        </section>
      )}
      {!entities.length && !canWrite && (
        <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">还没有自定义实体。数据工程师或管理员可以在这里登记。</div>
      )}
      {!!entities.length && (
        <div className="overflow-x-auto rounded-2xl border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>中文名</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>已发布</TableHead>
                <TableHead>草稿</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map(e => (
                <TableRow key={e.id} data-custom-entity={e.name}>
                  <TableCell><Link to={`/entities/${e.id}`} className="font-mono font-semibold hover:underline">{e.name}</Link></TableCell>
                  <TableCell>{e.label}</TableCell>
                  <TableCell className="text-sm">{CUSTOM_ENTITY_KINDS[e.kind]}</TableCell>
                  <TableCell className="text-sm">{e.published ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-3.5" />{`已发布 v${e.published}`}</span> : <span className="text-slate-400">—</span>}</TableCell>
                  <TableCell className="text-sm">{e.draft ? <span className="inline-flex items-center gap-1 text-amber-600" data-inferred={e.inferred || undefined}><PencilLine className="size-3.5" />{e.inferred ? `推断登记 · 待确认 v${e.draft}` : `草稿 v${e.draft}`}</span> : <span className="text-slate-400">—</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </AppShell>
  );
}

/** 一键直通的表单：数据源下拉决定表下拉列哪些已采集的源表 */
function PassthroughForm({ sources, tables, values, submitting }: {
  sources: { id: string; name: string }[];
  tables: Record<string, string[]>;
  values: { sourceId: string; table: string; name: string } | null;
  submitting: boolean;
}) {
  const [sourceId, setSourceId] = useState(values?.sourceId ?? sources[0]?.id ?? '');
  const sourceTables = tables[sourceId] ?? [];
  if (!sources.length) return <p className="text-sm text-slate-500">还没有数据源。先到「数据源」登记并采集，再回来生成。</p>;
  return (
    <Form method="post" action="/entities?passthrough=1">
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="passthrough-source">数据源</FieldLabel>
            <NativeSelect id="passthrough-source" name="sourceId" value={sourceId} onChange={e => setSourceId(e.target.value)}>
              {sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="passthrough-table">源表</FieldLabel>
            <NativeSelect id="passthrough-table" name="table" key={sourceId} defaultValue={values?.sourceId === sourceId ? values.table : undefined} disabled={!sourceTables.length}>
              {sourceTables.map(t => <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        <Field className="sm:max-w-sm">
          <FieldLabel htmlFor="passthrough-name">实体名（可选）</FieldLabel>
          <Input id="passthrough-name" name="name" className="font-mono" placeholder="custom_<表名>" defaultValue={values?.name ?? ''} />
        </Field>
        {!sourceTables.length && <p className="text-sm text-slate-500">这个数据源还没有已采集的源表。</p>}
        <div className="flex gap-2">
          <Button type="submit" name="intent" value="passthrough" disabled={submitting || !sourceTables.length}>{submitting ? '正在生成…' : '生成登记与映射草稿'}</Button>
          <Button asChild variant="outline"><Link to="/entities">取消</Link></Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

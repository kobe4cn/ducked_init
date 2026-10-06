// app/routes/entities.tsx —— 自定义实体列表（ADR-0019）：租户在标准模型之外登记的实体，各自的中文名、类型、已发布版本与草稿。
// 数据工程师、管理员在这里新建（名称、中文名、类型、字段与主键，保存为第一版草稿，到详情页由另一位成员发布）；分析师只读。
// 没有实体时直接给出新建表单；?new=1 时在列表上方打开新建表单。已发布映射在用、但没登记的实体打开列表时推断出登记草稿，标为待确认
import { CheckCircle2, CircleAlert, PencilLine, Plus } from 'lucide-react';
import { data, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/entities';
import { can, requirePermission } from '~/.server/access';
import { createCustomEntity, CustomEntityError, customEntityInputOf, listCustomEntities } from '~/.server/custom-entities';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { CustomEntityForm } from '~/components/custom-entity-form';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { CUSTOM_ENTITY_KINDS } from '~/lib/canonical-model';

export function meta() {
  return [{ title: '自定义实体 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    creating: new URL(request.url).searchParams.has('new'),
    entities: await listCustomEntities(member),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const input = customEntityInputOf(form);
  if (form.get('intent') !== 'create') return data({ error: '未知操作', input: null }, { status: 400 });
  try {
    const id = await createCustomEntity(await requirePermission(request, 'sources:write'), input);
    throw redirect(`/entities/${id}`);
  } catch (e) {
    if (e instanceof CustomEntityError) return data({ error: e.message, input }, { status: e.status });
    throw e;
  }
}

export default function Entities({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, creating, entities } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const showForm = canWrite && (creating || !entities.length || !!actionData);
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="自定义实体"
        description="标准模型之外、本租户自己登记的实体：名称以 custom_ 开头，映射可以写到它。登记的草稿需由另一位数据工程师或管理员发布。"
        actions={canWrite && !showForm && <Button asChild><Link to="/entities?new=1"><Plus />新建自定义实体</Link></Button>}
      />
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>未保存</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
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

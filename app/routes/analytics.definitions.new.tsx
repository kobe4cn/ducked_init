// app/routes/analytics.definitions.new.tsx —— 新建指标（有起草权限的成员）：填写键与 YAML，校验通过后保存为第 1 版草稿并转到定义页；
// 键不合规或已被占用、YAML 校验不通过时留在本页，按行列列出问题（ADR-0025）
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.new';
import { requirePermission } from '~/.server/access';
import { createDefinition, DslError } from '~/.server/dsl-definitions';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { PageHeader } from '~/components/page-header';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta() {
  return [{ title: '新建指标 · CRM 数据分析平台' }];
}

const EXAMPLE = `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, completed] }
window: { field: created_at, days: 30 }
dimensions:
  - name: city
    path: order.customer_id -> customer.city
`;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  return { email: member.email, nav: navFor(member) };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const form = await request.formData();
  const key = String(form.get('key') ?? '').trim();
  const yaml = String(form.get('yaml') ?? '');
  try {
    await createDefinition(member, 'metric', key, yaml);
  } catch (e) {
    if (e instanceof DslError) return data({ error: e.message, issues: e.issues, key, yaml }, { status: e.status });
    throw e;
  }
  throw redirect(`/analytics/definitions/metric/${key}`);
}

export default function NewDefinition({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="新建指标"
        description={<><Link to="/analytics" className="hover:underline">← 分析</Link>　保存后成为第 1 版草稿，由另一位有发布权限的成员发布</>}
      />

      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <Form method="post">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="key">键</FieldLabel>
              <Input id="key" name="key" required defaultValue={actionData?.key ?? ''} placeholder="如 revenue_30d" className="max-w-sm font-mono" />
              <FieldDescription>小写字母开头，只用小写字母、数字与下划线；建好后不能改。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>定义（YAML）</FieldLabel>
              <MappingEditor key={actionData?.yaml ?? 'example'} defaultValue={actionData?.yaml ?? EXAMPLE} />
            </Field>
            <div>
              <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>
    </AppShell>
  );
}

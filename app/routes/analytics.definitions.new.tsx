// app/routes/analytics.definitions.new.tsx —— 新建指标或标签（有起草权限的成员）：种类放在 URL（?kind=metric|tag，默认指标），
// 填写键与 YAML，校验通过后保存为第 1 版草稿并转到定义页；键不合规或已被占用、YAML 校验不通过时留在本页，按行列列出问题（ADR-0025）
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.new';
import { requirePermission } from '~/.server/access';
import { createDefinition, DslError } from '~/.server/dsl-definitions';
import { DSL_KINDS, isDslKind, type DslKind } from '~/.server/pipeline/dsl';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `新建${loaderData?.label ?? '定义'} · CRM 数据分析平台` }];
}

/** 各种定义在新建页上的键示例与 YAML 示例；名称取注册表 */
const EXAMPLES: Record<DslKind, { placeholder: string; example: string }> = {
  metric: {
    placeholder: '如 revenue_30d',
    example: `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, completed] }
window: { field: created_at, days: 30 }
dimensions:
  - name: city
    path: order.customer_id -> customer.city
`,
  },
  tag: {
    placeholder: '如 value_tier',
    example: `# 引用一个已发布、没有维度的指标；规则按顺序取第一条命中的，都没命中取 default
metric: revenue_30d
rules:
  - value: high
    when: { gte: 1000 }
  - value: mid
    when: { gte: 100, lt: 1000 }
default: low
`,
  },
};

function kindOf(value: string | null): DslKind {
  const kind = value ?? 'metric';
  if (!isDslKind(kind)) throw data(`没有 ${kind} 这种定义`, { status: 404 });
  return kind;
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const kind = kindOf(new URL(request.url).searchParams.get('kind'));
  return {
    email: member.email, nav: navFor(member), kind, label: DSL_KINDS[kind].label,
    kinds: (Object.keys(DSL_KINDS) as DslKind[]).map(k => ({ key: k, label: DSL_KINDS[k].label })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const form = await request.formData();
  const kind = kindOf(form.get('kind') as string | null);
  const key = String(form.get('key') ?? '').trim();
  const yaml = String(form.get('yaml') ?? '');
  try {
    await createDefinition(member, kind, key, yaml);
  } catch (e) {
    if (e instanceof DslError) return data({ error: e.message, issues: e.issues, key, yaml }, { status: e.status });
    throw e;
  }
  throw redirect(`/analytics/definitions/${kind}/${key}`);
}

export default function NewDefinition({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, kind, label, kinds } = loaderData;
  const { placeholder, example } = EXAMPLES[kind];
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`新建${label}`}
        description={<><Link to="/analytics" className="hover:underline">← 分析</Link>　保存后成为第 1 版草稿，由另一位有发布权限的成员发布</>}
      />

      <PillTabs
        current={kind}
        tabs={kinds.map(k => ({ ...k, href: `/analytics/definitions/new?kind=${k.key}` }))}
      />

      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <Form method="post">
          <input type="hidden" name="kind" value={kind} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="key">键</FieldLabel>
              <Input id="key" name="key" required defaultValue={actionData?.key ?? ''} placeholder={placeholder} className="max-w-sm font-mono" />
              <FieldDescription>小写字母开头，只用小写字母、数字与下划线；建好后不能改。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>定义（YAML）</FieldLabel>
              <MappingEditor key={actionData?.yaml ?? `example-${kind}`} defaultValue={actionData?.yaml ?? example} />
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

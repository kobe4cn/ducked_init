// app/routes/analytics.definitions.new.tsx —— 新建指标或标签（有起草权限的成员）：种类放在 URL（?kind=metric|tag，默认指标），
// 填写键与 YAML，校验通过后保存为第 1 版草稿并转到定义页；键不合规或已被占用、YAML 校验不通过时留在本页，按行列列出问题（ADR-0025）。
// 可以写下需求后用模型生成草稿（intent=model-draft，ADR-0035）：生成的 YAML 填进编辑框、不保存，失败时编辑框保持原内容
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.new';
import { requirePermission } from '~/.server/access';
import { createDefinition, DslError, modelDraftForDefinition } from '~/.server/dsl-definitions';
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

/** 各种定义在新建页上的键示例、YAML 示例、需求示例与生成时发给模型的内容；名称取注册表 */
const EXAMPLES: Record<DslKind, { placeholder: string; example: string; request: string; sends: string }> = {
  metric: {
    placeholder: '如 revenue_30d',
    request: '如：近 30 天每个城市已支付订单的金额合计',
    sends: '本租户实体的非敏感字段、关系',
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
    request: '如：近 30 天消费满 1000 的是高价值客户，满 100 的是中等，其余为普通',
    sends: '本租户已发布、没有维度的数值型指标的键、说明与度量',
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
  const requirement = String(form.get('request') ?? '');
  try {
    if (form.get('intent') === 'model-draft') {
      const generated = await modelDraftForDefinition(member, kind, requirement);
      return { error: null, issues: [], key, yaml: generated.yaml, request: requirement, generated: true };
    }
    await createDefinition(member, kind, key, yaml);
  } catch (e) {
    if (e instanceof DslError) return data({ error: e.message, issues: e.issues, key, yaml, request: requirement, generated: false }, { status: e.status });
    throw e;
  }
  throw redirect(`/analytics/definitions/${kind}/${key}`);
}

export default function NewDefinition({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, kind, label, kinds } = loaderData;
  const { placeholder, example, request, sends } = EXAMPLES[kind];
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
              <FieldLabel htmlFor="request">需求</FieldLabel>
              <textarea
                id="request" name="request" rows={3} defaultValue={actionData?.request ?? ''}
                placeholder={request}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <FieldDescription>用自然语言写下要算什么，点「用模型生成草稿」：会把需求与{sends}发给模型服务，生成的定义替换编辑框里的内容，不会保存。</FieldDescription>
              <div>
                <Button type="submit" name="intent" value="model-draft" variant="outline" formNoValidate disabled={submitting}>用模型生成草稿</Button>
              </div>
            </Field>
            {actionData?.generated && <p className="text-sm text-muted-foreground" data-generated>已用模型生成草稿，请核对后填写键并保存。</p>}
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

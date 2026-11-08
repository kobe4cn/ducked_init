// app/routes/analytics.definitions.new.tsx —— 新建指标或标签（有起草权限的成员）：种类放在 URL（?kind=metric|tag，默认指标），
// 填写键与 YAML，校验通过后保存为第 1 版草稿并转到定义页；键不合规或已被占用、YAML 校验不通过时留在本页，按行列列出问题（ADR-0025）。
// 指标还可以用条件构建器（?mode=builder|yaml，默认构建器；标签只有 YAML）：选实体与字段拼出表单，「检查」只编译给出四句摘要与 SQL、不保存，
// 保存仍走同一套校验与双人发布。构建器模式下表单只提交键、intent 与隐藏字段 form（MetricForm 的 JSON），字段表不信客户端，服务端按
// form.base 用 fieldsFor 重取（敏感字段已剔除，ADR-0005）再 formToYaml 成 YAML——与手写 YAML 走完全一样的路（ADR-0017）。
// 可以写下需求后用模型生成草稿（intent=model-draft，ADR-0035）：生成的 YAML 填进编辑框、不保存，失败时编辑框保持原内容
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.new';
import { requirePermission } from '~/.server/access';
import { publishedCustomEntities } from '~/.server/custom-entities';
import { createDefinition, DslError, dslContext, modelDraftForDefinition } from '~/.server/dsl-definitions';
import { DSL_KINDS, isDslKind, type DslKind } from '~/.server/pipeline/dsl';
import { checkMetric, compileMetric, fieldsFor } from '~/.server/pipeline/dsl/metric-spec';
import { getDb } from '~/.server/db/client';
import { todayUtc } from '~/.server/templates';
import { CANONICAL_ENTITIES, entityOf, type FieldType } from '~/lib/canonical-model';
import { formToYaml, summarize, yamlToForm, type FormField, type MetricForm } from '~/lib/metric-form';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { formOfEcho, MetricBuilder, type BuilderEntity } from '~/components/metric-builder';
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

/** 字段表补中文名（标准模型里有 label；自定义实体的字段没有，就用字段名），loader 的下拉与 action 的摘要是同一份 */
function labelledFields(base: string, fields: readonly { name: string; type: FieldType; enum?: readonly string[] }[]): FormField[] {
  const canonical = entityOf(base)?.fields;
  return fields.map(f => ({ ...f, label: canonical?.find(c => c.name === f.name)?.label ?? f.name }));
}

/**
 * 构建器隐藏字段 form（MetricForm 的 JSON）→ 表单状态：只收构建器有的控件（dimensions、readonly 一律为空），
 * 没选字段的条件行丢掉；读不出来（不是 JSON、没有 base）按业务错误 400。字段是否可用不在这里判断，交给 checkMetric
 */
function builderFormOf(text: string): MetricForm {
  let v: Partial<MetricForm> = {};
  try { v = JSON.parse(text) as Partial<MetricForm>; } catch { /* 按没有 base 处理 */ }
  if (typeof v.base !== 'string' || v.base === '') throw new DslError('构建器的内容读不出来，请刷新页面重试');
  return {
    base: v.base,
    agg: v.agg ?? 'count',
    field: v.field || undefined,
    by: v.by || undefined,
    ...(v.agg === 'ratio' ? { numerator: v.numerator, denominator: v.denominator } : {}),
    filter: (Array.isArray(v.filter) ? v.filter : []).filter(c => !!c && typeof c.field === 'string' && c.field !== ''),
    window: v.window && typeof v.window.field === 'string' && v.window.field !== '' && typeof v.window.days === 'number' ? v.window : undefined,
    dimensions: [],
    readonly: [],
  };
}

/** 指标构建器可选的基础实体：标准实体与已发布的自定义实体，字段取 fieldsFor（undefined 不列出）；不做 consumerHop 过滤，不能做基础实体的交给检查报错 */
function builderEntities(
  published: Iterable<{ name: string }>,
  registered: ReadonlyMap<string, { label: string }>,
  ctx: Awaited<ReturnType<typeof dslContext>>,
): BuilderEntity[] {
  // 自定义实体的中文名取已发布的登记（dslContext 里的是校验用的子集，没有 label）
  const named = [...CANONICAL_ENTITIES.map(e => ({ name: e.name, label: e.label })), ...[...published].map(e => ({ name: e.name, label: registered.get(e.name)?.label ?? e.name }))];
  return named.flatMap(({ name, label }) => {
    const fields = fieldsFor(name, ctx);
    return fields ? [{ name, label: label || name, fields: labelledFields(name, fields) }] : [];
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const url = new URL(request.url);
  const kind = kindOf(url.searchParams.get('kind'));
  // 指标的编辑模式放在 URL（&mode=builder|yaml，默认构建器）；标签只有 YAML，不显示切换
  const mode = kind === 'metric' && url.searchParams.get('mode') === 'yaml' ? 'yaml' : 'builder';
  let entities: BuilderEntity[] | undefined;
  if (kind === 'metric') {
    const ctx = await dslContext(getDb(), member.tenant.id);
    entities = builderEntities(ctx.published.values(), await publishedCustomEntities(getDb(), member.tenant.id), ctx);
  }
  return {
    email: member.email, nav: navFor(member), kind, label: DSL_KINDS[kind].label,
    kinds: (Object.keys(DSL_KINDS) as DslKind[]).map(k => ({ key: k, label: DSL_KINDS[k].label })),
    mode, entities,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const form = await request.formData();
  const kind = kindOf(form.get('kind') as string | null);
  const key = String(form.get('key') ?? '').trim();
  const yamlInput = String(form.get('yaml') ?? '');
  const requirement = String(form.get('request') ?? '');
  const intent = form.get('intent');
  /** 构建器模式：隐藏字段 form 是 MetricForm 的 JSON（YAML 模式不提交它） */
  const builder = kind === 'metric' && form.has('form') ? String(form.get('form')) : undefined;
  const keep = { key, request: requirement, generated: false, form: builder };
  let yaml = yamlInput;
  try {
    if (intent === 'model-draft') {
      const generated = await modelDraftForDefinition(member, kind, requirement);
      return { error: null, issues: [], yaml: generated.yaml, summary: null, sql: null, ...keep, generated: true };
    }
    if (kind === 'metric' && (intent === 'check' || builder !== undefined)) {
      const ctx = await dslContext(getDb(), member.tenant.id);
      const formState = builder !== undefined ? builderFormOf(builder) : yamlToForm(yaml, []);
      const fields = fieldsFor(formState.base, ctx);
      if (builder !== undefined && fields === undefined) throw new DslError(`${formState.base} 不能用作基础实体`);
      const labelled = fields ? labelledFields(formState.base, fields) : [];
      if (builder !== undefined) yaml = formToYaml(formState, labelled);
      if (intent === 'check') {
        const result = checkMetric(yaml, ctx);
        if (!result.ok) return data({ error: `指标定义有 ${result.issues.length} 个问题`, issues: result.issues, yaml, summary: null, sql: null, ...keep }, { status: 400 });
        // 只编译、不碰数据湖；摘要给四句（ratio）或三句
        return { error: null, issues: [], yaml, summary: summarize(formState, labelled), sql: compileMetric(result.spec, ctx, todayUtc()), ...keep };
      }
    }
    await createDefinition(member, kind, key, yaml);
  } catch (e) {
    if (e instanceof DslError) return data({ error: e.message, issues: e.issues, yaml, summary: null, sql: null, ...keep }, { status: e.status });
    throw e;
  }
  throw redirect(`/analytics/definitions/${kind}/${key}`);
}

export default function NewDefinition({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, kind, label, kinds, mode, entities } = loaderData;
  const { placeholder, example, request, sends } = EXAMPLES[kind];
  const submitting = useNavigation().state === 'submitting';
  // 指标在构建器与 YAML 间切换（切换不带内容过去：新建页不做 YAML → 构建器的转换）；标签只有 YAML
  const builder = kind === 'metric' && mode !== 'yaml';
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
      {kind === 'metric' && (
        <PillTabs
          current={builder ? 'builder' : 'yaml'}
          tabs={[
            { key: 'builder', label: '构建器', href: '/analytics/definitions/new?kind=metric&mode=builder' },
            { key: 'yaml', label: 'YAML', href: '/analytics/definitions/new?kind=metric&mode=yaml' },
          ]}
        />
      )}

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
            {builder ? (
              <MetricBuilder entities={entities ?? []} defaultForm={formOfEcho(actionData?.form)} />
            ) : (
              <>
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
              </>
            )}
            <div className="flex gap-2">
              {kind === 'metric' && <Button type="submit" name="intent" value="check" variant="outline" formNoValidate disabled={submitting}>检查</Button>}
              <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
            </div>
            {actionData?.summary && (
              <Field>
                <FieldLabel>摘要（确认这就是要算的口径）</FieldLabel>
                <ul data-summary className="list-disc space-y-0.5 pl-5 text-sm text-slate-600">
                  {actionData.summary.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </Field>
            )}
            {builder && actionData?.yaml && (
              <Field>
                <FieldLabel>生成的 YAML</FieldLabel>
                <pre data-generated-yaml className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-sm whitespace-pre-wrap">{actionData.yaml}</pre>
                <FieldDescription>构建器按这份 YAML 校验与保存，问题里的行列号也指向它（ADR-0017：YAML 仍是唯一格式）。</FieldDescription>
              </Field>
            )}
            {actionData?.sql && (
              <Field>
                <FieldLabel>编译出的 SQL（只编译，不跑数据湖）</FieldLabel>
                <pre data-compiled-sql className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-sm whitespace-pre-wrap">{actionData.sql}</pre>
              </Field>
            )}
          </FieldGroup>
        </Form>
      </div>
    </AppShell>
  );
}

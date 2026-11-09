// app/routes/analytics.definitions.new.tsx —— 新建指标或标签（有起草权限的成员）：种类放在 URL（?kind=metric|tag，默认指标），
// 填写键与 YAML，校验通过后保存为第 1 版草稿并转到定义页；键不合规或已被占用、YAML 校验不通过时留在本页，按行列列出问题（ADR-0025）。
// 指标还可以用条件构建器（?mode=builder|yaml，默认构建器；标签只有 YAML）：选实体与字段拼出表单，「检查」只编译给出四句摘要与 SQL、不保存，
// 保存仍走同一套校验与双人发布。构建器模式下表单只提交键、intent 与隐藏字段 form（MetricForm 的 JSON），字段表不信客户端，服务端按
// form.base 用 fieldsFor 重取（敏感字段已剔除，ADR-0005）再 formToYaml 成 YAML——与手写 YAML 走完全一样的路（ADR-0017）。
// 可以写下需求后用模型生成草稿（intent=model-draft，ADR-0035）：生成的 YAML 填进编辑框、不保存，失败时编辑框保持原内容
// 构建器模式还能写一句话解析（intent=parse，#517）：parseMetricSentence 把句子解析成表单填进构建器并逐项说明，
// 已有内容时先列出差异（intent=applyParse 确认后才覆盖），解析失败时表单保持原样
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.definitions.new';
import { requirePermission } from '~/.server/access';
import { publishedCustomEntities } from '~/.server/custom-entities';
import { createDefinition, DslError, dslContext, modelDraftForDefinition } from '~/.server/dsl-definitions';
import { MetricParseError, parseMetricSentence } from '~/.server/metric-parse';
import { DSL_KINDS, isDslKind, type DslKind } from '~/.server/pipeline/dsl';
import { checkMetric, compileMetric, fieldsFor } from '~/.server/pipeline/dsl/metric-spec';
import { getDb } from '~/.server/db/client';
import { todayUtc } from '~/.server/templates';
import { CANONICAL_ENTITIES, entityOf, type FieldType } from '~/lib/canonical-model';
import { diffForms, formToYaml, summarize, yamlToForm, type Cond, type FormField, type MetricForm, type RatioForm } from '~/lib/metric-form';
import { AGGS, RATIO_AGGS } from '~/lib/metric-vocab';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { formOfEcho, MetricBuilder, type BuilderEntity } from '~/components/metric-builder';
import { MetricParsePanel } from '~/components/metric-parse-panel';
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

/** 字符串或 undefined：客户端传来的其他类型一律当没填 */
function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** 条件行：只留 field、op 都是非空字符串，且 value 是 undefined、字符串或字符串数组的行；op 是否合法交给 checkMetric */
function condsOf(v: unknown): Cond[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): Cond[] => {
    if (!c || typeof c !== 'object') return [];
    const { field, op, value } = c as Record<string, unknown>;
    if (strOf(field) === undefined || strOf(op) === undefined) return [];
    const okValue = value === undefined || typeof value === 'string' || (Array.isArray(value) && value.every(x => typeof x === 'string'));
    if (!okValue) return [];
    return [{ field: field as string, op: op as Cond['op'], ...(value !== undefined ? { value: value as string | string[] } : {}) }];
  });
}

/** 分子 / 分母：不是对象当 undefined；agg 必须是字符串（是否合法交给 checkMetric），field 取字符串，filter 不是数组当空 */
function ratioOf(v: unknown): RatioForm | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.agg !== 'string') return undefined;
  return { agg: r.agg as RatioForm['agg'], field: strOf(r.field), filter: condsOf(r.filter) };
}

/**
 * 构建器隐藏字段 form（MetricForm 的 JSON）→ 表单状态：只收构建器有的控件（dimensions、readonly 一律为空），
 * 不信客户端：每一层都按类型规整，读不出来的条件行丢掉；没有 base、ratio 缺分子或分母按业务错误 400。字段、运算是否可用不在这里判断，交给 checkMetric
 */
function builderFormOf(text: string): MetricForm {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { /* 按没有 base 处理 */ }
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const base = strOf(v.base);
  if (base === undefined) throw new DslError('构建器的内容读不出来，请刷新页面重试');
  const agg = (typeof v.agg === 'string' ? v.agg : 'count') as MetricForm['agg'];
  const parts = agg === 'ratio' ? { numerator: ratioOf(v.numerator), denominator: ratioOf(v.denominator) } : undefined;
  // ratio 缺分子或分母：formToYaml 会默认补成 count，等于替客户端猜了一半，按读不出来处理
  if (parts && (parts.numerator === undefined || parts.denominator === undefined)) throw new DslError('构建器的内容读不出来：比例要有分子和分母，请刷新页面重试');
  const w = v.window && typeof v.window === 'object' ? (v.window as Record<string, unknown>) : undefined;
  return {
    base,
    agg,
    field: strOf(v.field),
    by: strOf(v.by),
    ...parts,
    filter: condsOf(v.filter),
    window: w && strOf(w.field) !== undefined && typeof w.days === 'number' ? { field: w.field as string, days: w.days } : undefined,
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

/** 回显用的表单：聚合在词表外就不回显——构建器的控件只认合法聚合（词表外的聚合仍进生成的 YAML、由检查按 measure.agg 报出，不替客户端猜成别的聚合） */
function echoable(form: MetricForm): string | undefined {
  const parts = form.agg === 'ratio' ? [form.numerator, form.denominator] : [];
  return AGGS.includes(form.agg) && parts.every(p => p !== undefined && RATIO_AGGS.includes(p.agg)) ? JSON.stringify(form) : undefined;
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
  /** 一句话解析的句子（构建器模式的「一句话」框；YAML 模式的需求框是 request，两边各回显各的） */
  const sentence = String(form.get('sentence') ?? '');
  /** 构建器模式：隐藏字段 form 是 MetricForm 的 JSON（YAML 模式不提交它） */
  const builder = kind === 'metric' && form.has('form') ? String(form.get('form')) : undefined;
  /** 回显给构建器的是服务端规整过的表单，不原样回传客户端的内容（读不出来、聚合在词表外就不回显） */
  const echo = builder === undefined ? undefined : (() => { try { return echoable(builderFormOf(builder)); } catch { return undefined; } })();
  /** 各分支共有的回显；parse / parsed / diff 只在 intent=parse 的应答里有，这里占位让组件能统一读 */
  const keep = { key, request: requirement, generated: false, form: echo, sentence, parse: undefined, parsed: undefined, diff: undefined };
  let yaml = yamlInput;
  try {
    if (intent === 'model-draft') {
      const generated = await modelDraftForDefinition(member, kind, requirement);
      return { error: null, issues: [], yaml: generated.yaml, summary: null, sql: null, ...keep, generated: true };
    }
    if (kind === 'metric' && intent === 'parse') {
      const parsed = await parseMetricSentence(member, sentence);
      // 解析出的表单先 JSON.stringify 再过 builderFormOf 规整（构建器不收 dimensions / readonly），再过 echoable（聚合在词表外构建器显示不了）
      const normalized = builderFormOf(JSON.stringify(parsed.form));
      const shown = echoable(normalized);
      if (shown === undefined) throw new DslError('解析结果构建器显示不了', 422);
      const parse = {
        items: parsed.items, unknowns: parsed.unknowns, unsupported: parsed.unsupported,
        // 构建器没有维度控件，builderFormOf 把 dimensions / readonly 都清空了：维度的名字显式提示，不能悄悄丢
        // （单段路径的维度在 form.dimensions，多跳或 as_of 的在 readonly 里、key 是 dimensions.N、raw 是原维度对象）
        dropped: [
          ...parsed.form.dimensions.map(d => d.name),
          ...parsed.form.readonly.flatMap(r => {
            const raw = /^dimensions\.\d+$/.test(r.key) && r.raw && typeof r.raw === 'object' && !Array.isArray(r.raw) ? (r.raw as { name?: unknown }).name : undefined;
            return typeof raw === 'string' ? [raw] : [];
          }),
        ],
      };
      // 当前构建器有内容（选了基础实体）才比差异；摘要的中文名按解析结果的基础实体取（换实体时旧字段名对不上就显示字段名）
      let current: MetricForm | undefined;
      if (builder !== undefined) { try { current = builderFormOf(builder); } catch { current = undefined; } }
      const diff = current === undefined ? [] : diffForms(
        current, normalized,
        labelledFields(normalized.base, fieldsFor(normalized.base, await dslContext(getDb(), member.tenant.id)) ?? []),
      );
      // 构建器是空的或解析结果与当前内容一样：直接填入；否则先列出差异等成员确认（form 仍是当前内容）
      return diff.length === 0
        ? { error: null, issues: [], yaml, summary: null, sql: null, ...keep, form: shown, parse }
        : { error: null, issues: [], yaml, summary: null, sql: null, ...keep, parsed: shown, diff, parse };
    }
    if (kind === 'metric' && intent === 'applyParse') {
      // 确认覆盖：读隐藏字段 parsed（parse 应答里那份 JSON），同样不信客户端，过一遍规整再回显
      let shown: string | undefined;
      try { shown = echoable(builderFormOf(String(form.get('parsed') ?? ''))); } catch { /* 按读不出来处理 */ }
      if (shown === undefined) throw new DslError('解析结果读不出来，请重新点「解析一句话」');
      return { error: null, issues: [], yaml, summary: null, sql: null, ...keep, form: shown };
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
    // MetricParseError（空句 / 超长 400、未配置模型服务 409、模型失败或不过校验 422）不是 DslError，不补会变成 500；表单保持原样
    if (e instanceof DslError || e instanceof MetricParseError) return data({ error: e.message, issues: e.issues ?? [], yaml, summary: null, sql: null, ...keep }, { status: e.status });
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
              <>
                <Field>
                  <FieldLabel htmlFor="sentence">一句话</FieldLabel>
                  <textarea
                    id="sentence" name="sentence" rows={2} defaultValue={actionData?.sentence ?? ''}
                    placeholder={request}
                    className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  <FieldDescription>写下要算什么，点「解析一句话」：会把这句话与{sends}发给模型服务，解析结果填进下面的构建器并逐项说明，不会保存；构建器已有内容时先列出差异，确认后才覆盖。</FieldDescription>
                  <div>
                    <Button type="submit" name="intent" value="parse" variant="outline" formNoValidate disabled={submitting}>解析一句话</Button>
                  </div>
                </Field>
                {actionData?.parse && <MetricParsePanel parse={actionData.parse} diff={actionData.diff} />}
                {actionData?.parsed && (
                  <div className="flex items-center gap-2">
                    {/* parse 应答里那份解析结果 JSON，确认覆盖时原样提交（服务端仍会规整，不信客户端） */}
                    <input type="hidden" name="parsed" value={actionData.parsed} />
                    <Button type="submit" name="intent" value="applyParse" variant="outline" formNoValidate disabled={submitting}>确认覆盖</Button>
                    <span className="text-sm text-slate-500">把构建器当前内容换成解析出的表单。</span>
                  </div>
                )}
                {/* MetricBuilder 的 useState 只在挂载时初始化，不换 key 时开着 JS 填不进解析结果 */}
                <MetricBuilder key={actionData?.form ?? 'empty'} entities={entities ?? []} defaultForm={formOfEcho(actionData?.form)} />
              </>
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

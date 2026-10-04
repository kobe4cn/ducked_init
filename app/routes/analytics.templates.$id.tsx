// app/routes/analytics.templates.$id.tsx —— 分析模板参数（有定义查看权限的成员）：RFM 的回看天数、计入的订单状态、分箱方式（五分位或固定阈值）与分群规则表。
// 有起草权限的成员保存草稿（参数不合法时报错）、丢弃草稿；草稿由最后保存它的人以外的另一位有发布权限的成员发布（ADR-0015），
// 发布后以新参数入队一次 RFM 计算，产出的快照记下定义版本。没有已发布版本时生效的是模板的默认参数
import { CheckCircle2, Lock, PencilLine, Plus, Trash2, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.templates.$id';
import { can, deniedReason, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import type { RfmDefinition, ScoreRange, SegmentRule } from '~/.server/pipeline/templates/rfm';
import { TaskError } from '~/.server/tasks';
import { discardDraft, getTemplate, publishTemplate, saveDraft, TemplateError } from '~/.server/templates';
import { entityOf } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.label} 模板参数` : '模板参数'} · CRM 数据分析平台` }];
}

const ORDER_STATUSES = entityOf('order')!.fields.find(f => f.name === 'status')!.enum!;

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:read');
  // 页面上的表单只有 RFM 的参数
  if (params.templateId !== 'rfm') throw data(null, { status: 404 });
  const t = await getTemplate(member, params.templateId);
  const canPublish = can(member.role, 'publish');
  return {
    email: member.email,
    nav: navFor(member),
    canDraft: can(member.role, 'definitions:draft'),
    /** 刚发布的版本（发布后跳回本页时带上 ?published=N） */
    justPublished: Number(new URL(request.url).searchParams.get('published')) || null,
    label: t.label,
    /** 表单里的参数：有草稿时是草稿，否则是生效的参数 */
    form: (t.draft?.params ?? t.params) as RfmDefinition,
    published: t.published?.version ?? null,
    versions: t.versions.map(v => ({
      version: v.version,
      status: v.status,
      authors: v.authors,
      lastEditor: v.lastEditor,
      publishedByEmail: v.publishedByEmail,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      updatedAt: v.updatedAt.toISOString(),
      /** 当前成员发布不了这一版草稿的原因（没有发布权限、最后保存的是自己、租户里没有别人能发布）；可以发布或不是草稿时为 null */
      publishBlocker: v.status !== 'draft' ? null
        : !canPublish ? deniedReason('publish')
        : v.publishBlocker && t.publishers === 1 && v.lastEditor === member.email ? '本租户只有你有发布权限，请先邀请一位数据工程师或管理员'
        : v.publishBlocker,
    })),
  };
}

const SCORES = ['r', 'f', 'm'] as const;
const number = (v: FormDataEntryValue | null | undefined) => (v == null || String(v).trim() === '' ? undefined : Number(v));

/** 表单 → 模板定义的参数（校验在保存时进行）；分群规则表里名称与条件都没填的行跳过 */
function rfmParamsOf(form: FormData): Record<string, unknown> {
  const cuts = (name: string) => String(form.get(name) ?? '').split(/[\s,，]+/).filter(Boolean).map(Number);
  const method = String(form.get('binning') ?? '');
  const names = form.getAll('segment').map(String);
  const segments = names.map((name, i) => {
    const rule: Record<string, unknown> = { name: name.trim() };
    for (const k of SCORES) {
      const min = number(form.getAll(`${k}Min`)[i]), max = number(form.getAll(`${k}Max`)[i]);
      if (min !== undefined || max !== undefined) rule[k] = { ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
    }
    return rule;
  }).filter(s => s.name || SCORES.some(k => s[k]));
  return {
    lookbackDays: number(form.get('lookbackDays')),
    statuses: form.getAll('status').map(String),
    binning: method === 'thresholds'
      ? { method, recency: cuts('recency'), frequency: cuts('frequency'), monetary: cuts('monetary') }
      : { method },
    segments,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const page = `/analytics/templates/${params.templateId}`;
  try {
    switch (String(form.get('intent') ?? '')) {
      case 'save':
        await saveDraft(await requirePermission(request, 'definitions:draft'), params.templateId, rfmParamsOf(form));
        break;
      case 'publish': {
        const version = Number(form.get('version'));
        await publishTemplate(await requirePermission(request, 'publish'), params.templateId, version);
        throw redirect(`${page}?published=${version}`);
      }
      case 'discard':
        await discardDraft(await requirePermission(request, 'definitions:draft'), params.templateId);
        break;
      default:
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof TemplateError) return data({ error: e.message }, { status: e.status });
    if (e instanceof TaskError) return data({ error: e.message }, { status: 400 });
    throw e;
  }
  throw redirect(page);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type LoaderData = Route.ComponentProps['loaderData'];
type Version = LoaderData['versions'][number];

/** 版本状态：已发布（锁定）或草稿，颜色配图标和文字（见 docs/agents/ui.md） */
function VersionStatus({ v }: { v: Version }) {
  return v.status === 'published'
    ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-3.5" />已发布</span>
    : <span className="inline-flex items-center gap-1 text-sm text-amber-600"><PencilLine className="size-3.5" />草稿</span>;
}

/** 草稿的发布与丢弃（发布不了时在按钮位置说明原因） */
function DraftActions({ v, canDraft, published, submitting }: { v: Version; canDraft: boolean; published: boolean; submitting: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2">
      {v.publishBlocker ? (
        <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-publish-blocker><Lock className="size-3.5 shrink-0" />{v.publishBlocker}</span>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <input type="hidden" name="version" value={v.version} />
          <Button type="submit" disabled={submitting}><Upload />{`发布 v${v.version}`}</Button>
        </Form>
      )}
      {canDraft && (
        <Form
          method="post"
          onSubmit={e => {
            const back = published ? '回到最近的已发布版本' : '回到模板的默认参数';
            if (!confirm(`丢弃第 ${v.version} 版草稿？${back}。`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="discard" />
          <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />丢弃草稿</Button>
        </Form>
      )}
    </div>
  );
}

const rangeInput = (range: ScoreRange | undefined, end: 'min' | 'max') => range?.[end] ?? '';

/** 分群规则表：按顺序取第一条满足的，最后一条不写条件兜住其余所有人；可加行、删行 */
function SegmentTable({ segments, disabled }: { segments: SegmentRule[]; disabled: boolean }) {
  const [rows, setRows] = useState(() => segments.map((s, i) => ({ key: i, rule: s })));
  const [next, setNext] = useState(segments.length);
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>人群</TableHead>
            {SCORES.map(k => <TableHead key={k} colSpan={2}>{`${k.toUpperCase()} 分（最低 – 最高）`}</TableHead>)}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, rule }) => (
            <TableRow key={key} data-segment-row>
              <TableCell><Input name="segment" defaultValue={rule.name} aria-label="人群名称" disabled={disabled} className="min-w-28" /></TableCell>
              {SCORES.flatMap(k => (['min', 'max'] as const).map(end => (
                <TableCell key={`${k}${end}`}>
                  <Input
                    name={`${k}${end === 'min' ? 'Min' : 'Max'}`} type="number" min={1} max={5} step={1} className="w-16"
                    defaultValue={rangeInput(rule[k], end)} aria-label={`${k.toUpperCase()} 分${end === 'min' ? '最低' : '最高'}`} disabled={disabled}
                  />
                </TableCell>
              )))}
              <TableCell>
                {!disabled && (
                  <Button type="button" variant="ghost" size="icon" aria-label="删除这一条" onClick={() => setRows(rows.filter(r => r.key !== key))}><X /></Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button type="button" variant="outline" size="sm" onClick={() => { setRows([...rows, { key: next, rule: { name: '' } }]); setNext(next + 1); }}>
          <Plus />添加一条
        </Button>
      )}
      <p className="text-sm text-slate-500">按顺序取第一条满足的规则；分值是 1 到 5 的整数，不填的一端不限。最后一条不能带条件，用来兜住其余所有消费者。</p>
    </div>
  );
}

function ParamsForm({ params, canDraft, submitting }: { params: RfmDefinition; canDraft: boolean; submitting: boolean }) {
  const [method, setMethod] = useState(params.binning.method);
  const cuts = (k: 'recency' | 'frequency' | 'monetary') => (params.binning.method === 'thresholds' ? params.binning[k].join(', ') : '');
  const disabled = !canDraft;
  return (
    <Form method="post">
      <FieldGroup>
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="lookback-days">回看天数</FieldLabel>
            <Input id="lookback-days" name="lookbackDays" type="number" min={1} max={3650} step={1} required defaultValue={params.lookbackDays} disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel htmlFor="binning">分箱方式</FieldLabel>
            <NativeSelect id="binning" name="binning" value={method} onChange={e => setMethod(e.target.value as typeof method)} disabled={disabled}>
              <NativeSelectOption value="quintile">五分位（按消费者排名五等分）</NativeSelectOption>
              <NativeSelectOption value="thresholds">固定阈值</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>
        <fieldset className="max-w-2xl space-y-2">
          <legend className="text-sm font-medium">计入的订单状态</legend>
          <div className="flex flex-wrap gap-4">
            {ORDER_STATUSES.map(s => (
              <label key={s} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="status" value={s} defaultChecked={params.statuses.includes(s)} disabled={disabled} />{s}
              </label>
            ))}
          </div>
        </fieldset>
        {method === 'thresholds' && (
          <div className="grid max-w-2xl grid-cols-3 gap-4">
            {([['recency', 'R：距今天数'], ['frequency', 'F：单数'], ['monetary', 'M：金额']] as const).map(([k, label]) => (
              <Field key={k}>
                <FieldLabel htmlFor={`cuts-${k}`}>{label}</FieldLabel>
                <Input id={`cuts-${k}`} name={k} defaultValue={cuts(k)} placeholder="四个升序的切分点，如 30, 90, 180, 365" disabled={disabled} />
              </Field>
            ))}
            <p className="col-span-3 text-sm text-slate-500">每项四个严格升序的切分点。R 的天数每不超过一个切分点加 1 分，F 的单数、M 的金额每达到一个切分点加 1 分，都从 1 分起。</p>
          </div>
        )}
        <SegmentTable segments={params.segments} disabled={disabled} />
        {canDraft && (
          <div>
            <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
          </div>
        )}
      </FieldGroup>
    </Form>
  );
}

export default function TemplateParams({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canDraft, justPublished, label, form, published, versions } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const draft = versions.find(v => v.status === 'draft');
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`${label} · 模板参数`}
        description={<><Link to="/analytics" className="hover:underline">← 分析</Link>{`　当前生效：${published ? `第 ${published} 版` : '默认参数'}`}</>}
      />

      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{actionData.error}</AlertTitle>
        </Alert>
      )}
      {justPublished && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{`第 ${justPublished} 版已发布`}</AlertTitle>
          <AlertDescription>已按新参数入队一次计算，完成后快照出现在分析页。</AlertDescription>
        </Alert>
      )}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">{draft ? `第 ${draft.version} 版草稿` : canDraft ? '编辑参数（保存后成为新的一版草稿）' : '生效的参数'}</h2>
        <ParamsForm key={draft?.updatedAt ?? published ?? 'defaults'} params={form} canDraft={canDraft} submitting={submitting} />
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">版本</h2>
        {versions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>作者</TableHead>
                <TableHead>最后保存</TableHead>
                <TableHead>发布</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map(v => (
                <TableRow key={v.version} data-version={v.version}>
                  <TableCell>{`v${v.version}`}</TableCell>
                  <TableCell><VersionStatus v={v} /></TableCell>
                  <TableCell>{v.authors.join('、')}</TableCell>
                  <TableCell className="text-slate-500">{`${v.lastEditor} · ${time(v.updatedAt)}`}</TableCell>
                  <TableCell className="text-slate-500">{v.publishedByEmail ? `${v.publishedByEmail} · ${time(v.publishedAt)}` : '—'}</TableCell>
                  <TableCell>{v.status === 'draft' && <DraftActions v={v} canDraft={canDraft} published={published !== null} submitting={submitting} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-slate-500">还没有保存过参数，生效的是模板的默认参数。保存草稿后，由另一位数据工程师或管理员发布。</p>
        )}
      </div>
    </AppShell>
  );
}

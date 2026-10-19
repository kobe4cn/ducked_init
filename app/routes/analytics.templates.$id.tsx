// app/routes/analytics.templates.$id.tsx —— 分析模板参数（有定义查看权限的成员），每个已登记模板一页：RFM 有专用表单（回看天数、计入的订单状态、
// 分箱方式（五分位或固定阈值）与分群规则表），其他模板按注册表里的 form 渲染通用表单（整数、订单状态多选、单选）。
// 有起草权限的成员保存草稿（参数不合法时报错）、丢弃草稿；草稿由最后保存它的人以外的另一位有发布权限的成员发布（ADR-0015），
// 发布后以新参数入队一次模板计算，产出的快照记下定义版本；有发布权限的成员也可以按生效的版本重新计算，选填不晚于今天的参考日期。
// 没有已发布版本时生效的是模板的默认参数（不能重新计算）。注册表有了比生效版本锁定的更新的模板版本时显示提示条：可以预览升级差异
// （只有分群迁移或变化人数，没有 consumer_id），有起草权限的成员确认升级后得到一版锁定新模板版本的草稿，照常双人发布（ADR-0021）
import { ArrowUpCircle, CheckCircle2, Eye, Lock, Plus, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.templates.$id';
import { can, deniedReason, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { publishReason } from '~/.server/publish-rules';
import { TEMPLATES, type ParamField } from '~/.server/pipeline/templates';
import type { RfmDefinition, ScoreRange, SegmentRule } from '~/.server/pipeline/templates/rfm';
import { TaskError } from '~/.server/tasks';
import {
  discardDraft, getTemplate, previewTemplateUpgrade, publishTemplate, recomputeTemplate, saveDraft, TemplateError, todayUtc, upgradeTemplateDraft,
} from '~/.server/templates';
import { entityOf } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
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
  if (!Object.hasOwn(TEMPLATES, params.templateId)) throw data(null, { status: 404 });
  const t = await getTemplate(member, params.templateId);
  const search = new URL(request.url).searchParams;
  return {
    email: member.email,
    nav: navFor(member),
    canDraft: can(member.role, 'definitions:draft'),
    /** 不能重新计算的原因（没有发布权限）；可以时为 null */
    recomputeDenied: can(member.role, 'publish') ? null : deniedReason('publish'),
    /** 今天（UTC），参考日期的上限 */
    today: todayUtc(),
    /** 刚发布的版本（发布后跳回本页时带上 ?published=N） */
    justPublished: Number(search.get('published')) || null,
    /** 刚重新计算所按的版本（重新计算后跳回本页时带上 ?recomputed=N） */
    justRecomputed: Number(search.get('recomputed')) || null,
    /** 刚起草的升级草稿（确认升级后跳回本页时带上 ?upgraded=N） */
    justUpgraded: Number(search.get('upgraded')) || null,
    /** 有比生效版本锁定的更新的模板版本 */
    upgradeAvailable: t.upgradeAvailable,
    latestTemplateVersion: t.latestTemplateVersion,
    /** 生效的已发布版本锁定的模板版本；没有已发布版本时为 null */
    lockedTemplateVersion: t.published?.templateVersion ?? null,
    /** 草稿锁定的模板版本；没有草稿时为 null */
    draftTemplateVersion: t.draft?.templateVersion ?? null,
    label: t.label,
    /** 通用表单的各项；RFM 用专用表单，为 null */
    fields: t.template === 'rfm' ? null : [...fieldsOf(t.template)],
    /** 表单里的参数：有草稿时是草稿，否则是生效的参数 */
    form: t.draft?.params ?? t.params,
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
      publishBlocker: publishReason(member, v, t.publishers),
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

/** 通用表单 → 模板定义的参数：只取 form 里列出的键（多出来的字段 saveDraft 会报不认识），校验在保存时进行 */
function formParamsOf(fields: readonly ParamField[], form: FormData): Record<string, unknown> {
  return Object.fromEntries(fields.map(f => [
    f.key,
    f.kind === 'int' ? number(form.get(f.key)) : f.kind === 'statuses' ? form.getAll(f.key).map(String) : String(form.get(f.key) ?? '') || undefined,
  ]));
}

/** 模板通用表单的各项；未登记的模板与 RFM（专用表单）为空 */
const fieldsOf = (id: string): readonly ParamField[] =>
  (Object.hasOwn(TEMPLATES, id) ? (TEMPLATES[id as keyof typeof TEMPLATES] as { form?: readonly ParamField[] }).form : undefined) ?? [];

const paramsOf = (id: string, form: FormData) => (id === 'rfm' ? rfmParamsOf(form) : formParamsOf(fieldsOf(id), form));

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const page = `/analytics/templates/${params.templateId}`;
  try {
    switch (String(form.get('intent') ?? '')) {
      case 'save':
        await saveDraft(await requirePermission(request, 'definitions:draft'), params.templateId, paramsOf(params.templateId, form));
        break;
      case 'publish': {
        const version = Number(form.get('version'));
        await publishTemplate(await requirePermission(request, 'publish'), params.templateId, version);
        throw redirect(`${page}?published=${version}`);
      }
      case 'recompute': {
        const { version } = await recomputeTemplate(await requirePermission(request, 'publish'), params.templateId, String(form.get('asOf') ?? '') || undefined);
        throw redirect(`${page}?recomputed=${version}`);
      }
      case 'discard':
        await discardDraft(await requirePermission(request, 'definitions:draft'), params.templateId);
        break;
      case 'preview-upgrade': {
        const member = await requirePermission(request, 'definitions:read');
        return { error: null, upgradeDiff: await previewTemplateUpgrade(member, params.templateId, String(form.get('asOf') ?? '') || undefined) };
      }
      case 'upgrade': {
        const { version } = await upgradeTemplateDraft(await requirePermission(request, 'definitions:draft'), params.templateId);
        throw redirect(`${page}?upgraded=${version}`);
      }
      default:
        return data({ error: '未知操作', upgradeDiff: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof TemplateError) return data({ error: e.message, upgradeDiff: null }, { status: e.status });
    if (e instanceof TaskError) return data({ error: e.message, upgradeDiff: null }, { status: 400 });
    throw e;
  }
  throw redirect(page);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

const rangeInput = (range: ScoreRange | undefined, end: 'min' | 'max') => range?.[end] ?? '';

/** 按生效的版本重新计算（intent=recompute），选填参考日期；没有发布权限时在按钮位置说明原因 */
function RecomputeAction({ denied, today, submitting }: { denied: string | null; today: string; submitting: boolean }) {
  if (denied) {
    return <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-recompute-denied><Lock className="size-3.5 shrink-0" />{denied}</span>;
  }
  return (
    <Form method="post" className="flex items-center justify-end gap-2">
      <input type="hidden" name="intent" value="recompute" />
      <Input type="date" name="asOf" max={today} aria-label="参考日期（不填为今天）" title="参考日期（不填为今天，UTC）" className="w-40" />
      <Button type="submit" variant="outline" disabled={submitting}><RefreshCw />重新计算</Button>
    </Form>
  );
}

type UpgradeDiff = Awaited<ReturnType<typeof previewTemplateUpgrade>>;

/**
 * 有新模板版本时的提示条：预览升级差异（intent=preview-upgrade，选填参考日期），有起草权限时确认升级（intent=upgrade）；
 * 草稿已锁定新版本时说明发布后生效。预览结果：RFM 是分群迁移人数表，其他模板是变化、新增、移出人数
 */
function UpgradeBanner({ latest, locked, draft, canDraft, today, diff, submitting }: {
  latest: number; locked: number; draft: { version: number; templateVersion: number | null } | null; canDraft: boolean; today: string;
  diff: UpgradeDiff | null; submitting: boolean;
}) {
  const upgraded = draft !== null && draft.templateVersion === latest;
  return (
    <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm" data-upgrade-banner>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-1.5 font-medium text-amber-600"><ArrowUpCircle className="size-4" />{`有新的模板版本 v${latest}（当前 v${locked}）`}</h2>
          <p className="text-sm text-slate-500">
            {upgraded
              ? `第 ${draft.version} 版草稿已锁定模板 v${latest}，由另一位数据工程师或管理员发布后按新版本计算；发布之前仍按 v${locked} 计算。`
              : `升级前先预览：以生效的参数分别按 v${locked} 与 v${latest} 计算，按消费者对比，只给人数。确认升级后生成一版草稿，发布之前仍按 v${locked} 计算。`}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="preview-upgrade" />
            <Input type="date" name="asOf" max={today} aria-label="参考日期（不填为今天）" title="参考日期（不填为今天，UTC）" className="w-40" />
            <Button type="submit" variant="outline" disabled={submitting}><Eye />预览升级差异</Button>
          </Form>
          {canDraft && !upgraded && (
            <Form method="post">
              <input type="hidden" name="intent" value="upgrade" />
              <Button type="submit" disabled={submitting}><ArrowUpCircle />升级到新版本</Button>
            </Form>
          )}
        </div>
      </div>
      {diff && (
        <div data-upgrade-diff className="space-y-2">
          <p className="text-sm text-slate-500">{`v${diff.from} → v${diff.to}，统计日 ${diff.asOf}`}</p>
          {diff.segments && (diff.segments.length
            ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>原分群</TableHead>
                    <TableHead>新分群</TableHead>
                    <TableHead>人数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diff.segments.map(t => (
                    <TableRow key={`${t.before} → ${t.after}`} data-upgrade-segment>
                      <TableCell>{t.before ?? '（无）'}</TableCell>
                      <TableCell>{t.after ?? '（无）'}</TableCell>
                      <TableCell>{t.consumers}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
            : <p className="text-sm">没有消费者换分群。</p>)}
          {diff.metric && (
            <p data-upgrade-metric className="text-sm">{`取值变化 ${diff.metric.changed} 人，新增 ${diff.metric.added} 人，移出 ${diff.metric.removed} 人`}</p>
          )}
        </div>
      )}
    </div>
  );
}

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

/** 按注册表里的 form 渲染的通用参数表单：int 是整数输入框（带 min / max），statuses 是订单状态多选，enum 是下拉框 */
function GenericParamsForm({ fields, params, canDraft, submitting }: { fields: ParamField[]; params: Record<string, unknown>; canDraft: boolean; submitting: boolean }) {
  const disabled = !canDraft;
  return (
    <Form method="post">
      <FieldGroup>
        {fields.map(f => {
          const value = params[f.key];
          if (f.kind === 'statuses') {
            const checked = Array.isArray(value) ? value : [];
            return (
              <fieldset key={f.key} className="max-w-2xl space-y-2">
                <legend className="text-sm font-medium">{f.label}</legend>
                <div className="flex flex-wrap gap-4">
                  {ORDER_STATUSES.map(s => (
                    <label key={s} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" name={f.key} value={s} defaultChecked={checked.includes(s)} disabled={disabled} />{s}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          const id = `param-${f.key}`;
          return (
            <Field key={f.key} className="max-w-xs">
              <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
              {f.kind === 'int' ? (
                <Input id={id} name={f.key} type="number" min={f.min} max={f.max} step={1} required defaultValue={value == null ? '' : String(value)} disabled={disabled} />
              ) : (
                <NativeSelect id={id} name={f.key} defaultValue={value == null ? '' : String(value)} disabled={disabled}>
                  {(f.options ?? []).map(o => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
                </NativeSelect>
              )}
            </Field>
          );
        })}
        {canDraft && (
          <div>
            <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
          </div>
        )}
      </FieldGroup>
    </Form>
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
  const {
    email, nav, canDraft, recomputeDenied, today, justPublished, justRecomputed, justUpgraded, upgradeAvailable, latestTemplateVersion, lockedTemplateVersion,
    draftTemplateVersion, label, fields, form, published, versions,
  } = loaderData;
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
      {justRecomputed && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{`已按第 ${justRecomputed} 版参数入队一次计算`}</AlertTitle>
          <AlertDescription>完成后快照出现在分析页。</AlertDescription>
        </Alert>
      )}
      {justUpgraded && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{`已起草第 ${justUpgraded} 版，锁定模板 v${latestTemplateVersion}`}</AlertTitle>
          <AlertDescription>由另一位数据工程师或管理员发布后按新版本计算。</AlertDescription>
        </Alert>
      )}
      {upgradeAvailable && lockedTemplateVersion !== null && (
        <UpgradeBanner
          latest={latestTemplateVersion} locked={lockedTemplateVersion} draft={draft ? { version: draft.version, templateVersion: draftTemplateVersion } : null}
          canDraft={canDraft} today={today} diff={actionData?.upgradeDiff ?? null} submitting={submitting}
        />
      )}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">{draft ? `第 ${draft.version} 版草稿` : canDraft ? '编辑参数（保存后成为新的一版草稿）' : '生效的参数'}</h2>
        {fields
          ? <GenericParamsForm key={draft?.updatedAt ?? published ?? 'defaults'} fields={fields} params={form} canDraft={canDraft} submitting={submitting} />
          : <ParamsForm key={draft?.updatedAt ?? published ?? 'defaults'} params={form as unknown as RfmDefinition} canDraft={canDraft} submitting={submitting} />}
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
                  <TableCell>
                    {v.status === 'draft' && (
                      <DraftActions
                        v={v} canDiscard={canDraft} discardHint={published !== null ? '回到最近的已发布版本' : '回到模板的默认参数'}
                        submitting={submitting} className="justify-end"
                      />
                    )}
                    {v.version === published && <RecomputeAction denied={recomputeDenied} today={today} submitting={submitting} />}
                  </TableCell>
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

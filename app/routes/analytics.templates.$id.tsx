// app/routes/analytics.templates.$id.tsx —— 分析模板参数（有定义查看权限的成员），每个已登记模板一页：RFM 有专用表单（回看天数、计入的订单状态、
// 分箱方式（五分位或固定阈值）与分群规则表），其他模板按注册表里的 form 渲染通用表单（整数、订单状态多选、单选）。
// 有起草权限的成员保存草稿（参数不合法时报错）、丢弃草稿；草稿由最后保存它的人以外的另一位有发布权限的成员发布（ADR-0015），
// 发布后以新参数入队一次模板计算，产出的快照记下定义版本；有发布权限的成员也可以按生效的版本重新计算，选填不晚于今天的参考日期。
// 没有已发布版本时生效的是模板的默认参数（不能重新计算）。注册表有了比生效版本锁定的更新的模板版本时显示提示条：可以预览升级差异
// （RFM 是一句话结论、分群对比与迁移矩阵，其他模板是一句话结论、按列统计对比与变化人数；没有 consumer_id），提示条与预览结果的头部列出锁定版本之后每一版的改动说明（模板注册表里的 changes），
// 有结果层查看权限的成员可以点迁移矩阵的一格（RFM）或输出列的「换了取值」（其他模板）查看最多 10 个样例消费者在两版下的全部输出列（#830，ADR-0025 补充），
// 预览另有「下游影响」一节（这个模板进服务库的表与读取它的对外接口）；有起草权限的成员确认升级后得到一版锁定新模板版本的草稿，照常双人发布（ADR-0021）
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Eye, Lock, Plus, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/analytics.templates.$id';
import { can, deniedReason, requirePermission } from '~/.server/access';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { navFor } from '~/.server/nav';
import { PublishError, publishReason } from '~/.server/publishing';
import { TEMPLATES, type ParamField } from '~/.server/pipeline/templates';
import type { ColumnStat, ColumnType } from '~/.server/pipeline/templates/upgrade-summary';
import { RFM_DEFAULTS, type RfmDefinition, type ScoreRange, type SegmentRule } from '~/.server/pipeline/templates/rfm';
import { TaskError } from '~/.server/tasks';
import {
  discardDraft, getTemplate, previewTemplateUpgrade, publishTemplate, recomputeTemplate, sampleTemplateUpgrade, saveDraft, templateDownstream,
  todayUtc, upgradeTemplateDraft,
} from '~/.server/templates';
import { cmpName } from '~/lib/compare';
import { entityOf } from '~/lib/canonical-model';
import { builtinName } from '~/lib/builtin-names';
import { makeT, msg, useLocale, useT, type Locale, type T } from '~/lib/i18n';
import { formatDateTime, formatNumber } from '~/lib/format';
import { summarySentence } from '~/lib/upgrade-summary-text';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData, matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  const name = loaderData ? t('{name} 模板参数', { name: builtinName(t, loaderData.label) }) : t('模板参数');
  return [{ title: `${name} · ${t('CRM 数据分析平台')}` }];
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
    /** 可以查看升级样例（有结果层查看权限，#830）；矩阵格子与「换了取值」只在可以时渲染成按钮 */
    canSample: can(member.role, 'results:read'),
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
    /** 锁定版本之后每一版的改动说明（提示条与预览结果的头部列出） */
    upgradeChanges: t.upgradeChanges,
    /** 生效的已发布版本锁定的模板版本；没有已发布版本时为 null */
    lockedTemplateVersion: t.published?.templateVersion ?? null,
    /** 草稿锁定的模板版本；没有草稿时为 null */
    draftTemplateVersion: t.draft?.templateVersion ?? null,
    label: t.label,
    /** RFM 默认人群名：升级迁移矩阵判断「是不是默认名」的名单（默认名翻译、租户改名原样）；非 RFM 模板为 null */
    defaultSegmentNames: t.template === 'rfm' ? RFM_DEFAULTS.segments.map(s => s.name) : null,
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

/** 表单里的分群名（迁移矩阵的格子）：空串表示「（无）」（新增 / 移出） */
const segmentOf = (v: FormDataEntryValue | null) => (v == null || String(v) === '' ? null : String(v));

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
        return {
          error: null,
          upgradeDiff: await previewTemplateUpgrade(member, params.templateId, String(form.get('asOf') ?? '') || undefined),
          downstream: await templateDownstream(member, params.templateId),
          sample: null,
        };
      }
      case 'preview-sample': {
        const member = await requirePermission(request, 'results:read');
        const asOf = String(form.get('asOf') ?? '') || undefined;
        const column = form.get('column');
        const pick = column != null && String(column) !== ''
          ? { column: String(column) }
          : { before: segmentOf(form.get('before')), after: segmentOf(form.get('after')) };
        // 带上升级差异让预览保持展开，样例表出现在点开的格子 / 列下面
        return {
          error: null,
          upgradeDiff: await previewTemplateUpgrade(member, params.templateId, asOf),
          downstream: await templateDownstream(member, params.templateId),
          sample: await sampleTemplateUpgrade(member, params.templateId, pick, asOf),
        };
      }
      case 'upgrade': {
        const { version } = await upgradeTemplateDraft(await requirePermission(request, 'definitions:draft'), params.templateId);
        throw redirect(`${page}?upgraded=${version}`);
      }
      default:
        return data({ error: formatServer(await getLocale(request), msg('未知操作')), upgradeDiff: null, downstream: null, sample: null }, { status: 400 });
    }
  } catch (e) {
    // 模板与发布流程的业务错误（TemplateError 是 PublishError 的子类，ADR-0051）
    if (e instanceof PublishError) return data({ error: await errorTextFor(request, e), upgradeDiff: null, downstream: null, sample: null }, { status: e.status });
    if (e instanceof TaskError) return data({ error: await errorTextFor(request, e), upgradeDiff: null, downstream: null, sample: null }, { status: 400 });
    throw e;
  }
  throw redirect(page);
}

const rangeInput = (range: ScoreRange | undefined, end: 'min' | 'max') => range?.[end] ?? '';

/** 按生效的版本重新计算（intent=recompute），选填参考日期；没有发布权限时在按钮位置说明原因 */
function RecomputeAction({ denied, today, submitting }: { denied: string | null; today: string; submitting: boolean }) {
  const t = useT();
  if (denied) {
    return <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-recompute-denied><Lock className="size-3.5 shrink-0" />{denied}</span>;
  }
  return (
    <Form method="post" className="flex items-center justify-end gap-2">
      <input type="hidden" name="intent" value="recompute" />
      <Input type="date" name="asOf" max={today} aria-label={t('参考日期（不填为今天）')} title={t('参考日期（不填为今天，UTC）')} className="w-40" />
      <Button type="submit" variant="outline" disabled={submitting}><RefreshCw />{t('重新计算')}</Button>
    </Form>
  );
}

type UpgradeDiff = Awaited<ReturnType<typeof previewTemplateUpgrade>>;
/** 升级样例（intent=preview-sample）：点的格子或列、两版输出列与样例行（#830） */
type UpgradeSample = Awaited<ReturnType<typeof sampleTemplateUpgrade>>;
/** 下游影响（#830）：这个模板进服务库的表与读取它的对外接口 */
type Downstream = Awaited<ReturnType<typeof templateDownstream>>;

/** 样例的取值：null 显示「—」，布尔显示「是 / 否」，其余按字符串 */
const sampleValue = (t: T, v: unknown) => {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? t('是') : t('否');
  return String(v);
};

/**
 * 样例消费者表（#830）：一行一个消费者（最多 10 个，按 consumer_id 排序），并排 v1 / v2 的全部输出列；
 * 取值只来自模板的输出列，不出敏感字段明文。人群列的值是湖里的中文原值：默认人群名按界面语言翻译（defaults 名单），
 * 租户改过名的人群原样
 */
function SampleTable({ from, to, sample, defaults }: { from: number; to: number; sample: UpgradeSample; defaults: ReadonlySet<string> }) {
  const t = useT();
  const cell = (c: string, v: unknown) => (c === 'segment' && typeof v === 'string' ? builtinName(t, v, defaults) : sampleValue(t, v));
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate-400">{t('样例消费者（最多 10 个，按 consumer_id 排序，{kind, select, cell {原分群 → 新分群} column {换了取值} other {对比}}）', { kind: sample.pick.kind })}</p>
      <Table data-upgrade-sample>
        <TableHeader>
          <TableRow>
            <TableHead>consumer_id</TableHead>
            {/* 每列并排 v1 / v2，方便逐列对比 */}
            {sample.columns.flatMap(c => [<TableHead key={c}>{`v${from} ${c}`}</TableHead>, <TableHead key={`v2-${c}`}>{`v${to} ${c}`}</TableHead>])}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sample.rows.map(r => (
            <TableRow key={r.consumerId} data-sample-row={r.consumerId}>
              <TableCell className="font-mono text-xs">{r.consumerId}</TableCell>
              {sample.columns.flatMap(c => [<TableCell key={c}>{cell(c, r.before[c])}</TableCell>, <TableCell key={`v2-${c}`}>{cell(c, r.after[c])}</TableCell>])}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sample.rows.length === 0 && <p className="text-sm text-slate-500">{t('这里没有消费者。')}</p>}
    </div>
  );
}

/** 「下游影响」（#830）：服务库表、发布后下一次计算时切换、读取它的对外接口与最近 30 天读取的 API Key（#921，吊销的标「已吊销」）；没有下游时写「没有下游使用」 */
function DownstreamImpact({ downstream }: { downstream: Downstream }) {
  const t = useT();
  return (
    <div data-downstream className="space-y-1">
      <p className="text-xs font-medium text-slate-400">{t('下游影响')}</p>
      {downstream.table === null ? (
        <p className="text-sm text-slate-500">{t('没有下游使用')}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-500">
          <li>{t('服务库表 {table}，升级发布后下一次计算时切换到新结果', { table: downstream.table })}</li>
          {downstream.paths.map(p => <li key={p}>{t('对外接口 {path} 读取这张表', { path: p })}</li>)}
          {downstream.keys.length > 0 && (
            <li data-downstream-keys>
              {t('最近 30 天读取的 API Key：')}
              <ul className="list-[circle] pl-5">
                {/* 名字不唯一（吊销后可以用同名再建），不能当 key */}
                {downstream.keys.map((k, i) => (
                  <li key={i}>{k.revoked
                    ? t('{name}（已吊销） · {calls, plural, other {# 次}}', { name: k.name, calls: k.calls })
                    : t('{name} · {calls, plural, other {# 次}}', { name: k.name, calls: k.calls })}
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** 锁定版本之后每一版的改动说明（提示条的说明段下面与预览结果的头部各列一次） */
function ChangeList({ changes }: { changes: { version: number; changes: string }[] }) {
  const t = useT();
  return (
    <ul data-upgrade-changes className="list-disc space-y-0.5 pl-5 text-sm text-slate-500">
      {changes.map(c => <li key={c.version}>{t('v{version}：{changes}', { version: c.version, changes: c.changes })}</li>)}
    </ul>
  );
}

/**
 * 有新模板版本时的提示条：预览升级差异（intent=preview-upgrade，选填参考日期），有起草权限时确认升级（intent=upgrade）；
 * 草稿已锁定新版本时说明发布后生效。预览结果：RFM 是一句话结论、分群对比与迁移矩阵，其他模板是一句话结论、按列统计对比与变化、新增、移出人数；
 * 有结果层查看权限的成员可以点格子 / 「换了取值」查看样例消费者（intent=preview-sample），预览还带「下游影响」一节
 */
function UpgradeBanner({ latest, locked, changes, draft, canDraft, canSample, today, diff, downstream, sample, defaultSegmentNames, submitting }: {
  latest: number; locked: number; changes: { version: number; changes: string }[]; draft: { version: number; templateVersion: number | null } | null;
  canDraft: boolean; canSample: boolean; today: string; diff: UpgradeDiff | null; downstream: Downstream | null; sample: UpgradeSample | null;
  defaultSegmentNames: string[] | null; submitting: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const upgraded = draft !== null && draft.templateVersion === latest;
  // 草稿已锁定新版本时只说明发布后生效；否则按能否点样例给两句不同详细程度的预览指引（不写嵌套三元）
  let guide: string;
  if (upgraded) {
    guide = t('第 {version} 版草稿已锁定模板 v{latest}，由另一位数据工程师或管理员发布后按新版本计算；发布之前仍按 v{locked} 计算。', { version: draft!.version, latest, locked });
  } else if (canSample) {
    guide = t('升级前先预览：以生效的参数分别按 v{locked} 与 v{latest} 计算，按消费者对比给计数与统计量，点迁移矩阵的格子或输出列的「换了取值」可看样例消费者。确认升级后生成一版草稿，发布之前仍按 v{locked} 计算。', { locked, latest });
  } else {
    guide = t('升级前先预览：以生效的参数分别按 v{locked} 与 v{latest} 计算，按消费者对比给计数与统计量。确认升级后生成一版草稿，发布之前仍按 v{locked} 计算。', { locked, latest });
  }
  return (
    <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm" data-upgrade-banner>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-1.5 font-medium text-amber-600"><ArrowUpCircle className="size-4" />{t('有新的模板版本 v{latest}（当前 v{locked}）', { latest, locked })}</h2>
          <p className="text-sm text-slate-500">{guide}</p>
          <div className="mt-1"><ChangeList changes={changes} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="preview-upgrade" />
            <Input type="date" name="asOf" max={today} aria-label={t('参考日期（不填为今天）')} title={t('参考日期（不填为今天，UTC）')} className="w-40" />
            <Button type="submit" variant="outline" disabled={submitting}><Eye />{t('预览升级差异')}</Button>
          </Form>
          {canDraft && !upgraded && (
            <Form method="post">
              <input type="hidden" name="intent" value="upgrade" />
              <Button type="submit" disabled={submitting}><ArrowUpCircle />{t('升级到新版本')}</Button>
            </Form>
          )}
        </div>
      </div>
      {diff && (
        <div data-upgrade-diff className="space-y-2">
          <p className="text-sm text-slate-500">{t('v{from} → v{to}，统计日 {asOf}', { from: diff.from, to: diff.to, asOf: diff.asOf })}</p>
          <ChangeList changes={changes} />
          {diff.summary && (
            <p data-upgrade-summary className={`flex items-center gap-1.5 text-sm ${diff.summary.warn ? 'text-amber-600' : 'text-slate-500'}`}>
              {diff.summary.warn && <AlertTriangle className="size-4 shrink-0" aria-label={t('警示')} />}
              <span>{summarySentence(t, locale, diff.summary, new Set(defaultSegmentNames ?? []))}</span>
            </p>
          )}
          {diff.distribution?.kind === 'segments'
            && <SegmentUpgradeDistribution from={diff.from} to={diff.to} asOf={diff.asOf} distribution={diff.distribution} canSample={canSample} sample={sample} defaultSegmentNames={defaultSegmentNames} />}
          {diff.distribution?.kind === 'columns'
            && <ColumnUpgradeDistribution from={diff.from} to={diff.to} asOf={diff.asOf} distribution={diff.distribution} canSample={canSample} sample={sample} />}
          {diff.metric && (
            <p data-upgrade-metric className="text-sm text-slate-500">{t('取值变化 {changed} 人，新增 {added} 人，移出 {removed} 人', { changed: diff.metric.changed, added: diff.metric.added, removed: diff.metric.removed })}</p>
          )}
          {downstream && <DownstreamImpact downstream={downstream} />}
        </div>
      )}
    </div>
  );
}

/** 分群按名字排（ADR-0045 的 cmpName），null（新增或移出，显示成「（无）」）排最后 */
function cmpSegment(a: string | null, b: string | null) {
  if (a === null) return 1;
  if (b === null) return -1;
  return cmpName(a, b);
}

const count = (locale: Locale, n: number) => formatNumber(locale, n);
/** 没有计数（只有一边有的列）时显示「—」 */
const countOrDash = (locale: Locale, n: number | null) => (n === null ? '—' : count(locale, n));

/** RFM 升级预览的分群对比（每个分群的 v1 / v2 人数、变化与 v2 占比）与「原分群 × 新分群」迁移矩阵（含没变的人，对角线淡显；计数本身不出消费者 ID，ADR-0025）。
 *  有结果层查看权限的成员点非零的格子查看样例消费者（#830）。人群名只翻显示文字：默认人群名按界面语言翻译，
 *  排序（cmpSegment）、行 / 列键与表单提交的 before / after 仍是存储的原值 */
function SegmentUpgradeDistribution({ from, to, asOf, distribution, canSample, sample, defaultSegmentNames }: {
  from: number; to: number; asOf: string; distribution: Extract<NonNullable<UpgradeDiff['distribution']>, { kind: 'segments' }>;
  canSample: boolean; sample: UpgradeSample | null; defaultSegmentNames: string[] | null;
}) {
  const t = useT();
  const locale = useLocale();
  const defaults = new Set(defaultSegmentNames ?? []);
  /** null（新增或移出）显示「（无）」 */
  const disp = (s: string | null) => (s === null ? t('（无）') : builtinName(t, s, defaults));
  const names = (side: 'before' | 'after') => [...new Set(distribution[side].map(s => s.segment))];
  // 对比表的行是 v1 / v2 分群名的并集（只有一边有的分群另一边人数为 0）；矩阵行是原分群、列是新分群，迁移里出现的「（无）」（新增或移出）也各占一行/列
  const compareRows = [...new Set([...names('before'), ...names('after')])].sort(cmpSegment);
  const matrixRows = [...new Set([...names('before'), ...distribution.matrix.map(m => m.before)])].sort(cmpSegment);
  const columns = [...new Set([...names('after'), ...distribution.matrix.map(m => m.after)])].sort(cmpSegment);
  const sideCount = (side: 'before' | 'after', segment: string | null) => distribution[side].find(s => s.segment === segment)?.consumers ?? 0;
  const totalAfter = distribution.after.reduce((n, s) => n + s.consumers, 0);
  const moved = (b: string | null, a: string | null) => distribution.matrix.find(m => m.before === b && m.after === a)?.consumers ?? 0;
  // 当前展开的样例是哪一格（null 是「（无）」）
  const picked = sample !== null && sample.pick.kind === 'cell' ? sample.pick : null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-400">{t('分群对比')}</p>
      <Table data-upgrade-distribution>
        <TableHeader>
          <TableRow>
            <TableHead>{t('分群')}</TableHead>
            <TableHead>{t('v{n} 人数', { n: from })}</TableHead>
            <TableHead>{t('v{n} 人数', { n: to })}</TableHead>
            <TableHead>{t('变化')}</TableHead>
            <TableHead>{t('v{n} 占比', { n: to })}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {compareRows.map(s => {
            const v1 = sideCount('before', s), v2 = sideCount('after', s);
            const delta = v2 - v1;
            return (
              <TableRow key={s ?? '（无）'}>
                <TableCell>{disp(s)}</TableCell>
                <TableCell>{count(locale, v1)}</TableCell>
                <TableCell>{count(locale, v2)}</TableCell>
                <TableCell>{delta >= 0 ? `+${count(locale, delta)}` : count(locale, delta)}</TableCell>
                <TableCell>{totalAfter > 0 ? `${((v2 / totalAfter) * 100).toFixed(1)}%` : '0.0%'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-xs font-medium text-slate-400">{canSample
        ? t('迁移矩阵（原分群 × 新分群，含没变的人，「（无）」是新增或移出，点人数查看样例）')
        : t('迁移矩阵（原分群 × 新分群，含没变的人，「（无）」是新增或移出）')}
      </p>
      <Table data-upgrade-matrix>
        <TableHeader>
          <TableRow>
            <TableHead>{t('原分群 ＼ 新分群')}</TableHead>
            {columns.map(a => <TableHead key={a ?? '（无）'}>{disp(a)}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {matrixRows.map(b => (
            <TableRow key={b ?? '（无）'}>
              <TableCell>{disp(b)}</TableCell>
              {columns.map(a => {
                const n = moved(b, a);
                const isPicked = picked !== null && picked.before === b && picked.after === a;
                return (
                  <TableCell key={a ?? '（无）'} className={a === b && !isPicked ? 'text-slate-400' : undefined}>
                    {canSample && n > 0 ? (
                      <Form method="post" className="inline">
                        <input type="hidden" name="intent" value="preview-sample" />
                        <input type="hidden" name="asOf" value={asOf} />
                        <input type="hidden" name="before" value={b ?? ''} />
                        <input type="hidden" name="after" value={a ?? ''} />
                        <button
                          type="submit"
                          data-sample-cell={`${b ?? ''}→${a ?? ''}`}
                          aria-label={t('查看 {before} → {after} 的样例消费者', { before: disp(b), after: disp(a) })}
                          className={`underline decoration-dotted underline-offset-2 hover:text-slate-900 ${isPicked ? 'font-medium text-slate-900' : ''}`}
                        >{count(locale, n)}</button>
                      </Form>
                    ) : count(locale, n)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sample?.pick.kind === 'cell' && <SampleTable from={from} to={to} sample={sample} defaults={defaults} />}
    </div>
  );
}

/** 非 RFM 升级预览的按列对比：每个输出列（不含 consumer_id）一行，并排 v1 / v2 统计量与换了取值的人数（计数与统计量本身不出单个消费者的取值，ADR-0025）。
 *  有结果层查看权限的成员点「换了取值」的人数查看样例消费者（#830） */
function ColumnUpgradeDistribution({ from, to, asOf, distribution, canSample, sample }: {
  from: number; to: number; asOf: string; distribution: Extract<NonNullable<UpgradeDiff['distribution']>, { kind: 'columns' }>;
  canSample: boolean; sample: UpgradeSample | null;
}) {
  const t = useT();
  const locale = useLocale();
  const typeLabel: Record<ColumnType, string> = { bool: t('布尔'), number: t('数值'), text: t('文本'), other: t('其他') };
  // 布尔列的占比用该边自己的总人数算；数值列的 null（这一列全为 null）与缺列的一边都显示「—」
  const cell = (c: ColumnStat, side: 'before' | 'after') => {
    const total = distribution.total[side];
    const percent = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
    if (c.type === 'bool') {
      const stat = c[side];
      return stat === null ? '—' : t('{n, plural, other {# 人}}（{p}%）', { n: stat.yes, p: percent(stat.yes) });
    }
    if (c.type === 'number') {
      const stat = c[side];
      if (stat === null) return '—';
      const decimal = (n: number | null) => (n === null ? '—' : n.toFixed(2));
      return (
        <div>
          <div>{t('均值 {v}', { v: decimal(stat.mean) })}</div>
          <div>{t('中位数 {v}', { v: decimal(stat.median) })}</div>
          <div>{`P90 ${decimal(stat.p90)}`}</div>
        </div>
      );
    }
    if (c.type === 'text') {
      const stat = c[side];
      return stat === null || stat.values.length === 0 ? '—' : (
        <div>{stat.values.map((v, i) => <div key={i}>{t('{value}：{n, plural, other {# 人}}', { value: v.value ?? t('（无）'), n: v.consumers })}</div>)}</div>
      );
    }
    const stat = c[side];
    return stat === null ? '—' : t('非空 {n, plural, other {# 人}}', { n: stat.nonNull });
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-400">{t('按列对比')}</p>
      <Table data-upgrade-columns>
        <TableHeader>
          <TableRow>
            <TableHead>{t('字段')}</TableHead>
            <TableHead>{t('类型')}</TableHead>
            <TableHead>{`v${from}`}</TableHead>
            <TableHead>{`v${to}`}</TableHead>
            <TableHead>{t('换了取值的人数')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {distribution.columns.map(c => (
            <TableRow key={c.name}>
              <TableCell>{c.name}</TableCell>
              <TableCell>{typeLabel[c.type]}</TableCell>
              <TableCell>{cell(c, 'before')}</TableCell>
              <TableCell>{cell(c, 'after')}</TableCell>
              <TableCell>
                {canSample && c.changed !== null && c.changed > 0 ? (
                  <Form method="post" className="inline">
                    <input type="hidden" name="intent" value="preview-sample" />
                    <input type="hidden" name="asOf" value={asOf} />
                    <input type="hidden" name="column" value={c.name} />
                    <button
                      type="submit"
                      data-sample-column={c.name}
                      aria-label={t('查看 {name} 换了取值的样例消费者', { name: c.name })}
                      className={`underline decoration-dotted underline-offset-2 hover:text-slate-900 ${sample?.pick.kind === 'column' && sample.pick.column === c.name ? 'font-medium text-slate-900' : ''}`}
                    >{count(locale, c.changed)}</button>
                  </Form>
                ) : countOrDash(locale, c.changed)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sample?.pick.kind === 'column' && <SampleTable from={from} to={to} sample={sample} defaults={new Set<string>()} />}
    </div>
  );
}

/** 分群规则表：按顺序取第一条满足的，最后一条不写条件兜住其余所有人；可加行、删行 */
function SegmentTable({ segments, disabled }: { segments: SegmentRule[]; disabled: boolean }) {
  const t = useT();
  const [rows, setRows] = useState(() => segments.map((s, i) => ({ key: i, rule: s })));
  const [next, setNext] = useState(segments.length);
  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('人群')}</TableHead>
            {SCORES.map(k => <TableHead key={k} colSpan={2}>{t('{score} 分（最低 – 最高）', { score: k.toUpperCase() })}</TableHead>)}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ key, rule }) => (
            <TableRow key={key} data-segment-row>
              <TableCell><Input name="segment" defaultValue={rule.name} aria-label={t('人群名称')} disabled={disabled} className="min-w-28" /></TableCell>
              {SCORES.flatMap(k => (['min', 'max'] as const).map(end => (
                <TableCell key={`${k}${end}`}>
                  <Input
                    name={`${k}${end === 'min' ? 'Min' : 'Max'}`} type="number" min={1} max={5} step={1} className="w-16"
                    defaultValue={rangeInput(rule[k], end)} aria-label={end === 'min' ? t('{score} 分最低', { score: k.toUpperCase() }) : t('{score} 分最高', { score: k.toUpperCase() })} disabled={disabled}
                  />
                </TableCell>
              )))}
              <TableCell>
                {!disabled && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t('删除这一条')} onClick={() => setRows(rows.filter(r => r.key !== key))}><X /></Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button type="button" variant="outline" size="sm" onClick={() => { setRows([...rows, { key: next, rule: { name: '' } }]); setNext(next + 1); }}>
          <Plus />{t('添加一条')}
        </Button>
      )}
      <p className="text-sm text-slate-500">{t('按顺序取第一条满足的规则；分值是 1 到 5 的整数，不填的一端不限。最后一条不能带条件，用来兜住其余所有消费者。')}</p>
    </div>
  );
}

/** 按注册表里的 form 渲染的通用参数表单：int 是整数输入框（带 min / max），statuses 是订单状态多选，enum 是下拉框 */
function GenericParamsForm({ fields, params, canDraft, submitting }: { fields: ParamField[]; params: Record<string, unknown>; canDraft: boolean; submitting: boolean }) {
  const t = useT();
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
                <legend className="text-sm font-medium">{builtinName(t, f.label)}</legend>
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
              <FieldLabel htmlFor={id}>{builtinName(t, f.label)}</FieldLabel>
              {f.kind === 'int' ? (
                <Input id={id} name={f.key} type="number" min={f.min} max={f.max} step={1} required defaultValue={value == null ? '' : String(value)} disabled={disabled} />
              ) : (
                <NativeSelect id={id} name={f.key} defaultValue={value == null ? '' : String(value)} disabled={disabled}>
                  {(f.options ?? []).map(o => <NativeSelectOption key={o.value} value={o.value}>{builtinName(t, o.label)}</NativeSelectOption>)}
                </NativeSelect>
              )}
            </Field>
          );
        })}
        {canDraft && (
          <div>
            <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? t('正在校验…') : t('校验并保存草稿')}</Button>
          </div>
        )}
      </FieldGroup>
    </Form>
  );
}

function ParamsForm({ params, canDraft, submitting }: { params: RfmDefinition; canDraft: boolean; submitting: boolean }) {
  const t = useT();
  const [method, setMethod] = useState(params.binning.method);
  const cuts = (k: 'recency' | 'frequency' | 'monetary') => (params.binning.method === 'thresholds' ? params.binning[k].join(', ') : '');
  const disabled = !canDraft;
  return (
    <Form method="post">
      <FieldGroup>
        <div className="grid max-w-2xl grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="lookback-days">{t('回看天数')}</FieldLabel>
            <Input id="lookback-days" name="lookbackDays" type="number" min={1} max={3650} step={1} required defaultValue={params.lookbackDays} disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel htmlFor="binning">{t('分箱方式')}</FieldLabel>
            <NativeSelect id="binning" name="binning" value={method} onChange={e => setMethod(e.target.value as typeof method)} disabled={disabled}>
              <NativeSelectOption value="quintile">{t('五分位（按消费者排名五等分）')}</NativeSelectOption>
              <NativeSelectOption value="thresholds">{t('固定阈值')}</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>
        <fieldset className="max-w-2xl space-y-2">
          <legend className="text-sm font-medium">{t('计入的订单状态')}</legend>
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
            {([['recency', t('R：距今天数')], ['frequency', t('F：单数')], ['monetary', t('M：金额')]] as const).map(([k, label]) => (
              <Field key={k}>
                <FieldLabel htmlFor={`cuts-${k}`}>{label}</FieldLabel>
                <Input id={`cuts-${k}`} name={k} defaultValue={cuts(k)} placeholder={t('四个升序的切分点，如 30, 90, 180, 365')} disabled={disabled} />
              </Field>
            ))}
            <p className="col-span-3 text-sm text-slate-500">{t('每项四个严格升序的切分点。R 的天数每不超过一个切分点加 1 分，F 的单数、M 的金额每达到一个切分点加 1 分，都从 1 分起。')}</p>
          </div>
        )}
        <SegmentTable segments={params.segments} disabled={disabled} />
        {canDraft && (
          <div>
            <Button type="submit" name="intent" value="save" disabled={submitting}>{submitting ? t('正在校验…') : t('校验并保存草稿')}</Button>
          </div>
        )}
      </FieldGroup>
    </Form>
  );
}

export default function TemplateParams({ loaderData, actionData }: Route.ComponentProps) {
  const {
    email, nav, canDraft, recomputeDenied, today, justPublished, justRecomputed, justUpgraded, upgradeAvailable, latestTemplateVersion, lockedTemplateVersion,
    upgradeChanges, draftTemplateVersion, label, defaultSegmentNames, fields, form, published, versions, canSample,
  } = loaderData;
  const t = useT();
  const locale = useLocale();
  const time = (iso: string | null) => (iso ? formatDateTime(locale, iso) : '—');
  const submitting = useNavigation().state === 'submitting';
  const draft = versions.find(v => v.status === 'draft');
  // 参数卡的标题（不写嵌套三元）：有草稿写第几版；没有时按能不能起草区分编辑与只读
  let paramsTitle: string;
  if (draft) paramsTitle = t('第 {n} 版草稿', { n: draft.version });
  else if (canDraft) paramsTitle = t('编辑参数（保存后成为新的一版草稿）');
  else paramsTitle = t('生效的参数');
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`${builtinName(t, label)} · ${t('模板参数')}`}
        description={<><Link to="/analytics" className="hover:underline">{t('← 分析')}</Link>{published != null ? t('　当前生效：第 {n} 版', { n: published }) : t('　当前生效：默认参数')}</>}
      />

      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{actionData.error}</AlertTitle>
        </Alert>
      )}
      {justPublished && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{t('第 {n} 版已发布', { n: justPublished })}</AlertTitle>
          <AlertDescription>{t('已按新参数入队一次计算，完成后快照出现在分析页。')}</AlertDescription>
        </Alert>
      )}
      {justRecomputed && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{t('已按第 {n} 版参数入队一次计算', { n: justRecomputed })}</AlertTitle>
          <AlertDescription>{t('完成后快照出现在分析页。')}</AlertDescription>
        </Alert>
      )}
      {justUpgraded && !actionData?.error && (
        <Alert role="status">
          <CheckCircle2 />
          <AlertTitle>{t('已起草第 {n} 版，锁定模板 v{latest}', { n: justUpgraded, latest: latestTemplateVersion })}</AlertTitle>
          <AlertDescription>{t('由另一位数据工程师或管理员发布后按新版本计算。')}</AlertDescription>
        </Alert>
      )}
      {upgradeAvailable && lockedTemplateVersion !== null && (
        <UpgradeBanner
          latest={latestTemplateVersion} locked={lockedTemplateVersion} changes={upgradeChanges}
          draft={draft ? { version: draft.version, templateVersion: draftTemplateVersion } : null}
          canDraft={canDraft} canSample={canSample} today={today} diff={actionData?.upgradeDiff ?? null}
          downstream={actionData?.downstream ?? null} sample={actionData?.sample ?? null} defaultSegmentNames={defaultSegmentNames} submitting={submitting}
        />
      )}

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">{paramsTitle}</h2>
        {fields
          ? <GenericParamsForm key={draft?.updatedAt ?? published ?? 'defaults'} fields={fields} params={form} canDraft={canDraft} submitting={submitting} />
          : <ParamsForm key={draft?.updatedAt ?? published ?? 'defaults'} params={form as unknown as RfmDefinition} canDraft={canDraft} submitting={submitting} />}
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">{t('版本')}</h2>
        {versions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('版本')}</TableHead>
                <TableHead>{t('状态')}</TableHead>
                <TableHead>{t('作者')}</TableHead>
                <TableHead>{t('最后保存')}</TableHead>
                <TableHead>{t('发布')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map(v => (
                <TableRow key={v.version} data-version={v.version}>
                  <TableCell>{`v${v.version}`}</TableCell>
                  <TableCell><VersionStatus v={v} /></TableCell>
                  <TableCell>{v.authors.join(t('、'))}</TableCell>
                  <TableCell className="text-slate-500">{`${v.lastEditor} · ${time(v.updatedAt)}`}</TableCell>
                  <TableCell className="text-slate-500">{v.publishedByEmail ? `${v.publishedByEmail} · ${time(v.publishedAt)}` : '—'}</TableCell>
                  <TableCell>
                    {v.status === 'draft' && (
                      <DraftActions
                        v={v} canDiscard={canDraft} discardHint={published !== null ? t('回到最近的已发布版本') : t('回到模板的默认参数')}
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
          <p className="text-slate-500">{t('还没有保存过参数，生效的是模板的默认参数。保存草稿后，由另一位数据工程师或管理员发布。')}</p>
        )}
      </div>
    </AppShell>
  );
}

// app/routes/mappings.tsx —— 映射（数据工程师、管理员可起草；分析师只读）：本租户的映射列表（源表 → 实体、已发布版本、草稿、已停用或待确认停用、目标自定义实体待补登、最近一次合并），
// 新建映射（选数据源、编写 YAML，默认是第一个数据源按规则生成的草稿，校验通过才保存为草稿，检查有提示（notices）时留在本页列出提示与新映射的入口；可按所选的表与实体按规则生成草稿填进编辑框，或用模型生成（复用已发布映射 > 模型 > 规则，ADR-0035，编辑框上方按置信度从低到高列出模型给的每项与理由），都不保存；换数据源 / 表 / 实体时编辑框换成新选择的初始内容（普通表按规则生成草稿、源视图用空白模板），手改过的先确认；目标实体可选标准实体或已发布登记的自定义实体；编辑框旁对照所选源表的列统计与目标实体的标准字段或登记的字段），
// 手动触发一次合并到标准层，以及主键冲突体检（silver.keycheck）：任何能看映射的成员都可以运行，报告按实体列出主键重叠的映射对
import { AlertTriangle, CheckCircle2, CircleDashed, Layers, Loader2, PencilLine, Play, Plus, ScanSearch, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { data, Form, Link, redirect, type ShouldRevalidateFunctionArgs, useFetcher, useNavigation, useRevalidator } from 'react-router';
import type { Route } from './+types/mappings';
import { assertCan, can, requirePermission } from '~/.server/access';
import { customEntityPages, customEntityRegistrations } from '~/.server/custom-entities';
import { errorTextFor } from '~/.server/i18n';
import { checkKeysNow, getKeyCheckStatus, KeyCheckError } from '~/.server/key-check';
import { createMapping, defaultDraft, draftFor, GenerationMismatchError, listMappings, MappingError, modelDraftFor, referenceTables, validateNewMapping } from '~/.server/mappings';
import { MergeError, mergeNow } from '~/.server/merges';
import { navFor } from '~/.server/nav';
import { functionList } from '~/lib/mapping-expr';
import { SUGGESTION_LABELS } from '~/.server/pipeline/key-check-engine';
import { listSources } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { CANONICAL_ENTITIES, entityLabel, entityOf, isCustomEntity } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { DraftConfidence } from '~/components/draft-confidence';
import { MappingErrors, MappingNotices } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { mappingOutline } from '~/lib/mapping-outline';
import { applyDraft, mappingTemplate, reselect, VIEW_PREFIX, withTarget } from '~/lib/mapping-template';
import { cn } from '~/lib/utils';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { StatusText } from '~/components/status-text';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';

export function meta({}: Route.MetaArgs) {
  return [{ title: '映射 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const { mappings, merge } = await listMappings(member);
  const customPages = await customEntityPages(member, mappings.map(m => m.entity));
  const sources = (await listSources(member)).map(s => ({ id: s.id, name: s.name }));
  const canWrite = can(member.role, 'sources:write');
  const keyCheck = await getKeyCheckStatus(member);
  const mappingNames = new Map(mappings.map(m => [m.id, `${m.sourceName} / ${m.tableName}`]));
  return {
    email: member.email,
    nav: navFor(member),
    canWrite,
    sources,
    /** 各数据源可对照的源表（只有能新建映射时才给） */
    tables: canWrite ? Object.fromEntries(await Promise.all(sources.map(async s => [s.id, await referenceTables(member, s.id)] as const))) : {},
    /** 本租户自定义实体的已发布登记，新建时可选为目标实体、在对照面板里对照（只有能新建映射时才给） */
    registered: canWrite ? await customEntityRegistrations(member) : {},
    /** 新建映射编辑框的默认内容：第一个数据源的草稿，没有已采集的表时是模板 */
    initialYaml: canWrite && sources[0] ? await defaultDraft(member, sources[0].id) : mappingTemplate('order', 'orders'),
    functions: functionList(),
    merge: {
      status: merge.status,
      statusLabel: merge.status === 'none' ? '未合并' : TASK_STATUS_LABELS[merge.status],
      error: merge.error,
      attemptedAt: merge.attemptedAt?.toISOString() ?? null,
    },
    keyCheck: {
      status: KEYCHECK_STATUS[keyCheck.status],
      error: keyCheck.error,
      checkedAt: keyCheck.checkedAt?.toISOString() ?? null,
      // 映射显示成「数据源 / 源表」，体检之后删掉的映射显示 ID
      entities: keyCheck.entities.map(e => ({
        ...e,
        entityLabel: customPages[e.entity]?.label ?? entityLabel(e.entity),
        pairs: e.pairs.map(p => ({ ...p, aName: mappingNames.get(p.a) ?? p.a, bName: mappingNames.get(p.b) ?? p.b, suggestionLabel: SUGGESTION_LABELS[p.suggestion] })),
      })),
    },
    mappings: mappings.map(m => ({
      id: m.id,
      sourceName: m.sourceName,
      table: m.tableName,
      entity: m.entity,
      entityLabel: customPages[m.entity]?.label ?? entityLabel(m.entity),
      published: m.published,
      draft: m.draft,
      /** 停用状态（ADR-0031）：已停用、有人提议待确认、没有 */
      disable: m.disabledAt ? 'disabled' as const : m.disableRequestedByEmail ? 'requested' as const : null,
      lastMerge: m.lastMerge,
      /** 源表列差异：没用到的新列与源端已删除的列（列名）；没有时为 null */
      drift: m.drift ? { newColumns: m.drift.newColumns.map(c => c.name), missing: m.drift.missing } : null,
      /** 目标是还没有已发布登记的自定义实体时，去补登的实体页（推断不出登记时是实体列表）；否则为 null */
      pendingEntity: customPages[m.entity]?.pending ? customPages[m.entity].href : null,
    })),
  };
}

/** 最近一次体检任务的状态 → 页面上的状态：从没体检过、体检中（排队或运行）、失败、成功 */
const KEYCHECK_STATUS = { none: 'never', queued: 'running', running: 'running', failed: 'failed', succeeded: 'ok' } as const;

/** 只读的提交（只校验、按规则生成草稿）不改数据，不重跑 loader：草稿靠 action 返回的 draftId 换编辑框内容 */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return formData?.get('intent') === 'validate' || formData?.get('intent') === 'draft' ? false : defaultShouldRevalidate;
}

/** 运行体检（intent=keycheck）只要 sources:read，其余操作都要 sources:write */
export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:read');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  if (field('intent') !== 'keycheck') assertCan(member, 'sources:write');
  try {
    switch (field('intent')) {
      case 'keycheck':
        await checkKeysNow(member);
        throw redirect('/mappings');
      case 'draft': {
        // 只生成、填进编辑框，不保存；draftId 让编辑框换成新内容
        const yaml = await draftFor(member, field('sourceId'), field('table'), field('entity'));
        return { error: null, issues: [], values: { sourceId: field('sourceId'), yaml }, draftId: crypto.randomUUID() };
      }
      case 'model-draft': {
        // 复用 > 模型 > 规则，填进编辑框、不保存；生成记录的 ID 留给之后的比对
        const draft = await modelDraftFor(member, field('sourceId'), field('table'), field('entity'));
        return {
          error: null, issues: [], values: { sourceId: field('sourceId'), yaml: draft.yaml }, draftId: crypto.randomUUID(),
          generationId: draft.generationId, generated: { origin: draft.origin, items: draft.items, reusedFrom: draft.reusedFrom ?? null, notice: draft.notice ?? null },
        };
      }
      case 'validate':
        // 只校验、不保存：与新建同一套检查，问题列表与新建被拒时相同
        return { ...await validateNewMapping(member, field('sourceId'), field('yaml')), values: null, draftId: null };
      case 'create': {
        // 从生成草稿开始改的，保存时比对生成稿记下改动（ADR-0035）
        const mapping = await createMapping(member, field('sourceId'), field('yaml'), { generationId: field('generationId') || undefined });
        // 检查有提示时不跳转，在列表页列出提示并给出新映射的入口
        if (mapping.notices.length) return { error: null, issues: [], values: null, draftId: null, created: { id: mapping.id, notices: mapping.notices } };
        throw redirect(`/mappings/${mapping.id}`);
      }
      case 'merge':
        await mergeNow(member);
        throw redirect('/mappings');
      default:
        return data({ error: '未知操作', issues: [], values: null, draftId: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof KeyCheckError) return data({ error: await errorTextFor(request, e), issues: [], values: null, draftId: null }, { status: 400 });
    // 手动合并被拒（已有合并等）：没有 issues，编辑框里留着提交的内容
    if (e instanceof MergeError) {
      return data({ error: await errorTextFor(request, e), issues: [], values: { sourceId: field('sourceId'), yaml: field('yaml') }, draftId: null, generationId: field('generationId') || null }, { status: e.status });
    }
    if (e instanceof MappingError) {
      // 没保存时仍带着生成记录，改好再保存照样比对；生成记录本身不符时不再带
      const generationId = e instanceof GenerationMismatchError ? null : field('generationId') || null;
      return data({ error: await errorTextFor(request, e), issues: e.issues, values: { sourceId: field('sourceId'), yaml: field('yaml') }, draftId: null, generationId }, { status: e.status });
    }
    throw e;
  }
}

type LoaderData = Route.ComponentProps['loaderData'];

/** 合并状态色配图标（见 docs/agents/ui.md） */
const TASK_STATUS: Record<LoaderData['merge']['status'], { icon: typeof CheckCircle2; tone: string }> = {
  none: { icon: CircleDashed, tone: 'text-slate-500' },
  queued: { icon: CircleDashed, tone: 'text-amber-600' },
  running: { icon: Loader2, tone: 'text-amber-600' },
  succeeded: { icon: CheckCircle2, tone: 'text-emerald-600' },
  failed: { icon: AlertTriangle, tone: 'text-red-600' },
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type LastMerge = LoaderData['mappings'][number]['lastMerge'];

/** 一个映射最近一次合并的结果 */
function mergeSummary(m: LastMerge) {
  if (!m) return '—';
  if ('error' in m) return `失败：${m.error}`;
  if ('skipped' in m) return `跳过：${m.skipped}`;
  if (m.mode === 'incremental' && m.batchTo === m.batchFrom) return `第 ${m.version} 版，无新批次，${m.rows.toLocaleString('zh-CN')} 行`;
  return `第 ${m.version} 版，${m.rows.toLocaleString('zh-CN')} 行（新增 ${m.inserted}，更新 ${m.updated}，删除 ${m.deleted}）`;
}

const percent = (ratio: number | null) => (ratio === null ? '无可比字段' : `一致 ${Math.round(ratio * 100)}%`);

/**
 * 主键冲突体检：最近一次体检的状态，以及最近一次成功体检里按实体列出的主键重叠的映射对（重叠键数、样本键、字段一致的比例与建议）。
 * 只出报告不改标准层；体检中时页面定时刷新到体检结束
 */
function KeyCheckSection({ keyCheck }: { keyCheck: LoaderData['keyCheck'] }) {
  const { status, entities, checkedAt } = keyCheck;
  const clashes = entities.reduce((n, e) => n + e.pairs.length, 0);
  const alarming = status === 'failed' || clashes > 0;
  const revalidator = useRevalidator();
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [status, revalidator]);
  return (
    <section data-keycheck-status={status} className={cn('space-y-4 rounded-2xl border bg-white p-6 shadow-sm', alarming && 'border-red-200')}>
      <SectionHeader title="主键冲突体检">统计每个实体里主键撞上的映射对：重叠的键数、样本键，以及重叠的键里两边都映射了的字段全部一致的比例，并给出建议。只出报告，不改标准层；customer 不参与，主键含消费者 ID 的实体按数据源比较。</SectionHeader>
      <p className="flex flex-wrap items-center text-sm text-slate-500">
        {status === 'never' && '尚未体检'}
        {status === 'running' && <span className="flex items-center gap-2 text-amber-600"><Loader2 className="size-4 animate-spin" />体检中</span>}
        {status === 'failed' && <span className="flex items-center gap-2 text-red-600"><AlertTriangle className="size-4" />{`体检失败：${keyCheck.error ?? ''}`}</span>}
        {checkedAt && <span className={status === 'ok' ? undefined : 'ml-3'}>{`${status === 'ok' ? '' : '上次'}体检时间：${time(checkedAt)}`}</span>}
      </p>
      {checkedAt && (clashes === 0 ? (
        <p data-no-keycheck-clash className="flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 className="size-4" />没有主键冲突</p>
      ) : entities.map(e => (
        <div key={e.entity} data-keycheck-entity={e.entity} className="space-y-2">
          <h3 className="text-sm font-medium">{`${e.entityLabel}（${e.entity}）`}{e.bySource && <span className="ml-2 text-xs font-normal text-slate-400">按数据源比较</span>}</h3>
          <ul className="divide-y rounded-xl border text-sm">
            {e.pairs.map(p => (
              <li key={`${p.a}:${p.b}`} data-keycheck-pair={`${e.entity}:${p.a}:${p.b}`} className="space-y-1 px-4 py-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-mono text-xs">{`${p.aName} ↔ ${p.bName}`}</span>
                  <span className="text-red-600">{`重叠 ${p.overlap.toLocaleString('zh-CN')} 个键`}</span>
                  <span className="text-slate-500">{percent(p.agreement)}</span>
                  <span className="text-slate-500">{`建议：${p.suggestionLabel}`}</span>
                  {/* 主键按数据源比较的实体不能建合并组（ADR-0032） */}
                  {p.suggestion === 'duplicate' && !e.bySource && (
                    <Link to={`/merge-groups?entity=${encodeURIComponent(e.entity)}`} className="hover:underline" data-keycheck-merge-group>去建合并组</Link>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-slate-400">{`样本键：${p.samples.map(k => k.join(', ')).join('、')}`}</div>
              </li>
            ))}
          </ul>
        </div>
      )))}
    </section>
  );
}

export default function Mappings({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, sources, tables, registered, initialYaml, functions, merge, keyCheck, mappings } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const { icon: MergeIcon, tone: mergeTone } = TASK_STATUS[merge.status];
  // 新建成功但检查有提示时留在本页列出
  const created = actionData && 'created' in actionData ? actionData.created : undefined;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="映射"
        description="数据源中的表 → 标准实体与字段的对应关系，带版本。草稿由另一位数据工程师或管理员发布后锁定；已发布的映射在每次同步后把原始层的变更批次合并进标准层。"
        actions={
          <>
            <Button asChild variant="outline"><Link to="/merge-groups"><Layers />合并组</Link></Button>
            <span className="flex flex-col items-end text-sm" data-merge-status={merge.status}>
              <span className={cn('inline-flex items-center gap-1', mergeTone)}><MergeIcon className="size-3.5" />{`最近一次合并：${merge.statusLabel}`}</span>
              <span className="text-xs text-slate-400">{time(merge.attemptedAt)}</span>
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="keycheck" />
              <Button type="submit" variant="outline" disabled={submitting || keyCheck.status === 'running'}>
                <ScanSearch />{keyCheck.status === 'running' ? '体检中…' : '运行体检'}
              </Button>
            </Form>
            {canWrite && (
              <Form method="post">
                <input type="hidden" name="intent" value="merge" />
                <Button type="submit" variant="outline" disabled={submitting}><Play />立即合并</Button>
              </Form>
            )}
          </>
        }
      />

      {merge.error && <div className="flex items-start gap-1 text-sm whitespace-normal text-red-600"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{merge.error}</div>}
      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}
      {created && (
        <MappingNotices title="映射已新建（第 1 版草稿已保存），检查有以下提示（不影响发布）" notices={created.notices}>
          <Link to={`/mappings/${created.id}`} className="underline">打开新建的映射</Link>
        </MappingNotices>
      )}

      <KeyCheckSection keyCheck={keyCheck} />

      {!mappings.length && (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          {canWrite ? '还没有映射。一个映射把数据源里的一张表对应到一个标准实体，在下面新建第一个。' : '还没有映射。数据工程师或管理员新建后会出现在这里。'}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {mappings.map(m => {
          const failed = m.lastMerge && 'error' in m.lastMerge;
          const sourceMissing = !!m.drift?.missing.length;
          // 卡片整体链到映射，「实体待补登」链到实体页：不能把链接套在链接里，卡片链接铺在底层，标记浮在它上面
          return (
            <div
              key={m.id}
              data-mapping-id={m.id}
              className={cn('relative rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md', (failed || sourceMissing) && 'border-red-200')}
            >
              <Link to={`/mappings/${m.id}`} className="block text-lg font-medium after:absolute after:inset-0">{`${m.entityLabel}（${m.entity}）`}</Link>
              <div className="mt-1 truncate font-mono text-xs text-slate-400">{`${m.sourceName} / ${m.table}`}</div>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {m.published
                  ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-3.5" />{`已发布 v${m.published}`}</span>
                  : <span className="inline-flex items-center gap-1 text-slate-500"><CircleDashed className="size-3.5" />未发布</span>}
                {m.draft && <span className="inline-flex items-center gap-1 text-amber-600"><PencilLine className="size-3.5" />{`草稿 v${m.draft}`}</span>}
                {m.disable === 'disabled' && <StatusText tone="none" data-mapping-disable="disabled">已停用</StatusText>}
                {m.disable === 'requested' && <StatusText tone="pending" data-mapping-disable="requested">待确认停用</StatusText>}
                {m.pendingEntity && (
                  <Link to={m.pendingEntity} title="这个实体还没有已发布的登记，去确认补登" className="relative inline-flex items-center gap-1 text-amber-600 hover:underline">
                    <AlertTriangle className="size-3.5" />实体待补登
                  </Link>
                )}
                {m.drift && m.drift.newColumns.length > 0 && (
                  <StatusText tone="pending" data-drift-new={m.drift.newColumns.join(',')}>{`源表新增 ${m.drift.newColumns.length} 列`}</StatusText>
                )}
                {m.drift && sourceMissing && (
                  <StatusText tone="bad" data-drift-missing={m.drift.missing.join(',')}>{`源端已删除 ${m.drift.missing.length} 列`}</StatusText>
                )}
              </div>
              <div className={cn('mt-4 flex items-start gap-1 border-t pt-3 text-xs', failed ? 'text-red-600' : 'text-slate-400')}>
                {failed && <AlertTriangle className="mt-px size-3.5 shrink-0" />}
                <span className="line-clamp-2">{m.lastMerge ? `最近一次合并：${mergeSummary(m.lastMerge)}` : '还没有合并过'}</span>
              </div>
            </div>
          );
        })}

        {canWrite && (
          // 没有 JS 时也能展开新建：<details> 收起时是虚线的「新建映射」卡片，展开后占满一行（编辑框与对照面板需要整行宽度）
          <details open={!mappings.length || Boolean(actionData && !created)} className="group rounded-2xl border-2 border-dashed open:col-span-full open:border open:border-solid open:bg-white open:p-6 open:shadow-sm">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span className="grid min-h-40 place-items-center text-slate-400 hover:text-slate-600 group-open:hidden">
                <span className="flex flex-col items-center gap-2"><Plus className="size-6" />新建映射</span>
              </span>
              <span className="hidden items-center justify-between gap-6 group-open:flex">
                <h2 className="text-lg font-semibold">新建映射</h2>
                <X aria-hidden className="size-4 text-slate-400" />
              </span>
            </summary>
            <p className="mt-1 mb-5 max-w-2xl text-sm text-slate-500">
              一个映射把数据源里的一张表（须在同步范围内、已采集）对应到一个实体。字段表达式只能用白名单函数，
              值字典把源端枚举对应到标准枚举，dedupe 声明去重键与取最新字段。实体与字段说明见<Link to="/model" className="underline">标准模型</Link>。
            </p>
            <NewMapping
              key={actionData?.draftId ?? 'new'}
              sources={sources}
              tables={tables}
              registered={registered}
              functions={functions}
              values={actionData?.values ?? { sourceId: sources[0]?.id ?? '', yaml: initialYaml }}
              generated={(actionData && 'generated' in actionData && actionData.generated) || null}
              generationId={(actionData && 'generationId' in actionData && actionData.generationId) || null}
              submitting={submitting}
            />
          </details>
        )}
      </div>
    </AppShell>
  );
}

/** 表下拉框的取值：源视图前加 view: 与同名的源表区分 */
const inputValue = (t: { name: string; view?: true }) => (t.view ? `${VIEW_PREFIX}${t.name}` : t.name);

/** 换选数据源 / 表 / 实体取规则草稿（intent=draft 走 fetcher）时 action 的返回值，这里只用到 error 与生成的 YAML */
interface DraftResult { error: string | null; values: { yaml: string } | null }

/**
 * 新建映射的表单：选数据源、用表单或 YAML 编写映射。表与目标实体两个下拉框决定表单列哪些字段、对照面板显示什么（默认取 YAML 里写的），
 * 也是「按规则生成草稿」的输入；换选数据源 / 表 / 实体时编辑框换成新选择的初始内容（普通表按规则生成草稿、源视图用空白模板，手改过先确认），
 * 保存时以 YAML 里写的为准
 */
function NewMapping({ sources, tables, registered, functions, values, generated, generationId, submitting }: {
  sources: LoaderData['sources'];
  tables: LoaderData['tables'];
  registered: LoaderData['registered'];
  functions: LoaderData['functions'];
  values: { sourceId: string; yaml: string };
  /** 用模型生成草稿时的来源、每项置信度与理由、提示（如没配置模型服务、已按规则生成） */
  generated: React.ComponentProps<typeof DraftConfidence> | null;
  /** 编辑框里是生成的草稿时它的生成记录，保存时一起提交；换了数据源、表或实体后不再带 */
  generationId: string | null;
  submitting: boolean;
}) {
  const [sourceId, setSourceId] = useState(values.sourceId);
  const [currentGenerationId, setCurrentGenerationId] = useState(generationId);
  const [yaml, setYaml] = useState(values.yaml);
  /** 编辑框里最近一次放进来的生成稿（loader 的初始草稿、action 生成的或换选换进来的），与它不同就是手改过 */
  const [lastGenerated, setLastGenerated] = useState(values.yaml);
  const [draftError, setDraftError] = useState<string | null>(null);
  // 换普通表时经 action 取规则草稿（「按规则生成草稿」按钮同一个 intent，走 fetcher 不整页提交）
  const draft = useFetcher<DraftResult>();
  /** 正在等的取草稿请求；响应回来时与当前选择比对，已经又切走的丢弃。yamlAtRequest 是发请求时编辑框的内容，在途期间又手改过要先确认 */
  const [draftRequest, setDraftRequest] = useState<{ sourceId: string; table: string; entity: string; yamlAtRequest: string } | null>(null);
  // 这条 fetcher 自上次取草稿后有没有真正提交过（离开过 idle）：刚记下新请求、还没提交的那一帧 data 仍是上一轮的，不能当新响应用
  const draftSubmitted = useRef(false);
  const [outline] = useState(() => mappingOutline(values.yaml));
  const [inputName, setInputName] = useState(outline.view ? inputValue({ name: outline.view, view: true }) : outline.table);
  const [entity, setEntity] = useState(outline.entity && (entityOf(outline.entity) || isCustomEntity(outline.entity)) ? outline.entity : CANONICAL_ENTITIES[0].name);
  // 标准实体、已发布登记的自定义实体，以及 YAML 里写的未登记自定义实体（对照面板提示去登记）
  const entities = [
    ...CANONICAL_ENTITIES.map(e => ({ name: e.name, label: e.label })),
    ...Object.values(registered).map(e => ({ name: e.name, label: e.label })),
    ...(isCustomEntity(entity) && !registered[entity] ? [{ name: entity, label: '未登记' }] : []),
  ];
  const sourceTables = tables[sourceId] ?? [];
  const table = sourceTables.find(t => inputValue(t) === inputName) ?? sourceTables[0] ?? null;
  const currentInput = table ? inputValue(table) : '';

  /**
   * 换选数据源 / 表 / 实体后换掉编辑框的内容：源视图换成该实体的空白模板、普通表按新表与实体取规则草稿（见 reselect）；
   * 手改过先确认，取消时一个 state 都不动、受控下拉框自然回到原选择。新的源还没有已采集的表时没有草稿可取，照旧只把实体行换掉
   */
  const reselectContent = (nextSourceId: string, nextInput: string, nextEntity: string) => {
    if (nextInput) {
      const { needsConfirm, next } = reselect({ sourceId: nextSourceId, input: nextInput, entity: nextEntity, yaml, lastGenerated });
      if (needsConfirm && !window.confirm('编辑框里的内容被手改过，换选后会替换成新表 / 实体的初始内容。确定替换吗？')) return false;
      if (next.kind === 'template') { setYaml(next.yaml); setLastGenerated(next.yaml); }
      else {
        draftSubmitted.current = false;
        setDraftRequest({ sourceId: next.sourceId, table: next.table, entity: next.entity, yamlAtRequest: yaml });
        void draft.submit({ intent: 'draft', ...next }, { method: 'post', action: '/mappings' });
      }
    } else {
      const rewritten = withTarget(yaml, 'entity', nextEntity);
      setYaml(rewritten);
      setLastGenerated(rewritten);
    }
    setDraftError(null);
    setCurrentGenerationId(null);
    return true;
  };

  // 规则草稿回来了才填进编辑框：只认这条请求真正提交过（fetcher 离开过 idle）之后的 idle 帧——那之前的 idle 帧 data 仍是上一轮的，
  // 不能当新响应用；再与当前选择比对，快速连续切换时丢弃过期的响应。取不到（如表没采集过）只报错、编辑框不动；在途期间手改过先确认
  useEffect(() => {
    if (draft.state !== 'idle') { draftSubmitted.current = true; return; }
    if (!draftSubmitted.current || !draft.data || !draftRequest) return;
    setDraftRequest(null);
    if (draftRequest.sourceId !== sourceId || draftRequest.table !== currentInput || draftRequest.entity !== entity) return;
    if (draft.data.error || !draft.data.values) {
      setDraftError(draft.data.error ?? '生成草稿失败');
      return;
    }
    // 取草稿在途期间编辑框又被手改过：先确认，取消就丢弃这条草稿，编辑框与 lastGenerated 都不动
    if (applyDraft({ yaml, yamlAtRequest: draftRequest.yamlAtRequest }).needsConfirm
      && !window.confirm('取规则草稿期间编辑框又被手改过，换进新表 / 实体的规则草稿会覆盖这些修改。确定替换吗？')) return;
    setDraftError(null);
    setYaml(draft.data.values.yaml);
    setLastGenerated(draft.data.values.yaml);
  }, [draft.state, draft.data, draftRequest, sourceId, currentInput, entity, yaml]);

  return (
    <Form method="post">
      {currentGenerationId && <input type="hidden" name="generationId" value={currentGenerationId} />}
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="mapping-source">数据源</FieldLabel>
            <NativeSelect id="mapping-source" name="sourceId" value={sourceId} onChange={e => {
              const id = e.target.value;
              const list = tables[id] ?? [];
              // 换数据源后表回退到新源里同名或第一张表，按回退后的输入重新生成并同步下拉框
              const fallback = list.find(t => inputValue(t) === inputName) ?? list[0];
              const nextInput = fallback ? inputValue(fallback) : '';
              if (!reselectContent(id, nextInput, entity)) return;
              setSourceId(id);
              setInputName(nextInput);
            }}>
              {sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-table">表或源视图</FieldLabel>
            <NativeSelect id="mapping-table" name="table" value={currentInput} onChange={e => { if (reselectContent(sourceId, e.target.value, entity)) setInputName(e.target.value); }} disabled={!sourceTables.length}>
              {sourceTables.map(t => <NativeSelectOption key={inputValue(t)} value={inputValue(t)}>{t.view ? `源视图 ${t.name}` : t.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-entity">目标实体</FieldLabel>
            <NativeSelect id="mapping-entity" name="entity" value={entity} onChange={e => { if (reselectContent(sourceId, currentInput, e.target.value)) setEntity(e.target.value); }}>
              {entities.map(e => <NativeSelectOption key={e.name} value={e.name}>{`${e.label}（${e.name}）`}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel>映射</FieldLabel>
          {generated && <DraftConfidence {...generated} />}
          {draftError && <MappingErrors error={draftError} issues={[]} />}
          <MappingEditorWithReference defaultValue={values.yaml} value={yaml} onValueChange={setYaml} table={table} entity={entity} registered={registered} functions={functions}
            validateAction={sources.length ? '/mappings' : undefined} validateExtra={{ sourceId }}
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" name="intent" value="create" disabled={submitting || !sources.length}>{submitting ? '正在处理…' : '校验并保存草稿'}</Button>
          <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !table || !!table.view} title={table?.view ? '按规则生成草稿要用源表的列统计，源视图请直接编写' : '按列名、类型与常见取值生成，替换编辑框里的内容；不会保存'}>
            按规则生成草稿
          </Button>
          <Button
            type="submit" name="intent" value="model-draft" variant="outline" disabled={submitting || !table || !!table.view}
            title={table?.view
              ? '用模型生成草稿要用源表的列统计，源视图请直接编写'
              : '会把表结构与列统计发给模型服务（打开「发送脱敏样本」时附 5 行脱敏样本）；结构与已发布映射一致时直接复用、不调用模型，没配置模型服务时按规则生成。替换编辑框里的内容，不会保存'}
          >
            用模型生成草稿
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

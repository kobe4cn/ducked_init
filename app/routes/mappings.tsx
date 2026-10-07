// app/routes/mappings.tsx —— 映射（数据工程师、管理员可起草；分析师只读）：本租户的映射列表（源表 → 实体、已发布版本、草稿、目标自定义实体待补登、最近一次合并），
// 新建映射（选数据源、编写 YAML，默认是第一个数据源按规则生成的草稿，校验通过才保存为草稿；可按所选的表与实体按规则生成草稿填进编辑框，不保存；目标实体可选标准实体或已发布登记的自定义实体；编辑框旁对照所选源表的列统计与目标实体的标准字段或登记的字段），
// 手动触发一次合并到标准层，以及主键冲突体检（silver.keycheck）：任何能看映射的成员都可以运行，报告按实体列出主键重叠的映射对
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, PencilLine, Play, Plus, ScanSearch, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isMap, isScalar, parseDocument } from 'yaml';
import { data, Form, Link, redirect, useNavigation, useRevalidator } from 'react-router';
import type { Route } from './+types/mappings';
import { assertCan, can, requirePermission } from '~/.server/access';
import { customEntityPages, customEntityRegistrations } from '~/.server/custom-entities';
import { checkKeysNow, getKeyCheckStatus, KeyCheckError } from '~/.server/key-check';
import { createMapping, defaultDraft, draftFor, listMappings, MappingError, mergeNow, referenceTables } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { functionList } from '~/lib/mapping-expr';
import { SUGGESTION_LABELS } from '~/.server/pipeline/key-check-engine';
import { mappingTemplate } from '~/.server/pipeline/mapping-spec';
import { listSources } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { CANONICAL_ENTITIES, entityLabel, entityOf, isCustomEntity } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { MappingErrors } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { mappingOutline } from '~/lib/mapping-outline';
import { cn } from '~/lib/utils';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
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
      lastMerge: m.lastMerge,
      /** 目标是还没有已发布登记的自定义实体时，去补登的实体页（推断不出登记时是实体列表）；否则为 null */
      pendingEntity: customPages[m.entity]?.pending ? customPages[m.entity].href : null,
    })),
  };
}

/** 最近一次体检任务的状态 → 页面上的状态：从没体检过、体检中（排队或运行）、失败、成功 */
const KEYCHECK_STATUS = { none: 'never', queued: 'running', running: 'running', failed: 'failed', succeeded: 'ok' } as const;

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
      case 'create': {
        const mapping = await createMapping(member, field('sourceId'), field('yaml'));
        throw redirect(`/mappings/${mapping.id}`);
      }
      case 'merge':
        await mergeNow(member);
        throw redirect('/mappings');
      default:
        return data({ error: '未知操作', issues: [], values: null, draftId: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof KeyCheckError) return data({ error: e.message, issues: [], values: null, draftId: null }, { status: 400 });
    if (e instanceof MappingError) {
      return data({ error: e.message, issues: e.issues, values: { sourceId: field('sourceId'), yaml: field('yaml') }, draftId: null }, { status: e.status });
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
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="映射"
        description="数据源中的表 → 标准实体与字段的对应关系，带版本。草稿由另一位数据工程师或管理员发布后锁定；已发布的映射在每次同步后把原始层的变更批次合并进标准层。"
        actions={
          <>
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

      <KeyCheckSection keyCheck={keyCheck} />

      {!mappings.length && (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          {canWrite ? '还没有映射。一个映射把数据源里的一张表对应到一个标准实体，在下面新建第一个。' : '还没有映射。数据工程师或管理员新建后会出现在这里。'}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {mappings.map(m => {
          const failed = m.lastMerge && 'error' in m.lastMerge;
          // 卡片整体链到映射，「实体待补登」链到实体页：不能把链接套在链接里，卡片链接铺在底层，标记浮在它上面
          return (
            <div
              key={m.id}
              data-mapping-id={m.id}
              className={cn('relative rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md', failed && 'border-red-200')}
            >
              <Link to={`/mappings/${m.id}`} className="block text-lg font-medium after:absolute after:inset-0">{`${m.entityLabel}（${m.entity}）`}</Link>
              <div className="mt-1 truncate font-mono text-xs text-slate-400">{`${m.sourceName} / ${m.table}`}</div>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                {m.published
                  ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-3.5" />{`已发布 v${m.published}`}</span>
                  : <span className="inline-flex items-center gap-1 text-slate-500"><CircleDashed className="size-3.5" />未发布</span>}
                {m.draft && <span className="inline-flex items-center gap-1 text-amber-600"><PencilLine className="size-3.5" />{`草稿 v${m.draft}`}</span>}
                {m.pendingEntity && (
                  <Link to={m.pendingEntity} title="这个实体还没有已发布的登记，去确认补登" className="relative inline-flex items-center gap-1 text-amber-600 hover:underline">
                    <AlertTriangle className="size-3.5" />实体待补登
                  </Link>
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
          <details open={!mappings.length || Boolean(actionData)} className="group rounded-2xl border-2 border-dashed open:col-span-full open:border open:border-solid open:bg-white open:p-6 open:shadow-sm">
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
              submitting={submitting}
            />
          </details>
        )}
      </div>
    </AppShell>
  );
}

/**
 * YAML 里的 table、view 或 entity 换成 value（保留注释与顺序）；table 与 view 只能写一个，换成另一种时原地改键名，换成 table 时去掉 view_key。
 * YAML 解析不了时不动
 */
function withTarget(yaml: string, key: 'table' | 'view' | 'entity', value: string) {
  const doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) return yaml;
  const other = key === 'table' ? 'view' : key === 'view' ? 'table' : null;
  const swapped = other && doc.contents.items.find(i => isScalar(i.key) && i.key.value === other);
  if (!swapped && doc.get(key) === value) return yaml;
  if (swapped && isScalar(swapped.key)) swapped.key.value = key;
  doc.set(key, value);
  if (key === 'table') doc.delete('view_key');
  return doc.toString();
}

/** 表下拉框的取值：源视图前加 view: 与同名的源表区分 */
const VIEW_PREFIX = 'view:';
const inputValue = (t: { name: string; view?: true }) => (t.view ? `${VIEW_PREFIX}${t.name}` : t.name);

/**
 * 新建映射的表单：选数据源、用表单或 YAML 编写映射。表与目标实体两个下拉框决定表单列哪些字段、对照面板显示什么（默认取 YAML 里写的），
 * 也是「按规则生成草稿」的输入；换选时一并写进 YAML 的 table / entity，保存时以 YAML 里写的为准
 */
function NewMapping({ sources, tables, registered, functions, values, submitting }: {
  sources: LoaderData['sources'];
  tables: LoaderData['tables'];
  registered: LoaderData['registered'];
  functions: LoaderData['functions'];
  values: { sourceId: string; yaml: string };
  submitting: boolean;
}) {
  const [sourceId, setSourceId] = useState(values.sourceId);
  const [yaml, setYaml] = useState(values.yaml);
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
  const selectInput = (value: string) => {
    setInputName(value);
    setYaml(y => (value.startsWith(VIEW_PREFIX) ? withTarget(y, 'view', value.slice(VIEW_PREFIX.length)) : withTarget(y, 'table', value)));
  };
  return (
    <Form method="post">
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="mapping-source">数据源</FieldLabel>
            <NativeSelect id="mapping-source" name="sourceId" value={sourceId} onChange={e => setSourceId(e.target.value)}>
              {sources.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-table">表或源视图</FieldLabel>
            <NativeSelect id="mapping-table" name="table" value={table ? inputValue(table) : ''} onChange={e => selectInput(e.target.value)} disabled={!sourceTables.length}>
              {sourceTables.map(t => <NativeSelectOption key={inputValue(t)} value={inputValue(t)}>{t.view ? `源视图 ${t.name}` : t.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="mapping-entity">目标实体</FieldLabel>
            <NativeSelect id="mapping-entity" name="entity" value={entity} onChange={e => { setEntity(e.target.value); setYaml(y => withTarget(y, 'entity', e.target.value)); }}>
              {entities.map(e => <NativeSelectOption key={e.name} value={e.name}>{`${e.label}（${e.name}）`}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel>映射</FieldLabel>
          <MappingEditorWithReference defaultValue={values.yaml} value={yaml} onValueChange={setYaml} table={table} entity={entity} registered={registered} functions={functions} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" name="intent" value="create" disabled={submitting || !sources.length}>{submitting ? '正在处理…' : '校验并保存草稿'}</Button>
          <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !table || !!table.view} title={table?.view ? '按规则生成草稿要用源表的列统计，源视图请直接编写' : '按列名、类型与常见取值生成，替换编辑框里的内容；不会保存'}>
            按规则生成草稿
          </Button>
        </div>
      </FieldGroup>
    </Form>
  );
}

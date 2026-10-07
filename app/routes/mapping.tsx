// app/routes/mapping.tsx —— 单个映射：各版本（已发布的锁定、草稿可改）、编辑与丢弃草稿（数据工程师、管理员）、发布草稿（需最后保存它的人以外的
// 另一位有发布权限的成员，最后保存的人看到不能发布的原因，租户里只有自己有发布权限时提示先邀请成员；编辑框旁对照源表的列统计与实体的标准字段（自定义实体对照它已发布登记的字段）；
// 可按规则重新生成草稿填进编辑框，不保存），以及这个映射每次合并到标准层的结果；实体是还没有已发布登记的自定义实体时顶部提示待补登、链接到实体页；有已发布版本时可以立即合并这一个映射。
// 页面分编辑、版本、合并记录三个标签页（?tab=edit|versions|merges，默认编辑），编辑页显示 ?version=N 选中的版本（默认最新）；
// 合并记录里落入兜底的取值可一键加进值对照（?tab=edit&field=<字段>&add=<取值>…：表单定位到该字段，取值作为待对应的行）；
// 编辑页可空跑正在查看的版本：在原始层样本上转换，编辑框下方展示样例行（敏感字段是哈希）与基础断言，不写标准层；
// 查看草稿时在编辑框上方展示它与最新已发布版本的差异（列级与去重键、取最新字段、身份打通匹配字段），供审阅者决定是否发布
import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, FileDiff, FlaskConical, PencilLine, Play } from 'lucide-react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/mapping';
import { can, requirePermission } from '~/.server/access';
import { customEntityPages, customEntityRegistrations } from '~/.server/custom-entities';
import { discardDraft, draftForMapping, dryRunMapping, getMapping, MappingError, mergeMapping, publishMapping, referenceTables, saveDraft } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { publishReason } from '~/.server/publish-rules';
import { fallbackText } from '~/lib/fallback';
import { functionList } from '~/lib/mapping-expr';
import { isEnumField } from '~/lib/mapping-form';
import type { ColumnField, PlanDiff } from '~/lib/mapping-diff';
import type { DryRunResult } from '~/.server/pipeline/dry-run-engine';
import type { FallbackStat } from '~/.server/pipeline/merge-engine';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { entityLabel, entityOf, isCustomEntity } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { DraftActions, VersionStatus } from '~/components/draft-version';
import { KindIcon } from '~/components/kind-icon';
import { MappingEditor, MappingErrors } from '~/components/mapping-editor';
import { MappingEditorWithReference } from '~/components/mapping-reference';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { StatTile } from '~/components/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.mapping.entityLabel} ← ${loaderData.mapping.table}` : '映射'} · CRM 数据分析平台` }];
}

type Tab = 'edit' | 'versions' | 'merges';
const TABS: Tab[] = ['edit', 'versions', 'merges'];
const tabOf = (request: Request): Tab => {
  const tab = new URL(request.url).searchParams.get('tab');
  return TABS.find(t => t === tab) ?? 'edit';
};

const focusOf = (url: URL) => {
  const field = url.searchParams.get('field');
  return field ? { field, add: url.searchParams.getAll('add') } : null;
};

/** 只留映射实体那一条登记，不把整个租户的登记都下发到页面 */
const registrationOf = <T,>(all: Record<string, T>, entity: string): Record<string, T> => (entity in all ? { [entity]: all[entity] } : {});

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const m = await getMapping(member, params.mappingId);
    const canWrite = can(member.role, 'sources:write');
    const url = new URL(request.url);
    const customPage = (await customEntityPages(member, [m.entity]))[m.entity];
    return {
      email: member.email,
      nav: navFor(member),
      tab: tabOf(request),
      /** 编辑页显示的版本（?version=N，没有这一版时为 null，显示最新的一版） */
      version: Number(url.searchParams.get('version')) || null,
      /** 表单定位到的字段与要加进它值对照表的源值（?field=&add=） */
      focus: focusOf(url),
      canWrite,
      functions: functionList(),
      mapping: {
        id: m.id,
        source: m.source,
        table: m.tableName,
        entity: m.entity,
        entityLabel: customPage?.label ?? entityLabel(m.entity),
        /** 实体卡片的去处：自定义实体是它的实体页（推断不出登记时是实体列表），标准实体是标准模型页 */
        entityPage: customPage?.href ?? '/model',
        /** 编辑草稿时对照的源表（还没采集、不在同步范围时为 null；不能编辑时不给） */
        reference: canWrite ? ((await referenceTables(member, m.source.id)).find(t => t.name === m.tableName && !!t.view === !!m.sourceViewId) ?? null) : null,
        /** 映射的实体是已发布登记的自定义实体时，编辑草稿对照的登记（只给这一条；不能编辑时不给） */
        registered: canWrite ? registrationOf(await customEntityRegistrations(member), m.entity) : {},
        /** 实体是还没有已发布登记的自定义实体时，去补登的实体页（推断不出登记时是实体列表）；否则为 null */
        pendingEntity: customPage?.pending ? customPage.href : null,
      },
      versions: m.versions.map(v => ({
        ...v,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        updatedAt: v.updatedAt.toISOString(),
        /** 当前成员发布不了这一版草稿的原因（没有发布权限、最后保存的是自己、租户里没有别人能发布）；可以发布或不是草稿时为 null */
        publishBlocker: publishReason(member, v, m.publishers),
      })),
      /** 草稿相对最新已发布版本 against 的差异；没有草稿时为 null */
      draftDiff: m.draftDiff,
      /** 草稿改了主键的键空间（from → to，未声明为 null）且有要一起改的同源引用映射时才有（只是提示，不阻止发布）；否则为 null */
      keySpaceChange: m.keySpaceChange && m.keySpaceFollowers.length ? { ...m.keySpaceChange, followers: m.keySpaceFollowers } : null,
      merge: {
        status: m.merge.status,
        statusLabel: m.merge.status === 'none' ? '未合并' : TASK_STATUS_LABELS[m.merge.status],
        history: m.merge.history,
      },
    };
  } catch (e) {
    if (e instanceof MappingError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'draft':
        // 只生成、填进编辑框，不保存；draftId 让编辑框换成新内容
        return { error: null, issues: [], yaml: await draftForMapping(await requirePermission(request, 'sources:write'), params.mappingId), draftId: crypto.randomUUID(), dryRun: null };
      case 'dryrun': {
        // 只转换样本、展示结果，不保存，也不写标准层
        const version = Number(field('version'));
        return { error: null, issues: [], yaml: null, draftId: null, dryRun: { version, ...await dryRunMapping(await requirePermission(request, 'sources:write'), params.mappingId, version) } };
      }
      case 'save':
        await saveDraft(await requirePermission(request, 'sources:write'), params.mappingId, field('yaml'));
        break;
      case 'publish':
        await publishMapping(await requirePermission(request, 'publish'), params.mappingId, Number(field('version')));
        break;
      case 'merge':
        await mergeMapping(await requirePermission(request, 'sources:write'), params.mappingId);
        break;
      case 'discard': {
        // 从没发布过的映射整个删除，回到映射列表
        const { kept } = await discardDraft(await requirePermission(request, 'sources:write'), params.mappingId);
        if (!kept) throw redirect('/mappings');
        break;
      }
      default:
        return data({ error: '未知操作', issues: [], yaml: null, draftId: null, dryRun: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MappingError) return data({ error: e.message, issues: e.issues, yaml: field('yaml') || null, draftId: null, dryRun: null }, { status: e.status });
    throw e;
  }
  // 回到提交时所在的标签页
  const tab = tabOf(request);
  throw redirect(`/mappings/${params.mappingId}${tab === 'edit' ? '' : `?tab=${tab}`}`);
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

type LoaderData = Route.ComponentProps['loaderData'];
type MergeEntry = LoaderData['merge']['history'][number];

/** 一列落入兜底的情况，字段用实体上的名称（见 fallbackText） */
const columnFallbackText = (entity: string, f: FallbackStat, what?: string) =>
  fallbackText(entityOf(entity)?.fields.find(x => x.name === f.column)?.label ?? f.column, f, what);

/** 把落入兜底的取值加进值对照：打开编辑标签页的表单，定位到该字段（只用于标准枚举字段） */
const addToDictionaryHref = (base: string, f: FallbackStat) =>
  `${base}?${new URLSearchParams([['tab', 'edit'], ['field', f.column], ...f.values.map(v => ['add', v.value])])}`;

function MergeRow({ e, base, canWrite }: { e: MergeEntry; base: string; canWrite: boolean }) {
  if ('error' in e || 'skipped' in e) {
    return (
      <TableRow data-merge-error={'error' in e ? true : undefined}>
        <TableCell>{`v${e.version}`}</TableCell>
        <TableCell colSpan={3} className={`whitespace-normal ${'error' in e ? 'text-destructive' : 'text-muted-foreground'}`}>
          {'error' in e ? `失败：${e.error}` : `跳过：${e.skipped}`}
        </TableCell>
        <TableCell>{time(e.startedAt)}</TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow data-merge-mode={e.mode}>
      <TableCell>{`v${e.version}`}</TableCell>
      <TableCell>{e.mode === 'rebuild' ? `重建（批次 1–${e.batchTo}）` : e.batchTo === e.batchFrom ? '增量（无新批次）' : `增量（批次 ${e.batchFrom + 1}–${e.batchTo}）`}</TableCell>
      <TableCell className="whitespace-normal">
        {`${e.rows.toLocaleString('zh-CN')} 行（新增 ${e.inserted}，更新 ${e.updated}，删除 ${e.deleted}）`}
        {e.fallback?.map(f => (
          <div key={f.column} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-merge-fallback={f.column}>
            {columnFallbackText(e.entity, f)}
            {canWrite && isEnumField(entityOf(e.entity)?.fields.find(x => x.name === f.column)) && (
              <Button asChild size="xs" variant="outline"><Link to={addToDictionaryHref(base, f)} data-add-to-dictionary={f.column}>加进值对照</Link></Button>
            )}
          </div>
        ))}
      </TableCell>
      <TableCell>{duration(e.durationMs)}</TableCell>
      <TableCell>{time(e.startedAt)}</TableCell>
    </TableRow>
  );
}

/** 一条断言：通过时绿色对勾，否则按严重程度标红（合并会失败）或标黄（合并照常，值得留意） */
function Assertion({ name, ok, severe, children }: { name: string; ok: boolean; severe?: boolean; children: React.ReactNode }) {
  const tone = ok ? 'text-emerald-600' : severe ? 'text-red-600' : 'text-amber-600';
  return (
    <li className={`flex items-start gap-2 text-sm ${tone}`} data-assertion={name} data-ok={ok}>
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
      <span className="whitespace-normal">{children}</span>
    </li>
  );
}

/** 空跑结果：基础断言与转换后的样例行（敏感字段是加盐哈希，空值显示为 —） */
function DryRunPanel({ entity, result }: { entity: string; result: DryRunResult & { version: number } }) {
  const { assertions: a, columns, rows, sampled } = result;
  const label = (name: string) => entityOf(entity)?.fields.find(f => f.name === name)?.label ?? name;
  const keys = a.key.map(label).join('、');
  return (
    <section className="mt-6 space-y-4 border-t pt-6" data-dryrun={result.version}>
      <div>
        <h2 className="font-semibold">{`空跑 v${result.version}`}</h2>
        <p className="max-w-2xl text-sm text-slate-500">{`取原始层里最新的 ${sampled} 条记录（最多 ${result.limit} 条）转换，没有写进标准层。`}</p>
      </div>
      <ul className="space-y-1.5">
        <Assertion name="key-nulls" ok={!a.keyNulls} severe>{a.keyNulls ? `去重键（${keys}）有 ${a.keyNulls} 行为空，合并会失败` : `去重键（${keys}）都不为空`}</Assertion>
        <Assertion name="key-unique" ok={!a.keyDuplicates}>{a.keyDuplicates ? `${a.keyDuplicates} 个去重键出现在不止一行，合并时只取最新的一行` : '去重键在样本里都唯一'}</Assertion>
        {Object.entries(a.requiredNulls).filter(([name]) => !a.key.includes(name)).map(([name, nulls]) => (
          <Assertion key={name} name={`required-${name}`} ok={!nulls}>{nulls ? `必填字段${label(name)}有 ${nulls} 行为空` : `必填字段${label(name)}都不为空`}</Assertion>
        ))}
        {a.unknownValues.map(u => (
          <Assertion key={u.column} name={`unknown-${u.column}`} ok={false} severe={!u.fallback}>
            {u.fallback ? columnFallbackText(entity, u) : `${columnFallbackText(entity, u, '不在值字典里')}，没写兜底值，合并会失败`}
          </Assertion>
        ))}
      </ul>
      <div className="overflow-x-auto rounded-2xl border bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(c => (
                <TableHead key={c.name} data-dryrun-column={c.name}>
                  <span className="block font-mono">{c.name}</span>
                  <span className="block text-xs font-normal text-slate-400">{`${c.sensitive ? '哈希 · ' : ''}空 ${c.nulls}/${sampled}`}</span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} data-dryrun-row>
                {columns.map(c => (
                  <TableCell key={c.name} className={`max-w-[16rem] truncate ${c.sensitive ? 'font-mono text-xs' : ''}`} title={r[c.name] == null ? undefined : String(r[c.name])}>
                    {r[c.name] == null ? <span className="text-slate-400">—</span> : String(r[c.name])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-center text-slate-500">源表在原始层里没有记录</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

const COLUMN_FIELD_LABELS: Record<ColumnField, string> = { type: '类型', expr: '表达式', dictionary: '值字典', otherwise: '兜底', sensitive: '敏感标记', keySpace: '键空间' };

/** 草稿与最新已发布版本的差异：首个版本、没有差异，或逐项列出列与去重 / 身份打通 / 键空间配置的变化 */
function DraftDiff({ entity, version, diff }: { entity: string; version: number; diff: PlanDiff & { against: number | null } }) {
  const label = (name: string) => {
    const l = entityOf(entity)?.fields.find(f => f.name === name)?.label;
    return <>{l && `${l} `}<span className="font-mono">{name}</span></>;
  };
  const fieldList = (list: string[] | null, none = '—') => (list?.length ? list.map((n, i) => <span key={n}>{i > 0 && '、'}{label(n)}</span>) : none);
  const latestText = (name: string | null) => (name ? label(name) : '最近同步到的一行');
  return (
    <section className="mb-4 rounded-xl border bg-slate-50 p-4" data-draft-diff={version}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <FileDiff className="size-4 text-amber-600" />
        {diff.first ? `v${version} 是首个版本` : `v${version} 与已发布 v${diff.against} 的差异`}
      </h2>
      {diff.first ? (
        <p className="mt-1 text-sm text-slate-500">还没有已发布的版本，发布后这一版的全部列与去重规则生效。</p>
      ) : diff.empty ? (
        <p className="mt-1 text-sm text-slate-500" data-diff-item="none">合并计划与已发布版本相同（只改了注释或写法）。</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {diff.added.map(n => <li key={`added-${n}`} data-diff-item={`added-${n}`}>新增列 {label(n)}</li>)}
          {diff.removed.map(n => <li key={`removed-${n}`} data-diff-item={`removed-${n}`}>删除列 {label(n)}</li>)}
          {diff.changed.map(c => <li key={`changed-${c.name}`} data-diff-item={`changed-${c.name}`}>{label(c.name)} 改了{c.fields.map(f => COLUMN_FIELD_LABELS[f]).join('、')}</li>)}
          {diff.key && <li data-diff-item="key">去重键：{fieldList(diff.key.from)} → {fieldList(diff.key.to)}</li>}
          {diff.latest && <li data-diff-item="latest">取最新字段：{latestText(diff.latest.from)} → {latestText(diff.latest.to)}</li>}
          {diff.identity && <li data-diff-item="identity">身份打通匹配字段：{fieldList(diff.identity.from, '平台默认')} → {fieldList(diff.identity.to, '平台默认')}</li>}
          {diff.keySpace && <li data-diff-item="key-space">键空间：<span className="font-mono">{diff.keySpace.from ?? '—'}</span> → <span className="font-mono">{diff.keySpace.to ?? '—'}</span></li>}
        </ul>
      )}
    </section>
  );
}

export default function Mapping({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tab, version, focus, canWrite, functions, mapping, versions, draftDiff, keySpaceChange, merge } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const draft = versions.find(v => v.status === 'draft');
  const live = versions.find(v => v.status === 'published');
  const selected = versions.find(v => v.version === version) ?? versions[0];
  const lastMerge = merge.history[0];
  const base = `/mappings/${mapping.id}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={<span className="flex items-center gap-3">{mapping.entityLabel}<span className="text-slate-300">←</span><span className="font-mono text-2xl text-slate-500">{mapping.table}</span></span>}
        description={<Link to="/mappings" className="hover:underline">← 全部映射</Link>}
        actions={
          <>
            {draft && <DraftActions v={draft} canDiscard={canWrite} discardHint={live ? '回到最近的已发布版本' : '这个映射从没发布过，将被删除'} submitting={submitting} />}
            {canWrite && live && (
              <Form method="post">
                <input type="hidden" name="intent" value="merge" />
                <Button type="submit" variant="outline" disabled={submitting} title="只合并这个映射已发布的最新版本"><Play />立即合并</Button>
              </Form>
            )}
          </>
        }
      />

      {mapping.pendingEntity && (
        <Alert role="status">
          <AlertTriangle />
          <AlertTitle>{`实体待补登：${mapping.entity} 还没有已发布的登记`}</AlertTitle>
          <AlertDescription>
            <p>
              登记发布前，这个映射保存不了新草稿；已发布的版本照常合并。
              <Link to={mapping.pendingEntity} className="underline">去实体页确认登记</Link>，再由另一位成员发布。
            </p>
          </AlertDescription>
        </Alert>
      )}
      {keySpaceChange && (
        <Alert role="status" data-key-space-followers>
          <AlertTriangle className="text-amber-600" />
          <AlertTitle>{`主键的键空间由 ${keySpaceChange.from ?? '未声明'} 改为 ${keySpaceChange.to ?? '未声明'}`}</AlertTitle>
          <AlertDescription>
            <p>同一数据源里这些已发布映射的引用字段还按旧的键空间写，关系会对不上。请把它们改成{keySpaceChange.to ? ` key_space: ${keySpaceChange.to}` : '不写键空间'}，与本映射一起改、一起发布（本映射先发布）：</p>
            <ul className="mt-1 space-y-0.5">
              {keySpaceChange.followers.map(f => (
                <li key={f.mapping}>
                  <Link to={`/mappings/${f.mapping}`} className="font-mono underline">{f.table}</Link>
                  <span className="text-slate-500">{`（${f.entity}）`}</span>
                  {f.fields.map(field => <code key={field} className="ml-2" data-key-space-follower-field={field}>{field}</code>)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {actionData?.error && <MappingErrors error={actionData.error} issues={actionData.issues} />}

      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr_1.2fr]">
        <Link to={`/sources/${mapping.source.id}`} className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md">
          <KindIcon kind={mapping.source.kind} />
          <span className="min-w-0">
            <span className="block text-xs text-slate-500">源表</span>
            <span className="block truncate font-medium">{mapping.source.name} / <span className="font-mono">{mapping.table}</span></span>
          </span>
        </Link>
        <div className="hidden place-items-center text-slate-300 lg:grid"><ArrowRight className="size-6" /></div>
        <Link to={mapping.entityPage} className="flex items-center gap-3 rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-violet-100 text-violet-700"><Boxes className="size-5" /></span>
          <span className="min-w-0">
            <span className="block text-xs text-slate-500">{isCustomEntity(mapping.entity) ? '自定义实体' : '标准实体'}</span>
            <span className="block truncate font-medium">{`${mapping.entityLabel}（${mapping.entity}）`}</span>
          </span>
        </Link>
        <div className="grid grid-cols-2 gap-4">
          <StatTile
            label="线上版本"
            value={live ? `v${live.version}` : '—'}
            hint={draft ? <span className="inline-flex items-center gap-1 text-amber-600"><PencilLine className="size-3" />{`有草稿 v${draft.version}`}</span> : live ? '已发布的最新版本' : '还没有发布'}
          />
          <StatTile
            label={<span className="inline-flex items-center gap-1">{merge.status === 'failed' && <AlertTriangle className="size-3.5 text-red-600" />}{`最近合并 · ${merge.statusLabel}`}</span>}
            value={lastMerge && 'rows' in lastMerge ? lastMerge.rows.toLocaleString('zh-CN') : '—'}
            hint="标准层行数"
            tone={merge.status === 'failed' ? 'text-red-600' : undefined}
          />
        </div>
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'edit', label: '编辑', href: base },
          { key: 'versions', label: `版本（${versions.length}）`, href: `${base}?tab=versions` },
          { key: 'merges', label: `合并记录（${merge.history.length}）`, href: `${base}?tab=merges` },
        ]}
      />

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        {tab === 'edit' && selected && (
          <>
            <div className="mb-4 space-y-1">
              <div className="flex items-center gap-2 text-sm text-slate-500">正在查看 <span className="font-mono font-semibold text-slate-900">{`v${selected.version}`}</span><VersionStatus v={selected} /></div>
              <p className="max-w-2xl text-sm text-slate-500">
                {canWrite
                  ? selected.status === 'draft' ? '保存后你是最后改这一版草稿的人，需由另一位数据工程师或管理员发布。' : draft ? `已发布的版本锁定。已有草稿 v${draft.version}，请在草稿上修改。` : '已发布的版本锁定，在这一版的基础上修改，保存为新的一版草稿。'
                  : '只读。'}
              </p>
            </div>
            {selected.status === 'draft' && draftDiff && <DraftDiff entity={mapping.entity} version={selected.version} diff={draftDiff} />}
            {canWrite && (selected.status === 'draft' || !draft) ? (
              <Form method="post" className="space-y-3" key={`${selected.version}-${actionData?.draftId ?? ''}`}>
                <MappingEditorWithReference defaultValue={actionData?.yaml ?? selected.yaml} table={mapping.reference} entity={mapping.entity} registered={mapping.registered} functions={functions} focus={focus} />
                <div className="flex gap-2">
                  <Button type="submit" name="intent" value="save" disabled={submitting}>
                    {submitting ? '正在处理…' : selected.status === 'draft' ? '校验并保存草稿' : '校验并保存为新草稿'}
                  </Button>
                  <Button type="submit" name="intent" value="draft" variant="outline" disabled={submitting || !mapping.reference} title="按列名、类型与常见取值生成，替换编辑框里的内容；不会保存">
                    按规则生成草稿
                  </Button>
                </div>
              </Form>
            ) : (
              <MappingEditor key={selected.version} defaultValue={selected.yaml} readOnly />
            )}
            {canWrite && (
              <Form method="post" className="mt-4 flex flex-wrap items-center gap-3">
                <input type="hidden" name="intent" value="dryrun" />
                <input type="hidden" name="version" value={selected.version} />
                <Button type="submit" variant="outline" disabled={submitting}><FlaskConical />{`空跑 v${selected.version}`}</Button>
                <span className="text-sm text-slate-500">在原始层最新的样本上转换已保存的这一版，看样例行与基础断言；编辑框里没保存的修改不参与，也不写标准层。</span>
              </Form>
            )}
            {actionData?.dryRun && actionData.dryRun.version === selected.version && <DryRunPanel entity={mapping.entity} result={actionData.dryRun} />}
          </>
        )}

        {tab === 'versions' && (
          <>
            <p className="mb-4 max-w-2xl text-sm text-slate-500">已发布的版本锁定，修改会形成新的一版草稿；草稿需由最后保存它的人以外的另一位数据工程师或管理员发布，也可以丢弃。</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>作者</TableHead>
                  <TableHead>发布</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map(v => (
                  <TableRow key={v.version} data-version={v.version} data-version-status={v.status}>
                    <TableCell className="font-mono font-semibold">{`v${v.version}`}</TableCell>
                    <TableCell><VersionStatus v={v} /></TableCell>
                    <TableCell className="text-sm">{v.authors.join('、')}</TableCell>
                    <TableCell className="text-sm text-slate-500">{v.publishedBy ? `${v.publishedBy}，${time(v.publishedAt)}` : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost"><Link to={`${base}?version=${v.version}`}>查看</Link></Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {tab === 'merges' && (
          <>
            <p className="mb-4 max-w-2xl text-sm text-slate-500">
              {merge.status === 'failed' && <AlertTriangle className="mr-1 inline size-3.5 text-red-600" />}
              {`这个映射最近一次合并：${merge.statusLabel}。发布后、以及同步给这个映射的源表写入了变更后，已发布的最新版本把原始层的新批次合并进标准层；换了版本时由全部批次重建。写了兜底值的字段，每次合并列出本次落入兜底的取值。`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>方式</TableHead>
                  <TableHead>标准层行数</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>开始时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {merge.history.map((e, i) => <MergeRow key={`${e.taskId}-${i}`} e={e} base={base} canWrite={canWrite} />)}
                {!merge.history.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-slate-500">还没有合并过</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </AppShell>
  );
}

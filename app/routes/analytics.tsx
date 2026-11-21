// app/routes/analytics.tsx —— 分析（有结果层查看权限的成员）：本租户分析模板任务产出的结果快照（带所用的模板定义版本与来源），最新的在前；已过期的标灰、不能打开，登记时数据不完整的标「数据不完整」（详情在快照页）。
// 快照表标明类型（分析模板 / 指标 / 标签）与归属（系统内置 / 自建 · 创建人），可按定义筛选（?definition=<template>）；
// 有定义查看权限的成员从这里进入每个已登记模板的参数页，有起草权限的成员从这里新建指标或标签；指标与标签（template 为 metric:<键>、tag:<键>）的快照链接到它们的定义页（ADR-0025）。
// 快照表之下另有「指标与标签」面板（有 definitions:read 才渲染，#798）：列出本租户全部定义（含只有草稿、未计算的），可按类型与状态筛选（?type= 与 ?status=，走 URL）
import { Plus, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { Route } from './+types/analytics';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { listDefinitions, type DefinitionSummary } from '~/.server/dsl-definitions';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { listSnapshots, SNAPSHOT_RETENTION_DAYS, triggerLabel, type SnapshotTemplate } from '~/.server/snapshots';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { StatusText, TASK_TONES } from '~/components/status-text';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { builtinName } from '~/lib/builtin-names';
import { useT, type T } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/** 指标与标签快照的 template：<种类>:<键> */
const DSL_TEMPLATE = /^(metric|tag):(.+)$/;

const TYPE_LABELS = { template: '分析模板', metric: '指标', tag: '标签' } as const;

/** 类型名与模板名都是平台内置名称：展示处按界面语言翻译（ADR-0060），存储与链接仍用原值。
 *  写成字面量 t('…') 的对照表（照 api-keys 的 scopeLabel）才能与词典对账 */
const typeLabel = (t: T, kind: keyof typeof TYPE_LABELS) =>
  ({ template: t('分析模板'), metric: t('指标'), tag: t('标签') })[kind];

/** 定义列表的状态筛选值与说明 */
const STATUS_TABS = [
  { key: 'draft', label: '有草稿' },
  { key: 'unpublished', label: '未发布' },
  { key: 'published', label: '已发布' },
] as const;

/** 定义是否符合状态筛选：有生效版本又有草稿的同时符合「有草稿」与「已发布」 */
function matchesStatus(d: DefinitionSummary, status: (typeof STATUS_TABS)[number]['key']) {
  switch (status) {
    case 'draft': return !!d.draft;
    case 'unpublished': return d.published === null;
    case 'published': return d.published !== null;
  }
}

/** 自建定义的归属文案；创建人未知时只写「自建」 */
const selfBuilt = (creator: string | null) => (creator ? `自建 · ${creator}` : '自建');

export function meta({}: Route.MetaArgs) {
  return [{ title: '分析 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'results:read');
  const url = new URL(request.url);
  // 筛选参数只认已知的值，非法值当作不筛选
  const typeParam = url.searchParams.get('type');
  const typeFilter = typeParam === 'metric' || typeParam === 'tag' ? typeParam : null;
  const statusFilter = STATUS_TABS.find(t => t.key === url.searchParams.get('status'))?.key ?? null;
  /** 快照表按定义（快照的 template）筛选 */
  const definitionFilter = url.searchParams.get('definition') || null;
  const canReadDefinitions = can(member.role, 'definitions:read');
  const snapshots = await listSnapshots(member.tenant.id, definitionFilter ?? undefined);
  const all = canReadDefinitions ? await listDefinitions(member) : [];
  /**
   * 「最近计算」在服务端拼好：最新一张快照写成「统计日 · 来源 · N 行」（来源用 triggerLabel 翻成中文），还没有快照时为 null；
   * 任务状态的文案也在服务端翻好（~/.server/tasks 不能进客户端构建，色调由组件按 status 查 TASK_TONES）
   */
  const lastRunWithLabel = (run: DefinitionSummary['lastRun']) =>
    run
      ? {
          snapshot: run.rowCount === null ? null : `${run.asOf ?? '—'} · ${triggerLabel(run.trigger)} · ${run.rowCount} 行`,
          status: run.status,
          statusLabel: run.status ? TASK_STATUS_LABELS[run.status] : null,
        }
      : null;
  const byTemplate = new Map(all.map(d => [`${d.kind}:${d.key}`, d]));
  return {
    email: member.email,
    nav: navFor(member),
    canReadDefinitions,
    canDraftDefinitions: can(member.role, 'definitions:draft'),
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    typeFilter,
    statusFilter,
    definitionFilter,
    /**
     * 快照表「按定义筛选」的选项：系统内置模板 + 本租户的定义（有定义查看权限才列定义）。
     * 只返回原名（模板名 / 类型 + 定义键），选项文字在渲染处按界面语言翻译
     */
    definitionOptions: [
      ...Object.entries(TEMPLATES).map(([id, t]) => ({ value: id, kind: 'template' as const, name: t.label })),
      ...all.map(d => ({ value: `${d.kind}:${d.key}`, kind: d.kind, key: d.key })),
    ],
    /** 本租户是否一个定义都没有（筛选后为空与没有任何定义的空状态不同） */
    hasAnyDefinitions: all.length > 0,
    definitions: all
      .filter(d => (!typeFilter || d.kind === typeFilter)
        && (!statusFilter || matchesStatus(d, statusFilter)))
      .map(d => ({
        kind: d.kind,
        key: d.key,
        /** 自建定义的创建人；老数据里没有时为 null（页面只写「自建」） */
        creator: d.creator,
        published: d.published,
        draft: d.draft && { version: d.draft.version, lastEditor: d.draft.lastEditor, updatedAt: d.draft.updatedAt.toISOString() },
        /** 最近一次计算：统计日、任务状态与其文案 */
        lastRun: lastRunWithLabel(d.lastRun),
      })),
    /** 每个已登记模板的参数入口（名称是注册表常量，按钮文字在渲染处按界面语言翻译） */
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })),
    snapshots: snapshots.map(s => {
      const dsl = DSL_TEMPLATE.exec(s.template);
      let kind: keyof typeof TYPE_LABELS = 'template';
      if (dsl) kind = dsl[1] === 'tag' ? 'tag' : 'metric';
      return {
        id: s.id,
        /** 类型：系统内置的分析模板，或成员自建的指标 / 标签 */
        kind,
        /**
         * 归属：系统内置（TEMPLATES 里的模板，包括已下线的旧值）或自建（成员创建的指标 / 标签，带创建人）。
         * 没有定义查看权限或定义已删时创建人不显示，只写「自建」
         */
        origin: dsl
          ? { builtIn: false as const, creator: byTemplate.get(s.template)?.creator ?? null }
          : { builtIn: true as const },
        /** 模板名（或指标 / 标签的定义键，键不翻译）；模板名在渲染处按界面语言翻译 */
        templateLabel: dsl ? dsl[2]! : TEMPLATES[s.template as SnapshotTemplate]?.label ?? s.template,
        /** 指标与标签的快照链接到定义页，其余链接到快照页 */
        href: dsl ? `/analytics/definitions/${dsl[1]}/${dsl[2]}` : `/analytics/snapshots/${s.id}`,
        asOf: typeof s.params.asOf === 'string' ? s.params.asOf : null,
        definitionVersion: s.definitionVersion,
        /** 来源（发布、回刷、定时刷新、手动）；老快照没记时为「—」 */
        trigger: triggerLabel(s.trigger),
        rowCount: s.rowCount,
        expired: !!s.expiredAt,
        incomplete: !!s.incomplete,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      };
    }),
  };
}

const time = (iso: string) => new Date(iso).toLocaleString('zh-CN');

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const {
    email, nav, canReadDefinitions, canDraftDefinitions, retentionDays, templates, snapshots,
    typeFilter, statusFilter, definitionFilter, definitionOptions, hasAnyDefinitions, definitions,
  } = loaderData;
  const t = useT();
  /** 筛选链接：改一组参数时保留另外两组 */
  const href = (over: { type?: string | null; status?: string | null; definition?: string | null }) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries({ type: typeFilter, status: statusFilter, definition: definitionFilter, ...over })) {
      if (value) params.set(name, value);
    }
    const query = params.toString();
    return query ? `/analytics?${query}` : '/analytics';
  };
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="分析" description={`分析模板每次运行在结果层写下一份快照，只含 consumer_id 与分值，保留 ${retentionDays} 天。点开快照查看各人群与消费者明细。`}
        actions={(canReadDefinitions || canDraftDefinitions) && (
          <>
            {canReadDefinitions && templates.map(tpl => (
              <Button key={tpl.id} asChild variant="outline"><Link to={`/analytics/templates/${tpl.id}`}><SlidersHorizontal />{t('{name} 模板参数', { name: builtinName(t, tpl.label) })}</Link></Button>
            ))}
            {canDraftDefinitions && <Button asChild variant="outline"><Link to="/analytics/definitions/new?kind=tag"><Plus />新建标签</Link></Button>}
            {canDraftDefinitions && <Button asChild><Link to="/analytics/definitions/new?kind=metric"><Plus />新建指标</Link></Button>}
          </>
        )}
      />

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">结果快照</h2>
          <form method="get" action="/analytics" className="flex items-center gap-2 text-sm">
            {typeFilter && <input type="hidden" name="type" value={typeFilter} />}
            {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
            <label htmlFor="snapshot-definition" className="text-slate-500">按定义筛选</label>
            <select id="snapshot-definition" name="definition" defaultValue={definitionFilter ?? ''} className="rounded-lg border bg-white px-2 py-1.5">
              <option value="">全部</option>
              {definitionOptions.map(o => (
                <option key={o.value} value={o.value}>
                  {o.kind === 'template'
                    ? t('{name}（分析模板）', { name: builtinName(t, o.name) })
                    : `${typeLabel(t, o.kind)} ${o.key}`}
                </option>
              ))}
            </select>
            <Button type="submit" variant="outline" size="sm">筛选</Button>
          </form>
        </div>
        {snapshots.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>类型</TableHead>
                <TableHead>归属</TableHead>
                <TableHead>模板</TableHead>
                <TableHead>参考日期</TableHead>
                <TableHead>参数</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>消费者</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map(s => {
                // 模板快照的模板名按界面语言翻译；指标 / 标签的 templateLabel 是定义键，不翻
                const templateName = s.kind === 'template' ? builtinName(t, s.templateLabel) : s.templateLabel;
                return (
                <TableRow key={s.id} data-snapshot={s.id} className={cn(s.expired && 'text-slate-400')}>
                  <TableCell><Badge variant="secondary">{typeLabel(t, s.kind)}</Badge></TableCell>
                  <TableCell className="text-slate-500">{s.origin.builtIn ? '系统内置' : selfBuilt(s.origin.creator)}</TableCell>
                  <TableCell>
                    {s.expired ? templateName : <Link to={s.href} className="font-medium hover:underline">{templateName}</Link>}
                  </TableCell>
                  <TableCell>{s.asOf ?? '—'}</TableCell>
                  <TableCell data-definition-version>{s.definitionVersion ? `定义第 ${s.definitionVersion} 版` : '任务参数'}</TableCell>
                  <TableCell data-snapshot-trigger>{s.trigger}</TableCell>
                  <TableCell>{s.rowCount.toLocaleString('zh-CN')}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.createdAt)}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.expiresAt)}</TableCell>
                  <TableCell>
                    {s.expired
                      ? <StatusText tone="none" data-snapshot-status="expired">已过期</StatusText>
                      : s.incomplete
                        ? <StatusText tone="pending" data-snapshot-status="incomplete">数据不完整</StatusText>
                        : <StatusText tone="ok" data-snapshot-status="available">可查看</StatusText>}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-slate-500" data-snapshots-empty>
            {definitionFilter ? '这个定义还没有结果快照。' : '还没有结果快照。RFM 分层等分析模板运行成功后，快照会出现在这里。'}
          </p>
        )}
      </div>

      {canReadDefinitions && (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-1 font-medium">指标与标签</h2>
          <p className="mb-4 max-w-2xl text-sm text-slate-500">本租户的全部定义，包括只有草稿、还没算出快照的。点键进入定义页。</p>
          {hasAnyDefinitions ? (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <PillTabs
                  tabs={[
                    { key: 'all', label: '全部', href: href({ type: null }) },
                    { key: 'metric', label: '指标', href: href({ type: 'metric' }) },
                    { key: 'tag', label: '标签', href: href({ type: 'tag' }) },
                  ]}
                  current={typeFilter ?? 'all'}
                  keepScroll
                />
                <PillTabs
                  tabs={[
                    { key: 'all', label: '全部状态', href: href({ status: null }) },
                    ...STATUS_TABS.map(t => ({ key: t.key, label: t.label, href: href({ status: t.key }) })),
                  ]}
                  current={statusFilter ?? 'all'}
                  keepScroll
                />
              </div>
              {definitions.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>键</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>归属</TableHead>
                      <TableHead>生效版本</TableHead>
                      <TableHead>草稿</TableHead>
                      <TableHead>最近计算</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {definitions.map(d => (
                      <TableRow key={`${d.kind}:${d.key}`} data-definition-row={`${d.kind}:${d.key}`}>
                        <TableCell><Link to={`/analytics/definitions/${d.kind}/${d.key}`} className="font-medium hover:underline">{d.key}</Link></TableCell>
                        <TableCell><Badge variant="secondary">{typeLabel(t, d.kind)}</Badge></TableCell>
                        <TableCell className="text-slate-500">{selfBuilt(d.creator)}</TableCell>
                        <TableCell>{d.published ? `v${d.published}` : '未发布'}</TableCell>
                        <TableCell>{d.draft ? `有草稿 · ${d.draft.lastEditor}` : '—'}</TableCell>
                        <TableCell>
                          {d.lastRun
                            ? (
                                <span className="inline-flex items-center gap-2">
                                  {d.lastRun.snapshot ?? '—'}
                                  {d.lastRun.status && <StatusText tone={TASK_TONES[d.lastRun.status]}>{d.lastRun.statusLabel}</StatusText>}
                                </span>
                              )
                            : '未计算'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-slate-500">没有符合条件的定义。</p>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-500" data-definitions-empty>
              还没有任何指标或标签定义。
              {canDraftDefinitions && <>有起草权限的成员可以<Link to="/analytics/definitions/new" className="mx-1 underline">新建定义</Link>。</>}
            </p>
          )}
        </div>
      )}
    </AppShell>
  );
}

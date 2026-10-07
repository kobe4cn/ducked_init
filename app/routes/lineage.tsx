// app/routes/lineage.tsx —— 数据地图（需登录，任何角色）：关系图画出已接入的标准层表与 _identities、_device_owner 之间的关系，
// 图下服务端渲染一份表与关系的列表；点表节点（?node=）给出按租户湖挂载为 lake 写的示例 SQL。
// _identities 显示匹配规则与最近一次打通的摘要（只有计数）；?all=1 时把未接入的标准实体与它们的内置关系也画出来，灰显。
// 流向图（?tab=flow）画源表 → 映射 → 标准层表 → 打通表，带各映射最近一次合并与标准层表行数（取自任务结果，不查湖），图下同样有一份列表；
// 只对有 sources:read 的成员开放，没有权限时回到关系图，源表名与映射信息都不下发。
// 点已接入的标准层表（关系图 ?node=<entity>，流向图 ?node=silver.<entity>）在右侧抽屉列出字段明细：有 sources:read 时带各映射的源表、源列、表达式、
// 标记与兜底统计，否则只下发字段说明与行数（在 loader 里裁剪）。
// 单表聚焦画布（?tab=flow&focus=<实体>，从抽屉进入）只画这张标准层表与写入它的源表，连线从源列连到字段；同样只对有 sources:read 的成员开放
// 流向图与聚焦画布上可以反向查（?q=列 或 表.列，不区分大小写）：命中的源表、映射、标准层表与连线保持原样，其余变淡；点源表节点（?node=table:<数据源>:<表>）
// 在抽屉里按源列列出它影响的标准层字段。两者都只对有 sources:read 的成员生效。
// 关系图下的「漂移检查」区块列出最近一次漂移检查（lake.inspect）的结果，任何角色可见；有 sources:write 的成员可以触发一次检查。
// 最近一次成功的检查里有差异的标准层表在两张图的节点与图下列表上标出差异种类与数量；孤表在图上没有节点，在区块里单独列出
import { useEffect, useMemo } from 'react';
import { data, Form, Link, redirect, useRevalidator, useSearchParams } from 'react-router';
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Loader2, Search } from 'lucide-react';
import type { Route } from './+types/lineage';
import { can, requirePermission } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { publishedCustomEntities } from '~/.server/custom-entities';
import { getDb } from '~/.server/db/client';
import { getInspectStatus, InspectError, inspectLakeNow } from '~/.server/lake-inspect';
import { lastMergeByMapping, latestIdentitySummary, type MergeHistoryEntry, publishedPlans } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { identityRules } from '~/.server/pipeline/identity-engine';
import { listSources } from '~/.server/sources';
import { TaskError } from '~/.server/tasks';
import type { Drift } from '~/.server/pipeline/inspect-engine';
import { entityOf } from '~/lib/canonical-model';
import { deriveLineage } from '~/lib/lineage';
import { focusGraph, type FocusInput } from '~/lib/lineage-focus';
import { driftAttrs, driftByTable, type DriftByTable } from '~/lib/lineage-drift';
import { entityFields, type FieldDrawer, redactFields } from '~/lib/lineage-fields';
import { type FlowInput, type FlowMerge, silverTotals } from '~/lib/lineage-flow';
import { type SearchHits, searchImpact, tableImpact, type TableImpact } from '~/lib/lineage-search';
import { relationGraph, ruleLabels, sampleSql } from '~/lib/lineage-graph';
import type { SourceKind } from '~/lib/sources';
import { AppShell } from '~/components/app-shell';
import { DriftBadge } from '~/components/drift-badge';
import { KindIcon } from '~/components/kind-icon';
import { LineageDrawer, TableDrawer } from '~/components/lineage-drawer';
import { FocusGraphView } from '~/components/lineage-focus';
import { FlowGraphView, MergeStatus } from '~/components/lineage-flow';
import { RelationGraphView } from '~/components/lineage-graph';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据地图 · CRM 数据分析平台' }];
}

/** 页面的标签页：关系图、流向图（需要 sources:read，没有权限时回到关系图） */
type Tab = 'graph' | 'flow';
const tabOf = (request: Request, canFlow: boolean): Tab =>
  canFlow && new URL(request.url).searchParams.get('tab') === 'flow' ? 'flow' : 'graph';

/** 一个映射最近一次合并的结果只留状态、结束时间与行数 */
const flowMerge = (r: MergeHistoryEntry): FlowMerge => ({
  status: 'error' in r ? 'failed' : 'skipped' in r ? 'skipped' : 'ok',
  at: new Date(Date.parse(r.startedAt) + r.durationMs).toISOString(),
  rows: 'rows' in r ? r.rows : null,
});

/** 抽屉要打开的标准层表：关系图的节点是实体名，流向图的是 silver.<实体>；只认已接入的 */
const drawerEntityOf = (node: string | null, connected: string[]) => {
  const entity = node?.startsWith('silver.') ? node.slice('silver.'.length) : node;
  return entity && connected.includes(entity) ? entity : null;
};

/** 最近一次漂移检查任务的状态 → 页面上的状态：从没检查过、检查中（排队或运行）、失败、成功 */
const INSPECT_STATUS = { none: 'never', queued: 'running', running: 'running', failed: 'failed', succeeded: 'ok' } as const;
type InspectView = { status: (typeof INSPECT_STATUS)[keyof typeof INSPECT_STATUS]; error: string | null; inspectedAt: string | null; drifts: Drift[] };

const NODE_KINDS = { entity: '标准层表', identity: '身份对应', device: '设备归属' } as const;
const EDGE_KINDS = { ref: '内置关系', identity: '经 _identities', device: '经 _device_owner' } as const;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const plans = await publishedPlans(getDb(), member.tenant.id);
  const connected = [...new Set(plans.map(p => p.entity))].sort();
  const searchParams = new URL(request.url).searchParams;
  const showAll = searchParams.get('all') === '1';
  let rules: readonly string[] | null;
  try {
    rules = identityRules(plans, p => p.mapping);
  } catch {
    // 各 customer 映射的匹配规则不一致：合并入队时会报错，这里不显示规则
    rules = null;
  }
  const summary = await latestIdentitySummary(member.tenant.id);
  const graph = relationGraph({
    edges: deriveLineage({ plans, sources: [] }).edges, connected, showAll,
    identity: { rules, summary: summary && { groups: summary.groups, records: summary.records } },
  });
  const node = searchParams.get('node');
  const sql = node ? sampleSql(node, graph) : null;
  const canFlow = can(member.role, 'sources:read');
  const tab = tabOf(request, canFlow);
  const drawerEntity = drawerEntityOf(node, connected);
  const focusParam = searchParams.get('focus');
  const focusEntity = tab === 'flow' && focusParam && connected.includes(focusParam) ? focusParam : null;
  // 反向查只在流向图与聚焦画布上；源表抽屉里有源表名与表达式，同样只给有 sources:read 的人
  const q = tab === 'flow' ? searchParams.get('q')?.trim() ?? '' : '';
  const tableNode = canFlow && node?.startsWith('table:') ? node : null;
  let flow: FlowInput | null = null;
  let drawer: FieldDrawer | null = null;
  let focus: FocusInput | null = null;
  let hitIds: { nodes: string[]; edges: string[]; fields: string[] } | null = null;
  let tableDrawer: TableImpact | null = null;
  if (tab === 'flow' || drawerEntity || tableNode) {
    // 只取数据源的名字与种类，不带连接配置；不下发合并计划（里面有列与表达式）
    const sources = canFlow ? (await listSources(member)).map(({ id, name, kind }) => ({ id, name, kind })) : [];
    const lineage = deriveLineage({ plans, sources });
    const last = await lastMergeByMapping(member.tenant.id, plans.map(p => p.mapping));
    const merges = Object.fromEntries(Object.entries(last).map(([id, r]) => [id, flowMerge(r)]));
    if (focusEntity) {
      const canonical = entityOf(focusEntity);
      const custom = canonical ? undefined : (await publishedCustomEntities(getDb(), member.tenant.id)).get(focusEntity);
      // 字段顺序同抽屉；只下发写入这张表的血缘与它用到的数据源名字
      const own = lineage.tables.filter(t => t.entity === focusEntity);
      focus = {
        entity: focusEntity,
        fields: entityFields(lineage, focusEntity, canonical?.fields ?? custom?.fields ?? [], {}).map(f => f.name),
        lineage: lineage.fields.filter(f => f.entity === focusEntity),
        sourceNames: Object.fromEntries(own.map(t => [t.sourceId, t.sourceName])),
      };
    } else if (tab === 'flow') {
      flow = { tables: lineage.tables, identityEdges: lineage.edges, identity: graph.nodes.find(n => n.identity)?.identity ?? null, merges };
    }
    const found = searchImpact(lineage, q);
    if (found) hitIds = { nodes: [...found.nodes], edges: [...found.edges], fields: [...found.fields] };
    if (tableNode) tableDrawer = tableImpact(lineage, tableNode);
    if (drawerEntity) {
      const canonical = entityOf(drawerEntity);
      const custom = canonical ? undefined : (await publishedCustomEntities(getDb(), member.tenant.id)).get(drawerEntity);
      // 兜底统计里是源端的取值，只给有 sources:read 的人
      const fallbacks = canFlow ? Object.fromEntries(Object.entries(last).map(([id, r]) => [id, 'fallback' in r ? r.fallback : undefined])) : {};
      const fields = entityFields(lineage, drawerEntity, canonical?.fields ?? custom?.fields ?? [], fallbacks);
      const head = { entity: drawerEntity, label: canonical?.label ?? custom?.label ?? drawerEntity, rows: silverTotals(lineage.tables, merges).get(`silver.${drawerEntity}`)?.rows ?? 0 };
      drawer = canFlow ? { ...head, detail: true, fields } : { ...head, detail: false, fields: redactFields(fields) };
    }
  }
  const inspect = await getInspectStatus(member);
  return {
    tab,
    canFlow,
    canInspect: can(member.role, 'sources:write'),
    inspect: {
      status: INSPECT_STATUS[inspect.status],
      error: inspect.error,
      inspectedAt: inspect.inspectedAt?.toISOString() ?? null,
      drifts: inspect.drifts,
    },
    drift: driftByTable(inspect.drifts),
    flow,
    focus,
    drawer,
    q,
    hitIds,
    tableDrawer,
    email: member.email,
    nav: navFor(member),
    graph,
    showAll,
    node: sql ? node : null,
    sql,
  };
}

/** 触发一次漂移检查（需 sources:write）；已有一次在排队或运行中时返回原因 */
export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:write');
  const form = await request.formData();
  try {
    switch (String(form.get('intent') ?? '')) {
      case 'inspect':
        await inspectLakeNow(member);
        break;
      default:
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof InspectError) return data({ error: e.message }, { status: 400 });
    if (e instanceof TaskError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/lineage');
}

export default function Lineage({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, canFlow, canInspect, inspect, drift, flow, focus, drawer, q, hitIds, tableDrawer, email, nav, graph, showAll, node, sql } = loaderData;
  const labelOf = (id: string) => graph.nodes.find(n => n.id === id)?.label ?? id;
  const [rawParams] = useSearchParams();
  // 链接里不带不生效的参数：关系图没有反向查，没有 sources:read 时不开源表抽屉
  const searchParams = new URLSearchParams(rawParams);
  if (tab !== 'flow') searchParams.delete('q');
  if (!canFlow && searchParams.get('node')?.startsWith('table:')) searchParams.delete('node');
  const hits = useMemo<SearchHits | null>(
    () => hitIds && { nodes: new Set(hitIds.nodes), edges: new Set(hitIds.edges), fields: new Set(hitIds.fields) },
    [hitIds],
  );
  const nodeHref = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('node', id);
    return `?${next}`;
  };
  const closeDrawerHref = (() => {
    const next = new URLSearchParams(searchParams);
    next.delete('node');
    return next.size ? `/lineage?${next}` : '/lineage';
  })();
  const showAllHref = (() => {
    const next = new URLSearchParams(searchParams);
    if (showAll) next.delete('all');
    else next.set('all', '1');
    return next.size ? `/lineage?${next}` : '/lineage';
  })();
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="数据地图"
        description="已接入的标准层表之间怎么关联。指向消费者的关系经 _identities 按 (_source, customer_id) 对应到统一消费者；匿名事件的设备经 _device_owner 按最近一次登录归到消费者。点一张表看示例 SQL。"
      />

      <PillTabs
        current={tab}
        tabs={[
          { key: 'graph', label: '关系图', href: '/lineage' },
          ...(canFlow ? [{ key: 'flow' as const, label: '流向图', href: '/lineage?tab=flow' }] : []),
        ]}
      />

      {graph.nodes.length === 0 ? (
        <section className="rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title="还没有已发布的映射">发布映射、合并到标准层之后，这里会画出已接入的表和它们之间的关系。</SectionHeader>
        </section>
      ) : focus ? <FocusSection focus={focus} q={q} hits={hits} /> : flow ? <FlowSection flow={flow} q={q} hits={hits} drift={drift} /> : (
        <>
          <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-6">
              <SectionHeader title="关系图">实线是标准实体之间的内置关系；绿色虚线经 _identities 关联到统一消费者；紫色虚线是设备归属（不带 _source，取设备最近一次登录）；灰色是还没接入的标准实体。</SectionHeader>
              <Link to={showAllHref} preventScrollReset role="switch" aria-checked={showAll} data-show-all className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
                <span className={`relative h-5 w-9 rounded-full transition-colors ${showAll ? 'bg-slate-900' : 'bg-slate-300'}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${showAll ? 'left-[18px]' : 'left-0.5'}`} />
                </span>
                显示未接入的标准实体
              </Link>
            </div>
            <RelationGraphView graph={graph} selected={node} drift={drift} />
          </section>

          {sql && node && (
            <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
              <SectionHeader title={`示例 SQL：${labelOf(node)}`}>
                按租户的湖挂载为 lake 来写，标准层表在 lake.silver 下。
              </SectionHeader>
              <pre data-sql className="overflow-x-auto rounded-xl bg-slate-900 p-4 font-mono text-xs text-slate-100">{sql}</pre>
            </section>
          )}

          <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
            <SectionHeader title="表与关系" />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>表</TableHead>
                  <TableHead>类型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {graph.nodes.map(n => (
                  <TableRow key={n.id} data-node={n.id} data-connected={n.connected} {...driftAttrs(drift[n.id])} aria-selected={n.id === node} className={n.connected ? undefined : 'text-slate-400'}>
                    <TableCell>
                      {n.connected
                        ? <Link to={nodeHref(n.id)} preventScrollReset className="font-mono text-xs hover:underline">{`silver.${n.id}`}</Link>
                        : <span className="font-mono text-xs">{`silver.${n.id}`}</span>}
                      {n.label !== n.id && <span className={`ml-2 ${n.connected ? 'text-slate-500' : ''}`}>{n.label}</span>}
                      {drift[n.id] && <span className="ml-3"><DriftBadge counts={drift[n.id]} /></span>}
                      {n.identity && (
                        <div className="mt-1 space-x-3 text-xs text-slate-500">
                          {n.identity.rules && <span data-rules>匹配规则：{ruleLabels(n.identity.rules)}</span>}
                          {n.identity.summary ? (
                            <>
                              <span data-groups={n.identity.summary.groups}>统一消费者 {n.identity.summary.groups.toLocaleString()}</span>
                              <span data-records={n.identity.summary.records}>参与打通的记录 {n.identity.summary.records.toLocaleString()}</span>
                            </>
                          ) : <span>尚未合并</span>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className={n.connected ? 'text-slate-500' : ''}>{n.connected ? NODE_KINDS[n.kind] : '未接入'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>从</TableHead>
                  <TableHead>到</TableHead>
                  <TableHead>关系</TableHead>
                  <TableHead>说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {graph.edges.map(e => (
                  <TableRow key={e.id} data-edge={e.kind} data-connected={e.connected} className={e.connected ? undefined : 'text-slate-400'}>
                    <TableCell className="font-mono text-xs">{e.source}</TableCell>
                    <TableCell className="font-mono text-xs">{e.target}</TableCell>
                    <TableCell className={e.connected ? 'text-slate-500' : ''}>{EDGE_KINDS[e.kind]}</TableCell>
                    <TableCell className="whitespace-normal font-mono text-xs">{e.label}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      {tab === 'graph' && <InspectSection inspect={inspect} canInspect={canInspect} submitError={actionData?.error ?? null} />}

      {tableDrawer && <TableDrawer impact={tableDrawer} closeHref={closeDrawerHref} />}
      {drawer && <LineageDrawer drawer={drawer} closeHref={closeDrawerHref} focusHref={drawer.detail ? `/lineage?tab=flow&focus=${encodeURIComponent(drawer.entity)}` : null} />}
    </AppShell>
  );
}

const DRIFT_KINDS = { missing: '缺列', extra: '多列', type: '类型不一致', orphan: '孤表' } as const;

/**
 * 漂移检查：最近一次检查的状态，以及最近一次成功检查的时间与每条差异（表、种类、列、应有 / 实际类型）。
 * 有 sources:write 的成员可以触发一次检查，检查中时按钮不可用、页面定时刷新到检查结束
 */
function InspectSection({ inspect, canInspect, submitError }: { inspect: InspectView; canInspect: boolean; submitError: string | null }) {
  const { status, drifts, inspectedAt } = inspect;
  // 孤表在两张图上都没有节点，单独列出
  const orphans = drifts.filter(d => d.kind === 'orphan');
  const columns = drifts.filter(d => d.kind !== 'orphan');
  const alarming = status === 'failed' || (inspectedAt !== null && drifts.length > 0);
  // 检查在调度器里异步进行：检查中时定时刷新，结束后停下
  const revalidator = useRevalidator();
  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [status, revalidator]);
  return (
    <section data-inspect-status={status} className={`space-y-4 rounded-2xl border bg-white p-6 shadow-sm ${alarming ? 'border-red-200' : ''}`}>
      <div className="flex items-start justify-between gap-6">
        <SectionHeader title="漂移检查">对比湖里标准层表的实际结构与标准模型、已发布映射推出的应有结构，报告缺列、多列、类型不一致与没有映射写入的孤表。只出报告，修复走合并。</SectionHeader>
        {canInspect && (
          <Form method="post" preventScrollReset className="shrink-0">
            <input type="hidden" name="intent" value="inspect" />
            <Button type="submit" variant="outline" disabled={status === 'running'}>{status === 'running' ? '检查中…' : '漂移检查'}</Button>
          </Form>
        )}
      </div>
      {submitError && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>没有开始检查</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}
      <p className="flex flex-wrap items-center text-sm text-slate-500">
        {status === 'never' && '尚未检查'}
        {status === 'running' && <span className="flex items-center gap-2 text-amber-600"><Loader2 className="size-4 animate-spin" />检查中</span>}
        {status === 'failed' && <span className="flex items-center gap-2 text-red-600"><CircleAlert className="size-4" />{`检查失败：${inspect.error ?? ''}`}</span>}
        {inspectedAt && <span className={status === 'ok' ? undefined : 'ml-3'}>{`${status === 'ok' ? '' : '上次'}检查时间：${new Date(inspectedAt).toLocaleString('zh-CN')}`}</span>}
      </p>
      {inspectedAt && (drifts.length === 0 ? (
        <p data-no-drift className="flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 className="size-4" />没有漂移</p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="size-4" />{`${drifts.length} 处漂移`}</p>
          {columns.length > 0 && <ul className="divide-y rounded-xl border text-sm">
            {columns.map(d => (
              <li key={`${d.table}:${d.kind}:${d.column ?? ''}`} data-drift={`${d.table}:${d.kind}:${d.column ?? ''}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                <span className="font-mono text-xs">{`silver.${d.table}`}</span>
                <span className="text-red-600">{DRIFT_KINDS[d.kind]}</span>
                {d.column && <span className="font-mono text-xs">{d.column}</span>}
                {(d.expected || d.actual) && (
                  <span className="text-slate-500">{`应有 ${d.expected ?? '—'} / 实际 ${d.actual ?? '—'}`}</span>
                )}
              </li>
            ))}
          </ul>}
          {orphans.length > 0 && (
            <ul className="divide-y rounded-xl border border-red-200 text-sm">
              {orphans.map(d => (
                <li key={d.table} data-drift={`${d.table}:orphan:`} data-orphan={d.table} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                  <span className="font-mono text-xs">{`silver.${d.table}`}</span>
                  <span className="text-red-600">{DRIFT_KINDS.orphan}</span>
                  <span className="text-slate-500">湖里有这张表，但已没有任何已发布映射写入</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ))}
    </section>
  );
}

/** 单表聚焦画布与图下服务端渲染的连线列表（画布挂载后才渲染，列表给没有脚本时与测试用） */
function FocusSection({ focus, q, hits }: { focus: FocusInput; q: string; hits: SearchHits | null }) {
  const graph = useMemo(() => focusGraph(focus), [focus]);
  const [searchParams] = useSearchParams();
  const backHref = (() => {
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    return `/lineage?${next}`;
  })();
  // 边都从源表出发
  const tables = new Map(graph.nodes.flatMap(n => (n.data.kind === 'table' ? [[n.id, n.data] as const] : [])));
  return (
    <>
      <section data-focus={focus.entity} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-6">
          <SectionHeader title={`聚焦：silver.${focus.entity}`}>只画这张标准层表和写入它的源表。源表只列出被表达式引用到的源列，每条线从源列连到标准层字段；常量表达式没有连线。点标准层表看字段明细，点源表看它的列影响了哪些字段。</SectionHeader>
          <Link to={backHref} preventScrollReset className="flex shrink-0 items-center gap-1 text-sm text-slate-600 hover:underline">
            <ArrowLeft className="size-4" />返回流向图
          </Link>
        </div>
        {/* 搜索按整个血缘算，这里只看这张表的画布上有没有命中 */}
        <ImpactSearch q={q} focus={focus.entity} found={hits && graph.nodes.some(n => hits.nodes.has(n.id))} />
        <FocusGraphView graph={graph} hits={hits} />
      </section>

      <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="字段连线" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>数据源</TableHead>
              <TableHead>源表</TableHead>
              <TableHead>源列</TableHead>
              <TableHead>标准层字段</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {graph.edges.map(e => {
              const t = tables.get(e.source)!;
              return (
                <TableRow key={e.id} data-field-edge={`${t.sourceId}:${t.label}.${e.sourceHandle}→${e.targetHandle}`} {...hitAttrs(hits, hits?.edges.has(e.id))}>
                  <TableCell>{t.sourceName}</TableCell>
                  <TableCell className="font-mono text-xs">{t.label}</TableCell>
                  <TableCell className="font-mono text-xs">{e.sourceHandle}</TableCell>
                  <TableCell className="font-mono text-xs">{e.targetHandle}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

/** 流向图与图下服务端渲染的列表（React Flow 挂载后才渲染，列表给没有脚本时与测试用） */
function FlowSection({ flow, q, hits, drift }: { flow: FlowInput; q: string; hits: SearchHits | null; drift: DriftByTable }) {
  const silver = [...silverTotals(flow.tables, flow.merges).values()];
  return (
    <>
      <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="流向图">源表按数据源分组，点分组可以折叠或展开；映射节点显示版本与最近一次合并，失败的标红，点开看合并记录；标准层表显示行数（各映射最近一次合并成功时的行数之和，最近一次失败或跳过的映射不计入）与写入它的映射数。点源表看它的列影响了哪些字段。</SectionHeader>
        <ImpactSearch q={q} focus={null} found={hits && hits.nodes.size > 0} />
        <FlowGraphView flow={flow} hits={hits} drift={drift} />
      </section>

      <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="映射与标准层表" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>数据源</TableHead>
              <TableHead>源表</TableHead>
              <TableHead>版本</TableHead>
              <TableHead>标准层表</TableHead>
              <TableHead>最近一次合并</TableHead>
              <TableHead>行数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flow.tables.map(t => {
              const merge = flow.merges[t.mapping];
              const status = merge?.status ?? 'never';
              return (
                <TableRow key={t.mapping} data-flow-mapping={t.mapping} data-version={t.version} data-merge-status={status} {...hitAttrs(hits, hits?.nodes.has(`mapping:${t.mapping}`))}>
                  <TableCell>
                    <span className="flex items-center gap-2"><KindIcon kind={t.sourceKind as SourceKind} small />{t.sourceName}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {t.table}
                    {t.viaView && <span className="ml-2 font-sans text-slate-500">源视图</span>}
                  </TableCell>
                  <TableCell>{`v${t.version}`}</TableCell>
                  <TableCell className="font-mono text-xs">{t.target}</TableCell>
                  <TableCell><MergeStatus status={status} at={merge?.at ?? null} mappingId={t.mapping} /></TableCell>
                  <TableCell {...(merge?.rows != null ? { 'data-rows': merge.rows } : {})}>{merge?.rows != null ? merge.rows.toLocaleString('zh-CN') : '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标准层表</TableHead>
              <TableHead>映射数</TableHead>
              <TableHead>行数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {silver.map(s => (
              <TableRow key={s.entity} data-silver={s.entity} data-mappings={s.mappings} data-rows={s.rows} {...driftAttrs(drift[s.entity])} {...hitAttrs(hits, hits?.nodes.has(`silver.${s.entity}`))}>
                <TableCell className="font-mono text-xs">
                  {`silver.${s.entity}`}
                  {drift[s.entity] && <span className="ml-3 font-sans"><DriftBadge counts={drift[s.entity]} /></span>}
                </TableCell>
                <TableCell>{s.mappings}</TableCell>
                <TableCell>{s.rows.toLocaleString('zh-CN')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

/** 有搜索时：命中的行带 data-hit，其余变淡 */
const hitAttrs = (hits: SearchHits | null, hit: boolean | undefined) =>
  !hits ? {} : hit ? { 'data-hit': true } : { className: 'opacity-40' };

/** 反向查：按列名或「表.列」搜索（GET，?q=），保留标签页与聚焦的表；found 为 false 时说没有找到，没有搜索时为 null */
function ImpactSearch({ q, focus, found }: { q: string; focus: string | null; found: boolean | null }) {
  return (
    <div className="space-y-2">
      <Form method="get" preventScrollReset className="flex max-w-2xl items-center gap-2">
        <input type="hidden" name="tab" value="flow" />
        {focus && <input type="hidden" name="focus" value={focus} />}
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
          <Input key={q} type="search" name="q" defaultValue={q} placeholder="反向查：列名，或 表.列" aria-label="反向查源列" className="pl-8" />
        </div>
      </Form>
      {found === false && <p data-no-hits className="text-sm text-slate-500">{`没有找到引用「${q}」的映射。`}</p>}
    </div>
  );
}

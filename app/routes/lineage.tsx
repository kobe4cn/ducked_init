// app/routes/lineage.tsx —— 数据地图（需登录，任何角色）：关系图画出已接入的标准层表与 _identities、_device_owner 之间的关系，
// 图下服务端渲染一份表与关系的列表；点表节点（?node=）给出按租户湖挂载为 lake 写的示例 SQL。
// _identities 显示匹配规则与最近一次打通的摘要（只有计数）；?all=1 时把未接入的标准实体与它们的内置关系也画出来，灰显。
// 流向图（?tab=flow）画源表 → 映射 → 标准层表 → 打通表，带各映射最近一次合并与标准层表行数（取自任务结果，不查湖），图下同样有一份列表；
// 只对有 sources:read 的成员开放，没有权限时回到关系图，源表名与映射信息都不下发。
// 点已接入的标准层表（关系图 ?node=<entity>，流向图 ?node=silver.<entity>）在右侧抽屉列出字段明细：有 sources:read 时带各映射的源表、源列、表达式、
// 标记与兜底统计，否则只下发字段说明与行数（在 loader 里裁剪）。
// 单表聚焦画布（?tab=flow&focus=<实体>，从抽屉进入）只画这张标准层表与写入它的源表，连线从源列连到字段；同样只对有 sources:read 的成员开放
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { Route } from './+types/lineage';
import { can } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { publishedCustomEntities } from '~/.server/custom-entities';
import { getDb } from '~/.server/db/client';
import { lastMergeByMapping, latestIdentitySummary, type MergeHistoryEntry, publishedPlans } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { identityRules } from '~/.server/pipeline/identity-engine';
import { listSources } from '~/.server/sources';
import { entityOf } from '~/lib/canonical-model';
import { deriveLineage } from '~/lib/lineage';
import { focusGraph, type FocusInput } from '~/lib/lineage-focus';
import { entityFields, type FieldDrawer, redactFields } from '~/lib/lineage-fields';
import { type FlowInput, type FlowMerge, silverTotals } from '~/lib/lineage-flow';
import { relationGraph, ruleLabels, sampleSql } from '~/lib/lineage-graph';
import type { SourceKind } from '~/lib/sources';
import { AppShell } from '~/components/app-shell';
import { KindIcon } from '~/components/kind-icon';
import { LineageDrawer } from '~/components/lineage-drawer';
import { FocusGraphView } from '~/components/lineage-focus';
import { FlowGraphView, MergeStatus } from '~/components/lineage-flow';
import { RelationGraphView } from '~/components/lineage-graph';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
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
  let flow: FlowInput | null = null;
  let drawer: FieldDrawer | null = null;
  let focus: FocusInput | null = null;
  if (tab === 'flow' || drawerEntity) {
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
  return {
    tab,
    canFlow,
    flow,
    focus,
    drawer,
    email: member.email,
    nav: navFor(member),
    graph,
    showAll,
    node: sql ? node : null,
    sql,
  };
}

export default function Lineage({ loaderData }: Route.ComponentProps) {
  const { tab, canFlow, flow, focus, drawer, email, nav, graph, showAll, node, sql } = loaderData;
  const labelOf = (id: string) => graph.nodes.find(n => n.id === id)?.label ?? id;
  const [searchParams] = useSearchParams();
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
      ) : focus ? <FocusSection focus={focus} /> : flow ? <FlowSection flow={flow} /> : (
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
            <RelationGraphView graph={graph} selected={node} />
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
                  <TableRow key={n.id} data-node={n.id} data-connected={n.connected} aria-selected={n.id === node} className={n.connected ? undefined : 'text-slate-400'}>
                    <TableCell>
                      {n.connected
                        ? <Link to={nodeHref(n.id)} preventScrollReset className="font-mono text-xs hover:underline">{`silver.${n.id}`}</Link>
                        : <span className="font-mono text-xs">{`silver.${n.id}`}</span>}
                      {n.label !== n.id && <span className={`ml-2 ${n.connected ? 'text-slate-500' : ''}`}>{n.label}</span>}
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

      {drawer && <LineageDrawer drawer={drawer} closeHref={closeDrawerHref} focusHref={drawer.detail ? `/lineage?tab=flow&focus=${encodeURIComponent(drawer.entity)}` : null} />}
    </AppShell>
  );
}

/** 单表聚焦画布与图下服务端渲染的连线列表（画布挂载后才渲染，列表给没有脚本时与测试用） */
function FocusSection({ focus }: { focus: FocusInput }) {
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
          <SectionHeader title={`聚焦：silver.${focus.entity}`}>只画这张标准层表和写入它的源表。源表只列出被表达式引用到的源列，每条线从源列连到标准层字段；常量表达式没有连线。点标准层表看字段明细。</SectionHeader>
          <Link to={backHref} preventScrollReset className="flex shrink-0 items-center gap-1 text-sm text-slate-600 hover:underline">
            <ArrowLeft className="size-4" />返回流向图
          </Link>
        </div>
        <FocusGraphView graph={graph} />
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
                <TableRow key={e.id} data-field-edge={`${t.sourceId}:${t.label}.${e.sourceHandle}→${e.targetHandle}`}>
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
function FlowSection({ flow }: { flow: FlowInput }) {
  const silver = [...silverTotals(flow.tables, flow.merges).values()];
  return (
    <>
      <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="流向图">源表按数据源分组，点分组可以折叠或展开；映射节点显示版本与最近一次合并，失败的标红，点开看合并记录；标准层表显示行数（各映射最近一次合并成功时的行数之和，最近一次失败或跳过的映射不计入）与写入它的映射数。</SectionHeader>
        <FlowGraphView flow={flow} />
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
                <TableRow key={t.mapping} data-flow-mapping={t.mapping} data-version={t.version} data-merge-status={status}>
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
              <TableRow key={s.entity} data-silver={s.entity} data-mappings={s.mappings} data-rows={s.rows}>
                <TableCell className="font-mono text-xs">{`silver.${s.entity}`}</TableCell>
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

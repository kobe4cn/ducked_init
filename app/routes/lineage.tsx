// app/routes/lineage.tsx —— 数据地图（需登录，任何角色）：关系图画出已接入的标准层表与 _identities、_device_owner 之间的关系，
// 图下服务端渲染一份表与关系的列表；点表节点（?node=）给出按租户湖挂载为 lake 写的示例 SQL。源端的表与字段需要 sources:read，不在这里下发。
// _identities 显示匹配规则与最近一次打通的摘要（只有计数）；?all=1 时把未接入的标准实体与它们的内置关系也画出来，灰显
import { Link, useSearchParams } from 'react-router';
import type { Route } from './+types/lineage';
import { requireMember } from '~/.server/auth';
import { getDb } from '~/.server/db/client';
import { latestIdentitySummary, publishedPlans } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { identityRules } from '~/.server/pipeline/identity-engine';
import { deriveLineage } from '~/lib/lineage';
import { relationGraph, ruleLabels, sampleSql } from '~/lib/lineage-graph';
import { AppShell } from '~/components/app-shell';
import { RelationGraphView } from '~/components/lineage-graph';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据地图 · CRM 数据分析平台' }];
}

/** 页面的标签页：关系图（#82 再加流向图） */
type Tab = 'graph';
const tabOf = (_request: Request): Tab => {
  // 目前只有关系图；#82 加流向图后按 ?tab= 区分
  return 'graph';
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
  return {
    tab: tabOf(request),
    email: member.email,
    nav: navFor(member),
    graph,
    showAll,
    node: sql ? node : null,
    sql,
  };
}

export default function Lineage({ loaderData }: Route.ComponentProps) {
  const { tab, email, nav, graph, showAll, node, sql } = loaderData;
  const labelOf = (id: string) => graph.nodes.find(n => n.id === id)?.label ?? id;
  const [searchParams] = useSearchParams();
  const nodeHref = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('node', id);
    return `?${next}`;
  };
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

      <PillTabs current={tab} tabs={[{ key: 'graph', label: '关系图', href: '/lineage' }]} />

      {graph.nodes.length === 0 ? (
        <section className="rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title="还没有已发布的映射">发布映射、合并到标准层之后，这里会画出已接入的表和它们之间的关系。</SectionHeader>
        </section>
      ) : (
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
    </AppShell>
  );
}

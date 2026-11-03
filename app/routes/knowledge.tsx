// app/routes/knowledge.tsx —— 业务知识集中页（ADR-0046）：所有成员可看（definitions:read，不新增权限），按分析主题分组列出有待确认提案或缺失项的目录条目
// （规则见 knowledge/hub.ts），没有主题的条目在最后的「未归入主题」组。点条目（?item=<targetId>）在本页展开与详情页相同的业务知识面板（字段不带说明区），
// 能不能编辑沿用面板的 canEdit（definitions:draft）；提交成功后回到原 URL，列表与计数随之更新
import type { Route } from './+types/knowledge';
import { data, Link, redirect } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleHelp, Inbox } from 'lucide-react';
import { requirePermission } from '~/.server/access';
import { catalogFor } from '~/.server/assistant/tools';
import { expand, type EntityEntry, type FieldEntry, type MetricEntry, type TagEntry } from '~/.server/catalog';
import { knowledgeHub, type HubItem } from '~/.server/knowledge/hub';
import { handleKnowledgeIntent, isKnowledgeIntent, knowledgePanel, type KnowledgePanel as Panel } from '~/.server/knowledge/panel';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { KnowledgePanel } from '~/components/knowledge-panel';
import { PageHeader } from '~/components/page-header';
import { StatTile } from '~/components/stat-tile';
import { claimTypeLabel } from '~/lib/semantic-claims';

const KIND_LABELS: Record<HubItem['kind'], string> = { entity: '实体', field: '字段', metric: '指标', tag: '标签' };
const STATE_LABELS: Record<HubItem['missing'][number]['state'], string> = { undeclared: '未声明', unknown: '未知', needsReview: '未知（待复核）' };

const itemHref = (targetId: string) => `/knowledge?item=${encodeURIComponent(targetId)}`;

export function meta({}: Route.MetaArgs) {
  return [{ title: '业务知识 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:read');
  const catalog = await catalogFor(member);
  const hub = await knowledgeHub(member, catalog);
  const itemId = new URL(request.url).searchParams.get('item');
  const system = itemId ? expand(catalog, itemId) : null;
  // 只给 ?item= 那一个条目算面板（每个面板都要读全租户的知识）
  let selected: { targetId: string; system: EntityEntry | FieldEntry | MetricEntry | TagEntry; panel: Panel } | null = null;
  if (system && (system.kind === 'entity' || system.kind === 'field' || system.kind === 'metric' || system.kind === 'tag')) {
    selected = { targetId: system.id, system, panel: await knowledgePanel(member, system.id) };
  }
  return { email: member.email, nav: navFor(member), hub, selected };
}

/** 面板提交（alias.* / claim.* / note.* / subject.* / proposal.*）交给 handleKnowledgeIntent，权限由它按 definitions:draft 判断；出错带 targetId 返回，成功回到原 URL */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  if (!isKnowledgeIntent(intent)) return data({ error: '未知操作', targetId: '' }, { status: 400 });
  const result = await handleKnowledgeIntent(await requirePermission(request, 'definitions:read'), form);
  if ('error' in result) return data({ error: result.error, targetId: String(form.get('targetId') ?? '') }, { status: result.status });
  throw redirect(`/knowledge${new URL(request.url).search}`);
}

function Item({ item, active }: { item: HubItem; active: boolean }) {
  return (
    <li data-hub-item={item.targetId} className={`rounded-lg px-3 py-2 ${active ? 'bg-slate-100' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-slate-500">{KIND_LABELS[item.kind]}</span>
        <Link to={itemHref(item.targetId)} className="font-medium hover:underline">{item.name}</Link>
        <span className="font-mono text-xs text-slate-400">{item.targetId}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {item.proposals > 0 && <span className="inline-flex items-center gap-1 text-amber-600"><Inbox className="size-3.5" />{`${item.proposals} 条待确认`}</span>}
        {item.missing.map(m => (
          <span key={m.type} data-missing={m.type} className="inline-flex items-center gap-1 text-red-600">
            <CircleHelp className="size-3.5" />{`${claimTypeLabel(m.type)}：${STATE_LABELS[m.state]}`}
          </span>
        ))}
      </div>
    </li>
  );
}

export default function Knowledge({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, hub, selected } = loaderData;
  const list = hub.groups.length === 0 ? (
    <section className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
      <p className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" />没有待确认的提案或缺失项。</p>
      <p className="mt-2 text-sm">这里按分析主题列出等待确认的知识提案，以及没有声明单位、币种（或声明为未知）的指标和金额字段。<Link to="/lineage" className="ml-2 text-slate-900 underline">去数据地图</Link></p>
    </section>
  ) : (
    <div className="space-y-4">
      {hub.groups.map(g => (
        <section key={g.subject ?? ''} data-hub-group={g.subject ?? 'none'} className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-lg font-semibold">{g.subject ?? '未归入主题'}</h2>
            {g.proposals > 0 && <span className="inline-flex items-center gap-1 text-sm text-amber-600"><Inbox className="size-4" />{`${g.proposals} 条待确认提案`}</span>}
            {g.missing > 0 && <span className="inline-flex items-center gap-1 text-sm text-red-600"><AlertTriangle className="size-4" />{`${g.missing} 个缺失项`}</span>}
          </div>
          <ul className="space-y-1">
            {g.items.map(i => <Item key={i.targetId} item={i} active={i.targetId === selected?.targetId} />)}
          </ul>
        </section>
      ))}
    </div>
  );
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="业务知识" description="按分析主题列出待确认的知识提案与缺失的口径声明，点开条目在本页处理" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile label="待确认提案" value={hub.totals.proposals} tone={hub.totals.proposals ? 'text-amber-600' : undefined} hint="等待成员确认的知识提案" />
        <StatTile label="缺失项" value={hub.totals.missing} tone={hub.totals.missing ? 'text-red-600' : undefined} hint="未声明或声明为未知的单位、币种" />
        <StatTile label="有条目的主题" value={hub.totals.subjects} hint="不含「未归入主题」" />
      </div>
      {selected ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0">{list}</div>
          <div className="min-w-0">
            <KnowledgePanel
              panel={selected.panel} system={selected.system} targetId={selected.targetId}
              error={actionData && actionData.targetId === selected.targetId ? actionData.error : null}
              hideNote={selected.system.kind === 'field'} compact
            />
          </div>
        </div>
      ) : list}
    </AppShell>
  );
}

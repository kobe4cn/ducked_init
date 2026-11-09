// app/routes/knowledge.tsx —— 业务知识集中页（ADR-0046）：所有成员可看（definitions:read，不新增权限），按分析主题分组列出有待确认提案或缺失项的目录条目
// （规则见 knowledge/hub.ts），没有主题的条目在最后的「未归入主题」组。点条目（?item=<targetId>）在本页展开与详情页相同的业务知识面板（字段不带说明区），
// 能不能编辑沿用面板的 canEdit（definitions:draft）；提交成功后回到原 URL，列表与计数随之更新。
// 主题组的「生成建议」（ADR-0046 入口③，#513）同步按主题生成一批提案：成功 302 回集中页带计数，查看者由 suggestForSubject 内部抛 403。
// 页头的「应用标准模板包」（ADR-0046 入口②，#521）把标准包按租户用到的实体展开成提案：成功同样 302 回集中页带计数，查看者由 applyStandardPackFor 抛 403
import type { Route } from './+types/knowledge';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleHelp, Inbox, PackageCheck, Sparkles } from 'lucide-react';
import { can, requirePermission } from '~/.server/access';
import { catalogFor } from '~/.server/assistant/tools';
import { expand } from '~/.server/catalog';
import { getDb } from '~/.server/db/client';
import { applyStandardPackFor } from '~/.server/knowledge/apply-pack';
import { KnowledgeError } from '~/.server/knowledge/basis';
import { isHubEntry, knowledgeHub, type HubEntry, type HubItem } from '~/.server/knowledge/hub';
import { handleKnowledgeIntent, isKnowledgeIntent, knowledgePanel, type KnowledgePanel as Panel } from '~/.server/knowledge/panel';
import { suggestForSubject, SuggestError, type SuggestResult } from '~/.server/knowledge/suggest-run';
import { listSubjects } from '~/.server/knowledge/subjects';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { KnowledgePanel } from '~/components/knowledge-panel';
import { PageHeader } from '~/components/page-header';
import { StatTile } from '~/components/stat-tile';
import { Alert, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
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
  const search = new URL(request.url).searchParams;
  const itemId = search.get('item');
  const system = itemId ? expand(catalog, itemId) : null;
  // 只给 ?item= 那一个条目算面板（每个面板都要读全租户的知识）
  let selected: { targetId: string; system: HubEntry; panel: Panel } | null = null;
  if (system && isHubEntry(system)) {
    selected = { targetId: system.id, system, panel: await knowledgePanel(member, system.id) };
  }
  // 主题名 → id（主题名租户内不分大小写唯一，组的标题就是主题名）；每次现查，不缓存
  const subjectIds: Record<string, string> = {};
  for (const s of await listSubjects(getDb(), member.tenant.id)) subjectIds[s.name] = s.id;
  // 刚生成完 302 回来（?suggested=）带出的计数；fresh=0 表示同样的输入已经生成过、没有新提案
  const suggestedName = search.get('suggested');
  const suggested = suggestedName === null ? null : {
    subject: suggestedName,
    created: Number(search.get('created')) || 0,
    skipped: Number(search.get('skipped')) || 0,
    fresh: search.get('fresh') !== '0',
  };
  // 刚应用完标准模板包 302 回来（?pack=）带出的计数
  const packVersion = search.get('pack');
  const packApplied = packVersion === null ? null : {
    version: Number(packVersion) || 0,
    created: Number(search.get('created')) || 0,
    skipped: Number(search.get('skipped')) || 0,
  };
  return { email: member.email, nav: navFor(member), hub, selected, subjectIds, canSuggest: can(member.role, 'definitions:draft'), suggested, packApplied };
}

/** 面板提交（alias.* / claim.* / note.* / subject.* / proposal.*）交给 handleKnowledgeIntent，权限由它按 definitions:draft 判断；出错带 targetId 返回，成功回到原 URL。
 *  intent=suggest 按主题生成一批提案、intent=apply-pack 应用标准模板包：成功都 302 回集中页带计数，可展示的错误（未配置模型、模型失败、没有这个主题）显示在页顶 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  if (intent === 'apply-pack') {
    // 不能叫 proposal.apply-pack：会被 isKnowledgeIntent 交给面板（实体 / 血缘 / 定义详情页共用那个面板）。403 由 applyStandardPackFor 里的 assertCan 抛出，这里不接
    const member = await requirePermission(request, 'definitions:read');
    const outcome = await applyStandardPackFor(member);
    const params = new URLSearchParams({
      pack: String(outcome.version), created: String(outcome.created), skipped: String(outcome.skipped),
    });
    const item = new URL(request.url).searchParams.get('item');
    if (item) params.set('item', item);
    throw redirect(`/knowledge?${params.toString()}`);
  }
  if (intent === 'suggest') {
    // 不能叫 subject.suggest：会被 isKnowledgeIntent 交给面板。403 由 suggestForSubject 里的 assertCan 抛出，这里不接
    const member = await requirePermission(request, 'definitions:read');
    const subjectId = String(form.get('subjectId') ?? '');
    let outcome: SuggestResult;
    try {
      outcome = await suggestForSubject(member, subjectId);
    } catch (e) {
      if (e instanceof SuggestError || e instanceof KnowledgeError) return data({ error: e.message, targetId: '' }, { status: e.status });
      throw e;
    }
    const params = new URLSearchParams({ suggested: (await listSubjects(getDb(), member.tenant.id)).find(s => s.id === subjectId)?.name ?? '' });
    if (outcome.fresh) {
      params.set('created', String(outcome.created));
      params.set('skipped', String(outcome.existing + outcome.rejected + outcome.invalid + outcome.stale));
    } else {
      params.set('fresh', '0');
    }
    const item = new URL(request.url).searchParams.get('item');
    if (item) params.set('item', item);
    throw redirect(`/knowledge?${params.toString()}`);
  }
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
  const { email, nav, hub, selected, subjectIds, canSuggest, suggested, packApplied } = loaderData;
  // 生成建议同步调模型：生成期间禁用所有「生成建议」防止再起一次调用，只有被点的那组显示「生成中…」；
  // 应用标准模板包同理禁用；面板里的提交（alias.add、proposal.accept 等）不影响这些按钮
  const navigation = useNavigation();
  const pendingSubject = navigation.state === 'submitting' && navigation.formData?.get('intent') === 'suggest'
    ? String(navigation.formData.get('subjectId'))
    : null;
  const pendingPack = navigation.state === 'submitting' && navigation.formData?.get('intent') === 'apply-pack';
  const list = hub.groups.length === 0 ? (
    <section className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
      <p className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-600" />没有待确认的提案或缺失项。</p>
      <p className="mt-2 text-sm">这里按分析主题列出等待确认的知识提案，以及没有声明单位、币种（或声明为未知）的指标和金额字段。<Link to="/lineage" className="ml-2 text-slate-900 underline">去数据地图</Link></p>
    </section>
  ) : (
    <div className="space-y-4">
      {hub.groups.map(g => (
        <section key={g.subject ?? ''} data-hub-group={g.subject ?? 'none'} className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 className="text-lg font-semibold">{g.subject ?? '未归入主题'}</h2>
            {g.proposals > 0 && <span className="inline-flex items-center gap-1 text-sm text-amber-600"><Inbox className="size-4" />{`${g.proposals} 条待确认提案`}</span>}
            {g.missing > 0 && <span className="inline-flex items-center gap-1 text-sm text-red-600"><AlertTriangle className="size-4" />{`${g.missing} 个缺失项`}</span>}
            {g.subject !== null && canSuggest && (
              <Form method="post" className="ml-auto">
                <input type="hidden" name="intent" value="suggest" />
                <input type="hidden" name="subjectId" value={subjectIds[g.subject] ?? ''} />
                <Button type="submit" variant="outline" size="sm" disabled={pendingSubject !== null}>
                  <Sparkles />{pendingSubject !== null && pendingSubject === subjectIds[g.subject] ? '生成中…' : '生成建议'}
                </Button>
              </Form>
            )}
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
      <PageHeader
        title="业务知识" description="按分析主题列出待确认的知识提案与缺失的口径声明，点开条目在本页处理"
        actions={canSuggest && (
          <Form method="post">
            <input type="hidden" name="intent" value="apply-pack" />
            <Button type="submit" disabled={pendingPack}>
              <PackageCheck />{pendingPack ? '应用中…' : '应用标准模板包'}
            </Button>
          </Form>
        )}
      />
      {packApplied && !actionData?.error && (
        <Alert role="status" className="mb-4">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>{`已应用标准模板包：新建 ${packApplied.created} 条提案，跳过 ${packApplied.skipped} 条`}</AlertTitle>
        </Alert>
      )}
      {suggested && !actionData?.error && (
        <Alert role="status" className="mb-4">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>
            {suggested.fresh
              ? `主题「${suggested.subject}」新建 ${suggested.created} 条提案，跳过 ${suggested.skipped} 条`
              : `主题「${suggested.subject}」已按当前内容生成过，没有新提案`}
          </AlertTitle>
        </Alert>
      )}
      {actionData?.error && !actionData.targetId && (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertTriangle />
          <AlertTitle>{actionData.error}</AlertTitle>
        </Alert>
      )}
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

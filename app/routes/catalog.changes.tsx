// app/routes/catalog.changes.tsx —— 目录变更记录（ADR-0041）：所有成员可看，按版本倒序列出各版的原因与新增 / 删除 / 改动的条目（只有标识、类型、名称与变了的顶层键，不显示快照内容）；
// ?since=N 只看 N 之后的版本，最多 50 个版本；没有 sources:read 的成员（查看者）看不到数据源与源表条目，数据源相关原因的版本只显示「数据源结构变化」、不列明细（ADR-0005）
import type { Route } from './+types/catalog.changes';
import { Link } from 'react-router';
import { ArrowLeft, Minus, Pencil, Plus } from 'lucide-react';
import { can } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import type { CatalogEntry } from '~/.server/catalog';
import { catalogChangesSince, type CatalogDiff, type CatalogVersionReason } from '~/.server/catalog/versions';
import { getDb } from '~/.server/db/client';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';

const MAX_VERSIONS = 50;

const REASON_LABELS: Partial<Record<CatalogVersionReason, string>> = {
  'mapping.published': '映射发布',
  'mapping.disabled': '映射停用',
  'mapping.restored': '映射恢复',
  'custom_entity.published': '自定义实体发布',
  'custom_entity.deleted': '自定义实体删除',
  'merge_group.published': '合并组发布',
  'source_view.published': '源视图发布',
  'source.scope_changed': '同步范围修改',
  'source.registered': '数据源登记',
  'source.updated': '数据源修改',
  'source.profiled': '采集发现源表结构变化',
  'source.synced': '同步发现源表结构变化',
  'definition.published': '指标或标签发布',
  'definition.deleted': '指标或标签删除',
  'template.published': '模板参数发布',
  'template.auto_enabled': '自动启用模板',
  'business_note.updated': '修改业务说明',
  'catalog.initial': '首次生成目录',
  'platform.capabilities': '平台能力更新',
  'catalog.detected': '读取目录时发现变化',
};

/** 查看者只看到「数据源结构变化」、不列明细的原因 */
const SOURCE_REASONS: ReadonlySet<string> = new Set<CatalogVersionReason>(['source.scope_changed', 'source.registered', 'source.updated', 'source.profiled', 'source.synced']);

const KIND_LABELS: Record<CatalogEntry['kind'], string> = {
  source: '数据源', table: '源表', entity: '实体', field: '字段', relation: '关系',
  metric: '指标', tag: '标签', template: '模板', capability: '平台能力',
};

const CHANGES = {
  added: { label: '新增', icon: Plus, tone: 'text-emerald-600' },
  removed: { label: '删除', icon: Minus, tone: 'text-red-600' },
  changed: { label: '改动', icon: Pencil, tone: 'text-amber-600' },
} as const;
const CHANGE_KINDS = Object.keys(CHANGES) as (keyof typeof CHANGES)[];

export function meta({}: Route.MetaArgs) {
  return [{ title: '目录变更记录 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const since = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get('since') ?? '', 10) || 0);
  const canSources = can(member.role, 'sources:read');
  const { current, versions } = await catalogChangesSince(getDb(), member.tenant.id, since);
  const visible = (x: { kind: CatalogEntry['kind'] }) => canSources || (x.kind !== 'source' && x.kind !== 'table');
  return {
    email: member.email,
    nav: navFor(member),
    current,
    since,
    versions: versions.slice(-MAX_VERSIONS).reverse().map(v => {
      const masked = !canSources && SOURCE_REASONS.has(v.reason);
      const diff: CatalogDiff = masked
        ? { added: [], removed: [], changed: [] }
        : { added: v.diff.added.filter(visible), removed: v.diff.removed.filter(visible), changed: v.diff.changed.filter(visible) };
      return {
        version: v.version,
        at: v.createdAt.toISOString(),
        /** 查看者看到的数据源相关原因统一为 sources，不暴露具体动作 */
        reason: masked ? 'sources' : v.reason,
        reasonLabel: masked ? '数据源结构变化' : REASON_LABELS[v.reason as CatalogVersionReason] ?? v.reason,
        masked,
        diff,
      };
    }),
  };
}

export default function CatalogChanges({ loaderData }: Route.ComponentProps) {
  const { email, nav, current, since, versions } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="目录变更记录"
        description={<><Link to="/lineage" className="inline-flex items-center gap-1 hover:text-slate-900"><ArrowLeft className="size-4" />数据地图</Link>{current !== null && <span className="ml-3">{`当前目录版本 ${current}`}</span>}</>}
      />

      {current === null ? (
        <section className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">还没有目录版本。发布映射、指标或标签，登记数据源或保存业务说明之后，目录的每次变化都会记在这里。<Link to="/lineage" className="ml-2 text-slate-900 underline">去数据地图</Link></section>
      ) : versions.length === 0 ? (
        <section className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">版本 {since} 之后没有新的变化。<Link to="/catalog/changes" className="ml-2 text-slate-900 underline">查看全部版本</Link></section>
      ) : (
        <div className="space-y-4">
          {since > 0 && <p className="text-sm text-slate-500">只显示版本 {since} 之后的变化。<Link to="/catalog/changes" className="ml-2 text-slate-900 underline">查看全部版本</Link></p>}
          {versions.map(v => (
            <section key={v.version} data-catalog-version={v.version} data-reason={v.reason} className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-lg font-semibold">{`版本 ${v.version}`}</h2>
                <span className="font-medium">{v.reasonLabel}</span>
                <span className="text-sm text-slate-500">{new Date(v.at).toLocaleString('zh-CN')}</span>
              </div>
              {v.masked ? null : (
                <ul className="space-y-1 text-sm">
                  {CHANGE_KINDS.flatMap(change => v.diff[change].map(x => {
                    const { label, icon: Icon, tone } = CHANGES[change];
                    return (
                    <li key={`${change}:${x.id}`} data-diff-id={x.id} data-diff-change={change} className="flex flex-wrap items-baseline gap-2">
                      <span className={`inline-flex items-center gap-1 ${tone}`}><Icon className="size-3.5" />{label}</span>
                      <span className="text-slate-500">{KIND_LABELS[x.kind]}</span>
                      <span>{x.name}</span>
                      <code className="text-xs text-slate-400">{x.id}</code>
                      {'keys' in x && <span className="text-xs text-slate-500">{`变了：${x.keys.join('、')}`}</span>}
                    </li>
                    );
                  }))}
                  {v.diff.added.length + v.diff.removed.length + v.diff.changed.length === 0 && <li className="text-slate-400">没有可显示的条目变化</li>}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}

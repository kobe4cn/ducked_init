// app/routes/home.tsx —— 首页：当前租户、空间与成员角色，本租户任务（及有权限时数据源）的概览，有发布权限时的「待你发布」草稿清单，
// 以及当前角色可做与不可做的操作（需登录）
import { Check, Minus, PencilLine } from 'lucide-react';
import { Link } from 'react-router';
import type { Route } from './+types/home';
import { can, capabilitiesOf } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { ROLE_LABELS } from '~/.server/db/schema';
import { navFor } from '~/.server/nav';
import { listPendingPublish, type PendingItem } from '~/.server/pending-publish';
import { listSources } from '~/.server/sources';
import { countTasksByStatus } from '~/.server/tasks';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { StatTile } from '~/components/stat-tile';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const [taskCounts, sources, pending] = await Promise.all([
    countTasksByStatus(member.tenant.id),
    // 查看者没有 sources:read，不查也不显示数据源指标
    can(member.role, 'sources:read') ? listSources(member) : null,
    // 分析师与查看者没有 publish，不查也不显示「待你发布」
    can(member.role, 'publish') ? listPendingPublish(member) : null,
  ]);
  return {
    tenantName: member.tenant.name,
    spaceName: member.space.name,
    email: member.email,
    roleLabel: ROLE_LABELS[member.role],
    nav: navFor(member),
    capabilities: capabilitiesOf(member.role),
    taskCounts,
    sourceCount: sources?.length ?? null,
    pending,
  };
}

/** 「待你发布」的一行：amber 图标加「草稿」标出状态（docs/agents/ui.md 的状态色），名称链到能发布它的页面 */
function PendingRow({ item }: { item: PendingItem }) {
  return (
    <li data-pending-kind={item.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
      <span className="inline-flex shrink-0 items-center gap-1 text-sm text-amber-600">
        <PencilLine className="size-3.5" aria-hidden />
        草稿
      </span>
      <Link to={item.href} className="min-w-0 flex-1 hover:underline">
        <span className="font-medium">{item.name}</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {`${item.kindLabel} · v${item.version} · 最后保存 ${item.lastEditor === 'platform' ? '平台' : item.lastEditor} · ${item.updatedAt.toLocaleString('zh-CN')}`}
        </span>
      </Link>
    </li>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, roleLabel, nav, capabilities, taskCounts, sourceCount, pending } = loaderData;
  const active = taskCounts.queued + taskCounts.running;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={tenantName} description={`当前租户 · ${spaceName} · ${email}（${roleLabel}）`} />

      <div className={`grid gap-4 ${sourceCount === null ? 'sm:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'}`}>
        <StatTile label="进行中" value={active} hint={`排队 ${taskCounts.queued} · 运行 ${taskCounts.running}`} tone={active ? 'text-amber-600' : undefined} />
        <StatTile label="失败" value={taskCounts.failed} hint="查看任务页的失败原因" tone={taskCounts.failed ? 'text-red-600' : undefined} />
        <StatTile label="成功" value={taskCounts.succeeded} hint="已完成的任务" tone={taskCounts.succeeded ? 'text-emerald-600' : undefined} />
        {sourceCount !== null && <StatTile label="数据源数" value={sourceCount} hint="本租户登记的外部连接" />}
      </div>

      {pending !== null && (
        <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title="待你发布">本租户处于草稿状态的可发布项（映射、源视图、指标 / 标签 / 模板定义、自定义实体、合并组）；按双人发布规则，最后保存的人需另一位成员发布。</SectionHeader>
          {pending.length === 0 ? (
            <p className="text-sm text-slate-500">现在没有等你发布的草稿。</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {pending.map(item => <PendingRow key={`${item.kind}:${item.href}`} item={item} />)}
            </ul>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="我的权限">角色为「{roleLabel}」。不可用的操作注明了需要的角色，如需调整请联系本租户管理员。</SectionHeader>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {capabilities.map(c => (
            <li key={c.permission} data-permission={c.permission} data-allowed={String(c.allowed)} className="flex items-start gap-2">
              {c.allowed
                ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="可用" />
                : <Minus className="mt-0.5 size-4 shrink-0 text-slate-400" aria-label="不可用" />}
              <div>
                <div className={c.allowed ? undefined : 'text-slate-500'}>{c.label}</div>
                {c.reason && <div className="text-xs text-slate-500">{c.reason}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}

// app/routes/home.tsx —— 首页：当前租户、空间与成员角色，本租户任务（及有权限时数据源）的概览，以及当前角色可做与不可做的操作（需登录）
import { Check, Minus } from 'lucide-react';
import type { Route } from './+types/home';
import { can, capabilitiesOf } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { ROLE_LABELS } from '~/.server/db/schema';
import { navFor } from '~/.server/nav';
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
  const [taskCounts, sources] = await Promise.all([
    countTasksByStatus(member.tenant.id),
    // 查看者没有 sources:read，不查也不显示数据源指标
    can(member.role, 'sources:read') ? listSources(member) : null,
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
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, roleLabel, nav, capabilities, taskCounts, sourceCount } = loaderData;
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

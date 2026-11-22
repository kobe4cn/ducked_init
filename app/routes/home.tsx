// app/routes/home.tsx —— 首页：当前租户、空间与成员角色，本租户任务（及有权限时数据源）的概览，有发布权限时的「待你发布」草稿清单，
// 以及当前角色可做与不可做的操作（需登录）
import { Check, Minus, PencilLine } from 'lucide-react';
import { Link } from 'react-router';
import type { Route } from './+types/home';
import { can, capabilitiesOf, type Permission } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import { listPendingPublish, type PendingItem } from '~/.server/pending-publish';
import { listSources } from '~/.server/sources';
import { countTasksByStatus } from '~/.server/tasks';
import { builtinName, ENUM_LABELS } from '~/lib/builtin-names';
import { formatDateTime } from '~/lib/format';
import { makeT, useLocale, useT, type T } from '~/lib/i18n';
import { ROLE_LABELS, ROLES, type Role } from '~/lib/roles';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { StatTile } from '~/components/stat-tile';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: t('CRM 数据分析平台') }];
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
    role: member.role,
    nav: navFor(member),
    // 不可用的原因（「仅…可以…」）在组件里按界面语言拼，这里只下发判断需要的角色列表
    capabilities: capabilitiesOf(member.role).map(({ permission, allowed }) => ({
      permission,
      allowed,
      roles: allowed ? null : ROLES.filter(r => can(r, permission)),
    })),
    taskCounts,
    sourceCount: sources?.length ?? null,
    pending,
  };
}

/** 能力名：中文与 access.ts 的 PERMISSIONS 逐字一致，这里写成字面量 t('…') 才能与词典对账（英文归 #1064 的 access.ts 不动） */
const capabilityLabel = (t: T, permission: Permission): string => ({
  'sources:read': t('查看数据源与映射'),
  'sources:write': t('登记与修改数据源、映射'),
  'definitions:read': t('查看指标、标签与模板定义'),
  'definitions:draft': t('起草指标、标签与模板定义'),
  'definitions:write': t('修改与删除指标、标签定义'),
  publish: t('发布映射与定义'),
  sandbox: t('使用个人沙箱'),
  'results:read': t('查看结果层'),
  'members:manage': t('邀请成员、修改角色与移除成员'),
  'api_keys:manage': t('管理外部系统 API Key'),
  'model_provider:manage': t('配置模型服务'),
  'audit:read': t('查看审计日志'),
  'pii:reveal': t('申请解密敏感信息'),
})[permission];

/** 角色的展示名（builtin 名单里的角色名按语言翻，名单外的原样） */
const roleLabelOf = (t: T, role: Role): string => builtinName(t, ROLE_LABELS[role], ENUM_LABELS);

/** 嵌进句子里时的能力名：英文标签首字母小写；中文以汉字开头，toLowerCase 不改变输出 */
const inSentence = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** 「待你发布」的一行：amber 图标加「草稿」标出状态（docs/agents/ui.md 的状态色），名称链到能发布它的页面 */
function PendingRow({ item }: { item: PendingItem }) {
  const t = useT();
  const locale = useLocale();
  return (
    <li data-pending-kind={item.kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
      <span className="inline-flex shrink-0 items-center gap-1 text-sm text-amber-600">
        <PencilLine className="size-3.5" aria-hidden />
        {t('草稿')}
      </span>
      <Link to={item.href} className="min-w-0 flex-1 hover:underline">
        <span className="font-medium">{item.kind === 'template' ? builtinName(t, item.name) : item.name}</span>
        <span className="mt-0.5 block text-xs text-slate-500">
          {t('{kind} · v{version} · 最后保存 {editor} · {time}', {
            kind: t('{kind, select, mapping {映射} source_view {源视图} metric {指标} tag {标签} template {模板} custom_entity {自定义实体} merge_group {合并组} other {{kind}}}', { kind: item.kind }),
            version: item.version,
            editor: item.lastEditor === 'platform' ? t('平台') : item.lastEditor,
            time: formatDateTime(locale, item.updatedAt),
          })}
        </span>
      </Link>
    </li>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { tenantName, spaceName, email, role, nav, capabilities, taskCounts, sourceCount, pending } = loaderData;
  const t = useT();
  const roleLabel = roleLabelOf(t, role);
  const active = taskCounts.queued + taskCounts.running;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={tenantName} description={t('当前租户 · {space} · {email}（{role}）', { space: spaceName, email, role: roleLabel })} />

      <div className={`grid gap-4 ${sourceCount === null ? 'sm:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4'}`}>
        <StatTile label={t('进行中')} value={active} hint={t('排队 {queued} · 运行 {running}', { queued: taskCounts.queued, running: taskCounts.running })} tone={active ? 'text-amber-600' : undefined} />
        <StatTile label={t('失败')} value={taskCounts.failed} hint={t('查看任务页的失败原因')} tone={taskCounts.failed ? 'text-red-600' : undefined} />
        <StatTile label={t('成功')} value={taskCounts.succeeded} hint={t('已完成的任务')} tone={taskCounts.succeeded ? 'text-emerald-600' : undefined} />
        {sourceCount !== null && <StatTile label={t('数据源数')} value={sourceCount} hint={t('本租户登记的外部连接')} />}
      </div>

      {pending !== null && (
        <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title={t('待你发布')}>{t('本租户处于草稿状态的可发布项（映射、源视图、指标 / 标签 / 模板定义、自定义实体、合并组）；按双人发布规则，最后保存的人需另一位成员发布。')}</SectionHeader>
          {pending.length === 0 ? (
            <p className="text-sm text-slate-500">{t('现在没有等你发布的草稿。')}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {pending.map(item => <PendingRow key={`${item.kind}:${item.href}`} item={item} />)}
            </ul>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('我的权限')}>{t('角色为「{role}」。不可用的操作注明了需要的角色，如需调整请联系本租户管理员。', { role: roleLabel })}</SectionHeader>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {capabilities.map(c => (
            <li key={c.permission} data-permission={c.permission} data-allowed={String(c.allowed)} className="flex items-start gap-2">
              {c.allowed
                ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label={t('可用')} />
                : <Minus className="mt-0.5 size-4 shrink-0 text-slate-400" aria-label={t('不可用')} />}
              <div>
                <div className={c.allowed ? undefined : 'text-slate-500'}>{capabilityLabel(t, c.permission)}</div>
                {c.roles && (
                  <div className="text-xs text-slate-500">
                    {t('仅{roles}可以{action}', {
                      roles: c.roles.map(r => roleLabelOf(t, r)).join(t('、')),
                      action: inSentence(capabilityLabel(t, c.permission)),
                    })}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}

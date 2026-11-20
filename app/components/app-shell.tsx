// app/components/app-shell.tsx —— 登录后页面的外壳：白色顶栏（品牌、按模块分组的胶囊导航（分组是 <details> 下拉，不用 JS 也能开合，路径变化后重新挂载为收起）、
// AI 助手、界面语言菜单、头像首字母（链到「我的设置」）、退出登录），内容铺满宽度；
// 运营后台不是租户成员，不显示 AI 助手（assistant={false}）、语言菜单与头像链接（settingsHref={null}）
import { Form, Link, useLocation } from 'react-router';
import { LogOut } from 'lucide-react';
import { activeGroupLabel, activeNavTo, flattenNav, type NavEntry } from '~/lib/nav';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';
import { AssistantPanel } from '~/components/assistant-panel';
import { LocaleSwitch } from '~/components/locale-switch';

export type { NavItem } from '~/lib/nav';

const avatarClass = 'grid size-8 place-items-center rounded-full bg-slate-200 font-medium text-slate-700';

export function AppShell({ email, nav, children, brand = 'CRM 数据分析平台', logoutAction = '/logout', assistant = true, settingsHref = '/settings' }: {
  email: string;
  nav: NavEntry[];
  children: React.ReactNode;
  brand?: string;
  logoutAction?: string;
  assistant?: boolean;
  settingsHref?: string | null;
}) {
  const pathname = useLocation().pathname;
  const active = activeNavTo(flattenNav(nav), pathname);
  const activeGroup = activeGroupLabel(nav, pathname);
  return (
    <div className="min-h-svh bg-slate-50">
      <header className="border-b bg-white">
        <div className="flex h-16 items-center justify-between gap-6 px-6 lg:px-8">
          <div className="flex items-center gap-8">
            <span className="flex items-center gap-2 font-semibold">
              <span className="size-6 rounded-full bg-gradient-to-br from-sky-400 to-violet-500" />
              {brand}
            </span>
            <nav className="flex flex-wrap gap-1 text-sm">
              {nav.map(entry => 'items' in entry ? (
                // key 带上路径：跳转后重新挂载，下拉收起；再拼 label 避免与同路径的单链接 key 撞车
                <details key={`${pathname}-${entry.label}`} className="relative">
                  <summary className={cn('flex cursor-pointer list-none items-center rounded-full px-3 py-1.5 text-slate-600 hover:bg-slate-100 [&::-webkit-details-marker]:hidden', entry.label === activeGroup && 'bg-slate-900 text-white hover:bg-slate-900')}>
                    {entry.label}
                    <span aria-hidden className="ml-0.5 text-[0.65em]">▾</span>
                  </summary>
                  <div className="absolute left-0 top-full z-50 mt-1 min-w-40 rounded-lg border bg-white p-1 shadow-lg">
                    {entry.items.map(item => (
                      <Link
                        key={item.to}
                        to={item.to}
                        aria-current={item.to === active ? 'page' : undefined}
                        className={cn('block rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-100', item.to === active && 'bg-slate-100 font-medium text-slate-900')}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </details>
              ) : (
                <Link
                  key={entry.to}
                  to={entry.to}
                  aria-current={entry.to === active ? 'page' : undefined}
                  className={cn('rounded-full px-3 py-1.5 text-slate-600 hover:bg-slate-100', entry.to === active && 'bg-slate-900 text-white hover:bg-slate-900')}
                >
                  {entry.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            {assistant && <AssistantPanel />}
            {settingsHref && <LocaleSwitch />}
            {settingsHref ? (
              <Link to={settingsHref} title={`我的设置（${email}）`} aria-label={`我的设置（${email}）`} className={avatarClass}>
                {email[0]?.toUpperCase()}
              </Link>
            ) : (
              <span role="img" title={email} aria-label={email} className={avatarClass}>
                {email[0]?.toUpperCase()}
              </span>
            )}
            <Form method="post" action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">
                <LogOut data-icon="inline-start" />
                退出登录
              </Button>
            </Form>
          </div>
        </div>
      </header>
      <main className="flex flex-col gap-6 px-6 pt-8 pb-24 lg:px-8">{children}</main>
    </div>
  );
}

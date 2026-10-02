// app/components/prototype-shells.tsx —— PROTOTYPE（一次性，不进 main）：三个视觉方向各自的页面外壳。A 左侧深色侧边栏；B 顶栏 + 大页头；C 全宽紧凑顶栏、内容铺满
import { Form, NavLink } from 'react-router';
import { Activity, Boxes, Database, GitMerge, LayoutDashboard, ListChecks, LogOut, ScrollText, Users } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { NavItem } from '~/components/app-shell';
import { Button } from '~/components/ui/button';

const ICONS: Record<string, typeof Database> = {
  '/': LayoutDashboard, '/sources': Database, '/mappings': GitMerge, '/model': Boxes, '/tasks': ListChecks, '/members': Users, '/audit': ScrollText,
};
const iconOf = (to: string) => ICONS[to] ?? Activity;

/** A：左侧深色侧边栏（图标 + 文字），内容区白底、宽屏 */
export function SidebarShell({ email, nav, children }: { email: string; nav: NavItem[]; children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh bg-background">
      <aside className="sticky top-0 flex h-svh w-56 shrink-0 flex-col bg-zinc-950 text-zinc-300">
        <div className="flex h-14 items-center gap-2 px-4 font-semibold text-white">
          <div className="grid size-7 place-items-center rounded-md bg-indigo-500 text-xs">CRM</div>
          数据分析平台
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2 text-sm">
          {nav.map(item => {
            const Icon = iconOf(item.to);
            return (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-3 py-2 hover:bg-white/5 hover:text-white', isActive && 'bg-white/10 text-white')}>
                <Icon className="size-4" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
        <div className="border-t border-white/10 p-3 text-xs">
          <div className="truncate text-zinc-400">{email}</div>
          <Form method="post" action="/logout">
            <button type="submit" className="mt-2 flex items-center gap-1.5 text-zinc-400 hover:text-white"><LogOut className="size-3.5" />退出登录</button>
          </Form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

/** B：白色顶栏 + 渐变大页头（标题、说明、主操作），内容在页头下方居中 */
export function HeroShell({ email, nav, title, description, actions, children }: {
  email: string; nav: NavItem[]; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <span className="flex items-center gap-2 font-semibold"><span className="size-6 rounded-full bg-gradient-to-br from-sky-400 to-violet-500" />CRM 数据分析平台</span>
            <nav className="flex gap-1 text-sm">
              {nav.map(item => (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('rounded-full px-3 py-1.5 text-slate-600 hover:bg-slate-100', isActive && 'bg-slate-900 text-white hover:bg-slate-900')}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span className="grid size-8 place-items-center rounded-full bg-slate-200 font-medium text-slate-700">{email[0]?.toUpperCase()}</span>
            <Form method="post" action="/logout"><Button type="submit" variant="ghost" size="sm"><LogOut />退出</Button></Form>
          </div>
        </div>
      </header>
      <section className="bg-gradient-to-b from-white to-slate-50">
        <div className="mx-auto flex max-w-6xl items-end justify-between gap-6 px-6 pt-10 pb-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-2 max-w-2xl text-slate-500">{description}</p>}
          </div>
          {actions}
        </div>
      </section>
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 pb-24">{children}</main>
    </div>
  );
}

/** C：一行紧凑顶栏（品牌 + 导航 + 账号），下方内容铺满视口高度，适合分栏 */
export function WorkbenchShell({ email, nav, children }: { email: string; nav: NavItem[]; children: React.ReactNode }) {
  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-3 text-sm">
        <div className="flex items-center gap-4">
          <span className="font-mono font-semibold">crm▸</span>
          <nav className="flex">
            {nav.map(item => {
              const Icon = iconOf(item.to);
              return (
                <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-muted-foreground hover:text-foreground', isActive && 'border-foreground text-foreground')}>
                  <Icon className="size-3.5" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {email}
          <Form method="post" action="/logout"><Button type="submit" variant="ghost" size="icon" aria-label="退出登录"><LogOut /></Button></Form>
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

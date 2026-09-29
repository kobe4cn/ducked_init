// app/components/app-shell.tsx —— 登录后页面的外壳：顶栏（导航、当前成员、退出登录）
import { Form, NavLink } from 'react-router';
import { LogOut } from 'lucide-react';
import { cn } from '~/lib/utils';
import { Button } from '~/components/ui/button';

export interface NavItem { to: string; label: string }

export function AppShell({ email, nav, children }: { email: string; nav: NavItem[]; children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-muted">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-6">
            <span className="font-semibold">CRM 数据分析平台</span>
            <nav className="flex items-center gap-4 text-sm">
              {nav.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end
                  className={({ isActive }) => cn('text-muted-foreground hover:text-foreground', isActive && 'text-foreground font-medium')}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{email}</span>
            <Form method="post" action="/logout">
              <Button type="submit" variant="ghost" size="sm">
                <LogOut data-icon="inline-start" />
                退出登录
              </Button>
            </Form>
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">{children}</main>
    </div>
  );
}

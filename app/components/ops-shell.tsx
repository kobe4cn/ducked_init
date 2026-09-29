// app/components/ops-shell.tsx —— 运营后台页面的外壳：与成员页面相同的顶栏，换成运营后台的名称、导航与退出入口
import { AppShell, type NavItem } from '~/components/app-shell';

export function OpsShell({ email, nav, children }: { email: string; nav: NavItem[]; children: React.ReactNode }) {
  return <AppShell email={email} nav={nav} brand="CRM 运营后台" logoutAction="/ops/logout">{children}</AppShell>;
}

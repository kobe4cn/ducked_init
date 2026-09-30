// app/components/ops-shell.tsx —— 运营后台页面的外壳：与成员页面相同的顶栏，换成运营后台的名称、导航与退出入口
import { AppShell, type NavItem } from '~/components/app-shell';

/** 运营后台的导航：只有租户元数据与运营者审计日志，没有进入租户的入口 */
const OPS_NAV: NavItem[] = [
  { to: '/ops', label: '租户' },
  { to: '/ops/audit', label: '审计日志' },
];

export function OpsShell({ email, children }: { email: string; children: React.ReactNode }) {
  return <AppShell email={email} nav={OPS_NAV} brand="CRM 运营后台" logoutAction="/ops/logout">{children}</AppShell>;
}

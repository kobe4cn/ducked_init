// app/lib/nav.ts —— 顶栏导航的高亮与分组（纯函数）：当前路径归到最具体的导航项下（/sources/123 → 数据源；/ops/audit 只算审计日志，不算租户）；
// 导航项可以是单链接，也可以是「分组 + 下拉子项」，展平后同样按最具体路径高亮
export interface NavItem { to: string; label: string }
export interface NavGroup { label: string; items: NavItem[] }
export type NavEntry = NavItem | NavGroup;

const contains = (to: string, pathname: string) => to === '/' || pathname === to || pathname.startsWith(`${to}/`);

/** 当前路径所属的导航项（`to` 最长的匹配项），没有匹配时返回 undefined */
export function activeNavTo(nav: { to: string }[], pathname: string): string | undefined {
  return nav.filter(item => contains(item.to, pathname)).sort((a, b) => b.to.length - a.to.length)[0]?.to;
}

/** 展平导航：单链接原样保留，分组展开成子项（高亮在展平后的列表上做，组内组外规则一致） */
export function flattenNav(nav: NavEntry[]): NavItem[] {
  return nav.flatMap(entry => ('items' in entry ? entry.items : [entry]));
}

/** 当前路径所在的分组名：当前导航项（最具体路径）所属的分组；落在单链接上或没有匹配时返回 undefined */
export function activeGroupLabel(nav: NavEntry[], pathname: string): string | undefined {
  const active = activeNavTo(flattenNav(nav), pathname);
  return nav.find((entry): entry is NavGroup => 'items' in entry && entry.items.some(item => item.to === active))?.label;
}

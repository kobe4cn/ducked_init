// app/lib/nav.ts —— 顶栏导航的高亮：当前路径归到最具体的导航项下（/sources/123 → 数据源；/ops/audit 只算审计日志，不算租户）

const contains = (to: string, pathname: string) => to === '/' || pathname === to || pathname.startsWith(`${to}/`);

/** 当前路径所属的导航项（`to` 最长的匹配项），没有匹配时返回 undefined */
export function activeNavTo(nav: { to: string }[], pathname: string): string | undefined {
  return nav.filter(item => contains(item.to, pathname)).sort((a, b) => b.to.length - a.to.length)[0]?.to;
}

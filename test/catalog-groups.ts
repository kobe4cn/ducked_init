// test/catalog-groups.ts —— 测试共用的分层目录全量输出（#855）：第一层分组与各分组组内列表（Markdown 与 JSON 各一份），
// 从第一层出发跟着分组行与「下一页」走全（合并组、分页都展开），给断言用（敏感信息不进任何输出、统计变了分层输出不变）
import { groupItems, groupOverview, toJson, toMarkdown, type Catalog } from '../app/.server/catalog';

export function groupedText(c: Catalog): string {
  const out: string[] = [];
  const walk = (id: string): void => {
    const gi = groupItems(c, id);
    if (!gi) return;
    out.push(toMarkdown(gi), toJson(gi));
    for (const line of toMarkdown(gi).split('\n')) {
      const group = /^- (?!下一页：)(group:\S+)/.exec(line);
      if (group) walk(group[1]!);
      const next = /^- 下一页：(\S+)/.exec(line);
      if (next) walk(next[1]!);
    }
  };
  const md = toMarkdown(groupOverview(c));
  out.push(md, toJson(groupOverview(c)));
  for (const line of md.split('\n')) {
    const group = /^- (group:\S+)/.exec(line);
    if (group) walk(group[1]!);
  }
  return out.join('\n');
}

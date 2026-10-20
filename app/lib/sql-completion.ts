// app/lib/sql-completion.ts —— 工作台 SQL 编辑器的补全数据：把 loader 已按权限过滤的目录树（listCatalog）转成 lang-sql 的 schema 对象。
// 不引用 codemirror（只有类型），页面组件可以直接用；schema、表名不是简单标识符时由 lang-sql 补全时加引号（结果层 rfm__<任务 ID>、数据源名 "CRM"），
// 字段名是补全对象、lang-sql 不加引号，这里按同一条规则加
import type { Completion } from '@codemirror/autocomplete';
import type { SQLNamespace } from '@codemirror/lang-sql';
import type { WorkbenchCatalog } from '~/.server/workbench';

type Columns = WorkbenchCatalog['silver'][number]['columns'];
/** 一个 schema 里的表名 → 字段补全 */
type TableColumns = Record<string, Completion[]>;

/** lang-sql 把 schema 的键按 . 拆成多级，名字里的点要转义 */
const escapeDots = (name: string) => name.replace(/\./g, '\\.');
/** 与 lang-sql 判断要不要加引号的规则一致 */
const SIMPLE = /^[a-z_][a-z_\d]*$/;
const columns = (cols: Columns): Completion[] => cols.map(c => ({
  label: c.name, type: 'property', detail: c.type, ...(SIMPLE.test(c.name) ? {} : { apply: `"${c.name.replace(/"/g, '""')}"` }),
}));

/**
 * 补全 schema：silver、gold、自己的沙箱与分享来的表按 <schema>.<表>.<字段>，另在 lake 下再放一份（lake.<schema>.<表>）；
 * 原始层按 <数据源名>.<表>.<字段>，没挂载的数据源不出现。只含目录里有的对象，前端不另拼对象名
 */
export function completionSchema(catalog: WorkbenchCatalog): SQLNamespace {
  const lake: Record<string, TableColumns> = {};
  for (const t of [...catalog.silver, ...catalog.gold, ...catalog.mine, ...catalog.shared]) {
    (lake[escapeDots(t.schema)] ??= {})[escapeDots(t.name)] = columns(t.columns);
  }
  const raw: Record<string, TableColumns> = {};
  for (const s of catalog.raw) {
    if (s.error) continue;
    raw[escapeDots(s.name)] = Object.fromEntries(s.tables.map(t => [escapeDots(t.name), columns(t.columns)]));
  }
  return { ...raw, ...lake, lake };
}

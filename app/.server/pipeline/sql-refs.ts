// app/.server/pipeline/sql-refs.ts —— 成员手写 SQL 的表引用检查（源视图 ADR-0022、数据查询工作台 ADR-0036 共用）：
// 在 json_serialize_sql 的解析树里找出引用的每一张表与不允许的东西（表函数、读配置的函数、SHOW 等），由调用方按自己的白名单判断。
// CTE 的可见范围与 DuckDB 绑定时一致：CTE 的定义体只看得到排在它前面的 CTE，递归 CTE 只在 UNION 右半边看得到自己；
// 否则 WITH duckdb_databases AS (SELECT * FROM duckdb_databases) 里的引用会被当成 CTE，实际读的是同名的系统视图

/** SQL 引用的一张表；cte 为真时它是所在作用域里可见的 CTE */
export interface TableRef { catalog: string; schema: string; table: string; cte: boolean }

export interface SqlRefs { tables: TableRef[]; forbidden: string[] }

/** 去掉首尾空白与结尾的分号 */
export const normalizeSql = (sql: string) => sql.trim().replace(/[;\s]+$/, '');

/** 能读出会话配置或环境的标量函数 */
const DENIED_FUNCTIONS = new Set(['getenv', 'current_setting', 'getvariable']);

/** 可以出现在 FROM 里的表引用种类；SHOW_REF 另按 allowedShows 判断，其余（表函数等）一律拒绝 */
const ALLOWED_REFS = new Set(['BASE_TABLE', 'SUBQUERY', 'JOIN', 'EXPRESSION_LIST', 'EMPTY', 'PIVOT']);

interface CteEntry { key: string; value: { query?: { node?: unknown } } }

/**
 * 解析树里引用的表与不允许的表引用，所有层级，含子查询与表达式里的子查询。
 * allowedShows 是放行的 SHOW_REF 种类（如 DESCRIBE、SUMMARY），只放行带查询的（DESCRIBE 一张表或一个查询，里面的表照样收集）。
 * 表引用节点带 sample 字段，不带表达式节点的 class 字段，种类也不像查询节点那样以 _NODE 结尾
 */
export function collectRefs(statements: unknown, { allowedShows = new Set<string>() }: { allowedShows?: ReadonlySet<string> } = {}): SqlRefs {
  const out: SqlRefs = { tables: [], forbidden: [] };
  const visit = (node: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, ctes);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    const defined = (o.cte_map as { map?: CteEntry[] } | undefined)?.map ?? [];
    // 第 i 个 CTE 的定义体只看得到外层与它前面的 CTE；查询本身看得到全部
    defined.forEach((c, i) => visit(c.value, new Set([...ctes, ...defined.slice(0, i).map(d => d.key.toLowerCase())])));
    if (defined.length) ctes = new Set([...ctes, ...defined.map(c => c.key.toLowerCase())]);
    if (o.type === 'RECURSIVE_CTE_NODE') {
      // 递归 CTE 的锚点（left）引用同名表时读的是真实的表，只有递归部分（right）看得到自己
      const self = String(o.cte_name).toLowerCase();
      visit(o.left, new Set([...ctes].filter(c => c !== self)));
      visit(o.right, new Set([...ctes, self]));
      visit([o.modifiers, o.key_targets], ctes);
      return;
    }
    if (o.class === 'FUNCTION' && DENIED_FUNCTIONS.has(String(o.function_name).toLowerCase())) out.forbidden.push(`函数 ${o.function_name}`);
    if ('sample' in o && !('class' in o) && !String(o.type).endsWith('_NODE')) {
      if (o.type === 'BASE_TABLE') {
        const [catalog, schema, table] = [String(o.catalog_name ?? ''), String(o.schema_name ?? ''), String(o.table_name)];
        out.tables.push({ catalog, schema, table, cte: !catalog && !schema && ctes.has(table.toLowerCase()) });
      } else if (o.type === 'TABLE_FUNCTION') {
        out.forbidden.push(`表函数 ${(o.function as { function_name?: string } | undefined)?.function_name ?? ''}`.trim());
      } else if (o.type === 'SHOW_REF') {
        if (!(allowedShows.has(String(o.show_type)) && o.query)) out.forbidden.push('SHOW / DESCRIBE / SUMMARIZE');
      } else if (!ALLOWED_REFS.has(String(o.type))) {
        out.forbidden.push(String(o.type));
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'cte_map') visit(v, ctes);
  };
  visit(statements, new Set());
  return out;
}

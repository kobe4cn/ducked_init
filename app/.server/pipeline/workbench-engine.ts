// app/.server/pipeline/workbench-engine.ts —— 数据查询工作台：校验成员手写的一条只读 SQL，并在只读挂载的数据湖上取出前若干行（ADR-0036）。
// 写入由只读挂载挡住；读的范围由这里挡住：用 DuckDB 自己的解析器（json_serialize_sql）拿到 SQL 引用的每一张表，
// 只能是 lake（或不写 catalog）里标准层 silver 与结果层 gold 的表，或所在作用域里的 CTE（sql-refs.ts）。会话里还挂着可写的本机库 stage
// 与 DuckLake 的元数据库 __ducklake_metadata_lake（里面有加密密钥，ADR-0020），表函数、SHOW DATABASES 之类与读配置的函数一律拒绝
import type { DuckDBConnection } from '@duckdb/node-api';
import { collectRefs, normalizeSql } from './sql-refs';

/** 可以展示给成员的 SQL 问题 */
export class WorkbenchSqlError extends Error {}

/** 能读的 schema */
const WORKBENCH_SCHEMAS = ['silver', 'gold'] as const;

/** 校验通过的查询：sql 是实际执行的语句（SHOW TABLES 换成只列标准层与结果层的查询） */
export interface CheckedQuery { sql: string }

export interface WorkbenchResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  /** 结果超过 limit 行，只给出了前 limit 行 */
  truncated: boolean;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const normalizeWorkbenchSql = normalizeSql;

const ALLOWED_STATEMENTS = '只能执行一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN 语句';
const ONLY_SILVER_GOLD = '只能读标准层 silver 与结果层 gold';

/** 放行的 SHOW_REF：DESCRIBE / SUMMARIZE 一张表或一个查询（里面的表照样检查） */
const ALLOWED_SHOWS = new Set(['DESCRIBE', 'SUMMARY']);

/** SHOW TABLES、SHOW ALL TABLES 与不带对象的 DESCRIBE 在解析树里的表名 */
const SHOW_TABLES = new Set(['"tables"', '__show_tables_expanded']);

/** 列出能读的表：代替 SHOW TABLES（原样执行会列出 stage 与元数据库里的表） */
const listTablesSql = (schemas: readonly string[]) => `SELECT table_schema AS schema, table_name AS name, table_type AS type
  FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema IN (${schemas.map(lit).join(', ')}) ORDER BY 1, 2`;

/** 整条语句就是 SHOW TABLES / SHOW ALL TABLES / DESCRIBE / SHOW TABLES FROM <schema> 时，要列的 schema；否则 null */
function showTablesOf(statement: unknown): readonly string[] | null {
  const from = (statement as { node?: { from_table?: Record<string, unknown> } }).node?.from_table;
  if (from?.type !== 'SHOW_REF' || from.query) return null;
  if (from.show_type === 'SHOW_UNQUALIFIED' && SHOW_TABLES.has(String(from.table_name))) return WORKBENCH_SCHEMAS;
  if (from.show_type !== 'SHOW_FROM') return null;
  const [catalog, schema] = [String(from.catalog_name ?? '').toLowerCase(), String(from.schema_name ?? '').toLowerCase()];
  if (catalog && catalog !== 'lake') throw new WorkbenchSqlError(`${ONLY_SILVER_GOLD}，不能列出 ${catalog}${schema ? `.${schema}` : ''} 的表`);
  if (!(WORKBENCH_SCHEMAS as readonly string[]).includes(schema)) throw new WorkbenchSqlError(`${ONLY_SILVER_GOLD}，不能列出 ${schema} 的表`);
  return [schema];
}

/**
 * 校验工作台的 SQL：只能是一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN [ANALYZE]，引用的表只能是 silver / gold 的表
 * （catalog 只能不写或写 lake）或所在作用域里的 CTE，不能用表函数、读配置的函数。SHOW TABLES 换成只列 silver / gold 的查询。
 * 不合规时抛出 WorkbenchSqlError
 */
export async function checkWorkbenchSql(con: DuckDBConnection, sql: string): Promise<CheckedQuery> {
  sql = normalizeWorkbenchSql(sql);
  if (!sql) throw new WorkbenchSqlError('请填写 SQL');
  // json_serialize_sql 只认 SELECT（DESCRIBE / SHOW / SUMMARIZE 也解析成 SELECT）：EXPLAIN 去掉前缀后检查后面的查询，执行时原样执行
  const explain = /^explain\s+(analyze\s+)?/i.exec(sql);
  const body = explain ? sql.slice(explain[0].length) : sql;
  const [{ j }] = (await con.runAndReadAll(`SELECT json_serialize_sql(${lit(body)}) AS j`)).getRowObjectsJson() as { j: string }[];
  const tree = JSON.parse(j) as { error: boolean; error_message?: string; statements?: unknown[] };
  if (tree.error) throw new WorkbenchSqlError(/only select/i.test(tree.error_message ?? '') ? ALLOWED_STATEMENTS : `SQL 有语法错误：${tree.error_message}`);
  if (tree.statements?.length !== 1) throw new WorkbenchSqlError(ALLOWED_STATEMENTS);
  if (!explain) {
    const schemas = showTablesOf(tree.statements[0]);
    if (schemas) return { sql: listTablesSql(schemas) };
  }
  const found = collectRefs(tree.statements, { allowedShows: ALLOWED_SHOWS });
  if (found.forbidden.length) throw new WorkbenchSqlError(`不能用 ${[...new Set(found.forbidden)].join('、')}，${ONLY_SILVER_GOLD}的表`);
  for (const t of found.tables) {
    if (t.cte) continue;
    const name = [t.catalog, t.schema, t.table].filter(Boolean).join('.');
    if (t.catalog && t.catalog.toLowerCase() !== 'lake') throw new WorkbenchSqlError(`${ONLY_SILVER_GOLD}，不能读 ${name}`);
    if (!(WORKBENCH_SCHEMAS as readonly string[]).includes(t.schema.toLowerCase())) {
      throw new WorkbenchSqlError(t.schema
        ? `${ONLY_SILVER_GOLD}，不能读 ${name}`
        : `表 ${t.table} 要写明 schema，如 silver.${t.table}（${ONLY_SILVER_GOLD}）`);
    }
  }
  return { sql };
}

/** 执行校验过的查询，最多取 limit 行（多读一行判断是否截断）。取值转成 JSON 能表示的形式 */
export async function runWorkbenchQuery(con: DuckDBConnection, query: CheckedQuery, { limit }: { limit: number }): Promise<WorkbenchResult> {
  const reader = await con.streamAndReadUntil(query.sql, limit + 1);
  const names = reader.columnNames();
  const types = reader.columnTypes();
  const rows = reader.getRowsJson();
  return {
    columns: names.map((name, i) => ({ name, type: types[i].toString() })),
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

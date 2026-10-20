// app/.server/pipeline/workbench-engine.ts —— 数据查询工作台：校验成员手写的一条只读 SQL，并在只读挂载的数据湖上取出前若干行（ADR-0036）。
// 写入由只读挂载挡住；读的范围由这里挡住：用 DuckDB 自己的解析器（json_serialize_sql）拿到 SQL 引用的每一张表，
// 只能是 lake（或不写 catalog）里标准层 silver、结果层 gold、成员自己的沙箱 sandbox_<成员> 与别人分享给他的沙箱表，或所在作用域里的 CTE（sql-refs.ts）。
// 读别人没分享的沙箱表时，表在与不在报同样的话。
// 会话里还挂着可写的本机库 stage 与 DuckLake 的元数据库 __ducklake_metadata_lake（里面有加密密钥，ADR-0020），
// 表函数、SHOW DATABASES 之类与读配置的函数一律拒绝。
// 保存沙箱表在可写挂载上执行：成员只给表名与一条校验过的 SELECT，CREATE 语句由这里拼出，只写进成员自己的沙箱
import type { DuckDBConnection } from '@duckdb/node-api';
import { collectRefs, normalizeSql } from './sql-refs';

/** 可以展示给成员的 SQL 问题 */
export class WorkbenchSqlError extends Error {}

/** 人人能读的 schema；成员自己的沙箱与分享给他的表另外加上 */
const WORKBENCH_SCHEMAS = ['silver', 'gold'] as const;

/** 成员的沙箱 schema：sandbox_<成员 ID 去掉横线> */
export const sandboxSchema = (memberId: string) => `sandbox_${memberId.replace(/-/g, '').toLowerCase()}`;
const SANDBOX_SCHEMA = /^sandbox_[0-9a-f]{32}$/;

/** 沙箱表名：小写字母开头，小写字母、数字、下划线，最长 63 个字符 */
export const SANDBOX_TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** 别人分享给成员的一张沙箱表：主人的沙箱 schema 与表名 */
export interface SandboxTableRef { schema: string; table: string }

/** 工作台能读的沙箱：成员自己的沙箱 schema 与别人分享给他的表 */
export interface SandboxAccess { sandbox?: string; shared?: readonly SandboxTableRef[] }

/**
 * 校验通过的查询：sql 是实际执行的语句（SHOW TABLES 换成只列能读的 schema 的查询）；
 * savable 为真时它是一条 SELECT / WITH（不是 EXPLAIN、DESCRIBE、SHOW、SUMMARIZE），可以保存为沙箱表
 */
export interface CheckedQuery { sql: string; savable: boolean }

export interface WorkbenchResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  /** 结果超过 limit 行，只给出了前 limit 行 */
  truncated: boolean;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const normalizeWorkbenchSql = normalizeSql;

const ALLOWED_STATEMENTS = '只能执行一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN 语句';
/** 说明能读哪些 schema */
const readableHint = (sandbox?: string, shared = false) =>
  `只能读标准层 silver 与结果层 gold${sandbox ? `、自己的沙箱 ${sandbox}` : ''}${shared ? '、分享给你的沙箱表' : ''}`;

/** 放行的 SHOW_REF：DESCRIBE / SUMMARIZE 一张表或一个查询（里面的表照样检查） */
const ALLOWED_SHOWS = new Set(['DESCRIBE', 'SUMMARY']);

/** SHOW TABLES、SHOW ALL TABLES 与不带对象的 DESCRIBE 在解析树里的表名 */
const SHOW_TABLES = new Set(['"tables"', '__show_tables_expanded']);

/** 列出能读的表（shared 是分享来的表，SHOW TABLES 时一并列出）：代替 SHOW TABLES（原样执行会列出 stage 与元数据库里的表） */
const listTablesSql = (schemas: readonly string[], shared: readonly SandboxTableRef[] = []) => `SELECT table_schema AS schema, table_name AS name, table_type AS type
  FROM information_schema.tables WHERE table_catalog = 'lake' AND (table_schema IN (${schemas.map(lit).join(', ')})${
  shared.map(t => ` OR (table_schema = ${lit(t.schema)} AND table_name = ${lit(t.table)})`).join('')}) ORDER BY 1, 2`;

/**
 * 整条语句就是 SHOW TABLES / SHOW ALL TABLES / DESCRIBE / SHOW TABLES FROM <schema> 时，要列的 schema（all：不带 FROM，能读的都列）；否则 null
 */
function showTablesOf(statement: unknown, schemas: readonly string[], hint: string): { schemas: readonly string[]; all: boolean } | null {
  const from = (statement as { node?: { from_table?: Record<string, unknown> } }).node?.from_table;
  if (from?.type !== 'SHOW_REF' || from.query) return null;
  if (from.show_type === 'SHOW_UNQUALIFIED' && SHOW_TABLES.has(String(from.table_name))) return { schemas, all: true };
  if (from.show_type !== 'SHOW_FROM') return null;
  const [catalog, schema] = [String(from.catalog_name ?? '').toLowerCase(), String(from.schema_name ?? '').toLowerCase()];
  if (catalog && catalog !== 'lake') throw new WorkbenchSqlError(`${hint}，不能列出 ${catalog}${schema ? `.${schema}` : ''} 的表`);
  if (!schemas.includes(schema)) throw new WorkbenchSqlError(`${hint}，不能列出 ${schema} 的表`);
  return { schemas: [schema], all: false };
}

/** 顶层是 SHOW_REF（DESCRIBE、SUMMARIZE、SHOW）的语句 */
const isShow = (statement: unknown) => (statement as { node?: { from_table?: { type?: string } } }).node?.from_table?.type === 'SHOW_REF';

/**
 * 校验工作台的 SQL：只能是一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN [ANALYZE]，引用的表只能是 silver / gold
 * 与 sandbox（成员自己的沙箱 schema，给了时）的表、shared 里的表（catalog 只能不写或写 lake）或所在作用域里的 CTE，
 * 不能用表函数、读配置的函数。别的沙箱表一律报「不存在或没有权限」。SHOW TABLES 换成只列这些 schema 与表的查询。不合规时抛出 WorkbenchSqlError
 */
export async function checkWorkbenchSql(con: DuckDBConnection, sql: string, { sandbox, shared = [] }: SandboxAccess = {}): Promise<CheckedQuery> {
  const schemas: readonly string[] = sandbox ? [...WORKBENCH_SCHEMAS, sandbox] : WORKBENCH_SCHEMAS;
  const hint = readableHint(sandbox, shared.length > 0);
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
    const listed = showTablesOf(tree.statements[0], schemas, hint);
    if (listed) return { sql: listTablesSql(listed.schemas, listed.all ? shared : []), savable: false };
  }
  const found = collectRefs(tree.statements, { allowedShows: ALLOWED_SHOWS });
  if (found.forbidden.length) throw new WorkbenchSqlError(`不能用 ${[...new Set(found.forbidden)].join('、')}，${hint}的表`);
  for (const t of found.tables) {
    if (t.cte) continue;
    const name = [t.catalog, t.schema, t.table].filter(Boolean).join('.');
    if (t.catalog && t.catalog.toLowerCase() !== 'lake') throw new WorkbenchSqlError(`${hint}，不能读 ${name}`);
    const schema = t.schema.toLowerCase();
    if (shared.some(s => s.schema === schema && s.table === t.table.toLowerCase())) continue;
    if (schema.startsWith('sandbox_') && schema !== sandbox) throw new WorkbenchSqlError(`表 ${name} 不存在或没有权限`);
    if (!schemas.includes(schema)) {
      throw new WorkbenchSqlError(t.schema
        ? `${hint}，不能读 ${name}`
        : `表 ${t.table} 要写明 schema，如 silver.${t.table}（${hint}）`);
    }
  }
  return { sql, savable: !explain && !isShow(tree.statements[0]) };
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

/**
 * 把校验过的 SELECT 存为成员沙箱里的表 lake.<schema>."<name>"（同名表覆盖），返回行数。
 * query 必须是同一会话里 checkWorkbenchSql 的结果；schema 由 sandboxSchema 给出，表名不合规时抛出 WorkbenchSqlError。
 * 拼出的语句再交给 DuckDB 拆分，确认仍是一条，才执行
 */
export async function saveSandboxTable(con: DuckDBConnection, schema: string, name: string, query: CheckedQuery): Promise<number> {
  if (!SANDBOX_SCHEMA.test(schema)) throw new Error(`不是沙箱 schema：${schema}`);
  if (!SANDBOX_TABLE_NAME.test(name)) throw new WorkbenchSqlError('表名只能用小写字母、数字和下划线，以小写字母开头，最长 63 个字符');
  if (!query.savable) throw new WorkbenchSqlError('只能把 SELECT / WITH 查询的结果保存为沙箱表');
  const table = `lake."${schema}"."${name}"`;
  const create = `CREATE OR REPLACE TABLE ${table} AS ${query.sql}`;
  if ((await con.extractStatements(create)).count !== 1) throw new WorkbenchSqlError('只能把一条 SELECT / WITH 查询的结果保存为沙箱表');
  await con.run(`CREATE SCHEMA IF NOT EXISTS lake."${schema}"`);
  await con.run(create);
  const [{ n }] = (await con.runAndReadAll(`SELECT count(*) AS n FROM ${table}`)).getRowObjectsJson() as { n: string }[];
  return Number(n);
}

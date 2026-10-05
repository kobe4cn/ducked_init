// app/.server/pipeline/source-view-engine.ts —— 源视图：校验一段只读原始层的 SELECT，并在只读挂载的数据湖上取出视图的列与前几行样本（ADR-0022）。
// 写入由只读挂载挡住；跨 schema 的读取另由这里挡住：用 DuckDB 自己的解析器（json_serialize_sql）拿到 SQL 引用的每一张表，
// 只能是本数据源原始层（bronze_<数据源 ID>）的表或所在作用域里的 CTE，不能用表函数（read_parquet 等可以读任意路径）。
// 视图要输出平台列 _op、_batch、_commit_ts，映射才能沿用变更批次的增量语义（ADR-0006）。
// 样本不直接读原始层：会话的本机库 stage 里给本数据源的每张原始层表建一个同名视图，敏感列先换成按租户加盐的哈希，
// 视图 SQL 在这些视图上执行，任何表达式与报错都只见得到哈希（ADR-0005）
import { createHash } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import { SENSITIVE_FORMATS, SENSITIVE_NAME } from '../../lib/sensitive';
import { TEXT_FORMATS, type TextFormat } from './source-engine';
import { bronzeSchema, PLATFORM_COLUMNS } from './sync-engine';

/** 可以展示给成员的 SQL 问题 */
export class ViewSqlError extends Error {}

/** 视图必须输出的平台列 */
export const VIEW_PLATFORM_COLUMNS = ['_op', '_batch', '_commit_ts'] as const;

export interface ViewColumn { name: string; type: string; sensitive: boolean }
/** tables：视图引用的本数据源原始层的表（映射在这些表同步后合并） */
export interface ViewPreview { columns: ViewColumn[]; rows: Record<string, unknown>[]; limit: number; tables: string[] }

/** SQL 引用的一张表；cte 为真时它是所在作用域里定义的 CTE */
interface TableRef { catalog: string; schema: string; table: string; cte: boolean }

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** 去掉首尾空白与结尾的分号 */
export const normalizeViewSql = (sql: string) => sql.trim().replace(/[;\s]+$/, '');

/** 能读出会话配置或环境的标量函数 */
const DENIED_FUNCTIONS = new Set(['getenv', 'current_setting', 'getvariable']);

/** 可以出现在 FROM 里的表引用种类；其余（表函数、SHOW / DESCRIBE 等）一律拒绝 */
const ALLOWED_REFS = new Set(['BASE_TABLE', 'SUBQUERY', 'JOIN', 'EXPRESSION_LIST', 'EMPTY', 'PIVOT']);

/**
 * 解析树里引用的表与不允许的表引用（表函数名或种类），所有层级，含子查询与表达式里的子查询。
 * ctes 是当前作用域里可见的 CTE 名：一个查询定义的 CTE 只在这个查询（含 CTE 本身，可以递归）里可见，外层同名的引用不算 CTE。
 * 表引用节点带 sample 字段，不带表达式节点的 class 字段，种类也不像查询节点那样以 _NODE 结尾
 */
function collect(node: unknown, out: { tables: TableRef[]; forbidden: string[] }, ctes: ReadonlySet<string> = new Set()) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, ctes);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const defined = (o.cte_map as { map?: { key: string }[] } | undefined)?.map ?? [];
  if (defined.length) ctes = new Set([...ctes, ...defined.map(c => c.key.toLowerCase())]);
  if (o.class === 'FUNCTION' && DENIED_FUNCTIONS.has(String(o.function_name).toLowerCase())) out.forbidden.push(`函数 ${o.function_name}`);
  if ('sample' in o && !('class' in o) && !String(o.type).endsWith('_NODE')) {
    if (o.type === 'BASE_TABLE') {
      const [catalog, schema, table] = [String(o.catalog_name ?? ''), String(o.schema_name ?? ''), String(o.table_name)];
      out.tables.push({ catalog, schema, table, cte: !catalog && !schema && ctes.has(table.toLowerCase()) });
    } else if (o.type === 'TABLE_FUNCTION') {
      out.forbidden.push(`表函数 ${(o.function as { function_name?: string } | undefined)?.function_name ?? ''}`.trim());
    } else if (!ALLOWED_REFS.has(String(o.type))) {
      out.forbidden.push(o.type === 'SHOW_REF' ? 'SHOW / DESCRIBE / SUMMARIZE' : String(o.type));
    }
  }
  for (const v of Object.values(o)) collect(v, out, ctes);
}

/**
 * 校验源视图的 SQL：只能是一条 SELECT，引用的表只能是本数据源原始层的表（可以带 bronze_<数据源 ID> 前缀，也可以不带，不能带 catalog）
 * 或所在作用域里的 CTE，不能用表函数、SHOW 等与读配置的函数。bronzeTables 是本数据源原始层现有的表。不合规时抛出 ViewSqlError；
 * 通过时返回引用的原始层表（按 bronzeTables 里的写法，去重排序）
 */
export async function checkViewSql(con: DuckDBConnection, sql: string, sourceId: string, bronzeTables: readonly string[]) {
  if (!sql) throw new ViewSqlError('请填写 SQL');
  const [{ j }] = await rows<{ j: string }>(con, `SELECT json_serialize_sql(${lit(sql)}) AS j`);
  const tree = JSON.parse(j) as { error: boolean; error_message?: string; statements?: unknown[] };
  if (tree.error) {
    throw new ViewSqlError(/only select/i.test(tree.error_message ?? '') ? '源视图只能是一条 SELECT 语句，不能写入或执行其他语句' : `SQL 有语法错误：${tree.error_message}`);
  }
  if (tree.statements?.length !== 1) throw new ViewSqlError('源视图只能是一条 SELECT 语句');
  const found = { tables: [] as TableRef[], forbidden: [] as string[] };
  collect(tree.statements, found);
  if (found.forbidden.length) throw new ViewSqlError(`源视图不能用 ${[...new Set(found.forbidden)].join('、')}，只能读本数据源原始层的表`);
  const schema = bronzeSchema(sourceId);
  const own = new Map(bronzeTables.map(t => [t.toLowerCase(), t]));
  const used = new Set<string>();
  for (const t of found.tables) {
    const name = [t.catalog, t.schema, t.table].filter(Boolean).join('.');
    // 不能带 catalog：预览在 stage 里的同名视图上执行，带上 lake 就绕过了敏感列的哈希
    if (t.catalog || (t.schema && t.schema.toLowerCase() !== schema)) {
      throw new ViewSqlError(`源视图只能读本数据源原始层的表，不能读 ${name}`);
    }
    if (t.cte) continue;
    const table = own.get(t.table.toLowerCase());
    if (!table) throw new ViewSqlError(`本数据源的原始层没有表 ${t.table}（只能读已同步进原始层的表）`);
    used.add(table);
  }
  return [...used].sort();
}

/** 本数据源原始层现有的表 */
export async function bronzeTablesOf(con: DuckDBConnection, sourceId: string) {
  return (await rows<{ name: string }>(con, `SELECT table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'lake' AND table_schema = ${lit(bronzeSchema(sourceId))} ORDER BY 1`)).map(r => r.name);
}

/** 在文本里出现邮箱、手机号（不要求整段都是） */
const SENSITIVE_PATTERNS = SENSITIVE_FORMATS.map(f => new RegExp(TEXT_FORMATS[f as TextFormat].replace(/^\^|\$$/g, '')));
const HASH = /^[0-9a-f]{64}$/;
const CONTAINS_HASH = /[0-9a-f]{64}/;
const sensitiveName = (name: string) => !PLATFORM_COLUMNS.includes(name) && SENSITIVE_NAME.test(name);

/**
 * 在 stage 里建与本数据源原始层同名的 schema，每张表一个同名视图：sensitive 里列出的列（采集时像敏感信息的）与列名像敏感信息的列
 * 换成 sha256(盐 || 取值)，其余列原样。返回这个 schema 名
 */
async function maskedBronze(con: DuckDBConnection, sourceId: string, tables: readonly string[], sensitive: Readonly<Record<string, readonly string[]>>, salt: string) {
  const schema = bronzeSchema(sourceId);
  await con.run(`CREATE SCHEMA IF NOT EXISTS stage.${ident(schema)}`);
  for (const table of tables) {
    const columns = await rows<{ name: string }>(con, `SELECT column_name AS name FROM information_schema.columns
      WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(table)} ORDER BY ordinal_position`);
    const masked = new Set(sensitive[table] ?? []);
    const select = columns.map(({ name }) => (masked.has(name) || sensitiveName(name)
      ? `sha256(${lit(salt)} || CAST(${ident(name)} AS VARCHAR)) AS ${ident(name)}` : ident(name)));
    await con.run(`CREATE OR REPLACE VIEW stage.${ident(schema)}.${ident(table)} AS SELECT ${select.join(', ')} FROM lake.${ident(schema)}.${ident(table)}`);
  }
  return schema;
}

/**
 * 输出的一列是否当作敏感：列名像敏感信息（平台列的名字不算），样本里有取值含哈希（来自哈希过的源列），
 * 或有取值里出现邮箱、手机号（任何列，别名改成平台列也一样）
 */
const looksSensitive = (name: string, values: unknown[]) => sensitiveName(name) || values.some(v => v !== null && v !== undefined
  && [CONTAINS_HASH, ...SENSITIVE_PATTERNS].some(p => p.test(typeof v === 'string' ? v : JSON.stringify(v))));

/**
 * 校验源视图并取预览：视图的列（DESCRIBE，在原始层上，不读数据）与前 limit 行样本（在哈希过敏感列的同名视图上，见 maskedBronze）。
 * 输出里像敏感信息、还不是哈希的取值再换成哈希。sensitive 是各原始层表里采集时像敏感信息的列。con 须是只读挂载数据湖的会话
 */
export async function previewView(
  con: DuckDBConnection, sql: string, sourceId: string, salt: string, limit: number, sensitive: Readonly<Record<string, readonly string[]>> = {},
): Promise<ViewPreview> {
  const tables = await bronzeTablesOf(con, sourceId);
  const used = await checkViewSql(con, sql, sourceId, tables);
  // 换行再收尾：SQL 末尾的行注释不会吞掉右括号
  const query = `SELECT * FROM (\n${sql}\n)`;
  const schema = bronzeSchema(sourceId);
  try {
    await con.run(`USE lake.${ident(schema)}`);
    const described = await rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${query}`);
    const missing = VIEW_PLATFORM_COLUMNS.filter(c => !described.some(d => d.column_name === c));
    if (missing.length) {
      throw new ViewSqlError(`源视图要输出平台列 ${missing.join('、')}（从原始层的表里带出来），映射才能按变更批次增量合并`);
    }
    await maskedBronze(con, sourceId, tables, sensitive, salt);
    await con.run(`USE stage.${ident(schema)}`);
    const sample = await rows<Record<string, unknown>>(con, `${query} LIMIT ${limit}`);
    const columns = described.map(d => ({ name: d.column_name, type: d.column_type, sensitive: looksSensitive(d.column_name, sample.map(r => r[d.column_name])) }));
    const hash = (v: unknown) => (v === null || v === undefined || HASH.test(String(v))
      ? v : createHash('sha256').update(salt + (typeof v === 'string' ? v : JSON.stringify(v))).digest('hex'));
    return {
      columns,
      rows: sample.map(r => Object.fromEntries(columns.map(c => [c.name, c.sensitive ? hash(r[c.name]) : r[c.name]]))),
      limit,
      tables: used,
    };
  } finally {
    await con.run(`USE lake; DROP SCHEMA IF EXISTS stage.${ident(schema)} CASCADE`);
  }
}

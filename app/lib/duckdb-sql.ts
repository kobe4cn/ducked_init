// app/lib/duckdb-sql.ts —— 工作台 SQL 编辑器的 DuckDB 方言：PostgreSQL 方言加上 DuckDB 扩展的关键字与类型，用于高亮与关键字补全。
// 引用 @codemirror/lang-sql，只由 SqlEditor 在客户端动态加载，页面组件不要静态引用
import { PostgreSQL, SQLDialect } from '@codemirror/lang-sql';

/** DuckDB 在 PostgreSQL 之外的语句与子句关键字（PostgreSQL 方言已有的 columns、exclude 等也列上，表明 DuckDB 用到） */
const DUCKDB_KEYWORDS = [
  'summarize', 'describe', 'qualify', 'pivot', 'unpivot', 'pivot_wider', 'pivot_longer', 'exclude', 'columns', 'rename',
  'asof', 'positional', 'anti', 'semi', 'sample', 'reservoir', 'lambda', 'macro', 'install', 'pragma', 'export', 'unnest',
];
/** DuckDB 在 PostgreSQL 之外的类型名 */
const DUCKDB_TYPES = [
  'hugeint', 'uhugeint', 'ubigint', 'uinteger', 'usmallint', 'utinyint', 'tinyint', 'int1', 'int16', 'int32', 'int64', 'int128', 'varint',
  'blob', 'bitstring', 'string', 'struct', 'map', 'list', 'union', 'timestamp_s', 'timestamp_ms', 'timestamp_ns', 'timestamp_tz', 'datetime', 'enum',
];

export const duckdbDialect = SQLDialect.define({
  ...PostgreSQL.spec,
  keywords: `${PostgreSQL.spec.keywords ?? ''} ${DUCKDB_KEYWORDS.join(' ')}`,
  types: `${PostgreSQL.spec.types ?? ''} ${DUCKDB_TYPES.join(' ')}`,
});

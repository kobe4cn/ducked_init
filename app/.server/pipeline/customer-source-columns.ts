// app/.server/pipeline/customer-source-columns.ts —— 老湖补跨源引用列（ADR-0030）：标准层里有 customer_id 却没有 _customer_source 的表
// 补上这一列并按行自己的 _source 回填（不整表重建）；_ 开头的系统表（如 _identities）不算。合并开头与 ensureLakeSchemas 调用，可重复执行
import type { DuckDBConnection } from '@duckdb/node-api';
import { customerSourceColumn } from '../../lib/customer-source';
import { SILVER } from './lake-schemas';

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 补列与回填在同一事务里，中途失败不会留下没回填的列；已有这一列的表不动 */
export async function ensureCustomerSourceColumns(con: DuckDBConnection) {
  const column = customerSourceColumn('customer_id');
  const reader = await con.runAndReadAll(`
    SELECT table_name FROM information_schema.columns WHERE table_catalog = 'lake' AND table_schema = ${lit(SILVER)} AND NOT starts_with(table_name, '_')
    GROUP BY table_name HAVING bool_or(column_name = 'customer_id') AND bool_or(column_name = '_source') AND NOT bool_or(column_name = ${lit(column)})
    ORDER BY table_name`);
  for (const { table_name: name } of reader.getRowObjectsJson() as { table_name: string }[]) {
    const table = `${SILVER}.${ident(name)}`;
    await con.run('BEGIN');
    try {
      await con.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} VARCHAR`);
      await con.run(`UPDATE ${table} SET ${column} = _source WHERE ${column} IS NULL`);
      await con.run('COMMIT');
    } catch (e) {
      await con.run('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }
}

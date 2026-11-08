// app/.server/pipeline/duck-sql.ts —— DuckDB SQL 小工具：读行、查表与列是否存在、拼键列表 / 连接条件 / 标准层表名（ADR-0053）。
import type { DuckDBConnection } from '@duckdb/node-api';
import { ident, lit } from '../../lib/mapping-expr';
import { SILVER } from './lake-schemas';

export const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
export const tableExists = async (con: DuckDBConnection, schema: string, name: string) => (await rows(con, `
  SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).length > 0;
export const keyList = (keys: string[], alias?: string) => keys.map(k => (alias ? `${alias}.${ident(k)}` : ident(k))).join(', ');
export const joinOn = (keys: string[], a: string, b: string) => keys.map(k => `${a}.${ident(k)} = ${b}.${ident(k)}`).join(' AND ');
export const columnExists = async (con: DuckDBConnection, entity: string, column: string) => (await rows(con, `
  SELECT 1 FROM information_schema.columns WHERE table_catalog = 'lake' AND table_schema = ${lit(SILVER)} AND table_name = ${lit(entity)}
    AND column_name = ${lit(column)}`)).length > 0;

/** 标准层表：silver."<实体>" */
export const silverTable = (entity: string) => `${SILVER}.${ident(entity)}`;

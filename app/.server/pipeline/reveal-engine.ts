// app/.server/pipeline/reveal-engine.ts —— 解密敏感信息：按源表主键从原始层读出一条记录敏感字段的明文（ADR-0005）。
// 取值的写法与合并相同（映射里的表达式），只是不规范化、不哈希；取这条记录在原始层的最新一版，最新一版是删除时视为没有。
// 只读，明文只返回给调用方，不写进数据湖或任何日志
import type { DuckDBConnection } from '@duckdb/node-api';
import { rawValue, sensitivePlanColumns, sourceKeysOf } from './merge-engine';
import type { MergePlan } from './mapping-spec';
import { bronzeSchema } from './sync-engine';
import { parseExpression, referencedColumns } from '../../lib/mapping-expr';

/** 可以展示给管理员的原因：源表没有主键、主键填得不对、找不到记录等 */
export class RevealError extends Error {
  constructor(message: string, readonly status: 400 | 404) { super(message); }
}

/**
 * 一条记录敏感字段的明文；key 是按源表主键列对应的取值，sensitiveKeys 是其中被敏感字段用到的主键列
 * （主键本身就是敏感信息，如以邮箱为主键，记审计时不能照原样记）
 */
export interface RevealedRecord { key: Record<string, string>; sensitiveKeys: string[]; fields: { name: string; value: string | null }[] }

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const tableExists = async (con: DuckDBConnection, schema: string, name: string) => (await rows(con, `
  SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(name)}`)).length > 0;

/**
 * 映射 plan 所在源表里主键为 key 的记录，其敏感字段的明文。主键有多列时 key 按列的顺序用逗号分隔（取值里不能有逗号）；
 * 取值按文本比较（时间、小数按 DuckDB 的文本写法）。源表的主键与合并取的相同，没有主键的表无法按主键定位
 */
export async function readSensitive(con: DuckDBConnection, sourceId: string, plan: MergePlan, key: string): Promise<RevealedRecord> {
  const columns = sensitivePlanColumns(plan);
  if (!columns.length) throw new RevealError('这个映射没有敏感字段', 400);
  // 源视图可能连接多张表、改写取值，按源表主键找不回它的一行
  if (plan.view) throw new RevealError(`这个映射读的是源视图 ${plan.table}，不能按源表主键解密；请在读源表的映射上解密`, 400);
  const schema = bronzeSchema(sourceId);
  if (!await tableExists(con, schema, plan.table)) throw new RevealError(`源表 ${plan.table} 还没有同步进原始层`, 404);
  const keys = await sourceKeysOf(con, sourceId, plan.table);
  if (!keys) throw new RevealError(`源表 ${plan.table} 没有主键，不能按主键定位记录`, 400);
  const values = keys.length === 1 ? [key.trim()] : key.split(',').map(v => v.trim());
  if (values.length !== keys.length || values.some(v => !v)) {
    throw new RevealError(`源表 ${plan.table} 的主键是 ${keys.join('、')} ${keys.length} 列，请按这个顺序用逗号分隔填写`, 400);
  }
  const match = keys.map((k, i) => `CAST(${ident(k)} AS VARCHAR) = ${lit(values[i])}`).join(' AND ');
  // 同一批次里一删一增取新增（与合并相同）
  const [found] = await rows<Record<string, string | null>>(con, `
    SELECT ${columns.map(c => `CAST(${rawValue(c, 'b')} AS VARCHAR) AS ${ident(c.name)}`).join(', ')}
    FROM (SELECT *, row_number() OVER (ORDER BY _batch DESC, _op = 'delete') AS _rn
          FROM ${ident(schema)}.${ident(plan.table)} WHERE ${match}) b
    WHERE b._rn = 1 AND b._op <> 'delete'`);
  const shown = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  if (!found) throw new RevealError(`源表 ${plan.table} 里没有找到主键为 ${keys.map(k => `${k} = ${shown[k]}`).join('，')} 的记录`, 404);
  const used = new Set(columns.flatMap(c => referencedColumns(parseExpression(c.expr)).map(r => r.name)));
  return { key: shown, sensitiveKeys: keys.filter(k => used.has(k)), fields: columns.map(c => ({ name: c.name, value: found[c.name] })) };
}

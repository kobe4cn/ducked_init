// app/.server/pipeline/custom-assertions.ts —— 映射级自定义断言（ADR-0026）：成员在映射 YAML 的 assertions 里给映射出的字段声明的检查，随映射双人发布。
// 四种检查：not_null、unique、range（min / max）、in（values）；断言名固定为 custom:<字段>:<检查>。
// 对一张已转换的表（空跑的样例、合并时的批次）逐条算不合格行数，结果只有断言名、级别、实体、字段与行数，不带取值，也不带 values / min / max
import type { DuckDBConnection } from '@duckdb/node-api';
import type { AssertionLevel, AssertionResult } from './assertions';
import { ident, lit } from '../../lib/mapping-expr';

export const CUSTOM_CHECKS = ['not_null', 'unique', 'range', 'in'] as const;
export type CustomCheck = (typeof CUSTOM_CHECKS)[number];

/** 映射 YAML 里的一条断言：min / max 只配 range（数值字段写数字，日期与时间字段写日期文本），values 只配 in */
export interface CustomAssertion {
  field: string;
  check: CustomCheck;
  level: AssertionLevel;
  min?: number | string;
  max?: number | string;
  values?: string[];
}

export const customAssertionName = (a: Pick<CustomAssertion, 'field' | 'check'>) => `custom:${a.field}:${a.check}`;

/** range 的边界写成 SQL 字面量：数字原样，日期文本加引号（与日期、时间列比较时 DuckDB 隐式转换） */
const boundSql = (v: number | string) => (typeof v === 'number' ? String(v) : lit(v));

/** 一条断言的不合格行数（unique 是出现不止一次的非空值个数） */
function failedSql(table: string, a: CustomAssertion) {
  const f = ident(a.field);
  switch (a.check) {
    case 'not_null': return `SELECT count(*) FILTER (WHERE ${f} IS NULL) AS n FROM ${table}`;
    case 'unique': return `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${f} IS NOT NULL GROUP BY ${f} HAVING count(*) > 1)`;
    case 'range': {
      const out = [a.min !== undefined && `${f} < ${boundSql(a.min)}`, a.max !== undefined && `${f} > ${boundSql(a.max)}`].filter(Boolean).join(' OR ');
      return `SELECT count(*) FILTER (WHERE ${f} IS NOT NULL AND (${out})) AS n FROM ${table}`;
    }
    case 'in': return `SELECT count(*) FILTER (WHERE ${f} IS NOT NULL AND ${f} NOT IN (${a.values!.map(lit).join(', ')})) AS n FROM ${table}`;
  }
}

/** 对一张已转换的表逐条算自定义断言的不合格行数；entity 是映射的实体 */
export async function evalCustomAssertions(
  con: DuckDBConnection, table: string, entity: string, assertions: readonly CustomAssertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const a of assertions) {
    const [{ n }] = (await con.runAndReadAll(failedSql(table, a))).getRowObjectsJson() as { n: string }[];
    results.push({ name: customAssertionName(a), level: a.level, entity, failed: Number(n), detail: a.field });
  }
  return results;
}

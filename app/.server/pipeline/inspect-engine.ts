// app/.server/pipeline/inspect-engine.ts —— 漂移检查：对比湖里标准层（silver）表的实际结构与「标准模型 + 已发布映射」推出的应有结构，
// 报告缺列、多列、类型不一致与孤表。在工作进程里运行，数据湖只读挂载，只出报告、不改湖；修复走合并（ADR-0014）。
// 应有结构在入队时由平台算好放进参数（工作进程不连平台库）。_ 开头的内部表（_merges、_identities、_device_owner）不检查
import type { DuckDBConnection } from '@duckdb/node-api';

/** 应有结构：表名 → 列名 → DuckDB 类型 */
export type InspectParams = { expected: Record<string, Record<string, string>> };

/**
 * 一条差异：missing 应有、湖里没有的列；extra 湖里有、应有里没有的列；type 两边类型不一致；
 * orphan 湖里有、没有任何已发布映射写入的表（不带列）
 */
export interface Drift { table: string; kind: 'missing' | 'extra' | 'type' | 'orphan'; column?: string; expected?: string; actual?: string }

export type InspectResult = { drifts: Drift[] };

/** 比较前的类型写法：大写、去掉空白（DESCRIBE 给 DECIMAL(18,2)，字段类型写的是 DECIMAL(18, 2)），带时区的时间统一写成 TIMESTAMPTZ */
export const normalizeType = (t: string) => {
  const s = t.toUpperCase().replace(/\s+/g, '');
  return s === 'TIMESTAMPWITHTIMEZONE' ? 'TIMESTAMPTZ' : s;
};

const KIND_ORDER: Drift['kind'][] = ['orphan', 'missing', 'extra', 'type'];

/** 检查本租户湖里的标准层表。应有的表湖里还没有时不报（还没合并过不算漂移） */
export async function inspectLake(con: DuckDBConnection, { expected }: InspectParams): Promise<InspectResult> {
  const rows = (await con.runAndReadAll(`
    SELECT table_name AS t, column_name AS c, data_type AS type FROM information_schema.columns
    WHERE table_catalog = 'lake' AND table_schema = 'silver' AND NOT starts_with(table_name, '_')
    ORDER BY table_name, ordinal_position`)).getRowObjectsJson() as { t: string; c: string; type: string }[];
  const actual = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!actual.has(r.t)) actual.set(r.t, new Map());
    actual.get(r.t)!.set(r.c, r.type);
  }
  const drifts: Drift[] = [];
  for (const [table, columns] of actual) {
    const want = Object.hasOwn(expected, table) ? expected[table] : null;
    if (!want) {
      drifts.push({ table, kind: 'orphan' });
      continue;
    }
    for (const [column, type] of Object.entries(want)) {
      const actualType = columns.get(column);
      if (actualType === undefined) drifts.push({ table, kind: 'missing', column, expected: type });
      else if (normalizeType(actualType) !== normalizeType(type)) drifts.push({ table, kind: 'type', column, expected: type, actual: actualType });
    }
    for (const [column, type] of columns) {
      if (!Object.hasOwn(want, column)) drifts.push({ table, kind: 'extra', column, actual: type });
    }
  }
  drifts.sort((a, b) => a.table.localeCompare(b.table)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || (a.column ?? '').localeCompare(b.column ?? ''));
  return { drifts };
}

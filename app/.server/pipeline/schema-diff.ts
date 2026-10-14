// app/.server/pipeline/schema-diff.ts —— 比较两版表结构（列名与类型）：同步时与上一次记下的源表结构比对（ADR-0034），
// 核对湖中数据时与原始层的列对照。类型变化另判断是不是放宽（已有的值都能无损地放进新类型）

/** 一列：名称与 DuckDB 类型 */
export interface ColumnType { name: string; type: string }

/** 两版结构之间的变化：新增、删除的列名，改了类型的列带原类型、新类型与是否放宽 */
export interface SchemaDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  typeChanged: { name: string; from: string; to: string; widened: boolean }[];
}

const INTEGERS = ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT'];
const UNSIGNED = ['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT'];
/** 各整数类型最多几位十进制数（放进 DECIMAL 时需要的整数位） */
const INTEGER_DIGITS: Record<string, number> = { TINYINT: 3, SMALLINT: 5, INTEGER: 10, BIGINT: 19, UTINYINT: 3, USMALLINT: 5, UINTEGER: 10, UBIGINT: 20 };
const decimal = (type: string) => type.match(/^DECIMAL\((\d+),(\d+)\)$/)?.slice(1).map(Number) as [number, number] | undefined;

/** 新类型 to 是否是原类型 from 的放宽：已有的值都能无损地放进新类型 */
export function isWidened(from: string, to: string) {
  if (to === 'VARCHAR') return true;
  for (const ranks of [INTEGERS, UNSIGNED]) {
    if (ranks.includes(from) && ranks.includes(to)) return ranks.indexOf(to) > ranks.indexOf(from);
  }
  if (UNSIGNED.includes(from) && INTEGERS.includes(to)) return INTEGERS.indexOf(to) > UNSIGNED.indexOf(from);
  if (from === 'FLOAT' && to === 'DOUBLE') return true;
  if (from === 'DATE' && /^TIMESTAMP/.test(to)) return true;
  const target = decimal(to);
  if (!target) return false;
  const source = decimal(from);
  if (source) return target[1] >= source[1] && target[0] - target[1] >= source[0] - source[1];
  return from in INTEGER_DIGITS && target[0] - target[1] >= INTEGER_DIGITS[from];
}

/** 以 next 为新版与 prev 比较；只是列的顺序变了不算变化 */
export function diffColumns(prev: ColumnType[], next: ColumnType[]): SchemaDiff {
  const before = new Map(prev.map(c => [c.name, c.type]));
  const after = new Set(next.map(c => c.name));
  const added = next.filter(c => !before.has(c.name)).map(c => c.name);
  const removed = prev.filter(c => !after.has(c.name)).map(c => c.name);
  const typeChanged = next
    .filter(c => before.has(c.name) && before.get(c.name) !== c.type)
    .map(c => ({ name: c.name, from: before.get(c.name)!, to: c.type, widened: isWidened(before.get(c.name)!, c.type) }));
  return { changed: Boolean(added.length || removed.length || typeChanged.length), added, removed, typeChanged };
}

// app/.server/pipeline/key-check-engine.ts —— 主键冲突体检（ADR-0024「冲突体检」）：对每个实体里主键撞上的每对映射，统计重叠的键数、样本键，
// 以及重叠的键里两边都映射了的字段全部一致的比例，按比例给出建议。在工作进程里运行，数据湖只读挂载，只出报告、不改标准层。
// 实体的主键、是否按数据源比较与各映射的列在入队时由平台算好放进参数（工作进程不连平台库）
import type { DuckDBConnection } from '@duckdb/node-api';
import { SILVER } from './lake-schemas';
import { ident, joinOn, keyList, lit, rows, silverTable, SILVER_SYSTEM_COLUMNS, tableExists } from './merge-engine';

/**
 * 一个实体：主键、写入它的已发布映射（各带映射出来的列名）；bySource 为真时（主键含指向 customer 的字段）
 * 只在同一个数据源内比较主键
 */
export interface KeyCheckEntity { entity: string; key: string[]; bySource: boolean; mappings: { mapping: string; columns: string[] }[] }
export type KeyCheckParams = { entities: KeyCheckEntity[] };

/**
 * 建议：duplicate 一边的键全在另一边里，多半是重复接入；drop_one 同一批对象，去掉一边的映射；
 * key_space 编号各自独立，声明键空间；review 需人工判断
 */
export type KeyCheckSuggestion = 'duplicate' | 'drop_one' | 'key_space' | 'review';
export const SUGGESTION_LABELS: Record<KeyCheckSuggestion, string> = {
  duplicate: '多半是重复接入',
  drop_one: '同一批对象，去掉一边的映射',
  key_space: '编号各自独立，声明键空间',
  review: '需人工判断',
};

/** 一致比例不低于它时，两边是同一批对象 */
const SAME_OBJECTS = 0.8;
/** 一致比例不高于它时，两边的编号各自独立 */
const INDEPENDENT_KEYS = 0.2;

/** 一对映射：a、b 是映射 ID（a < b），overlap 重叠的键数，samples 最多 5 个重叠的键（按文本排序），agreement 一致比例（没有可比的字段时为 null） */
export interface KeyCheckPair { a: string; b: string; overlap: number; samples: string[][]; agreement: number | null; suggestion: KeyCheckSuggestion }
export type KeyCheckResult = { entities: { entity: string; bySource: boolean; pairs: KeyCheckPair[] }[] };

/** 按顺序取第一条命中的建议：一边的键全在另一边里 → 比例高 → 比例低 → 其余（含没有可比的字段）人工判断 */
export function suggestionOf({ overlap, keysA, keysB, agreement }: { overlap: number; keysA: number; keysB: number; agreement: number | null }): KeyCheckSuggestion {
  if (keysA === overlap || keysB === overlap) return 'duplicate';
  if (agreement === null) return 'review';
  if (agreement >= SAME_OBJECTS) return 'drop_one';
  if (agreement <= INDEPENDENT_KEYS) return 'key_space';
  return 'review';
}

const SAMPLES = 5;

/** 体检本租户标准层里各实体的主键。标准层还没有的表、只有一个映射写入的实体跳过；没有重叠的映射对与实体不进结果 */
export async function runKeyCheck(con: DuckDBConnection, { entities }: KeyCheckParams): Promise<KeyCheckResult> {
  const result: KeyCheckResult['entities'] = [];
  for (const { entity, key, bySource, mappings } of entities) {
    if (mappings.length < 2 || !await tableExists(con, SILVER, entity)) continue;
    const table = silverTable(entity);
    const on = bySource ? [...key, '_source'] : key;
    const sampleKey = `[${key.map(c => `x.${ident(c)}::VARCHAR`).join(', ')}]`;
    // 映射的去重键可以和实体主键不同：先按 (映射, 主键) 去重；主键为空的行撞不上，不计入键数
    const overlaps = await rows<{ a: string; b: string; overlap: string; samples: string[][]; keys_a: string; keys_b: string }>(con, `
      WITH k AS (
        SELECT DISTINCT _mapping, ${keyList(on)} FROM ${table}
        WHERE _mapping IN (${mappings.map(m => lit(m.mapping)).join(', ')}) AND ${on.map(c => `${ident(c)} IS NOT NULL`).join(' AND ')}),
      n AS (SELECT _mapping, count(*) AS n FROM k GROUP BY _mapping),
      o AS (
        SELECT x._mapping AS a, y._mapping AS b, count(*) AS overlap, min(${sampleKey}, ${SAMPLES}) AS samples
        FROM k x JOIN k y ON ${joinOn(on, 'x', 'y')} AND x._mapping < y._mapping GROUP BY x._mapping, y._mapping)
      SELECT o.a, o.b, o.overlap, o.samples, na.n AS keys_a, nb.n AS keys_b
      FROM o JOIN n na ON na._mapping = o.a JOIN n nb ON nb._mapping = o.b ORDER BY o.a, o.b`);
    if (!overlaps.length) continue;
    const pairs: KeyCheckPair[] = [];
    for (const o of overlaps) {
      const overlap = Number(o.overlap);
      const agreement = await agreementOf(con, table, on, key, mappings.find(m => m.mapping === o.a)!, mappings.find(m => m.mapping === o.b)!, overlap);
      pairs.push({
        a: o.a, b: o.b, overlap, samples: o.samples, agreement,
        suggestion: suggestionOf({ overlap, keysA: Number(o.keys_a), keysB: Number(o.keys_b), agreement }),
      });
    }
    result.push({ entity, bySource, pairs });
  }
  return { entities: result.sort((x, y) => x.entity.localeCompare(y.entity)) };
}

/**
 * 一致比例：重叠的键里，两边都映射了的列（去掉主键与系统列）全部 IS NOT DISTINCT FROM 的键所占的比例；没有这样的列时为 null。
 * 同一个映射的一个键有多行时（去重键比主键细），所有行两两一致才算一致
 */
async function agreementOf(
  con: DuckDBConnection, table: string, on: string[], key: string[], a: KeyCheckEntity['mappings'][number], b: KeyCheckEntity['mappings'][number], overlap: number,
) {
  const skip = new Set<string>([...key, ...Object.keys(SILVER_SYSTEM_COLUMNS)]);
  const columns = a.columns.filter(c => !skip.has(c) && b.columns.includes(c));
  if (!columns.length) return null;
  const [{ n }] = await rows<{ n: string }>(con, `
    SELECT count(*) FILTER (WHERE same) AS n FROM (
      SELECT bool_and(${columns.map(c => `x.${ident(c)} IS NOT DISTINCT FROM y.${ident(c)}`).join(' AND ')}) AS same
      FROM ${table} x JOIN ${table} y ON ${joinOn(on, 'x', 'y')}
      WHERE x._mapping = ${lit(a.mapping)} AND y._mapping = ${lit(b.mapping)} GROUP BY ${keyList(on, 'x')})`);
  return Number(n) / overlap;
}

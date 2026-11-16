// app/.server/pipeline/key-check-engine.ts —— 主键冲突体检（ADR-0024「冲突体检」）：对每个实体里主键撞上的每对映射，统计重叠的键数、样本键，
// 以及重叠的键里两边都映射了的字段全部一致的比例，按比例给出建议。在工作进程里运行，数据湖只读挂载，只出报告、不改标准层。
// 实体的主键、是否按数据源比较与各映射的列在入队时由平台算好放进参数（工作进程不连平台库）。
// 标准层里一行都没有的已发布映射是因主键跨映射重复合并失败（或从未合并成功）：撞号的合并整个事务回滚，不留记录。这些映射的键按它的合并计划
// 从原始层（源表或源视图）现算，取的是合并时会用的同一批当前行，与标准层里其他映射的行（或同样现算的行）比对；只是新版本合并失败、
// 标准层里还留着旧版本行的映射按旧行比对。现算只写本机库 stage（只读湖下 stage 仍可写）；现算用领取任务时拿到的租户盐，与合并同一套哈希，
// 敏感列照常参与一致比例，比对键里有敏感列的映射也照常现算。源视图每次整张物化，大表会慢；不采样，采样会让重叠数不准
import type { DuckDBConnection } from '@duckdb/node-api';
import { cmp } from '../../lib/compare';
import { customerSourceColumn } from '../../lib/customer-source';
import { SILVER } from './lake-schemas';
import { ident, lit } from '../../lib/mapping-expr';
import { columnExists, joinOn, keyList, rows, silverTable, tableExists } from './duck-sql';
import { customerRefColumns, filterLive, liveRecords, mappingInput, SILVER_SYSTEM_COLUMNS, transformRows } from './merge-engine';
import type { KeyCheckEntity, KeyCheckParams } from './task-contracts';

/**
 * 体检的参数（各实体）与一个实体的类型由契约推出（task-contracts 的 keyCheckEntity / silverKeyCheckParams schema，ADR-0052，
 * 字段含义见契约里的注释），只在这里转出，调用方 import 不变。引擎对契约只能 import type / export type（ADR-0008）
 */
export type { KeyCheckEntity, KeyCheckParams } from './task-contracts';

/**
 * 建议：duplicate 一边的键全在另一边里，多半是重复接入，可以建合并组（ADR-0032）；drop_one 同一批对象，去掉一边的映射；
 * key_space 编号各自独立，声明键空间；review 需人工判断
 */
export type KeyCheckSuggestion = 'duplicate' | 'drop_one' | 'key_space' | 'review';
export const SUGGESTION_LABELS: Record<KeyCheckSuggestion, string> = {
  duplicate: '多半是重复接入，可以建合并组',
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

/** 现算用的本机库中间表：源视图物化、当前记录、转换结果与比对表（winners 按映射序号另起，见 liveWinners） */
const KEYCHECK_VIEW = 'stage.keycheck_view';
const KEYCHECK_LATEST = 'stage.keycheck_latest';
const KEYCHECK_LIVE = 'stage.keycheck_live';
const KEYCHECK_TRANSFORMED = 'stage.keycheck_t';
const KEYCHECK_ROWS = 'stage.keycheck_rows';

/** 参数里 mappings 的一项 */
type MappingEntry = KeyCheckEntity['mappings'][number];

/**
 * 按合并计划从原始层现算一个映射这次会写进标准层的行（与合并同一套步骤：物化输入、当前记录、行过滤、转换、按去重键取最新一行、补系统列），
 * 物化进 stage.keycheck_w<index> 并返回表名。源表（或源视图引用的表）还没有同步进原始层时返回 null，这个映射照旧不参与比对。
 * 敏感列用与合并同一个租户盐哈希，与标准层里的值可以直接比较；_src、_n、_batch 是合并的中间列，不带进比对表
 */
async function liveWinners(con: DuckDBConnection, index: number, plan: NonNullable<MappingEntry['plan']>, salt: string): Promise<string | null> {
  const input = await mappingInput(con, plan, plan.sourceId, plan.sourceView, KEYCHECK_VIEW, '体检');
  if ('skipped' in input) return null;
  const bronze = await input.load();
  const [{ top }] = await rows<{ top: string | null }>(con, `SELECT max(_batch) AS top FROM ${bronze}`);
  await liveRecords(con, bronze, input.keys, { from: 0, to: Number(top ?? 0), held: null }, { latest: KEYCHECK_LATEST, live: KEYCHECK_LIVE });
  if (plan.where) await filterLive(con, plan, KEYCHECK_LIVE);
  await transformRows(con, plan, salt, { live: KEYCHECK_LIVE, into: KEYCHECK_TRANSFORMED });
  // 每个去重键取最新的一行，排序与合并的 winners 相同（最新字段最大、再按最近的批次、最后按记录的哈希），结果确定
  const order = [...(plan.latest ? [`c.${ident(plan.latest)} DESC NULLS LAST`] : []), 'c._batch DESC', 'c._src'].join(', ');
  const winners = `stage.keycheck_w${index}`;
  // 补合并会写的系统列：_version、_merged_at 与 _key_space 不参与比对，不用补；键空间前缀转换时已加在列值里
  await con.run(`CREATE OR REPLACE TABLE ${winners} AS SELECT w.* EXCLUDE (_src, _n, _batch),
    ${lit(plan.mapping)} AS _mapping, ${lit(plan.sourceId)} AS _source${customerRefColumns(plan).map(c => `,
    ${lit(c.customerSource ?? plan.sourceId)} AS ${ident(customerSourceColumn(c.name))}`).join('')}
    FROM (SELECT * EXCLUDE (_rn) FROM (
      SELECT c.*, row_number() OVER (PARTITION BY ${keyList(plan.key, 'c')} ORDER BY ${order}) AS _rn FROM ${KEYCHECK_TRANSFORMED} c) WHERE _rn = 1) w`);
  return winners;
}

/**
 * 体检本租户标准层里各实体的主键。只有一个映射写入的实体跳过；没有重叠的映射对、同一合并组的映射对与没有剩下映射对的实体不进结果。
 * 标准层里一行都没有的映射按合并计划从原始层现算（见文件头注释），它的行与标准层里其他映射的行并进本机库的一张表再比对
 */
export async function runKeyCheck(con: DuckDBConnection, { entities }: KeyCheckParams, salt: string): Promise<KeyCheckResult> {
  const result: KeyCheckResult['entities'] = [];
  for (const { entity, key, bySource, mappings } of entities) {
    if (mappings.length < 2) continue;
    const silver = silverTable(entity);
    const exists = await tableExists(con, SILVER, entity);
    // 各映射在标准层里的行数，表不存在时都算 0：一行都没有的已发布映射是合并失败（或从未合并成功），从原始层现算
    const counts = new Map(mappings.map(m => [m.mapping, 0]));
    if (exists) for (const { _mapping, n } of await rows<{ _mapping: string; n: string }>(con, `
      SELECT _mapping, count(*) AS n FROM ${silver} WHERE _mapping IN (${mappings.map(m => lit(m.mapping)).join(', ')}) GROUP BY _mapping`))
      counts.set(_mapping, Number(n));
    const absent = mappings.filter(m => !counts.get(m.mapping) && m.plan);
    if (!exists && !absent.length) continue;
    const winnersTables: string[] = [];
    try {
      // 按主键里指向 customer 的字段旁的数据源列比较（ADR-0030，跨源引用时是目标数据源）；表还没有或老湖里没有这些列时退回 _source（现算的行带 _source）
      const sourceColumns = [];
      if (bySource) for (const column of key.map(customerSourceColumn)) if (await columnExists(con, entity, column)) sourceColumns.push(column);
      const on = bySource ? [...key, ...sourceColumns.length ? sourceColumns : ['_source']] : key;
      let table = silver;
      if (absent.length) {
        for (const m of absent) {
          const winners = await liveWinners(con, winnersTables.length, m.plan!, salt);
          if (!winners) continue;
          winnersTables.push(winners);
        }
        if (winnersTables.length) {
          // 标准层里其他映射的行与现算的行并成一张表：失败映射可能有标准层里没有的列，按列名并
          const selects = [
            ...(exists ? [`SELECT * FROM ${silver} WHERE _mapping IN (${mappings.map(m => lit(m.mapping)).join(', ')})`] : []),
            ...winnersTables.map(t => `SELECT * FROM ${t}`),
          ];
          await con.run(`CREATE OR REPLACE TABLE ${KEYCHECK_ROWS} AS ${selects.join(' UNION ALL BY NAME ')}`);
          table = KEYCHECK_ROWS;
        } else if (!exists) continue;
      }
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
      const pairs: KeyCheckPair[] = [];
      for (const o of overlaps) {
        const [a, b] = [o.a, o.b].map(id => mappings.find(m => m.mapping === id)!);
        if (a.group && a.group === b.group) continue;
        const overlap = Number(o.overlap);
        const agreement = await agreementOf(con, table, on, key, a, b, overlap);
        pairs.push({
          a: o.a, b: o.b, overlap, samples: o.samples, agreement,
          suggestion: suggestionOf({ overlap, keysA: Number(o.keys_a), keysB: Number(o.keys_b), agreement }),
        });
      }
      if (pairs.length) result.push({ entity, bySource, pairs });
    } finally {
      if (absent.length) await con.run([KEYCHECK_ROWS, KEYCHECK_VIEW, KEYCHECK_LATEST, KEYCHECK_LIVE, KEYCHECK_TRANSFORMED, ...winnersTables]
        .map(t => `DROP TABLE IF EXISTS ${t};`).join(' '));
    }
  }
  return { entities: result.sort((x, y) => cmp(x.entity, y.entity)) };
}

/**
 * 一致比例：重叠的键里，两边都映射了的列（去掉主键与系统列）全部 IS NOT DISTINCT FROM 的键所占的比例；没有这样的列时为 null。
 * 同一个映射的一个键有多行时（去重键比主键细），所有行两两一致才算一致。敏感列照常比：现算与合并用同一个租户盐，两边的哈希可以直接比较
 */
async function agreementOf(
  con: DuckDBConnection, table: string, on: string[], key: string[], a: MappingEntry, b: MappingEntry, overlap: number,
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

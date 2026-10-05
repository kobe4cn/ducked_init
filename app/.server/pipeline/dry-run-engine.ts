// app/.server/pipeline/dry-run-engine.ts —— 映射空跑：取原始层里源表最新、未删除的前 N 条记录，按合并计划转换，返回样例行与基础断言。
// 中间表只放在会话的本机库 stage 里，不写标准层、当前记录与合并日志 silver._merges，可以在只读挂载的数据湖上运行。
// 转换与合并共用 merge-engine 的同一套步骤，敏感字段同样换成按租户加盐的哈希，样例行里没有明文（ADR-0005）
import type { DuckDBConnection } from '@duckdb/node-api';
import type { MergePlan } from './mapping-spec';
import { liveRecords, sensitiveColumns, sourceKeysOf, tableExists, transformRows, unknownValues, type FallbackStat } from './merge-engine';
import { bronzeSchema } from './sync-engine';

/** 样例里的一列：是否敏感（值是哈希）、是否必填（去重键与身份打通的匹配字段），以及为空的行数 */
export interface DryRunColumn { name: string; sensitive: boolean; required: boolean; nulls: number }

/** 一列里值字典没有、或不是标准枚举的取值；fallback 为真时合并会写成兜底值，否则合并会报错 */
export interface DryRunUnknown extends FallbackStat { fallback: boolean }

export interface DryRunResult {
  /** 样例取了多少条记录（最多 limit 条） */
  sampled: number;
  limit: number;
  columns: DryRunColumn[];
  rows: Record<string, unknown>[];
  assertions: {
    key: string[];
    /** 去重键有空值的行数 */
    keyNulls: number;
    /** 出现在不止一行的去重键个数（合并时只取最新的一行） */
    keyDuplicates: number;
    /** 必填字段各有几行为空 */
    requiredNulls: Record<string, number>;
    unknownValues: DryRunUnknown[];
  };
}

const LATEST = 'stage.dryrun_latest';
const LIVE = 'stage.dryrun_live';
const SAMPLE = 'stage.dryrun_sample';
const ROWS = 'stage.dryrun_rows';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** 必填字段：去重键，加上身份打通的匹配字段（映射出来的） */
const requiredColumns = (plan: MergePlan) => new Set([...plan.key, ...(plan.identity?.match ?? []).filter(m => plan.columns.some(c => c.name === m))]);

/**
 * 空跑一个映射：源表还没有同步进原始层时返回 skipped。样例取最近批次里的记录（同一批次按记录哈希，结果确定）；
 * 转换出错时抛出的错误已抹掉敏感字段的源端取值（盐由调用方抹掉）
 */
export async function dryRun(con: DuckDBConnection, plan: MergePlan, sourceId: string, salt: string, limit: number): Promise<DryRunResult | { skipped: string }> {
  const schema = bronzeSchema(sourceId);
  if (!await tableExists(con, schema, plan.table)) return { skipped: `源表 ${plan.table} 还没有同步进原始层，首次同步后再空跑` };
  const bronze = `${ident(schema)}.${ident(plan.table)}`;
  try {
    const sourceKeys = await sourceKeysOf(con, sourceId, plan.table) ?? [];
    const [{ top }] = await rows<{ top: string | null }>(con, `SELECT max(_batch) AS top FROM ${bronze}`);
    await liveRecords(con, bronze, sourceKeys, { from: 0, to: Number(top ?? 0), held: null }, { latest: LATEST, live: LIVE });
    await con.run(`CREATE OR REPLACE TABLE ${SAMPLE} AS SELECT * FROM ${LIVE} ORDER BY _batch DESC, _src LIMIT ${limit}`);

    const pii = sensitiveColumns(plan);
    const unknown: DryRunUnknown[] = [];
    for (const c of plan.columns.filter(c => !pii.has(c.name))) {
      const stat = await unknownValues(con, c, SAMPLE);
      if (stat) unknown.push({ ...stat, fallback: c.otherwise !== undefined });
    }
    await transformRows(con, plan, salt, { live: SAMPLE, into: ROWS });

    const names = plan.columns.map(c => c.name);
    const [stats] = await rows<Record<string, string>>(con, `SELECT count(*) AS _rows,
      count(*) FILTER (WHERE ${plan.key.map(k => `${ident(k)} IS NULL`).join(' OR ')}) AS _key_nulls,
      ${names.map((n, i) => `count(*) FILTER (WHERE ${ident(n)} IS NULL) AS c${i}`).join(', ')} FROM ${ROWS}`);
    const [{ n: keyDuplicates }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM (
      SELECT 1 FROM ${ROWS} WHERE ${plan.key.map(k => `${ident(k)} IS NOT NULL`).join(' AND ')} GROUP BY ${plan.key.map(ident).join(', ')} HAVING count(*) > 1)`);
    const required = requiredColumns(plan);
    const columns = names.map((name, i) => ({ name, sensitive: pii.has(name), required: required.has(name), nulls: Number(stats[`c${i}`]) }));
    const sample = await rows<Record<string, unknown>>(con, `SELECT ${names.map(ident).join(', ')} FROM ${ROWS} ORDER BY _batch DESC, _src`);
    return {
      sampled: Number(stats._rows),
      limit,
      columns,
      rows: sample,
      assertions: {
        key: plan.key,
        keyNulls: Number(stats._key_nulls),
        keyDuplicates: Number(keyDuplicates),
        requiredNulls: Object.fromEntries(columns.filter(c => c.required).map(c => [c.name, c.nulls])),
        unknownValues: unknown,
      },
    };
  } finally {
    await con.run([LATEST, LIVE, SAMPLE, ROWS].map(t => `DROP TABLE IF EXISTS ${t};`).join(' '));
  }
}

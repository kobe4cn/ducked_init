// app/.server/pipeline/sync-engine.ts —— 水位线增量同步：把源表自上次同步以来的变化作为变更批次追加到本租户数据湖的原始层（ADR-0006、ADR-0012）。
// 在工作进程里运行，数据湖与数据源挂在同一个 DuckDB 里（源端只读挂载为 src）。每个数据源在数据湖里一个 schema（bronzeSchema），
// 每张源表一张原始层表：源表的全部列加上操作类型 _op、源端提交时间 _commit_ts、批次号 _batch 与同步时间 _synced_at。
// 批次日志 _batches 与变更批次在同一个 DuckLake 事务里写入，是水位线的唯一依据：任务结果没记下来也不会重复或漏掉变化
import type { DuckDBConnection } from '@duckdb/node-api';
import type { TenantLakeSession } from './lake-engine';
import { primaryKeys, writeGrants, type SourceSpec, type SourceTable, type WatermarkKind } from './source-engine';

/** 同步任务里的一张表：成员确认的水位线字段及其种类 */
export interface SyncTableParam { name: string; column: string; kind: WatermarkKind }

/** 批次的读取范围：全表读取（首次同步或换了水位线字段）或按水位线增量读取。与“全量比对”这种同步方式无关 */
export type BatchMode = 'full' | 'incremental';

/** 一张表一次同步的结果：成功时是写入的变更批次，失败时是错误。时间为 ISO 字符串 */
export type SyncRecord = { table: string; startedAt: string; durationMs: number } & (
  | {
    batch: number;
    mode: BatchMode;
    rows: number;
    inserted: number;
    updated: number;
    watermarkColumn: string;
    /** 本批次的起点（上一批次的水位线）；全量同步时为 null */
    watermarkFrom: string | null;
    /** 同步后的水位线：本批次中水位线字段的最大值，没有新行时沿用起点 */
    watermarkTo: string | null;
  }
  | { error: string }
);

/** 数据源在租户数据湖里的原始层 schema */
export const bronzeSchema = (sourceId: string) => `bronze_${sourceId.replace(/-/g, '')}`;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const mysqlIdent = (s: string) => `\`${s.replace(/`/g, '``')}\``;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const columnsOf = (con: DuckDBConnection, relation: string) =>
  rows<{ column_name: string; column_type: string }>(con, `DESCRIBE ${relation}`);

/** 原始层表里平台追加的列（ADR-0006） */
const BATCH_COLUMNS = `NULL::VARCHAR AS _op, NULL::TIMESTAMPTZ AS _commit_ts, NULL::BIGINT AS _batch, NULL::TIMESTAMPTZ AS _synced_at`;

/**
 * 读取源表自水位线 from 起（含）的行；from 为 null 时读全表。PostgreSQL 与 MySQL 的条件写进发往源端的查询，
 * 在源端执行（不依赖扩展的条件下推）；其他数据源在 DuckDB 里过滤（Parquet 按行组统计跳过不相关的数据）
 */
function sourceRelation(spec: SourceSpec, table: SourceTable, column: string, type: string, from: string | null) {
  if (spec.kind === 'postgres') {
    const where = from === null ? '' : ` WHERE ${ident(column)} >= ${lit(from)}`;
    return `postgres_query('src', ${lit(`SELECT * FROM ${ident(table.schema)}.${ident(table.table)}${where}`)})`;
  }
  if (spec.kind === 'mysql') {
    const where = from === null ? '' : ` WHERE ${mysqlIdent(column)} >= ${lit(from)}`;
    return `mysql_query('src', ${lit(`SELECT * FROM ${mysqlIdent(table.schema)}.${mysqlIdent(table.table)}${where}`)})`;
  }
  return `(SELECT * FROM ${table.from}${from === null ? '' : ` WHERE ${ident(column)} >= CAST(${lit(from)} AS ${type})`})`;
}

interface LastBatch { batch: string; watermark_column: string; watermark_to: string | null }

/**
 * 同步一张表，产出一个变更批次（可能为空）：
 * - 这张表还没有按当前水位线字段同步过时全量读取，否则读取水位线及之后的行。用“大于等于”是为了不漏掉与水位线同一时刻、
 *   上次同步之后才提交的行；上次已同步过的边界行（整行相同）不再重复写入。
 * - 有主键时，原始层里已有该主键的行记为更新，否则记为新增；没有主键的表一律记为新增（由映射声明的去重键在标准层合并）。
 * - 更新时间水位线的源端提交时间取该字段，自增主键拿不到提交时间，用同步时间代替
 */
async function syncTable(
  con: DuckDBConnection, spec: SourceSpec, schema: string, table: SourceTable, param: SyncTableParam, keys: string[],
): Promise<SyncRecord> {
  const startedAt = new Date();
  const target = `${ident(schema)}.${ident(table.name)}`;
  const [last] = await rows<LastBatch>(con, `
    SELECT batch, watermark_column, watermark_to FROM ${ident(schema)}._batches
    WHERE table_name = ${lit(table.name)} ORDER BY batch DESC LIMIT 1`);
  const from = last?.watermark_column === param.column ? last.watermark_to : null;
  const batch = Number(last?.batch ?? 0) + 1;

  const wm = (await columnsOf(con, `SELECT * FROM ${table.from}`)).find(c => c.column_name === param.column);
  if (!wm) throw new Error(`源表中没有水位线字段 ${param.column}，请重新采集并确认`);
  await con.run(`CREATE OR REPLACE TEMP TABLE incoming AS SELECT * FROM ${sourceRelation(spec, table, param.column, wm.column_type, from)}`);
  try {
    const columns = await columnsOf(con, 'incoming');
    const syncedAt = `TIMESTAMPTZ ${lit(startedAt.toISOString())}`;
    const all = (alias: string) => columns.map(c => `${alias}.${ident(c.column_name)}`).join(', ');
    const atFrom = (alias: string) => `${alias}.${ident(param.column)} = CAST(${lit(from ?? '')} AS ${wm.column_type})`;

    await con.run('BEGIN');
    try {
      const [exists] = await rows(con, `
        SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = ${lit(schema)} AND table_name = ${lit(table.name)}`);
      if (!exists) {
        await con.run(`CREATE TABLE ${target} AS SELECT *, ${BATCH_COLUMNS} FROM incoming LIMIT 0`);
      } else {
        // 源表新增的字段在原始层随之加列，之前的批次里为空
        const known = new Set((await columnsOf(con, target)).map(c => c.column_name));
        for (const c of columns.filter(c => !known.has(c.column_name))) {
          await con.run(`ALTER TABLE ${target} ADD COLUMN ${ident(c.column_name)} ${c.column_type}`);
        }
      }
      const seen = keys.length
        ? `LEFT JOIN (SELECT DISTINCT ${keys.map(ident).join(', ')}, true AS _seen FROM ${target}) k ON ${keys.map(c => `k.${ident(c)} = i.${ident(c)}`).join(' AND ')}`
        : '';
      const boundary = from === null
        ? ''
        : `WHERE NOT coalesce(${atFrom('i')} AND hash(${all('i')}) IN (SELECT hash(${all('b')}) FROM ${target} b WHERE ${atFrom('b')}), false)`;
      await con.run(`
        INSERT INTO ${target} BY NAME
        SELECT i.*,
               ${keys.length ? `CASE WHEN k._seen THEN 'update' ELSE 'insert' END` : `'insert'`} AS _op,
               ${param.kind === 'updated_at' ? `CAST(i.${ident(param.column)} AS TIMESTAMPTZ)` : syncedAt} AS _commit_ts,
               ${batch} AS _batch,
               ${syncedAt} AS _synced_at
        FROM incoming i ${seen} ${boundary}`);
      const [stats] = await rows<{ n: string; inserted: string; updated: string; wm: string | null }>(con, `
        SELECT count(*) AS n, count_if(_op = 'insert') AS inserted, count_if(_op = 'update') AS updated, max(${ident(param.column)})::VARCHAR AS wm
        FROM ${target} WHERE _batch = ${batch}`);
      const finishedAt = new Date();
      const record: SyncRecord = {
        table: table.name,
        startedAt: startedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        batch,
        mode: from === null ? 'full' : 'incremental',
        rows: Number(stats.n),
        inserted: Number(stats.inserted),
        updated: Number(stats.updated),
        watermarkColumn: param.column,
        watermarkFrom: from,
        watermarkTo: stats.wm ?? from,
      };
      await con.run(`INSERT INTO ${ident(schema)}._batches VALUES (
        ${lit(table.name)}, ${batch}, ${lit(record.mode)}, ${lit(param.column)},
        ${from === null ? 'NULL' : lit(from)}, ${record.watermarkTo === null ? 'NULL' : lit(record.watermarkTo)},
        ${record.rows}, ${record.inserted}, ${record.updated}, ${syncedAt}, TIMESTAMPTZ ${lit(finishedAt.toISOString())})`);
      await con.run('COMMIT');
      return record;
    } catch (e) {
      await con.run('ROLLBACK').catch(() => undefined);
      throw e;
    }
  } finally {
    await con.run('DROP TABLE IF EXISTS incoming');
  }
}

/**
 * 按成员确认的水位线同步数据源的若干张表，每张表一个变更批次、各自一个事务：一张表失败不影响其他表。
 * 账号可写时整体拒绝（登记之后才被授予写权限的账号）。redact 用来抹掉错误信息里的凭据
 */
export async function syncSourceTables(
  session: TenantLakeSession, spec: SourceSpec, sourceId: string, params: SyncTableParam[], redact: (message: string) => string,
): Promise<SyncRecord[]> {
  const { con, source } = session;
  if (!source) throw new Error('数据源没有挂载');
  const writable = await writeGrants({ con, mongo: source.mongo }, spec);
  if (writable.length) throw new Error(`账号可以写入数据源（${writable.map(g => g.object).join('、')}），平台只使用只读账号，请更换账号`);
  const tables = await source.tables();
  const keys = await primaryKeys(con, spec, tables);
  const schema = bronzeSchema(sourceId);
  await con.run(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)};
    CREATE TABLE IF NOT EXISTS ${ident(schema)}._batches (
      table_name VARCHAR, batch BIGINT, mode VARCHAR, watermark_column VARCHAR, watermark_from VARCHAR, watermark_to VARCHAR,
      rows BIGINT, inserted BIGINT, updated BIGINT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);

  const records: SyncRecord[] = [];
  for (const param of params) {
    const startedAt = new Date();
    const table = tables.find(t => t.name === param.name);
    try {
      if (!table) throw new Error(`数据源中已没有表 ${param.name}`);
      if (!table.readable) throw new Error(`账号没有表 ${param.name} 的读权限`);
      records.push(await syncTable(con, spec, schema, table, param, keys.get(param.name) ?? []));
    } catch (e) {
      records.push({ table: param.name, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), error: redact((e as Error).message) });
    }
  }
  return records;
}

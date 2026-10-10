// app/.server/pipeline/lake-schemas.ts —— 数据湖里名字固定的 schema 与平台表（ADR-0020）：初始化数据湖时建好，任务里不再建。
// 并发的任务各自新建同名 schema 或表时，DuckLake 提交会判冲突、其中一个任务失败；先建好后，各任务只在其下建不同名字的表。
// 按名字区分的表（每个数据源的 bronze_<id>、标准层实体表、结果层快照）以及靠存在与否判断「还没打通」的
// silver._identities / silver._device_owner 不在这里建
import type { DuckDBConnection } from '@duckdb/node-api';

/** 标准层 */
export const SILVER = 'silver';
/** 各映射的当前记录（ADR-0015） */
export const RECORDS = 'silver_records';
/** 合并日志：每个映射每次合并一行（ADR-0015） */
export const MERGES = `${SILVER}._merges`;
/** 断言的运行记录：每个检查过的实体每次一行（ADR-0026） */
export const ASSERTION_RUNS = `${SILVER}._assertion_runs`;
/** 隔离区：失败断言的不合格行（ADR-0026） */
export const QUARANTINE = `${SILVER}._quarantine`;

/** 建好固定的 schema 与平台表，可重复执行；已有租户的数据湖用 pnpm lake:ensure 补建 */
export async function ensureLakeSchemas(con: DuckDBConnection) {
  // 早于敏感字段哈希的数据湖里，合并日志还没有 scheme 列：补上后老的日志为空，各映射下次合并时重建
  await con.run(`CREATE SCHEMA IF NOT EXISTS gold; CREATE SCHEMA IF NOT EXISTS ${SILVER}; CREATE SCHEMA IF NOT EXISTS ${RECORDS};
    CREATE TABLE IF NOT EXISTS ${MERGES} (
      mapping_id VARCHAR, version INTEGER, source_keys VARCHAR, batch_from BIGINT, batch_to BIGINT,
      inserted BIGINT, updated BIGINT, deleted BIGINT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, scheme INTEGER);
    ALTER TABLE ${MERGES} ADD COLUMN IF NOT EXISTS scheme INTEGER;
    CREATE TABLE IF NOT EXISTS ${ASSERTION_RUNS} (task_id VARCHAR, entity VARCHAR, rows BIGINT, assertions JSON, "at" TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS ${QUARANTINE} (assertion VARCHAR, level VARCHAR, entity VARCHAR, "key" VARCHAR, "row" JSON, task_id VARCHAR, "at" TIMESTAMPTZ)`);
}

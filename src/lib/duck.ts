// src/lib/duck.ts —— DuckDB 实例、扩展/密钥/PG 挂载的统一初始化，以及执行计时工具
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { config, isS3Lake } from "./config";

let instance: DuckDBInstance | undefined;
const SCRIPT = basename(process.argv[1] ?? "repl").replace(/\.ts$/, "");

/** 进程内单例。一个 instance 可以开多个 connection 并行查询 */
export async function getInstance(): Promise<DuckDBInstance> {
  if (instance) return instance;
  mkdirSync(dirname(config.dbFile), { recursive: true });
  mkdirSync(config.tempDir, { recursive: true });
  instance = await DuckDBInstance.create(config.dbFile, {
    threads: String(config.threads),
    memory_limit: config.memoryLimit,
    temp_directory: config.tempDir,
    preserve_insertion_order: "false",
  });
  return instance;
}

export interface BootstrapOptions {
  pg?: boolean;
  s3?: boolean;
  ducklake?: boolean;
}

/**
 * 打开连接并完成初始化：
 *  - 加载扩展（首次运行会从 extensions.duckdb.org 自动下载）
 *  - 创建 S3 / PG 密钥（会话级，不落盘）
 *  - 把 PostgreSQL 挂载为 `pg` 目录（只要 pg: true）
 */
// 扩展、密钥、ATTACH 都是实例级的：每种只初始化一次（并发 connect() 共享同一个 Promise，避免写冲突）
const ready = new Map<string, Promise<void>>();
function once(key: string, con: DuckDBConnection, sql: string): Promise<void> {
  if (!ready.has(key))
    ready.set(
      key,
      con.run(sql).then(() => undefined),
    );
  return ready.get(key)!;
}

export async function connect(
  opts: BootstrapOptions = {},
): Promise<DuckDBConnection> {
  const con = await (await getInstance()).connect();
  const { pg = false, s3 = isS3Lake(), ducklake = false } = opts;

  if (s3) {
    await once(
      "s3",
      con,
      `
      INSTALL httpfs; LOAD httpfs;
      CREATE OR REPLACE SECRET lake_s3 (
        TYPE s3, KEY_ID '${config.s3.key}', SECRET '${config.s3.secret}',
        REGION '${config.s3.region}', ENDPOINT '${config.s3.endpoint}',
        URL_STYLE '${config.s3.urlStyle}', USE_SSL ${config.s3.useSsl}
      );
      SET GLOBAL s3_uploader_max_parts_per_file = 10000;`,
    );
  }
  if (pg) {
    await once(
      "pg",
      con,
      `
      INSTALL postgres; LOAD postgres;
      CREATE OR REPLACE SECRET crm_pg (
        TYPE postgres, HOST '${config.pg.host}', PORT ${config.pg.port},
        DATABASE '${config.pg.database}', USER '${config.pg.user}', PASSWORD '${config.pg.password}'
      );
      ATTACH IF NOT EXISTS '' AS pg (TYPE postgres, SECRET crm_pg);`,
    );
  }
  if (ducklake) await once("ducklake", con, `INSTALL ducklake; LOAD ducklake;`);
  return con;
}

// ------------------------------------------------------------------
// 计时与基准记录：每一步写入 reports/bench.jsonl，方便对比不同规模
// ------------------------------------------------------------------
export function record(step: string, ms: number, rows?: number) {
  mkdirSync("./reports", { recursive: true });
  appendFileSync(
    "./reports/bench.jsonl",
    JSON.stringify({
      at: new Date().toISOString(),
      scale: config.scale,
      target: config.seedTarget,
      script: SCRIPT,
      step,
      ms: Math.round(ms),
      rows,
    }) + "\n",
  );
}
const fmt = (ms: number) =>
  ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;

/** 执行（不取结果）并计时 */
export async function exec(con: DuckDBConnection, sql: string, label?: string) {
  const t0 = performance.now();
  await con.run(sql);
  const ms = performance.now() - t0;
  if (label) {
    console.log(`✔ ${label}  (${fmt(ms)})`);
    record(label, ms);
  }
  return ms;
}

/** 执行并返回行对象（BIGINT / DECIMAL 以字符串返回，避免精度丢失） */
export async function q<T = Record<string, unknown>>(
  con: DuckDBConnection,
  sql: string,
  params?: Record<string, any> | any[],
  label?: string,
): Promise<T[]> {
  const t0 = performance.now();
  const reader = await con.runAndReadAll(sql, params as any);
  const rows = reader.getRowObjectsJson() as T[];
  const ms = performance.now() - t0;
  if (label) {
    console.log(`\n▶ ${label}  (${fmt(ms)}, ${rows.length} 行)`);
    record(label, ms, rows.length);
  }
  return rows;
}

/** 表格打印 */
export function show(rows: Record<string, unknown>[], max = 12) {
  console.table(rows.slice(0, max));
  if (rows.length > max) console.log(`… 共 ${rows.length} 行`);
}

/** 统计表行数（带千分位） */
export async function count(
  con: DuckDBConnection,
  from: string,
): Promise<string> {
  const [r] = await q<{ n: string }>(
    con,
    `SELECT count(*)::BIGINT AS n FROM ${from}`,
  );
  return Number(r.n).toLocaleString("en-US");
}

export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  const ms = performance.now() - t0;
  console.log(`✔ ${label}  (${fmt(ms)})`);
  record(label, ms);
  return out;
}

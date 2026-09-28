// src/lib/config.ts —— 所有配置都来自环境变量（.env），这里集中读取并给出默认值
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';

const env = (k: string, d?: string) => process.env[k] ?? d ?? '';
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  // ---- 规模：SCALE=1 → 1000 万会员 / 约 1.1 亿订单 / 约 2.4 亿明细 / 1 亿埋点 / 5000 万触达 ----
  scale: num('SCALE', 0.01),
  // 业务数据（客户、订单、明细）写到哪里：pg = 写入 PostgreSQL（真实链路）；lake = 直接写成 landing Parquet（跳过 PG，做纯湖上压测）
  seedTarget: env('SEED_TARGET', 'pg') as 'pg' | 'lake',

  // ---- PostgreSQL（你本地容器里的库）----
  pg: {
    host: env('PG_HOST', 'localhost'),
    port: num('PG_PORT', 5432),
    database: env('PG_DATABASE', 'crm'),
    user: env('PG_USER', 'crm'),
    password: env('PG_PASSWORD', 'crm'),
    schema: env('PG_SCHEMA', 'crm'),
  },

  // ---- 对象存储（SeaweedFS / RustFS / Garage / 云上 S3 / OSS）----
  s3: {
    endpoint: env('S3_ENDPOINT', 'localhost:8333'),   // 不带 http://
    region: env('S3_REGION', 'us-east-1'),
    key: env('S3_ACCESS_KEY', 'crm'),
    secret: env('S3_SECRET_KEY', 'crm-secret'),
    urlStyle: env('S3_URL_STYLE', 'path'),              // 自建存储一般用 path
    useSsl: env('S3_USE_SSL', 'false') === 'true',
  },

  // 数据湖根目录：s3://bucket/prefix 或本地目录
  lake: env('LAKE_URI', 's3://crm-lake/lake').replace(/\/$/, ''),

  // ---- DuckDB ----
  dbFile: env('DB_FILE', './data/crm.duckdb'),
  threads: num('DUCKDB_THREADS', os.cpus().length),
  memoryLimit: env('DUCKDB_MEMORY', `${Math.floor((os.totalmem() / 1024 ** 3) * 0.6)}GB`),
  tempDir: env('DUCKDB_TEMP_DIR', './data/tmp'),

  // ---- 模拟的会员 SaaS 接口 ----
  apiPort: num('MOCK_API_PORT', 18080),
  apiPageSize: num('MOCK_API_PAGE_SIZE', 20000),
  apiConcurrency: num('MOCK_API_CONCURRENCY', 4),
};

/** 由 SCALE 推导的数据量（SCALE=1 为目标规模） */
export const sizes = {
  customers: Math.round(10_000_000 * config.scale),
  products: 100_000,                                          // 商品数不随规模变化
  sessions: Math.round(22_000_000 * config.scale),            // ≈ 1 亿埋点事件
  touches: Math.round(50_000_000 * config.scale),
  eventDays: 118,                                             // 2026-06-01 起
  customerChunk: 1_000_000,                                   // 分块写入：每块 100 万客户（≈ 1100 万订单）
};

export const lakePath = (p: string) => `${config.lake}/${p}`;
export const isS3Lake = () => config.lake.startsWith('s3://');

/** 写出目标路径：本地湖时自动创建目录（对象存储不需要） */
export function outPath(p: string): string {
  const full = lakePath(p);
  if (!isS3Lake()) mkdirSync(extname(full) ? dirname(full) : full, { recursive: true });
  return full;
}

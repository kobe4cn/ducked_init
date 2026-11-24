// scripts/eval-shared/report.ts —— 各项模型评测共用的结果文件（ADR-0035）：缺环境变量时退出、提示词哈希、
// 一次评测的元信息 { 模型、端点主机、提示词哈希、开始时间 } 与写结果文件。只记主机，不记 Key、完整 URL、请求与模型原文
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportFileName } from '../eval-mapping/report';

const VARS = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY'] as const;

/** 缺 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 时打印缺了哪些并以 2 退出 */
export function requireLlmEnv(): void {
  const missing = VARS.filter(v => !process.env[v]);
  if (!missing.length) return;
  console.error(`缺少环境变量：${missing.join('、')}（写进 .env 或在命令前设置）`);
  process.exit(2);
}

/** 提示词哈希：system 消息加输出 Schema 的 sha256 前 12 位；改了提示词或 Schema 就变 */
export function hashPrompt(system: string, schema: object): string {
  return createHash('sha256').update(system).update(JSON.stringify(schema)).digest('hex').slice(0, 12);
}

export interface EvalReport<C extends { name: string; stage?: string }, T> {
  model: string;
  /** 端点主机（含端口），不是完整 URL */
  host: string;
  promptHash: string;
  startedAt: string;
  cases: C[];
  total: T;
}

export type ReportMeta = Pick<EvalReport<{ name: string }, unknown>, 'model' | 'host' | 'promptHash' | 'startedAt'>;

/** 一次评测的元信息：baseUrl 只留主机，开始时间写成 ISO 文本 */
export function reportMeta(meta: { model: string; baseUrl: string; startedAt: Date }, promptHash: string): ReportMeta {
  return { model: meta.model, host: new URL(meta.baseUrl).host, promptHash, startedAt: meta.startedAt.toISOString() };
}

/** 把结果写到 dir/<时间戳>-<模型>.json（目录不存在就建），返回文件路径 */
export function writeReport<C extends { name: string; stage?: string }, T>(dir: string, report: EvalReport<C, T>): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, reportFileName(report));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

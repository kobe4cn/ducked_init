// app/.server/llm-usage.ts —— 模型调用统计（#303，Spec #1 故事 94）：给「模型调用」页按用途汇总 platform.llm_calls（近 N 天）并取最近调用明细。
// 质量只看 Schema 通过率、错误率与耗时；成本折算按 (purpose, model) 分组留给 #304 在这个模块里加查询。
// 总计是单独一条不分组的聚合（不能拿各用途的 P95 再平均）；pg 把 bigint / numeric / double 当字符串返回，统一 Number() + Math.round 成整数
import { and, desc, eq, sql } from 'drizzle-orm';
import { cmp } from '../lib/compare';
import { getDb } from './db/client';
import { llmCalls } from './db/schema';

export const LLM_CALL_PAGE_SIZE = 50;

/** 时间段白名单：其他值一律回退 7 天 */
export function parseDays(v: string | null): 7 | 30 {
  return v === '30' ? 30 : 7;
}

export interface PurposeUsage {
  purpose: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  avgMs: number;
  p95Ms: number;
  /** schema_valid 不为空的行数（通过率的分母；chatTools 与 embedding 记 null，不算） */
  schemaChecked: number;
  schemaValid: number;
  errors: number;
}

/** 时间窗口的起点在库里算（now() - make_interval），避免应用与库的时区差 */
const inWindow = (tenantId: string, days: 7 | 30) =>
  and(eq(llmCalls.tenantId, tenantId), sql`${llmCalls.createdAt} >= now() - make_interval(days => ${days})`);

const agg = () => ({
  calls: sql<number>`count(*)`,
  promptTokens: sql<number>`coalesce(sum(${llmCalls.promptTokens}), 0)`,
  completionTokens: sql<number>`coalesce(sum(${llmCalls.completionTokens}), 0)`,
  avgMs: sql<number>`avg(${llmCalls.durationMs})`,
  p95Ms: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${llmCalls.durationMs})`,
  schemaChecked: sql<number>`count(*) filter (where ${llmCalls.schemaValid} is not null)`,
  schemaValid: sql<number>`count(*) filter (where ${llmCalls.schemaValid})`,
  errors: sql<number>`count(*) filter (where ${llmCalls.error} is not null)`,
});

const toUsage = (r: Record<string, unknown>, purpose: string): PurposeUsage => ({
  purpose,
  calls: Number(r.calls ?? 0),
  promptTokens: Number(r.promptTokens ?? 0),
  completionTokens: Number(r.completionTokens ?? 0),
  avgMs: Math.round(Number(r.avgMs ?? 0)),
  p95Ms: Math.round(Number(r.p95Ms ?? 0)),
  schemaChecked: Number(r.schemaChecked ?? 0),
  schemaValid: Number(r.schemaValid ?? 0),
  errors: Number(r.errors ?? 0),
});

/** 按用途分组统计，另给一条不分组的总计；行按调用次数降序、同次数按用途名 */
export async function usageByPurpose(tenantId: string, days: 7 | 30) {
  const db = getDb();
  const grouped = await db.select({ purpose: llmCalls.purpose, ...agg() }).from(llmCalls)
    .where(inWindow(tenantId, days)).groupBy(llmCalls.purpose);
  const [total] = await db.select(agg()).from(llmCalls).where(inWindow(tenantId, days));
  return {
    rows: grouped.map(r => toUsage(r, r.purpose)).sort((a, b) => b.calls - a.calls || cmp(a.purpose, b.purpose)),
    total: toUsage(total ?? {}, 'total'),
  };
}

/** 明细行取 `llm_calls` 的一部分列（见 listCalls 的 select） */
export type LlmCallRow = Pick<typeof llmCalls.$inferSelect,
  'id' | 'createdAt' | 'purpose' | 'model' | 'promptTokens' | 'completionTokens' | 'durationMs' | 'schemaValid' | 'error'>;

/** 最近调用明细（时间倒序）分页：页码夹到 1..pages，total 是窗口内的总条数 */
export async function listCalls(tenantId: string, days: 7 | 30, page: number) {
  const db = getDb();
  const [counted] = await db.select({ total: sql<number>`count(*)` }).from(llmCalls).where(inWindow(tenantId, days));
  const total = Number(counted?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / LLM_CALL_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows: LlmCallRow[] = total === 0 ? [] : await db.select({
    id: llmCalls.id,
    createdAt: llmCalls.createdAt,
    purpose: llmCalls.purpose,
    model: llmCalls.model,
    promptTokens: llmCalls.promptTokens,
    completionTokens: llmCalls.completionTokens,
    durationMs: llmCalls.durationMs,
    schemaValid: llmCalls.schemaValid,
    error: llmCalls.error,
  }).from(llmCalls).where(inWindow(tenantId, days))
    .orderBy(desc(llmCalls.createdAt), desc(llmCalls.id))
    .limit(LLM_CALL_PAGE_SIZE).offset((current - 1) * LLM_CALL_PAGE_SIZE);
  return { rows, total, page: current, pages };
}

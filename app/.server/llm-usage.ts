// app/.server/llm-usage.ts —— 模型调用统计（#303，Spec #1 故事 94）：给「模型调用」页按用途汇总 platform.llm_calls（近 N 天）并取最近调用明细。
// 质量看 Schema 通过率、错误率与耗时；成本按 (purpose, model) 分组、用查看时的当前单价折算成各币种金额（ADR-0057，#745）。
// 总计是单独一条不分组的聚合（不能拿各用途的 P95 再平均）；pg 把 bigint / numeric / double 当字符串返回，统一 Number() + Math.round 成整数
import { and, desc, eq, sql } from 'drizzle-orm';
import { cmp } from '../lib/compare';
import { getDb } from './db/client';
import { llmCalls } from './db/schema';
import { formatCost, priceMap, summarizeCost } from './model-prices';

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
  /** 按当前单价折算的金额（ADR-0057）：各币种「CNY 0.1234 + USD 0.0100」，未配单价时有对应提示 */
  cost: string;
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

const toUsage = (r: Record<string, unknown>, purpose: string): Omit<PurposeUsage, 'cost'> => ({
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

/** 按用途分组统计，另给一条不分组的总计；行按调用次数降序、同次数按用途名。金额按 (purpose, model) 分组用当前单价折算（ADR-0057），总计用全部分组重算 */
export async function usageByPurpose(tenantId: string, days: 7 | 30) {
  const db = getDb();
  const byModel = () => ({
    purpose: llmCalls.purpose,
    model: llmCalls.model,
    calls: sql<number>`count(*)`,
    promptTokens: sql<number>`coalesce(sum(${llmCalls.promptTokens}), 0)`,
    completionTokens: sql<number>`coalesce(sum(${llmCalls.completionTokens}), 0)`,
  });
  const [grouped, [total], byPurposeModel, prices] = await Promise.all([
    db.select({ purpose: llmCalls.purpose, ...agg() }).from(llmCalls)
      .where(inWindow(tenantId, days)).groupBy(llmCalls.purpose),
    db.select(agg()).from(llmCalls).where(inWindow(tenantId, days)),
    db.select(byModel()).from(llmCalls).where(inWindow(tenantId, days)).groupBy(llmCalls.purpose, llmCalls.model),
    priceMap(),
  ]);
  // pg 的 count / sum 是字符串，先 Number()（照 toUsage）；金额在各币种内先累加，最后由 formatCost 统一保留 4 位小数
  const costOfGroups = (groups: { model: string; calls: unknown; promptTokens: unknown; completionTokens: unknown }[]) =>
    formatCost(summarizeCost(groups.map(g => ({
      model: g.model,
      calls: Number(g.calls ?? 0),
      promptTokens: Number(g.promptTokens ?? 0),
      completionTokens: Number(g.completionTokens ?? 0),
    })), prices));
  return {
    rows: grouped.map(r => ({
      ...toUsage(r, r.purpose),
      cost: costOfGroups(byPurposeModel.filter(g => g.purpose === r.purpose)),
    })).sort((a, b) => b.calls - a.calls || cmp(a.purpose, b.purpose)),
    total: { ...toUsage(total ?? {}, 'total'), cost: costOfGroups(byPurposeModel) },
  };
}

/** 明细行取 `llm_calls` 的一部分列（见 listCalls 的 select）加折算好的金额 */
export type LlmCallRow = Pick<typeof llmCalls.$inferSelect,
  'id' | 'createdAt' | 'purpose' | 'model' | 'promptTokens' | 'completionTokens' | 'durationMs' | 'schemaValid' | 'error'> & { cost: string };

/** 最近调用明细（时间倒序）分页：页码夹到 1..pages，total 是窗口内的总条数；每行按当前单价折算金额（ADR-0057） */
export async function listCalls(tenantId: string, days: 7 | 30, page: number) {
  const db = getDb();
  const [[counted], prices] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(llmCalls).where(inWindow(tenantId, days)),
    priceMap(),
  ]);
  const total = Number(counted?.total ?? 0);
  const pages = Math.max(1, Math.ceil(total / LLM_CALL_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const picked = total === 0 ? [] : await db.select({
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
  // 单行也走 summarizeCost / formatCost（calls: 1），与统计口径一致
  const rows: LlmCallRow[] = picked.map(r => ({
    ...r,
    cost: formatCost(summarizeCost([{ model: r.model, promptTokens: r.promptTokens, completionTokens: r.completionTokens, calls: 1 }], prices)),
  }));
  return { rows, total, page: current, pages };
}

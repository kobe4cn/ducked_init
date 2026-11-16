// app/.server/llm-usage.ts —— 模型调用统计（#303，Spec #1 故事 94）：给「模型调用」页按用途汇总 platform.llm_calls（近 N 天）并取最近调用明细；
// 运营后台「模型调用汇总」（#746）跨租户按（租户、模型、用途）分组，只取聚合数（ADR-0007）。
// 质量看 Schema 通过率、错误率与耗时；成本按 (purpose, model) 分组、用查看时的当前单价折算成各币种金额（ADR-0057，#745）。
// 映射草稿另有「校验通过率」（#802）：不在 llm_calls 记，从 mapping_generations 加审计算（ADR-0035，见 draftCheckStats）。
// 总计是单独一条不分组的聚合（不能拿各用途的 P95 再平均）；pg 把 bigint / numeric / double 当字符串返回，统一 Number() + Math.round 成整数
import { and, desc, eq, sql } from 'drizzle-orm';
import { cmp, cmpName } from '../lib/compare';
import { getDb } from './db/client';
import { auditLogs, llmCalls, mappingGenerations, tenants } from './db/schema';
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
  /** 映射草稿的「校验通过率」（#802）：checked 分母（做了映射校验的生成）、passed 通过、partial 部分采用；只有 mapping_draft 行有 */
  draftCheck?: { checked: number; passed: number; partial: number };
}

/** 时间窗口的起点在库里算（now() - make_interval），避免应用与库的时区差 */
const since = (days: 7 | 30) => sql`${llmCalls.createdAt} >= now() - make_interval(days => ${days})`;
const inWindow = (tenantId: string, days: 7 | 30) => and(eq(llmCalls.tenantId, tenantId), since(days));

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

/**
 * 映射草稿的「校验通过率」（#802，口径见 #791 评论）：不改 llm_calls、不加迁移，从已有两处记录算——
 * 采用 = mapping_generations 里 origin = 'model' 的行（mappings.ts 只在映射校验通过后才写这个 origin），
 * 其中 items 有元素带 dropped 键的是部分采用（#801 写入，值是校验消息；TS 类型没写这个键，判断放 SQL）；
 * 失败 = audit_logs 里 mapping.model_draft_failed、detail.stage = 'mapping' 且无 kind 的行（两条整份拒绝路径都这样记）。
 * 模型阶段失败（stage = 'model'）与断言建议失败（带 kind = 'assertions'）不算；mapping.model_draft_partial 审计不参与计数，
 * 部分采用只从生成记录数，不重复计。通过数 = 采用 − 部分采用，分母 = 采用 + 失败。
 * 口径与调用行不是一一对应：生成记录、审计与调用可能跨窗口边界，tableContextFor 出错或抛出非 MappingError 的异常时
 * 不写审计、不计入分母——这两点可接受。getDb() 不受 RLS 限制，必须按 tenant_id 过滤。
 */
async function draftCheckStats(tenantId: string, days: 7 | 30) {
  const [[gen], [fail]] = await Promise.all([
    getDb().select({
      adopted: sql<number>`count(*)`,
      partial: sql<number>`count(*) filter (where jsonb_path_exists(${mappingGenerations.items}, '$[*].dropped'))`,
    }).from(mappingGenerations).where(and(
      eq(mappingGenerations.tenantId, tenantId),
      eq(mappingGenerations.origin, 'model'),
      sql`${mappingGenerations.createdAt} >= now() - make_interval(days => ${days})`,
    )),
    getDb().select({ failed: sql<number>`count(*)` }).from(auditLogs).where(and(
      eq(auditLogs.tenantId, tenantId),
      eq(auditLogs.action, 'mapping.model_draft_failed'),
      sql`${auditLogs.detail} ->> 'stage' = 'mapping'`,
      sql`${auditLogs.detail} ->> 'kind' is null`,
      sql`${auditLogs.createdAt} >= now() - make_interval(days => ${days})`,
    )),
  ]);
  // pg 的 count 是字符串，先 Number()（照 toUsage）
  const adopted = Number(gen?.adopted ?? 0);
  const partial = Number(gen?.partial ?? 0);
  return { checked: adopted + Number(fail?.failed ?? 0), passed: adopted - partial, partial };
}

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
  const [grouped, [total], byPurposeModel, prices, draftCheck] = await Promise.all([
    db.select({ purpose: llmCalls.purpose, ...agg() }).from(llmCalls)
      .where(inWindow(tenantId, days)).groupBy(llmCalls.purpose),
    db.select(agg()).from(llmCalls).where(inWindow(tenantId, days)),
    db.select(byModel()).from(llmCalls).where(inWindow(tenantId, days)).groupBy(llmCalls.purpose, llmCalls.model),
    priceMap(),
    draftCheckStats(tenantId, days),
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
      // 「校验通过率」只挂在映射草稿一行（窗口内整份失败一定有调用行，不用补行）；总计与其他用途不汇总这一列
      ...(r.purpose === 'mapping_draft' ? { draftCheck } : {}),
    })).sort((a, b) => b.calls - a.calls || cmp(a.purpose, b.purpose)),
    total: { ...toUsage(total ?? {}, 'total'), cost: costOfGroups(byPurposeModel) },
  };
}

/** 运营后台「模型调用汇总」的一行（#746）：（租户、模型、用途）分组的聚合数，金额按当前单价折算（ADR-0057） */
export interface TenantModelUsage {
  tenantName: string;
  model: string;
  purpose: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  errors: number;
  cost: string;
}

/**
 * 跨租户按（租户、模型、用途）分组汇总（#746，运营后台）。运营者没有租户 RLS，直接用 getDb()（先例 listOperatorAuditLogs）；
 * 只取聚合数与租户名，不 select error 原文、不带出其他租户字段（ADR-0007）。排序：租户名 zh-CN（ADR-0045），模型与用途按码点
 */
export async function usageAcrossTenants(days: 7 | 30): Promise<TenantModelUsage[]> {
  const [rows, prices] = await Promise.all([
    getDb().select({
      tenantName: tenants.name,
      model: llmCalls.model,
      purpose: llmCalls.purpose,
      calls: sql<number>`count(*)`,
      promptTokens: sql<number>`coalesce(sum(${llmCalls.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${llmCalls.completionTokens}), 0)`,
      errors: sql<number>`count(*) filter (where ${llmCalls.error} is not null)`,
    }).from(llmCalls)
      .innerJoin(tenants, eq(tenants.id, llmCalls.tenantId))
      .where(since(days))
      .groupBy(llmCalls.tenantId, tenants.name, llmCalls.model, llmCalls.purpose),
    priceMap(),
  ]);
  // pg 的 count / sum 是字符串，先 Number()（照 toUsage）；每行单独走 summarizeCost / formatCost，与统计口径一致
  return rows.map(r => {
    const calls = Number(r.calls ?? 0);
    const promptTokens = Number(r.promptTokens ?? 0);
    const completionTokens = Number(r.completionTokens ?? 0);
    return {
      tenantName: r.tenantName,
      model: r.model,
      purpose: r.purpose,
      calls,
      promptTokens,
      completionTokens,
      errors: Number(r.errors ?? 0),
      cost: formatCost(summarizeCost([{ model: r.model, calls, promptTokens, completionTokens }], prices)),
    };
  }).sort((a, b) => cmpName(a.tenantName, b.tenantName) || cmp(a.model, b.model) || cmp(a.purpose, b.purpose));
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

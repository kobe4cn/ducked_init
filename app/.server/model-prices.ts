// app/.server/model-prices.ts —— 运营后台维护的模型单价（ADR-0057）：llm_calls.model 原值 → 每百万 token 的输入 / 输出单价。
// 金额按查看时的当前单价折算，不在 llm_calls 上存调用时单价，也不保留历史版本；每次改动的前后值在审计里，可重建价格历史。
// 单价可增改可删除（删除后该模型的调用显示「未配置单价」，删除前的值在审计里）；本模块只管平台元数据，不碰任何租户的调用数据（ADR-0007）
import { eq } from 'drizzle-orm';
import { cmp } from '../lib/compare';
import { recordAudit, type OperatorActor } from './audit';
import { getDb, isUniqueViolation } from './db/client';
import { modelPrices } from './db/schema';

export type PriceCurrency = 'CNY' | 'USD';
const CURRENCIES = ['CNY', 'USD'] as const;

/** 单价的一行（numeric 读出来是字符串，这里已转成数字） */
export interface ModelPrice {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** 缓存输入单价（#1255）：没配（null）时缓存 token 按输入单价折算 */
  cachedInputPerMTok: number | null;
  currency: PriceCurrency;
  updatedAt: Date;
}

/** 展示给运营者的业务错误（输入不合法、并发的同名冲突），带对应的 HTTP 状态码 */
export class ModelPriceError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 校验单价：数字、非负、最多 4 位小数、整数部分不超过 8 位（numeric(12,4) 的上限），返回数字 */
function parseAmount(label: string, raw: unknown): number {
  const s = String(raw ?? '').trim();
  const v = Number(s);
  if (!Number.isFinite(v)) throw new ModelPriceError(`${label}必须是数字`);
  if (v < 0) throw new ModelPriceError(`${label}不能是负数`);
  if (!/^\d{1,8}(\.\d{1,4})?$/.test(s)) throw new ModelPriceError(`${label}最多 4 位小数，整数部分最多 8 位`);
  return v;
}

/** 校验表单：模型名去首尾空白、非空、最长 100 字；币种只认白名单 */
function parsePrice(raw: Record<string, unknown>) {
  const model = String(raw.model ?? '').trim();
  if (!model) throw new ModelPriceError('模型名不能为空');
  if (model.length > 100) throw new ModelPriceError('模型名最长 100 字');
  const currency = String(raw.currency ?? '').trim();
  if (!CURRENCIES.includes(currency as PriceCurrency)) throw new ModelPriceError('币种只能是 CNY 或 USD');
  return {
    model,
    inputPerMTok: parseAmount('输入单价', raw.inputPerMTok),
    outputPerMTok: parseAmount('输出单价', raw.outputPerMTok),
    currency: currency as PriceCurrency,
  };
}

type PriceRow = typeof modelPrices.$inferSelect;

const toPrice = (r: PriceRow): ModelPrice => ({
  model: r.model,
  // pg 把 numeric 返回成字符串（"2.5000"），统一转成数字；缓存单价可空，null 保留 null（不能 Number(null) 得 0，缓存 token 就成免费了）
  inputPerMTok: Number(r.inputPerMTok),
  outputPerMTok: Number(r.outputPerMTok),
  cachedInputPerMTok: r.cachedInputPerMTok == null ? null : Number(r.cachedInputPerMTok),
  currency: r.currency as PriceCurrency,
  updatedAt: r.updatedAt,
});

/** 全部单价，按模型名（内部键，ADR-0045）排序 */
export async function listModelPrices(): Promise<ModelPrice[]> {
  const rows = await getDb().select().from(modelPrices);
  return rows.map(toPrice).sort((a, b) => cmp(a.model, b.model));
}

/** 模型名 → 单价，金额折算（#745、#746）从这里查 */
export async function priceMap(): Promise<Map<string, ModelPrice>> {
  return new Map((await listModelPrices()).map(p => [p.model, p]));
}

/**
 * 金额 = (prompt_tokens − cached_tokens) × 输入单价 / 1e6 + cached_tokens × 缓存单价（没配按输入单价）/ 1e6
 * + completion_tokens × 输出单价 / 1e6（ADR-0057，#1255）；token 为 null 按 0 算。
 * prompt_tokens 本身已包含缓存 token（#1253 记的 cached_tokens 是 prompt 的一部分），所以先减掉再按各自单价算
 */
export function costOf(
  promptTokens: number | null,
  completionTokens: number | null,
  cachedTokens: number | null,
  price: Pick<ModelPrice, 'inputPerMTok' | 'outputPerMTok'> & { cachedInputPerMTok?: number | null },
): number {
  const cached = cachedTokens ?? 0;
  return (((promptTokens ?? 0) - cached) * price.inputPerMTok
    + cached * (price.cachedInputPerMTok ?? price.inputPerMTok)
    + (completionTokens ?? 0) * price.outputPerMTok) / 1_000_000;
}

/** 一组调用折算后的结果：各币种金额（先累加，显示时才保留 4 位小数）与已配价 / 未配价的调用次数 */
export interface CostSummary {
  byCurrency: Partial<Record<PriceCurrency, number>>;
  pricedCalls: number;
  unpricedCalls: number;
}

/** 把按 (purpose, model) 或单次调用的一组行折算成各币种金额（ADR-0057）：未配单价的模型只计 unpricedCalls，不当 0 算 */
export function summarizeCost(
  rows: { model: string; promptTokens: number | null; completionTokens: number | null; cachedTokens: number | null; calls: number }[],
  prices: Map<string, ModelPrice>,
): CostSummary {
  const summary: CostSummary = { byCurrency: {}, pricedCalls: 0, unpricedCalls: 0 };
  for (const r of rows) {
    const p = prices.get(r.model);
    if (p === undefined) { summary.unpricedCalls += r.calls; continue; }
    summary.byCurrency[p.currency] = (summary.byCurrency[p.currency] ?? 0) + costOf(r.promptTokens, r.completionTokens, r.cachedTokens, p);
    summary.pricedCalls += r.calls;
  }
  return summary;
}

/** 折算结果 → 展示文本：都没配价是「未配置单价」；否则「币种 金额（4 位小数）」按币种代码排序、用「 + 」连接，有未配价的在末尾加注 */
export function formatCost(summary: CostSummary): string {
  if (summary.pricedCalls === 0) return '未配置单价';
  const parts = Object.entries(summary.byCurrency).sort(([a], [b]) => cmp(a, b))
    .map(([currency, amount]) => `${currency} ${(amount ?? 0).toFixed(4)}`);
  return parts.join(' + ') + (summary.unpricedCalls > 0 ? '（部分模型未配置单价）' : '');
}

/** 与已存的一行比是否同值：numeric 读出来是字符串，先转数字再比，否则 "2.0000" 和 "2" 会被当成变了 */
const samePrice = (r: PriceRow, p: { inputPerMTok: number; outputPerMTok: number; currency: string }) =>
  Number(r.inputPerMTok) === p.inputPerMTok && Number(r.outputPerMTok) === p.outputPerMTok && r.currency === p.currency;

const detailOf = (p: { inputPerMTok: number; outputPerMTok: number; currency: string }) =>
  ({ inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok, currency: p.currency });

/**
 * 新增或修改一个模型的单价（填已有模型名就是修改），审计与变更写在同一事务里；同值保存是 no-op、不写审计。
 * 并发新增同名模型由 model 列上的唯一约束兜底，转成业务错误
 */
export async function upsertModelPrice(operator: OperatorActor, raw: Record<string, unknown>) {
  const price = parsePrice(raw);
  try {
    await getDb().transaction(async tx => {
      const [existing] = await tx.select().from(modelPrices).where(eq(modelPrices.model, price.model)).for('update');
      if (!existing) {
        // numeric 列写入也要字符串（读出在 toPrice 里统一转数字）
        await tx.insert(modelPrices).values({ ...price, inputPerMTok: String(price.inputPerMTok), outputPerMTok: String(price.outputPerMTok), updatedBy: operator?.operatorId ?? null });
        await recordAudit(tx, {
          tenantId: null,
          operator,
          action: 'model_price.created',
          targetType: 'model_price',
          targetId: price.model,
          detail: { model: price.model, ...detailOf(price) },
        });
        return;
      }
      if (samePrice(existing, price)) return;
      await tx.update(modelPrices)
        .set({
          ...price,
          inputPerMTok: String(price.inputPerMTok),
          outputPerMTok: String(price.outputPerMTok),
          updatedAt: new Date(),
          updatedBy: operator?.operatorId ?? null,
        })
        .where(eq(modelPrices.id, existing.id));
      await recordAudit(tx, {
        tenantId: null,
        operator,
        action: 'model_price.updated',
        targetType: 'model_price',
        targetId: price.model,
        detail: { model: price.model, from: detailOf(toPrice(existing)), to: detailOf(price) },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ModelPriceError(`已有模型 ${price.model} 的单价，请刷新后重试`);
    throw e;
  }
}

/**
 * 删除一个模型的单价（ADR-0057）：删除后该模型的调用按「未配置单价」处理，删除前的值写进审计，可照着重新填回。
 * 模型不存在（已被别人删掉或从未配置）是业务错误
 */
export async function deleteModelPrice(operator: OperatorActor, rawModel: unknown) {
  const model = String(rawModel ?? '').trim();
  if (!model) throw new ModelPriceError('缺少模型名');
  await getDb().transaction(async tx => {
    const [existing] = await tx.delete(modelPrices).where(eq(modelPrices.model, model)).returning();
    if (!existing) throw new ModelPriceError(`没有模型 ${model} 的单价，可能已被删除，请刷新`);
    await recordAudit(tx, {
      tenantId: null,
      operator,
      action: 'model_price.deleted',
      targetType: 'model_price',
      targetId: model,
      detail: { model, ...detailOf(toPrice(existing)) },
    });
  });
}

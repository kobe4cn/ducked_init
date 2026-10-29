// app/.server/model-provider.ts —— 租户自己的模型服务配置（ADR-0035，仅管理员）：查看当前生效的来源、保存端点 / 模型名 / API Key、
// 恢复平台默认、测试连通性。API Key 用租户数据密钥加密（ADR-0009），读出来只告诉页面「已设置」，明文与密文都不出这个模块；
// 留空保存沿用原来的 Key，审计只记端点、模型名与是否轮换。是否发送脱敏样本也在这里开关，tableContextFor 按它组织给模型的表上下文。
// 测试连通性时的工具调用探测结果连同当时的端点、模型存下来，toolSupport 给 AI 助手判断能不能用
import { and, eq, isNotNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { modelProviders } from './db/schema';
import { chatJson, chatTools, LlmError, MODEL_PROVIDER_CONTEXT, platformProvider, providerSource, resolveProvider } from './llm';
import { buildTableContext, type TableContext } from './pipeline/llm-context';
import { decryptForTenant, encryptForTenant } from './secrets';
import { maskedSample, SourceViewError } from './source-views';
import { confirmedTables } from './sources';

/** 可以展示给管理员的输入错误 */
export class ModelProviderError extends Error {
  readonly status = 400;
}

export interface ModelProviderView {
  /** 当前生效的配置：本租户的、平台默认，或都没有 */
  source: 'tenant' | 'platform' | 'none';
  baseUrl: string | null;
  model: string | null;
  apiKeySet: boolean;
  allowSamples: boolean;
}

const rowOf = async (tenantId: string) =>
  (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId)))[0];

/** 本租户填写的端点与模型名、Key 是否已设置，以及当前实际用哪套（providerSource，与调用模型时的选取一致） */
export async function getModelProvider(actor: CurrentMember): Promise<ModelProviderView> {
  assertCan(actor, 'model_provider:manage');
  const row = await rowOf(actor.tenant.id);
  return {
    source: providerSource(row) ?? 'none',
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    apiKeySet: Boolean(row?.apiKey),
    allowSamples: row?.allowSamples ?? false,
  };
}

function parseBaseUrl(raw: string) {
  const value = raw.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new ModelProviderError('端点须是完整的 http(s) 地址，如 https://api.openai.com/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ModelProviderError('端点须是 http 或 https 地址');
  return value.replace(/\/+$/, '');
}

/** 清空工具调用探测结果。读的时候 toolSupport 也会比对端点与模型，这里另外清掉是为了改回原来的配置时旧结果不再复活 */
const NO_PROBE = { toolsSupported: null, toolsProbedBaseUrl: null, toolsProbedModel: null };

/**
 * 保存本租户的模型服务：apiKey 留空沿用原来的 Key，填了新值就加密保存并在审计里记轮换。
 * 第一次配置与改了端点时必须填 Key：否则拿到管理员会话就能把已存的 Key 发到自己的主机上（ADR-0035）
 */
export async function saveModelProvider(actor: CurrentMember, input: { baseUrl: string; model: string; apiKey: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const baseUrl = parseBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const apiKey = input.apiKey.trim();
  const row = await rowOf(tenantId);
  const kept = row?.apiKey && row.baseUrl === baseUrl ? row.apiKey : null;
  if (!apiKey && !kept) throw new ModelProviderError(row?.apiKey ? '改了端点须重新填写 API Key' : '第一次配置须填写 API Key');

  const previous = row?.apiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.apiKey)).apiKey : null;
  const rotated = Boolean(apiKey) && apiKey !== previous;
  // 没轮换时 row.apiKey 一定有：留空要求 kept，填了同一个值说明原来就有
  const sealed = rotated ? await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey }) : row?.apiKey ?? null;
  // 端点或模型变了，旧的工具调用探测结果作废
  const probe = row?.baseUrl === baseUrl && row.model === model ? {} : NO_PROBE;
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, baseUrl, model, apiKey: sealed })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { baseUrl, model, apiKey: sealed, ...probe, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { baseUrl, model, credentialsRotated: rotated },
    });
  });
}

/** 恢复平台默认：清空端点、模型名、Key 与工具调用探测结果（是否允许发送样本行保留），之后 resolveProvider 回到环境变量的配置。本来就没配置时什么也不做 */
export async function resetModelProvider(actor: CurrentMember) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const cleared = await tx.update(modelProviders).set({ baseUrl: null, model: null, apiKey: null, ...NO_PROBE, updatedAt: new Date() })
      .where(and(eq(modelProviders.tenantId, tenantId), isNotNull(modelProviders.baseUrl)))
      .returning({ tenantId: modelProviders.tenantId });
    if (cleared.length) await recordAudit(tx, { tenantId, actor, action: 'model_provider.reset', targetType: 'model_provider' });
  });
}

/** tools：模型是否支持工具调用（AI 助手要用，ADR-0042）；null 是这次没能确认（模型没调用探测工具，或临时故障） */
export type ConnectivityResult = { ok: true; model: string; durationMs: number; tools: boolean | null } | { ok: false; error: string };

const PING_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

const PING_TOOL = { name: 'ping', description: '连通性探测：收到请求就调用它', parameters: { type: 'object', properties: {} } };

/**
 * 带一个 ping 工具问一次：返回里有工具调用视为支持；模型服务拒绝这个请求（4xx，不含 429）视为不支持。调用日志里记一条 tool_probe。
 * 其余返回 null（不确定）：只回了文本（tool_choice 是 auto，支持工具调用的模型也可能不调用），或超时、连不上、5xx、429 这类临时故障。
 * 不确定的结果不存，免得一次误判就把助手停掉
 */
async function probeTools(tenantId: string): Promise<boolean | null> {
  try {
    return (await chatTools(tenantId, 'tool_probe', [{ role: 'user', content: '调用 ping 工具' }], [PING_TOOL])).toolCalls.length > 0 || null;
  } catch (e) {
    if (e instanceof LlmError) return e.transient ? null : false;
    throw e;
  }
}

/**
 * 用当前生效的配置发一次小请求；错误消息由 chatJson 抹掉了 Key，调用日志里记一条 connectivity。
 * 连通后再探测是否支持工具调用（不计入耗时），结果连同这次的端点与模型存下来（不确定时不存）（没有配置行时插入一行，端点、模型名与 Key 为空）
 */
export async function testModelProvider(actor: CurrentMember): Promise<ConnectivityResult> {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const provider = await resolveProvider(tenantId);
  const model = provider?.model ?? '';
  const started = Date.now();
  try {
    await chatJson(tenantId, 'connectivity', [{ role: 'user', content: '只回复 JSON：{"ok": true}' }], PING_SCHEMA);
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, error: e.message };
    throw e;
  }
  const durationMs = Date.now() - started;
  const tools = await probeTools(tenantId);
  if (tools !== null) {
    const probe = { toolsSupported: tools, toolsProbedBaseUrl: provider?.baseUrl ?? '', toolsProbedModel: model };
    await getDb().insert(modelProviders).values({ tenantId, ...probe })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: probe });
  }
  return { ok: true, model, durationMs, tools };
}

/**
 * 当前生效的模型服务是否支持工具调用：最近一次探测时的端点与模型和现在生效的一致才算数，
 * 否则（没探测过、改过配置、恢复了平台默认、平台默认换了）返回 null。没配置模型服务时也是 null
 */
export async function toolSupport(tenantId: string): Promise<boolean | null> {
  const row = await rowOf(tenantId);
  const source = providerSource(row);
  if (!source || row?.toolsSupported == null) return null;
  const current = source === 'tenant' ? { baseUrl: row.baseUrl, model: row.model ?? '' } : platformProvider();
  return row.toolsProbedBaseUrl === current.baseUrl && row.toolsProbedModel === current.model ? row.toolsSupported : null;
}

/** 是否允许把原始层的脱敏样本行发给模型服务（默认不允许）；没有配置行时插入一行，端点、模型名与 Key 为空。值没变时什么也不做 */
export async function setAllowSamples(actor: CurrentMember, allow: boolean) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  if (((await rowOf(tenantId))?.allowSamples ?? false) === allow) return;
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, allowSamples: allow })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { allowSamples: allow, updatedAt: new Date() } });
    await recordAudit(tx, { tenantId, actor, action: 'model_provider.updated', targetType: 'model_provider', detail: { allowSamples: allow } });
  });
}

/** 每张表发给模型几行样本 */
export const SAMPLE_ROWS = 5;

/**
 * 给模型的表上下文：表结构与最近一次采集的列统计；租户允许发送样本时附上原始层最近提交的 SAMPLE_ROWS 行（敏感列是加盐哈希、没有平台列）。
 * 数据湖没初始化、表还没同步时照常只给结构与统计，错误消息不往外带。表不在同步范围或还没采集过时报错
 */
export async function tableContextFor(tenantId: string, sourceId: string, tableName: string): Promise<TableContext> {
  const { tables } = await confirmedTables(tenantId, sourceId);
  const profile = tables.find(t => t.table.name === tableName)?.table;
  if (!profile) throw new Error(`表 ${tableName} 不在同步范围内或还没有采集`);
  if (!(await rowOf(tenantId))?.allowSamples) return buildTableContext(profile);
  const samples = await maskedSample(tenantId, sourceId, tableName, SAMPLE_ROWS).catch((e: unknown) => {
    if (e instanceof SourceViewError) return undefined;
    throw e;
  });
  return buildTableContext(profile, samples);
}

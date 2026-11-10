// app/.server/model-provider.ts —— 租户自己的模型服务配置（ADR-0035，仅管理员）：查看当前生效的来源、保存端点 / 模型名 / API Key、
// 恢复平台默认、测试连通性。API Key 用租户数据密钥加密（ADR-0009），读出来只告诉页面「已设置」，明文与密文都不出这个模块；
// 留空保存沿用原来的 Key，审计只记端点、模型名与是否轮换。是否发送脱敏样本也在这里开关，tableContextFor 按它组织给模型的表上下文。
// 测试连通性时的工具调用探测结果连同当时的端点、模型存下来（#531：存助手实际要用的 reasoning 档位那一套），toolSupport 给 AI 助手判断能不能用。
// embedding 端点（ADR-0049）自成一套同样的保存 / 恢复 / 测试，与 chat 互不影响；
// fast / reasoning 档位（ADR-0055 路由③a）是租户按用途绑的模型，只在 chat 三项整套生效时才有意义，保存 / 恢复同样在这里
import { and, eq, isNotNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { modelProviders } from './db/schema';
import { chatJson, chatTools, chatToolsWith, embed, embeddingSource, LlmError, MODEL_PROVIDER_CONTEXT, providerSource, resolveEmbeddingProvider, resolveProvider, resolveRoute, type LlmRoute } from './llm';
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
  /** embedding 端点（ADR-0049）自成一套，与 chat 互不影响：来源按 embeddingSource 另算，没有版本共用一个租户 */
  embedding: { source: 'tenant' | 'platform' | 'none'; baseUrl: string | null; model: string | null; apiKeySet: boolean };
  /** 档位（ADR-0055 路由③a）：租户按用途绑的模型。model 为空表示该档没绑定、用默认那一套；端点为空表示沿用本租户默认的端点与 Key */
  tiers: Record<'fast' | 'reasoning', { model: string | null; baseUrl: string | null; apiKeySet: boolean }>;
}

const rowOf = async (tenantId: string) =>
  (await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId)))[0];

/** 租户是否允许把脱敏样本行发给模型服务（默认否）；不查权限，给分析师发起的调用（如工作台结果解读）判断发什么 */
export const samplesAllowed = async (tenantId: string): Promise<boolean> => (await rowOf(tenantId))?.allowSamples ?? false;

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
    embedding: {
      source: embeddingSource(row) ?? 'none',
      baseUrl: row?.embeddingBaseUrl ?? null,
      model: row?.embeddingModel ?? null,
      apiKeySet: Boolean(row?.embeddingApiKey),
    },
    tiers: {
      fast: tierView(row, 'fast'),
      reasoning: tierView(row, 'reasoning'),
    },
  };
}

/** 行上某一档的三列：没绑定时 model 为 null，端点与 Key 为 null 表示沿用本租户默认的那一套 */
function tierOf(row: Awaited<ReturnType<typeof rowOf>> | undefined, tier: 'fast' | 'reasoning') {
  if (tier === 'fast') return { model: row?.fastModel ?? null, baseUrl: row?.fastBaseUrl ?? null, apiKey: row?.fastApiKey ?? null };
  return { model: row?.reasoningModel ?? null, baseUrl: row?.reasoningBaseUrl ?? null, apiKey: row?.reasoningApiKey ?? null };
}

/** 页面上某一档的显示：绑定的模型与端点，Key 只告诉有没有 */
function tierView(row: Awaited<ReturnType<typeof rowOf>> | undefined, tier: 'fast' | 'reasoning') {
  const t = tierOf(row, tier);
  return { model: t.model, baseUrl: t.baseUrl, apiKeySet: Boolean(t.apiKey) };
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
 * 决定 API Key 怎么存（chat 与 embedding 共用）：留空且端点没变就沿用密文，填了新值就加密保存并报轮换。
 * 第一次配置与改了端点时必须填 Key：否则拿到管理员会话就能把已存的 Key 发到自己的主机上（ADR-0035）
 */
async function sealApiKey(tenantId: string, existing: string | null, existingBaseUrl: string | null, baseUrl: string, apiKey: string) {
  if (!apiKey && !(existing && existingBaseUrl === baseUrl)) {
    throw new ModelProviderError(existing ? '改了端点须重新填写 API Key' : '第一次配置须填写 API Key');
  }
  const previous = existing ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, existing)).apiKey : null;
  const rotated = Boolean(apiKey) && apiKey !== previous;
  // 没轮换时 existing 一定有：留空要求沿用，填了同一个值说明原来就有
  return { sealed: rotated ? await encryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, { apiKey }) : existing ?? null, rotated };
}

/**
 * 保存本租户的模型服务：apiKey 留空沿用原来的 Key，填了新值就加密保存并在审计里记轮换
 */
export async function saveModelProvider(actor: CurrentMember, input: { baseUrl: string; model: string; apiKey: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const baseUrl = parseBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const row = await rowOf(tenantId);
  const { sealed, rotated } = await sealApiKey(tenantId, row?.apiKey ?? null, row?.baseUrl ?? null, baseUrl, input.apiKey.trim());
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

/** 保存本租户的 embedding 端点（ADR-0049）：Key 规则与 chat 相同；只写 embedding 三列，不动 chat 配置与工具调用探测结果 */
export async function saveEmbeddingProvider(actor: CurrentMember, input: { baseUrl: string; model: string; apiKey: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const baseUrl = parseBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const row = await rowOf(tenantId);
  const { sealed, rotated } = await sealApiKey(tenantId, row?.embeddingApiKey ?? null, row?.embeddingBaseUrl ?? null, baseUrl, input.apiKey.trim());
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, embeddingBaseUrl: baseUrl, embeddingModel: model, embeddingApiKey: sealed })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { embeddingBaseUrl: baseUrl, embeddingModel: model, embeddingApiKey: sealed, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { embedding: true, baseUrl, model, credentialsRotated: rotated },
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

/** 恢复 embedding 的平台默认（ADR-0049）：只清空 embedding 三列，chat 的配置与探测结果不动；本来就没配置时不记审计 */
export async function resetEmbeddingProvider(actor: CurrentMember) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const cleared = await tx.update(modelProviders).set({ embeddingBaseUrl: null, embeddingModel: null, embeddingApiKey: null, updatedAt: new Date() })
      .where(and(eq(modelProviders.tenantId, tenantId), isNotNull(modelProviders.embeddingBaseUrl)))
      .returning({ tenantId: modelProviders.tenantId });
    if (cleared.length) await recordAudit(tx, { tenantId, actor, action: 'model_provider.reset', targetType: 'model_provider', detail: { embedding: true } });
  });
}

/** 只写某一档三列（保存与恢复共用），别的列一律不动 */
function tierColumns(tier: 'fast' | 'reasoning', values: { model: string | null; baseUrl: string | null; apiKey: string | null }) {
  return tier === 'fast'
    ? { fastModel: values.model, fastBaseUrl: values.baseUrl, fastApiKey: values.apiKey }
    : { reasoningModel: values.model, reasoningBaseUrl: values.baseUrl, reasoningApiKey: values.apiKey };
}

/**
 * 保存某一档绑定的模型（ADR-0055 路由③a）：模型名必填，只写该档三列，chat 与另一档的配置、工具调用探测结果都不动。
 * 档位只在 chat 三项整套生效时才有意义，本租户还没有自己的模型服务时 400。端点留空表示沿用本租户默认的端点与 Key（都存 null）；
 * 填了端点就按 chat 的规则要 Key（同一个加密 context），端点与 Key 必须一起填
 */
export async function saveTierProvider(actor: CurrentMember, tier: 'fast' | 'reasoning', input: { baseUrl: string; model: string; apiKey: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const row = await rowOf(tenantId);
  if (!row?.baseUrl || !row.model || !row.apiKey) throw new ModelProviderError('先保存本租户的模型服务后才能按用途配置档位');
  let baseUrl: string | null = null;
  let sealed: string | null = null;
  let rotated = false;
  if (input.baseUrl.trim()) {
    baseUrl = parseBaseUrl(input.baseUrl);
    const stored = tierOf(row, tier);
    ({ sealed, rotated } = await sealApiKey(tenantId, stored.apiKey, stored.baseUrl, baseUrl, input.apiKey.trim()));
  } else if (input.apiKey.trim()) {
    throw new ModelProviderError('填了 API Key 须同时填写端点；端点留空表示沿用本租户的端点与 Key');
  }
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, ...tierColumns(tier, { model, baseUrl, apiKey: sealed }) })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { ...tierColumns(tier, { model, baseUrl, apiKey: sealed }), updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { tier, baseUrl, model, credentialsRotated: rotated },
    });
  });
}

/** 恢复该档的默认（不再绑定）：只清该档三列，chat 与另一档、工具调用探测结果都不动；本来就没绑定时不记审计 */
export async function resetTierProvider(actor: CurrentMember, tier: 'fast' | 'reasoning') {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const modelColumn = tier === 'fast' ? modelProviders.fastModel : modelProviders.reasoningModel;
  await getDb().transaction(async tx => {
    const cleared = await tx.update(modelProviders).set({ ...tierColumns(tier, { model: null, baseUrl: null, apiKey: null }), updatedAt: new Date() })
      .where(and(eq(modelProviders.tenantId, tenantId), isNotNull(modelColumn)))
      .returning({ tenantId: modelProviders.tenantId });
    if (cleared.length) await recordAudit(tx, { tenantId, actor, action: 'model_provider.reset', targetType: 'model_provider', detail: { tier } });
  });
}

/** tools：模型是否支持工具调用（AI 助手要用，ADR-0042）；null 是这次没能确认（模型没调用探测工具，或临时故障） */
export type ConnectivityResult = { ok: true; model: string; durationMs: number; tools: boolean | null } | { ok: false; error: string };

const PING_SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

const PING_TOOL = { name: 'ping', description: '连通性探测：收到请求就调用它', parameters: { type: 'object', properties: {} } };

/**
 * 带一个 ping 工具问一次：返回里有工具调用视为支持；模型服务拒绝这个请求（4xx，不含 429）视为不支持。调用日志里记一条 tool_probe。
 * 传入 route（#531，探测 reasoning 档位的模型）时经 chatToolsWith 用那一套发、日志 route 记档位；没传时用解析出的默认那一套。
 * 其余返回 null（不确定）：只回了文本（tool_choice 是 auto，支持工具调用的模型也可能不调用），或超时、连不上、5xx、429 这类临时故障。
 * 不确定的结果不存，免得一次误判就把助手停掉
 */
async function probeTools(tenantId: string, route?: LlmRoute): Promise<boolean | null> {
  const ask = [{ role: 'user' as const, content: '调用 ping 工具' }];
  try {
    const reply = route
      ? await chatToolsWith(tenantId, 'tool_probe', route, ask, [PING_TOOL])
      : await chatTools(tenantId, 'tool_probe', ask, [PING_TOOL]);
    return reply.toolCalls.length > 0 || null;
  } catch (e) {
    if (e instanceof LlmError) return e.transient ? null : false;
    throw e;
  }
}

/**
 * 用当前生效的配置发一次小请求；错误消息由 chatJson 抹掉了 Key，调用日志里记一条 connectivity。
 * 连通后再探测是否支持工具调用（不计入耗时），结果连同这次的端点与模型存下来（不确定时不存）（没有配置行时插入一行，端点、模型名与 Key 为空）。
 * reasoning 档位绑定了不同模型时（#531；平台与租户档位都会，租户档位自路由③b 起生效）再探一次档位模型：三列里存的是助手实际要用的那一套的结果
 * （没有不同模型时就是默认这一套），返回给页面的 tools 仍显示默认这一次的
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
  let probe = tools !== null ? { toolsSupported: tools, toolsProbedBaseUrl: provider?.baseUrl ?? '', toolsProbedModel: model } : null;
  const tier = await resolveRoute(tenantId, 'assistant');
  if (tier && (tier.provider.baseUrl !== provider?.baseUrl || tier.provider.model !== model)) {
    const tierTools = await probeTools(tenantId, tier);
    probe = tierTools !== null ? { toolsSupported: tierTools, toolsProbedBaseUrl: tier.provider.baseUrl, toolsProbedModel: tier.provider.model } : null;
  }
  if (probe) {
    await getDb().insert(modelProviders).values({ tenantId, ...probe })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: probe });
  }
  return { ok: true, model, durationMs, tools };
}

/** 测试 embedding：向量维度是第一条样例的长度 */
export type EmbeddingTestResult = { ok: true; model: string; dimensions: number; durationMs: number } | { ok: false; error: string };

/**
 * 用当前生效的 embedding 配置发一条样例文本（embed 自己记 purpose=embedding 的调用日志），显示模型、维度与耗时。
 * 错误消息由 embed 抹掉了 Key；不写探测结果、不改配置行。租户与平台都没配置时说明原因、不发请求
 */
export async function testEmbeddingProvider(actor: CurrentMember): Promise<EmbeddingTestResult> {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const model = (await resolveEmbeddingProvider(tenantId))?.model ?? '';
  const started = Date.now();
  let vectors: number[][] | null;
  try {
    vectors = await embed(tenantId, ['连通测试']);
  } catch (e) {
    if (e instanceof LlmError) return { ok: false, error: e.message };
    throw e;
  }
  if (!vectors) return { ok: false, error: '没有可用的 embedding 配置：平台没有配置默认，请先填写' };
  return { ok: true, model, dimensions: vectors[0].length, durationMs: Date.now() - started };
}

/**
 * 助手实际要用的模型服务是否支持工具调用（#531，按 reasoning 档位比对）：最近一次探测时的端点与模型和
 * resolveRoute(tenantId, 'assistant') 解析出的一致才算数，否则（没探测过、改过配置、恢复了平台默认、
 * 平台默认或档位换了模型）返回 null。没配置模型服务、没探测过时也是 null。route 由助手一轮开始时传入，
 * 与本轮用的同一套；其他调用方不传、在这里解析
 */
export async function toolSupport(tenantId: string, route?: LlmRoute): Promise<boolean | null> {
  const row = await rowOf(tenantId);
  if (row?.toolsSupported == null) return null;
  const { provider } = route ?? await resolveRoute(tenantId, 'assistant') ?? {};
  if (!provider) return null;
  return row.toolsProbedBaseUrl === provider.baseUrl && row.toolsProbedModel === provider.model ? row.toolsSupported : null;
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

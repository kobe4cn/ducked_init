// app/.server/model-provider.ts —— 租户自己的模型服务配置（ADR-0035，仅管理员）：查看当前生效的来源、保存端点 / 模型名 / API Key、
// 恢复平台默认、测试连通性。API Key 用租户数据密钥加密（ADR-0009），读出来只告诉页面「已设置」，明文与密文都不出这个模块；
// 留空保存沿用原来的 Key，审计只记端点、模型名与是否轮换。是否发送脱敏样本也在这里开关，tableContextFor 按它组织给模型的表上下文。
// 测试连通性时的工具调用探测结果连同当时的端点、模型存下来（#531：存助手实际要用的 reasoning 档位那一套），toolSupport 给 AI 助手判断能不能用。
// embedding 端点（ADR-0049）自成一套同样的保存 / 恢复 / 测试，与 chat 互不影响；
// fast / reasoning 档位（ADR-0055 路由③a）是租户按用途绑的模型，只在 chat 三项整套生效时才有意义，保存 / 恢复同样在这里
// 向量存储（ADR-0058，#848）也在这里：选平台库还是外部 pgvector、连接串加密保存（context vector_store，不回显），
// 保存时先测连通失败不保存；切换存储后的清理与补算也在保存后触发（#849-1：embeddings.ts 按这里的选型解析存储）
// 向量补算的最近结果（#1172 写）在这里给页面看；改 embedding 配置或向量存储时清空，补算退避立即失效（#1173）
// 服务商参数（#1169）：租户默认与 fast / reasoning 档位各存一份 JSON 对象原文，不是密钥、页面回显，审计只记变没变
import { and, eq, isNotNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { embedBatchSize, ensureEmbeddings } from './catalog/embeddings';
import { preparePgvector, redactUrl } from './catalog/vector-store-pgvector';
import { platformStore } from './catalog/vector-store';
import { getDb } from './db/client';
import { modelProviders } from './db/schema';
import { CHAT_EXTRA_PROTECTED, chatJson, chatTools, chatToolsWith, embed, embeddingSource, LlmError, MODEL_PROVIDER_CONTEXT, parseChatExtraObject, providerSource, resolveEmbeddingProvider, resolveProvider, resolveRoute, type LlmRoute } from './llm';
import { buildTableContext, type TableContext } from './pipeline/llm-context';
import { formatServer } from './i18n';
import { decryptForTenant, encryptForTenant } from './secrets';
import { maskedSample, SourceViewError } from './source-views';
import { confirmedTables } from './sources';
import { msg } from '~/lib/i18n';

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
  /** 租户默认的服务商参数原文（#1169），没填为 null */
  chatExtra: string | null;
  allowSamples: boolean;
  /** embedding 端点（ADR-0049）自成一套，与 chat 互不影响：来源按 embeddingSource 另算，没有版本共用一个租户 */
  /** fill：最近一次向量补算的结果（#1172 写、#1173 显示）；error 已脱敏，非空即失败；从未补算过为 null */
  embedding: {
    source: 'tenant' | 'platform' | 'none'; baseUrl: string | null; model: string | null; apiKeySet: boolean;
    fill: { at: string | null; error: string | null } | null;
  };
  /** 档位（ADR-0055 路由③a）：租户按用途绑的模型。model 为空表示该档没绑定、用默认那一套；端点为空表示沿用本租户默认的端点与 Key */
  tiers: Record<'fast' | 'reasoning', { model: string | null; baseUrl: string | null; apiKeySet: boolean; chatExtra: string | null }>;
  /** 向量存储（ADR-0058，#848）：当前选的库与最近一次连通检查；连接串只告诉页面有没有，明文与密文都不出这个模块 */
  vectorStore: { kind: 'platform' | 'pgvector'; urlSet: boolean; checkedAt: string | null; error: string | null };
}

/** 清空最近一次补算的结果（#1173）：改了 embedding 配置或向量存储后退避立即失效，下一次检索就入队补算 */
const NO_FILL = { embeddingFillError: null, embeddingFillAt: null };

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
    chatExtra: row?.chatExtra ?? null,
    allowSamples: row?.allowSamples ?? false,
    embedding: {
      source: embeddingSource(row) ?? 'none',
      baseUrl: row?.embeddingBaseUrl ?? null,
      model: row?.embeddingModel ?? null,
      apiKeySet: Boolean(row?.embeddingApiKey),
      fill: row?.embeddingFillError || row?.embeddingFillAt
        ? { at: row.embeddingFillAt?.toISOString() ?? null, error: row.embeddingFillError ?? null }
        : null,
    },
    tiers: {
      fast: tierView(row, 'fast'),
      reasoning: tierView(row, 'reasoning'),
    },
    vectorStore: {
      kind: row?.vectorStore ?? 'platform',
      urlSet: Boolean(row?.vectorStoreUrl),
      checkedAt: row?.vectorStoreCheckedAt?.toISOString() ?? null,
      error: row?.vectorStoreError ?? null,
    },
  };
}

/** 行上某一档的四列：没绑定时 model 为 null，端点与 Key 为 null 表示沿用本租户默认的那一套，服务商参数为 null 表示继承租户默认的 */
function tierOf(row: Awaited<ReturnType<typeof rowOf>> | undefined, tier: 'fast' | 'reasoning') {
  if (tier === 'fast') {
    return { model: row?.fastModel ?? null, baseUrl: row?.fastBaseUrl ?? null, apiKey: row?.fastApiKey ?? null, chatExtra: row?.fastChatExtra ?? null };
  }
  return { model: row?.reasoningModel ?? null, baseUrl: row?.reasoningBaseUrl ?? null, apiKey: row?.reasoningApiKey ?? null, chatExtra: row?.reasoningChatExtra ?? null };
}

/** 页面上某一档的显示：绑定的模型与端点，Key 只告诉有没有 */
function tierView(row: Awaited<ReturnType<typeof rowOf>> | undefined, tier: 'fast' | 'reasoning') {
  const t = tierOf(row, tier);
  return { model: t.model, baseUrl: t.baseUrl, apiKeySet: Boolean(t.apiKey), chatExtra: t.chatExtra };
}

/**
 * 校验要保存的服务商参数（#1169）：undefined 表示这次不改（返回 undefined），空白存 null；
 * 否则须是 JSON 对象且不含平台字段（CHAT_EXTRA_PROTECTED，调用时本来也会删掉，这里直接报错免得管理员以为生效了），存原文
 */
function parseChatExtra(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) return null;
  const parsed = parseChatExtraObject(value);
  if (!parsed) {
    throw new ModelProviderError(formatServer('zh-CN', msg('服务商参数须是 JSON 对象，如 {example}', { example: '{"enable_thinking": false}' })));
  }
  const protectedKeys = CHAT_EXTRA_PROTECTED.filter(k => Object.hasOwn(parsed, k));
  if (protectedKeys.length) {
    throw new ModelProviderError(formatServer('zh-CN', msg('服务商参数不能包含平台字段：{keys}', { keys: protectedKeys.join(', ') })));
  }
  return value;
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
export async function saveModelProvider(actor: CurrentMember, input: { baseUrl: string; model: string; apiKey: string; chatExtra?: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const baseUrl = parseBaseUrl(input.baseUrl);
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const chatExtra = parseChatExtra(input.chatExtra);
  const row = await rowOf(tenantId);
  const extra = chatExtra === undefined ? {} : { chatExtra };
  const chatExtraChanged = chatExtra !== undefined && chatExtra !== (row?.chatExtra ?? null);
  const { sealed, rotated } = await sealApiKey(tenantId, row?.apiKey ?? null, row?.baseUrl ?? null, baseUrl, input.apiKey.trim());
  // 端点或模型变了，旧的工具调用探测结果作废
  const probe = row?.baseUrl === baseUrl && row.model === model ? {} : NO_PROBE;
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, baseUrl, model, apiKey: sealed, ...extra })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { baseUrl, model, apiKey: sealed, ...extra, ...probe, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { baseUrl, model, credentialsRotated: rotated, chatExtraChanged },
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
    await tx.insert(modelProviders).values({ tenantId, embeddingBaseUrl: baseUrl, embeddingModel: model, embeddingApiKey: sealed, ...NO_FILL })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { embeddingBaseUrl: baseUrl, embeddingModel: model, embeddingApiKey: sealed, ...NO_FILL, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { embedding: true, baseUrl, model, credentialsRotated: rotated },
    });
  });
}

/** 恢复平台默认：清空端点、模型名、Key、服务商参数与工具调用探测结果（是否允许发送样本行保留），之后 resolveProvider 回到环境变量的配置。本来就没配置时什么也不做 */
export async function resetModelProvider(actor: CurrentMember) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  await getDb().transaction(async tx => {
    const cleared = await tx.update(modelProviders).set({ baseUrl: null, model: null, apiKey: null, chatExtra: null, ...NO_PROBE, updatedAt: new Date() })
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
    // 走平台 embedding 的租户补算时也会建行：补算状态不论有没有租户配置都清空，下一次检索不再退避（#1173）；不动 updatedAt、不另记审计
    await tx.update(modelProviders).set(NO_FILL).where(eq(modelProviders.tenantId, tenantId));
    if (cleared.length) await recordAudit(tx, { tenantId, actor, action: 'model_provider.reset', targetType: 'model_provider', detail: { embedding: true } });
  });
}

/** 只写某一档的列（保存与恢复共用），别的列一律不动；chatExtra 为 undefined 时不写服务商参数那一列 */
function tierColumns(tier: 'fast' | 'reasoning', values: { model: string | null; baseUrl: string | null; apiKey: string | null; chatExtra?: string | null }) {
  const extra = values.chatExtra === undefined ? {} : tier === 'fast' ? { fastChatExtra: values.chatExtra } : { reasoningChatExtra: values.chatExtra };
  return tier === 'fast'
    ? { fastModel: values.model, fastBaseUrl: values.baseUrl, fastApiKey: values.apiKey, ...extra }
    : { reasoningModel: values.model, reasoningBaseUrl: values.baseUrl, reasoningApiKey: values.apiKey, ...extra };
}

/**
 * 保存某一档绑定的模型（ADR-0055 路由③a）：模型名必填，只写该档的列，chat 与另一档的配置、工具调用探测结果都不动。
 * 档位只在 chat 三项整套生效时才有意义，本租户还没有自己的模型服务时 400。端点留空表示沿用本租户默认的端点与 Key（都存 null）；
 * 填了端点就按 chat 的规则要 Key（同一个加密 context），端点与 Key 必须一起填
 */
export async function saveTierProvider(actor: CurrentMember, tier: 'fast' | 'reasoning', input: { baseUrl: string; model: string; apiKey: string; chatExtra?: string }) {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const model = input.model.trim();
  if (!model) throw new ModelProviderError('请填写模型名');
  const chatExtra = parseChatExtra(input.chatExtra);
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
  const columns = tierColumns(tier, { model, baseUrl, apiKey: sealed, chatExtra });
  const chatExtraChanged = chatExtra !== undefined && chatExtra !== tierOf(row, tier).chatExtra;
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, ...columns })
      .onConflictDoUpdate({ target: modelProviders.tenantId, set: { ...columns, updatedAt: new Date() } });
    await recordAudit(tx, {
      tenantId, actor,
      action: 'model_provider.updated',
      targetType: 'model_provider',
      detail: { tier, baseUrl, model, credentialsRotated: rotated, chatExtraChanged },
    });
  });
}

/** 恢复该档的默认（不再绑定）：只清该档的列（含服务商参数），chat 与另一档、工具调用探测结果都不动；本来就没绑定时不记审计 */
export async function resetTierProvider(actor: CurrentMember, tier: 'fast' | 'reasoning') {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const modelColumn = tier === 'fast' ? modelProviders.fastModel : modelProviders.reasoningModel;
  await getDb().transaction(async tx => {
    const cleared = await tx.update(modelProviders).set({ ...tierColumns(tier, { model: null, baseUrl: null, apiKey: null, chatExtra: null }), updatedAt: new Date() })
      .where(and(eq(modelProviders.tenantId, tenantId), isNotNull(modelColumn)))
      .returning({ tenantId: modelProviders.tenantId });
    if (cleared.length) await recordAudit(tx, { tenantId, actor, action: 'model_provider.reset', targetType: 'model_provider', detail: { tier } });
  });
}

/** 向量存储保存 / 测试的结果：失败时 error 已由 preparePgvector 抹掉连接串与密码，可以直接给页面显示 */
export type VectorStoreResult = { ok: true } | { ok: false; error: string };

/** 向量存储连接串的加密 context（ADR-0058；与 API Key 的 model_provider 分开，用途不同不共用） */
const VECTOR_STORE_CONTEXT = 'vector_store';

/**
 * 保存向量存储的选型（ADR-0058，#848）：选外部 pgvector 时连接串整串加密保存（不回显，留空沿用已存的密文；主机只能通过填新连接串来改，
 * 规则同 sealApiKey）。保存前先在事务外调 preparePgvector 测连通并建表，失败不写库、把抹过凭据的错误返回给页面显示。
 * 选 platform 时忽略表单里的连接串、不测连通，url / checked_at / error 三列原样保留（切回时不丢配置，方便撤回）。
 * 审计只记 from / to / urlRotated；存储没换且连接串也没换时不记。「测试连接」不在这里，见 testVectorStore。
 * 事务提交后处理存储切换（ADR-0058，#849-1）：切到 pgvector 时清掉本租户在平台表的行并入队从零补算（换连接串同样入队）；
 * 切回 platform 时外部库的行不删、平台表入队补算。清理与补算失败只打日志，不让保存失败
 */
export async function saveVectorStore(actor: CurrentMember, input: { kind: string; url: string }): Promise<VectorStoreResult> {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  if (input.kind !== 'platform' && input.kind !== 'pgvector') throw new ModelProviderError('向量存储须是「系统自带」或「外部 pgvector」');
  const row = await rowOf(tenantId);
  const from = row?.vectorStore ?? 'platform';
  const existingUrl = row?.vectorStoreUrl ? (await decryptForTenant(tenantId, VECTOR_STORE_CONTEXT, row.vectorStoreUrl)).url : null;
  const filled = input.url.trim();
  if (input.kind === 'platform') {
    if (from === 'platform') return { ok: true }; // 什么都没变，不写库也不记审计（同 setAllowSamples）
    await getDb().transaction(async tx => {
      await tx.insert(modelProviders).values({ tenantId, vectorStore: 'platform', ...NO_FILL })
        .onConflictDoUpdate({ target: modelProviders.tenantId, set: { vectorStore: 'platform', ...NO_FILL, updatedAt: new Date() } });
      await recordAudit(tx, { tenantId, actor, action: 'model_provider.vector_store_updated', targetType: 'model_provider', detail: { from, to: 'platform', urlRotated: false } });
    });
    // 切回「系统自带」（ADR-0058）：外部库的行保留不删（租户自己的库），平台表入队从零补算。
    // 补算在事务提交之后、失败只打日志——配置已经保存，不该让保存失败；没配 embedding 时 ensureEmbeddings 返回 off、不入队，是对的
    await ensureEmbeddings(tenantId)
      .catch(e => console.warn('切回系统向量库后入队补算失败', tenantId, e instanceof Error ? e.message : e));
    return { ok: true };
  }
  // 外部 pgvector：先校验连接串（文案不带原串），拿到要用的 url 再去测连通
  let url: string;
  if (filled) {
    let parsed: URL;
    try {
      parsed = new URL(filled);
    } catch {
      throw new ModelProviderError('连接串须是 postgres:// 或 postgresql:// 开头的完整地址');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new ModelProviderError('连接串须是 postgres:// 或 postgresql:// 开头的完整地址');
    url = filled;
  } else if (existingUrl) {
    url = existingUrl; // 留空沿用已存的密文（改主机只能通过填新连接串）
  } else {
    throw new ModelProviderError('第一次选择外部 pgvector 须填写连接串');
  }
  const prepared = await preparePgvector(url);
  if (!prepared.ok) return prepared; // 不写库：设置与实际可用保持一致（ADR-0058）
  const urlRotated = Boolean(filled) && filled !== existingUrl;
  const sealed = urlRotated ? await encryptForTenant(tenantId, VECTOR_STORE_CONTEXT, { url }) : row?.vectorStoreUrl ?? null;
  await getDb().transaction(async tx => {
    await tx.insert(modelProviders).values({ tenantId, vectorStore: 'pgvector', vectorStoreUrl: sealed, vectorStoreCheckedAt: new Date(), vectorStoreError: null, ...NO_FILL })
      .onConflictDoUpdate({
        target: modelProviders.tenantId,
        set: { vectorStore: 'pgvector', vectorStoreUrl: sealed, vectorStoreCheckedAt: new Date(), vectorStoreError: null, ...NO_FILL, updatedAt: new Date() },
      });
    if (from !== 'pgvector' || urlRotated) {
      await recordAudit(tx, { tenantId, actor, action: 'model_provider.vector_store_updated', targetType: 'model_provider', detail: { from, to: 'pgvector', urlRotated } });
    }
  });
  // 存储切换的清理与补算都在事务提交之后（ADR-0058：外部库和平台表清理都进不了平台事务），失败只打日志（不带连接串）——配置已经保存
  if (from === 'platform') {
    // 切到外部库：删掉本租户在平台表里的全部行，再入队 catalog.embed 从零补算
    await platformStore(tenantId).clear()
      .catch(e => console.warn('切到外部向量库后清理平台表失败', tenantId, e instanceof Error ? e.message : e));
    await ensureEmbeddings(tenantId)
      .catch(e => console.warn('切到外部向量库后入队补算失败', tenantId, redactUrl(e instanceof Error ? e.message : String(e), url)));
  } else if (urlRotated) {
    // 换了连接串：新库是空的，入队从零补算（ensureEmbeddings 会先看缺多少，不缺就不入队）
    await ensureEmbeddings(tenantId)
      .catch(e => console.warn('更换外部向量库连接串后入队补算失败', tenantId, redactUrl(e instanceof Error ? e.message : String(e), url)));
  }
  return { ok: true };
}

/**
 * 用已存的连接串测外部 pgvector 连通（不换配置）：结果写进 vector_store_checked_at / vector_store_error，页面显示上次检查时间与状态。
 * 还没配置连接串时直接失败、不发起连接。照 embedding 的测试，不记审计
 */
export async function testVectorStore(actor: CurrentMember): Promise<VectorStoreResult> {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const row = await rowOf(tenantId);
  if (!row?.vectorStoreUrl) return { ok: false, error: '还没有配置外部 pgvector 连接串' };
  const result = await preparePgvector((await decryptForTenant(tenantId, VECTOR_STORE_CONTEXT, row.vectorStoreUrl)).url);
  // 只写检查结果两列：配置没改，不动 updated_at（同工具调用探测的写法）
  await getDb().update(modelProviders)
    .set({ vectorStoreCheckedAt: new Date(), vectorStoreError: result.ok ? null : result.error })
    .where(eq(modelProviders.tenantId, tenantId));
  return result;
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
 * 用当前生效的 embedding 配置发一批样例文本（条数等于补算的批大小 embedBatchSize，内容短、互不相同；embed 自己记 purpose=embedding 的调用日志），显示模型、维度与耗时。
 * 发满一批是为了让服务商的批大小上限（如 DashScope v3/v4 的 10 条）在测试时就暴露，而不是到后台补算才失败。
 * 错误消息由 embed 抹掉了 Key；不写探测结果、不改配置行。租户与平台都没配置时说明原因、不发请求
 */
export async function testEmbeddingProvider(actor: CurrentMember): Promise<EmbeddingTestResult> {
  assertCan(actor, 'model_provider:manage');
  const tenantId = actor.tenant.id;
  const model = (await resolveEmbeddingProvider(tenantId))?.model ?? '';
  const started = Date.now();
  let vectors: number[][] | null;
  try {
    vectors = await embed(tenantId, Array.from({ length: embedBatchSize() }, (_, i) => `连通测试 ${i + 1}`));
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

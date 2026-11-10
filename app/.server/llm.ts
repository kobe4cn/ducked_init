// app/.server/llm.ts —— 模型服务客户端（ADR-0003、ADR-0035）。模型只在设计时产出草稿：调用 OpenAI 兼容的 /chat/completions，
// 要求返回 JSON 对象并按调用方给的 JSON Schema 校验，不合格就报错，不把半成品交给调用方。
// 端点按「租户自己的配置（platform.model_providers，Key 用租户数据密钥加密）> 平台默认（环境变量 LLM_*）」整套选取，不混用。
// 在选出的一套上按用途分档（ADR-0055）：PURPOSE_TIER 写死每个用途属 fast / reasoning 哪档，平台档位用 LLM_<TIER>_* 环境变量换模型，
// 租户整套自配时读租户自己的档位列（只填模型沿用租户默认端点与 Key，带端点用档位自己的 Key），平台档位不生效；
// 档位没绑定模型就回落默认并记 fallbackReason='unbound'。
// chatTools 带工具调用模型（AI 助手，ADR-0042），不要求 JSON。
// embed（ADR-0049）走可选的 embedding 端点：租户的 embedding 三项 > 平台环境变量 LLM_EMBEDDING_*，与 chat 互不影响；
// 都没配置时返回 null（不发请求、不记日志），调用方只走关键词检索。
// chatJson 与 chatTools 的每次调用（成功、HTTP 失败、校验失败）都在 platform.llm_calls 记一行：用途、模型、令牌数、耗时、校验结果与错误摘要，不存提示词与返回原文；评测命令用不查库、不记日志的 callModel
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { llmCalls, modelProviders } from './db/schema';
import { decryptForTenant } from './secrets';

/** 调用的用途，记进调用日志 */
export type LlmPurpose = 'connectivity' | 'tool_probe' | 'assistant' | 'mapping_draft' | 'metric_draft' | 'tag_draft' | 'assertion_draft'
  | 'workbench_draft' | 'workbench_interpret' | 'knowledge_proposal' | 'knowledge_import' | 'metric_parse' | 'embedding';

/** 每个用途属于哪一档（ADR-0055）：写死在这里，不进库。null 的用途不分档，永远用解析出的那一套 provider */
export const PURPOSE_TIER: Record<LlmPurpose, 'fast' | 'reasoning' | null> = {
  assistant: 'reasoning', mapping_draft: 'reasoning', metric_draft: 'reasoning', tag_draft: 'reasoning', workbench_draft: 'reasoning',
  assertion_draft: 'fast', workbench_interpret: 'fast', knowledge_proposal: 'fast', knowledge_import: 'fast', metric_parse: 'fast',
  connectivity: null, tool_probe: null, embedding: null,
};

/** 对话里的一条消息（OpenAI 兼容格式）：assistant 要调用工具时带 tool_calls（content 可为空串），工具结果是 role 为 tool、带 tool_call_id 的一条 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmProvider { baseUrl: string; model: string; apiKey: string; source: 'tenant' | 'platform' }

/** transient：超时、连不上、HTTP 5xx 或 429，过一会儿再试可能就好了 */
export class LlmError extends Error {
  constructor(message: string, readonly transient = false) { super(message); }
}

/** 租户 API Key 的加密 context（ADR-0009），解密时须给出同一个 */
export const MODEL_PROVIDER_CONTEXT = 'model_provider';

const TIMEOUT_MS = 60_000;

let fetchOverride: typeof fetch | undefined;

/** 测试通过它注入假 fetch；传 undefined 恢复真实 fetch */
export function setLlmFetch(f: typeof fetch | undefined) { fetchOverride = f; }

const llmFetch = () => fetchOverride ?? fetch;

/** 选哪一套：租户填了端点就整套用租户的，否则三个环境变量都有才用平台默认；都没有返回 null。不解密，模型服务页也用它 */
export function providerSource(row: { baseUrl: string | null } | undefined): LlmProvider['source'] | null {
  if (row?.baseUrl) return 'tenant';
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = process.env;
  return LLM_BASE_URL && LLM_MODEL && LLM_API_KEY ? 'platform' : null;
}

/** 平台默认的端点、模型与 Key（环境变量 LLM_*）；只在三个变量都有时调用 */
export const platformProvider = (): LlmProvider =>
  ({ baseUrl: process.env.LLM_BASE_URL!, model: process.env.LLM_MODEL!, apiKey: process.env.LLM_API_KEY!, source: 'platform' });

/** 行上某一档的三列（与 model-provider.ts 的 tierOf 同样的取法，不 import 它：那边已 import 本文件，反向会循环）：
 *  没绑定时 model 为 null，端点与 Key 为 null 表示沿用本租户默认的那一套 */
function tierOf(row: typeof modelProviders.$inferSelect | undefined, tier: 'fast' | 'reasoning') {
  if (tier === 'fast') return { model: row?.fastModel ?? null, baseUrl: row?.fastBaseUrl ?? null, apiKey: row?.fastApiKey ?? null };
  return { model: row?.reasoningModel ?? null, baseUrl: row?.reasoningBaseUrl ?? null, apiKey: row?.reasoningApiKey ?? null };
}

/** 查一次 modelProviders 行并按 providerSource 算出那一套 provider（租户的 Key 解密后返回）；都没有时 provider 为 null。
 *  resolveProvider 与 resolveRoute 共用它，各自不再查第二次库 */
async function providerRow(tenantId: string): Promise<{ row: typeof modelProviders.$inferSelect | undefined; provider: LlmProvider | null }> {
  const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  switch (providerSource(row)) {
    case 'tenant': {
      const apiKey = row.apiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.apiKey)).apiKey : '';
      return { row, provider: { baseUrl: row.baseUrl!, model: row.model ?? '', apiKey, source: 'tenant' } };
    }
    case 'platform':
      return { row, provider: platformProvider() };
    default:
      return { row, provider: null };
  }
}

/** 按 providerSource 选出的那一套端点、模型与 Key（租户的 Key 解密后返回）；都没有返回 null */
export async function resolveProvider(tenantId: string): Promise<LlmProvider | null> {
  return (await providerRow(tenantId)).provider;
}

/** 按用途选档位的结果（ADR-0055）：route 是这次调用所属的档位（不分档为 null），fallbackReason 为 'unbound' 表示
 *  该档位没绑定模型、用了回落的那一套；provider.model 是实际要调的模型名 */
export interface LlmRoute { provider: LlmProvider; route: 'fast' | 'reasoning' | null; fallbackReason: 'unbound' | null }

/** 平台档位的某一项环境变量（LLM_<TIER>_*），空串算没填 */
const tierEnv = (tier: 'fast' | 'reasoning', suffix: 'MODEL' | 'BASE_URL' | 'API_KEY') => process.env[`LLM_${tier.toUpperCase()}_${suffix}`] || undefined;

/**
 * 解析一次调用走哪一档（ADR-0055）：先按 ADR-0035 选出整套 provider（都没有返回 null）。
 * 用途不分档时直接用那一套。租户整套自配时读租户自己的档位列、平台档位不生效：只填模型名沿用租户默认的端点与 Key，
 * 档位有自己的端点时用档位的端点与 Key（端点与 Key 须一起填，只填端点按没绑定处理并 console.warn，不把租户默认
 * Key 发到档位的端点）。平台默认时 LLM_<TIER>_MODEL 有值就把模型换成它；BASE_URL 与 API_KEY 必须一起填才用
 * 档位自己的端点与 Key（只填一个同样按没绑定处理并 console.warn），只填 MODEL 时端点与 Key 复用默认的。
 */
export async function resolveRoute(tenantId: string, purpose: LlmPurpose): Promise<LlmRoute | null> {
  const { row, provider } = await providerRow(tenantId);
  if (!provider) return null;
  const tier = PURPOSE_TIER[purpose];
  if (!tier) return { provider, route: null, fallbackReason: null };

  if (provider.source === 'tenant') {
    const { model, baseUrl, apiKey } = tierOf(row, tier);
    if (!model) return { provider, route: tier, fallbackReason: 'unbound' };
    if (!baseUrl) return { provider: { ...provider, model }, route: tier, fallbackReason: null };   // 只填模型名：沿用租户默认端点与 Key
    if (!apiKey) {
      // 保存校验（#605）不允许只填端点，这里只防脏数据：按没绑定处理，不把租户默认 Key 发到档位端点
      console.warn(`model_providers 的 ${tier} 档位有端点但没有 Key，按未绑定该档位处理`);
      return { provider, route: tier, fallbackReason: 'unbound' };
    }
    const decrypted = (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, apiKey)).apiKey;
    return { provider: { baseUrl, model, apiKey: decrypted, source: 'tenant' }, route: tier, fallbackReason: null };
  }

  const model = tierEnv(tier, 'MODEL');
  const baseUrl = tierEnv(tier, 'BASE_URL');
  const apiKey = tierEnv(tier, 'API_KEY');
  if ((baseUrl || apiKey) && !(baseUrl && apiKey)) {
    console.warn(`LLM_${tier.toUpperCase()}_BASE_URL 与 LLM_${tier.toUpperCase()}_API_KEY 要一起填才生效，现在按未配置档位处理`);
    return { provider, route: tier, fallbackReason: 'unbound' };
  }
  if (!model) return { provider, route: tier, fallbackReason: 'unbound' };
  return {
    provider: { baseUrl: baseUrl ?? provider.baseUrl, model, apiKey: apiKey ?? provider.apiKey, source: 'platform' },
    route: tier, fallbackReason: null,
  };
}

/** embedding 选哪一套（ADR-0049）：规则与 chat 的 providerSource 相同但互不影响——租户填了 embedding 端点就整套用租户的，
 *  否则三个 LLM_EMBEDDING_* 环境变量都有才用平台默认；都没有返回 null。导出给模型服务页显示当前来源（与 chat 的 providerSource 对称） */
export function embeddingSource(row: { embeddingBaseUrl: string | null } | undefined): LlmProvider['source'] | null {
  if (row?.embeddingBaseUrl) return 'tenant';
  const { LLM_EMBEDDING_BASE_URL, LLM_EMBEDDING_MODEL, LLM_EMBEDDING_API_KEY } = process.env;
  return LLM_EMBEDDING_BASE_URL && LLM_EMBEDDING_MODEL && LLM_EMBEDDING_API_KEY ? 'platform' : null;
}

/** 平台默认的 embedding 端点、模型与 Key（环境变量 LLM_EMBEDDING_*）；只在三个变量都有时调用。导出给评测脚本与测试直接用 */
export const platformEmbeddingProvider = (): LlmProvider =>
  ({ baseUrl: process.env.LLM_EMBEDDING_BASE_URL!, model: process.env.LLM_EMBEDDING_MODEL!, apiKey: process.env.LLM_EMBEDDING_API_KEY!, source: 'platform' });

/** 按 embeddingSource 选出的那一套端点、模型与 Key（租户的 Key 用与 chat 相同的 context 解密后返回）；都没配置返回 null */
export async function resolveEmbeddingProvider(tenantId: string): Promise<LlmProvider | null> {
  const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  switch (embeddingSource(row)) {
    case 'tenant': {
      const apiKey = row.embeddingApiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.embeddingApiKey)).apiKey : '';
      return { baseUrl: row.embeddingBaseUrl!, model: row.embeddingModel ?? '', apiKey, source: 'tenant' };
    }
    case 'platform':
      return platformEmbeddingProvider();
    default:
      return null;
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const compiledSchemas = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: object) {
  let v = compiledSchemas.get(schema);
  if (!v) compiledSchemas.set(schema, v = ajv.compile(schema));
  return v;
}

/** 一条校验错误的中文说明（常见的几种，其余用 ajv 的原文） */
function describeError(e: ErrorObject) {
  const p = e.params as Record<string, unknown>;
  const at = e.instancePath ? `${e.instancePath.slice(1).replaceAll('/', '.')}：` : '';
  switch (e.keyword) {
    case 'required': return `${at}缺少 ${p.missingProperty}`;
    case 'additionalProperties': return `${at}不认识的项 ${p.additionalProperty}`;
    case 'type': return `${at}应为 ${p.type}`;
    case 'enum': return `${at}应为以下之一：${(p.allowedValues as unknown[]).join('、')}`;
    default: return `${at}${e.message ?? e.keyword}`;
  }
}

/** 校验错误的中文摘要，最多列三条 */
const schemaErrors = (v: ValidateFunction) => (v.errors ?? []).slice(0, 3).map(describeError).join('；');

/** 一次调用的统计，调用日志用：令牌数与 Schema 校验结果（没走到校验时为 null） */
export interface CallStats { usage?: { prompt_tokens?: number; completion_tokens?: number }; schemaValid: boolean | null }

const maskKey = (apiKey: string, s: string) => (apiKey ? s.replaceAll(apiKey, '***') : s);

/** 跑 run，失败都转成 LlmError，消息里的 API Key 换成 ***；timeoutMs 只是超时消息里的秒数，中断本身由 postJson 的 AbortSignal 负责 */
async function masked<T>(apiKey: string, run: () => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new LlmError(maskKey(apiKey, e instanceof LlmError ? e.message
      : timedOut ? `模型服务 ${timeoutMs / 1000} 秒内没有返回`
      : `调用模型服务失败：${e instanceof Error ? e.message : String(e)}`), e instanceof LlmError ? e.transient : true);
  }
}

/** 返回里的 choices[0].message，字段都没校验 */
interface RawMessage { content?: unknown; tool_calls?: unknown }

/** POST 一个 JSON 请求到 {baseUrl}{path}（带 Bearer Key 与超时），非 2xx 抛 LlmError（5xx 与 429 算 transient），返回解析后的 JSON，不是 JSON 时返回 null */
async function postJson(provider: LlmProvider, path: string, payload: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const { baseUrl, apiKey } = provider;
  const res = await llmFetch()(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 先遮蔽再截断：Key 跨过截断处时半截 Key 就遮不住了
  if (!res.ok) throw new LlmError(`模型服务返回 HTTP ${res.status}：${maskKey(apiKey, await res.text()).slice(0, 200)}`, res.status >= 500 || res.status === 429);
  return res.json().catch(() => null);
}

/** 发一次 /chat/completions（payload 之外补上模型名与 temperature 0），返回 choices[0].message；令牌数填进 stats */
async function postChat(provider: LlmProvider, payload: Record<string, unknown>, stats: CallStats): Promise<RawMessage> {
  if (!provider.model) throw new LlmError('模型服务配置不完整：没有填写模型名');
  const body = await postJson(provider, '/chat/completions', { model: provider.model, ...payload, temperature: 0 }) as
    { choices?: { message?: RawMessage }[]; usage?: CallStats['usage'] } | null;
  stats.usage = body?.usage;
  return body?.choices?.[0]?.message ?? {};
}

/** 发一次 /embeddings（body 是模型名与输入文本），按 data[].index 排好序返回每条输入的向量；usage 的 prompt_tokens 填进 stats。
 *  返回里缺某条输入的向量时算失败，不把错位的向量交给调用方。检索的查询向量传更短的 timeoutMs（catalog/embeddings.ts） */
async function postEmbeddings(provider: LlmProvider, texts: string[], stats: CallStats, opts: { timeoutMs?: number } = {}): Promise<number[][]> {
  const body = await postJson(provider, '/embeddings', { model: provider.model, input: texts }, opts.timeoutMs) as
    { data?: { index?: unknown; embedding?: unknown }[]; usage?: CallStats['usage'] } | null;
  stats.usage = body?.usage;
  const byIndex = new Map<number, number[]>();
  for (const d of body?.data ?? []) {
    if (typeof d?.index === 'number' && Array.isArray(d.embedding) && d.embedding.every(v => typeof v === 'number')) byIndex.set(d.index, d.embedding);
  }
  if (!texts.every((_, i) => byIndex.has(i))) throw new LlmError(`模型服务的返回里没有全部 ${texts.length} 条输入的向量`);
  return texts.map((_, i) => byIndex.get(i)!);
}

/**
 * 用给定的端点调用模型，返回按 schema 校验过的 JSON。不查库、不记日志（评测命令直接用它，产品走 chatJson）。
 * 失败都抛 LlmError（消息里的 API Key 换成 ***，HTTP 错误只带状态码与前 200 字的响应体）；stats 由调用方传入时顺带填上令牌数与校验结果
 */
export async function callModel<T>(provider: LlmProvider, messages: LlmMessage[], schema: object, stats: CallStats = { schemaValid: null }): Promise<T> {
  return masked(provider.apiKey, async () => {
    const { content } = await postChat(provider, { messages, response_format: { type: 'json_object' } }, stats);
    if (typeof content !== 'string') throw new LlmError('模型服务的返回里没有 choices[0].message.content');
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new LlmError('模型返回的内容不是 JSON'); }
    const validate = validatorFor(schema);
    stats.schemaValid = validate(parsed);
    if (!stats.schemaValid) throw new LlmError(`模型返回的 JSON 不符合 Schema：${schemaErrors(validate)}`);
    return parsed as T;
  });
}

/** 给模型的一个工具：parameters 是输入的 JSON Schema */
export interface LlmTool { name: string; description: string; parameters: object }

/** 模型要调用的一个工具：arguments 是模型给的 JSON 文本，没解析 */
export interface LlmToolCall { id: string; name: string; arguments: string }

export interface ToolReply { content: string | null; toolCalls: LlmToolCall[] }

/**
 * 带工具调用模型（OpenAI 兼容的 tools + tool_choice: auto，不带 response_format：很多服务不接受两者同时出现），返回文本回复与要调用的工具。
 * 不查库、不记日志；失败与 callModel 一样抛抹掉 Key 的 LlmError，既没有文本也没有工具调用时也算失败
 */
export async function callTools(provider: LlmProvider, messages: LlmMessage[], tools: LlmTool[], stats: CallStats = { schemaValid: null }): Promise<ToolReply> {
  return masked(provider.apiKey, async () => {
    const message = await postChat(provider, {
      messages, tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto',
    }, stats);
    const raw = Array.isArray(message.tool_calls) ? message.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] : [];
    const toolCalls = raw.flatMap(c => typeof c?.function?.name === 'string' ? [{
      id: typeof c.id === 'string' ? c.id : '',
      name: c.function.name,
      arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
    }] : []);
    const content = typeof message.content === 'string' && message.content ? message.content : null;
    if (content === null && !toolCalls.length) throw new LlmError('模型服务的返回里既没有内容也没有工具调用');
    return { content, toolCalls };
  });
}

/**
 * 按租户与用途选档位（resolve，默认 chat 的 resolveRoute）后调用 call。没配置模型服务或没填模型名时直接报错、不发请求、不记日志；
 * 其余调用（成功或失败）都记日志，embedding 调用带上条数 inputCount。日志直接写平台库，不进调用方的事务：调用方回滚时调用记录也要留下
 */
async function logged<T>(tenantId: string, purpose: LlmPurpose, call: (provider: LlmProvider, stats: CallStats) => Promise<T>,
  resolve: (tenantId: string, purpose: LlmPurpose) => Promise<LlmRoute | null> = resolveRoute, inputCount: number | null = null): Promise<T> {
  const { provider, route, fallbackReason } = (await resolve(tenantId, purpose)) ?? {};
  if (!provider) throw new LlmError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务');
  const { model } = provider;
  if (!model) throw new LlmError('模型服务配置不完整：没有填写模型名');

  const started = Date.now();
  const stats: CallStats = { schemaValid: null };
  let error: string | null = null;
  try {
    return await call(provider, stats);
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    await getDb().insert(llmCalls).values({
      tenantId, purpose, model, schemaValid: stats.schemaValid, error, inputCount,
      // 档位与回落原因（ADR-0055）：route 是这次调用所属的档位，fallbackReason 为 'unbound' 表示该档位没绑定模型
      route, fallbackReason,
      promptTokens: stats.usage?.prompt_tokens ?? null, completionTokens: stats.usage?.completion_tokens ?? null,
      durationMs: Date.now() - started,
    }).catch(e => console.error('记录模型调用日志失败', e));
  }
}

/** 按租户的模型服务 callModel，记调用日志（logged） */
export const chatJson = <T>(tenantId: string, purpose: LlmPurpose, messages: LlmMessage[], schema: object): Promise<T> =>
  logged(tenantId, purpose, (provider, stats) => callModel<T>(provider, messages, schema, stats));

/** 按租户的模型服务 callTools，记调用日志（logged；schema_valid 为 null） */
export const chatTools = (tenantId: string, purpose: LlmPurpose, messages: LlmMessage[], tools: LlmTool[]): Promise<ToolReply> =>
  logged(tenantId, purpose, (provider, stats) => callTools(provider, messages, tools, stats));

/**
 * 按调用方解析好的档位路由（route）调 callTools 并记调用日志（口径同 chatTools，route / fallback_reason 用传入的 route 的值）。
 * 助手一轮问答开始时解析一次、整轮复用（#531）：tool_call 历史对模型敏感，一次调用中途换模型会不兼容，
 * 路由不再由 logged 每次自己解析（照 embedWith 的写法）
 */
export const chatToolsWith = (tenantId: string, purpose: LlmPurpose, route: LlmRoute, messages: LlmMessage[], tools: LlmTool[]): Promise<ToolReply> =>
  logged(tenantId, purpose, (provider, stats) => callTools(provider, messages, tools, stats), async () => route);

/**
 * 按租户的 embedding 端点（resolveEmbeddingProvider）调 /embeddings，返回按输入顺序排好的向量，记调用日志
 * （purpose embedding、模型、条数、prompt_tokens 与耗时；不记请求文本与向量，completion_tokens 与 schema_valid 为空）。
 * 超时与网络错误和 chat 走同一套 masked（transient 的 LlmError，消息里 Key 遮掉）。
 * 租户与平台都没配置 embedding 时返回 null（chat 配没配不影响）：不发请求、不记日志，调用方只走关键词检索
 */
export async function embed(tenantId: string, texts: string[]): Promise<number[][] | null> {
  const provider = await resolveEmbeddingProvider(tenantId);
  if (!provider) return null;
  return logged(tenantId, 'embedding',
    (p, stats) => masked(p.apiKey, () => postEmbeddings(p, texts, stats)),
    async () => ({ provider, route: null, fallbackReason: null }), texts.length);
}

/**
 * 用给定的端点调一次 /embeddings，返回按输入顺序排好的向量。不查库、不记日志（评测脚本直接用它，产品走 embed / embedWith）；
 * 失败与 callModel 一样抛抹掉 Key 的 LlmError
 */
export async function callEmbeddings(provider: LlmProvider, texts: string[], stats: CallStats = { schemaValid: null }, opts: { timeoutMs?: number } = {}): Promise<number[][]> {
  return masked(provider.apiKey, () => postEmbeddings(provider, texts, stats, opts), opts.timeoutMs);
}

/**
 * 按调用方传入的 embedding 端点调 /embeddings 并记调用日志（日志口径同 embed：purpose embedding、模型、条数、prompt_tokens 与耗时，
 * 不记请求文本与向量）。补算用 provider 由调用方在开始时解析一次传入，保证一次补算只用一个模型，不会中途换端点；
 * 检索的查询向量一路传更短的 timeoutMs（catalog/embeddings.ts 的 QUERY_EMBED_TIMEOUT_MS），补算不传、仍是默认超时
 */
export const embedWith = (tenantId: string, provider: LlmProvider, texts: string[], opts: { timeoutMs?: number } = {}): Promise<number[][]> =>
  logged(tenantId, 'embedding', (p, stats) => callEmbeddings(p, texts, stats, opts), async () => ({ provider, route: null, fallbackReason: null }), texts.length);

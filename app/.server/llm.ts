// app/.server/llm.ts —— 模型服务客户端（ADR-0003、ADR-0035）。模型只在设计时产出草稿：调用 OpenAI 兼容的 /chat/completions，
// 要求返回 JSON 对象并按调用方给的 JSON Schema 校验，不合格就报错，不把半成品交给调用方。
// 端点按「租户自己的配置（platform.model_providers，Key 用租户数据密钥加密）> 平台默认（环境变量 LLM_*）」整套选取，不混用。
// chatTools 带工具调用模型（AI 助手，ADR-0042），不要求 JSON。
// chatJson 与 chatTools 的每次调用（成功、HTTP 失败、校验失败）都在 platform.llm_calls 记一行：用途、模型、令牌数、耗时、校验结果与错误摘要，不存提示词与返回原文；评测命令用不查库、不记日志的 callModel
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { llmCalls, modelProviders } from './db/schema';
import { decryptForTenant } from './secrets';

/** 调用的用途，记进调用日志 */
export type LlmPurpose = 'connectivity' | 'tool_probe' | 'assistant' | 'mapping_draft' | 'metric_draft' | 'tag_draft' | 'assertion_draft';

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

/** 按 providerSource 选出的那一套端点、模型与 Key（租户的 Key 解密后返回）；都没有返回 null */
export async function resolveProvider(tenantId: string): Promise<LlmProvider | null> {
  const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  switch (providerSource(row)) {
    case 'tenant': {
      const apiKey = row.apiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.apiKey)).apiKey : '';
      return { baseUrl: row.baseUrl!, model: row.model ?? '', apiKey, source: 'tenant' };
    }
    case 'platform':
      return platformProvider();
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

/** 跑 run，失败都转成 LlmError，消息里的 API Key 换成 *** */
async function masked<T>(apiKey: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new LlmError(maskKey(apiKey, e instanceof LlmError ? e.message
      : timedOut ? `模型服务 ${TIMEOUT_MS / 1000} 秒内没有返回`
      : `调用模型服务失败：${e instanceof Error ? e.message : String(e)}`), e instanceof LlmError ? e.transient : true);
  }
}

/** 返回里的 choices[0].message，字段都没校验 */
interface RawMessage { content?: unknown; tool_calls?: unknown }

/** 发一次 /chat/completions（payload 之外补上模型名与 temperature 0），返回 choices[0].message；令牌数填进 stats */
async function postChat(provider: LlmProvider, payload: Record<string, unknown>, stats: CallStats): Promise<RawMessage> {
  const { baseUrl, model, apiKey } = provider;
  if (!model) throw new LlmError('模型服务配置不完整：没有填写模型名');
  const res = await llmFetch()(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, ...payload, temperature: 0 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 先遮蔽再截断：Key 跨过截断处时半截 Key 就遮不住了
  if (!res.ok) throw new LlmError(`模型服务返回 HTTP ${res.status}：${maskKey(apiKey, await res.text()).slice(0, 200)}`, res.status >= 500 || res.status === 429);
  const body = await res.json().catch(() => null) as { choices?: { message?: RawMessage }[]; usage?: CallStats['usage'] } | null;
  stats.usage = body?.usage;
  return body?.choices?.[0]?.message ?? {};
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
 * 按租户选端点（resolveProvider）后调用 call。没配置模型服务或没填模型名时直接报错、不发请求、不记日志；
 * 其余调用（成功或失败）都记日志。日志直接写平台库，不进调用方的事务：调用方回滚时调用记录也要留下
 */
async function logged<T>(tenantId: string, purpose: LlmPurpose, call: (provider: LlmProvider, stats: CallStats) => Promise<T>): Promise<T> {
  const provider = await resolveProvider(tenantId);
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
      tenantId, purpose, model, schemaValid: stats.schemaValid, error,
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

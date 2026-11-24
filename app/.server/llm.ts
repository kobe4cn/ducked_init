// app/.server/llm.ts —— 模型服务客户端（ADR-0003、ADR-0035）。模型只在设计时产出草稿：调用 OpenAI 兼容的 /chat/completions，
// 要求返回 JSON 对象并按调用方给的 JSON Schema 校验，不合格就报错，不把半成品交给调用方。
// 校验的容错（#1160）：模型对用不到的可选键写 null（qwen-max）时按没给处理——删掉出错位置上为 null 的键再校验；输出被 max_tokens
// 截断（finish_reason: length）时报截断原因而不是「不是 JSON」；内容被 ```json 代码块包着时先去掉外壳；minItems / minimum 等报中文说明。
// 解析加固（#1224）：开头的 <think>…</think> 先去掉，再取第一个完整 JSON 对象；服务商没给工具调用 id 时本地生成（call_<uuid>）。
// 端点按「租户自己的配置（platform.model_providers，Key 用租户数据密钥加密）> 平台默认（环境变量 LLM_*）」整套选取，不混用。
// 在选出的一套上按用途分档（ADR-0055）：PURPOSE_TIER 写死每个用途属 fast / reasoning 哪档，平台档位用 LLM_<TIER>_* 环境变量换模型，
// 租户整套自配时读租户自己的档位列（只填模型沿用租户默认端点与 Key，带端点用档位自己的 Key），平台档位不生效；
// 档位没绑定模型就回落默认并记 fallbackReason='unbound'。
// chatTools 带工具调用模型（AI 助手，ADR-0042），不要求 JSON。
// 平台 chat 的请求体可经 LLM_CHAT_EXTRA 合并服务商参数（按档位 LLM_<TIER>_CHAT_EXTRA 覆盖，如 qwen3 思考模型关思考模式）；
// 租户自配时改用租户存的服务商参数（#1169，chat_extra，档位 fast_ / reasoning_chat_extra 覆盖），平台的不串进租户请求体。
// 平台字段（model、messages、response_format、tools 等）不会被它覆盖；chat 与 embedding 补算的超时由 LLM_TIMEOUT_SECONDS 控制（默认 60 秒）。
// embed（ADR-0049）走可选的 embedding 端点：租户的 embedding 三项 > 平台环境变量 LLM_EMBEDDING_*，与 chat 互不影响；
// 都没配置时返回 null（不发请求、不记日志），调用方只走关键词检索。
// chatJson 与 chatTools 的每次调用（成功、HTTP 失败、校验失败）都在 platform.llm_calls 记一行：用途、模型、令牌数、耗时、校验结果与错误摘要，不存提示词与返回原文；评测命令用不查库、不记日志的 callModel
import { randomUUID } from 'node:crypto';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { llmCalls, modelProviders } from './db/schema';
import { decryptForTenant } from './secrets';
import { formatServer } from './i18n';
import { msg, type Msg } from '~/lib/i18n';

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

export interface LlmProvider {
  baseUrl: string; model: string; apiKey: string; source: 'tenant' | 'platform';
  /** 服务商参数原文：平台的 LLM(_<TIER>)_CHAT_EXTRA 或租户存的 chat_extra 列（#1169）。env 是报配置错误时用的名字（变量名或说明），
   *  raw 是原文，调用时才解析合并进 chat 请求体 */
  chatExtra?: { env: string; raw: string };
}

/** transient：超时、连不上、HTTP 5xx 或 429，过一会儿再试可能就好了 */
export class LlmError extends Error {
  /** status：HTTP 错误的状态码（postJson 填），callModel 据此判断要不要退回 json_object；
   *  timeout：超时（masked 填，此时 transient 也为 true）。logged 的重试只认 transient 且不是超时的——超时再等一轮太久（ADR-0035）；
   *  aborted：外部 signal 中止（#1248），此时 transient 与 timeout 都是 false */
  constructor(message: string, readonly transient = false, readonly status?: number, readonly timeout = false, readonly aborted = false) { super(message); }
}

/** 租户 API Key 的加密 context（ADR-0009），解密时须给出同一个 */
export const MODEL_PROVIDER_CONTEXT = 'model_provider';

/** chat 与 embedding 补算共用的超时毫秒数（ADR-0049）：LLM_TIMEOUT_SECONDS 每次调用都读（默认参数在调用时求值，stubEnv 生效），
 *  正整数字符串才用（照 lakeConnectTimeout 的取法），否则回落默认 60 秒——配错不让所有模型调用一起失败。检索查询向量的短超时由调用方另传 */
export function timeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LLM_TIMEOUT_SECONDS;
  return /^\d+$/.test(raw ?? '') && Number(raw) > 0 ? Number(raw) * 1000 : 60_000;
}

let fetchOverride: typeof fetch | undefined;

/** 测试通过它注入假 fetch；传 undefined 恢复真实 fetch */
export function setLlmFetch(f: typeof fetch | undefined) { fetchOverride = f; jsonObjectOnly.clear(); }

const llmFetch = () => fetchOverride ?? fetch;

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let sleepOverride: ((ms: number) => Promise<void>) | undefined;

/** 测试通过它注入假的重试等待（记下毫秒数、不真等）；传 undefined 恢复真实等待 */
export function setLlmSleep(f: ((ms: number) => Promise<void>) | undefined) { sleepOverride = f; }

const llmSleep = (ms: number) => (sleepOverride ?? realSleep)(ms);

/** 选哪一套：租户填了端点就整套用租户的，否则三个环境变量都有才用平台默认；都没有返回 null。不解密，模型服务页也用它 */
export function providerSource(row: { baseUrl: string | null } | undefined): LlmProvider['source'] | null {
  if (row?.baseUrl) return 'tenant';
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = process.env;
  return LLM_BASE_URL && LLM_MODEL && LLM_API_KEY ? 'platform' : null;
}

/** 平台默认的端点、模型与 Key（环境变量 LLM_*）；只在三个变量都有时调用。LLM_CHAT_EXTRA 有值（空串算没填）时带上服务商参数原文 */
export const platformProvider = (): LlmProvider => {
  const extra = process.env.LLM_CHAT_EXTRA;
  return {
    baseUrl: process.env.LLM_BASE_URL!, model: process.env.LLM_MODEL!, apiKey: process.env.LLM_API_KEY!, source: 'platform',
    ...(extra ? { chatExtra: { env: 'LLM_CHAT_EXTRA', raw: extra } } : {}),
  };
};

/** 行上某一档的三列（与 model-provider.ts 的 tierOf 同样的取法，不 import 它：那边已 import 本文件，反向会循环）：
 *  没绑定时 model 为 null，端点与 Key 为 null 表示沿用本租户默认的那一套 */
function tierOf(row: typeof modelProviders.$inferSelect | undefined, tier: 'fast' | 'reasoning') {
  if (tier === 'fast') {
    return { model: row?.fastModel ?? null, baseUrl: row?.fastBaseUrl ?? null, apiKey: row?.fastApiKey ?? null, chatExtra: row?.fastChatExtra ?? null };
  }
  return { model: row?.reasoningModel ?? null, baseUrl: row?.reasoningBaseUrl ?? null, apiKey: row?.reasoningApiKey ?? null, chatExtra: row?.reasoningChatExtra ?? null };
}

/** 租户存的服务商参数（#1169）包成 provider.chatExtra；env 只进配置错误的报错文案 */
export const tenantChatExtra = (raw: string | null, tier?: 'fast' | 'reasoning'): Pick<LlmProvider, 'chatExtra'> =>
  raw ? { chatExtra: { env: zh(tier ? msg('本租户 {tier} 档位的服务商参数', { tier }) : msg('本租户模型服务的服务商参数')), raw } } : {};

/** 查一次 modelProviders 行并按 providerSource 算出那一套 provider（租户的 Key 解密后返回）；都没有时 provider 为 null。
 *  resolveProvider 与 resolveRoute 共用它，各自不再查第二次库 */
async function providerRow(tenantId: string): Promise<{ row: typeof modelProviders.$inferSelect | undefined; provider: LlmProvider | null }> {
  const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  switch (providerSource(row)) {
    case 'tenant': {
      const apiKey = row.apiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.apiKey)).apiKey : '';
      return { row, provider: { baseUrl: row.baseUrl!, model: row.model ?? '', apiKey, source: 'tenant', ...tenantChatExtra(row.chatExtra) } };
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
const tierEnv = (tier: 'fast' | 'reasoning', suffix: 'MODEL' | 'BASE_URL' | 'API_KEY' | 'CHAT_EXTRA') =>
  process.env[`LLM_${tier.toUpperCase()}_${suffix}`] || undefined;

/**
 * 解析一次调用走哪一档（ADR-0055）：先按 ADR-0035 选出整套 provider（都没有返回 null）。
 * 用途不分档时直接用那一套。租户整套自配时读租户自己的档位列、平台档位不生效：只填模型名沿用租户默认的端点与 Key，
 * 档位有自己的端点时用档位的端点与 Key（端点与 Key 须一起填，只填端点按没绑定处理并 console.warn，不把租户默认
 * Key 发到档位的端点）。平台默认时 LLM_<TIER>_MODEL 有值就把模型换成它；BASE_URL 与 API_KEY 必须一起填才用
 * 档位自己的端点与 Key（只填一个同样按没绑定处理并 console.warn），只填 MODEL 时端点与 Key 复用默认的。
 * 服务商参数（#952）：档位自己的 LLM_<TIER>_CHAT_EXTRA 覆盖默认的 LLM_CHAT_EXTRA，只填 MODEL 的档位继承默认的。
 * 租户自配时（#1169）同理用租户的列：档位的 *_chat_extra 有值就用它，否则继承租户默认的 chat_extra；平台的 env 不参与。
 */
export async function resolveRoute(tenantId: string, purpose: LlmPurpose): Promise<LlmRoute | null> {
  const { row, provider } = await providerRow(tenantId);
  if (!provider) return null;
  const tier = PURPOSE_TIER[purpose];
  if (!tier) return { provider, route: null, fallbackReason: null };

  if (provider.source === 'tenant') {
    const { model, baseUrl, apiKey, chatExtra } = tierOf(row, tier);
    if (!model) return { provider, route: tier, fallbackReason: 'unbound' };
    // 档位自己的服务商参数优先，没填时继承 provider 上租户默认的那份
    const extra = chatExtra ? tenantChatExtra(chatExtra, tier) : { chatExtra: provider.chatExtra };
    if (!baseUrl) return { provider: { ...provider, model, ...extra }, route: tier, fallbackReason: null };   // 只填模型名：沿用租户默认端点与 Key
    if (!apiKey) {
      // 保存校验（#605）不允许只填端点，这里只防脏数据：按没绑定处理，不把租户默认 Key 发到档位端点
      console.warn(`model_providers 的 ${tier} 档位有端点但没有 Key，按未绑定该档位处理`);
      return { provider, route: tier, fallbackReason: 'unbound' };
    }
    const decrypted = (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, apiKey)).apiKey;
    return { provider: { baseUrl, model, apiKey: decrypted, source: 'tenant', ...extra }, route: tier, fallbackReason: null };
  }

  const model = tierEnv(tier, 'MODEL');
  const baseUrl = tierEnv(tier, 'BASE_URL');
  const apiKey = tierEnv(tier, 'API_KEY');
  const chatExtra = tierEnv(tier, 'CHAT_EXTRA');
  if ((baseUrl || apiKey) && !(baseUrl && apiKey)) {
    console.warn(`LLM_${tier.toUpperCase()}_BASE_URL 与 LLM_${tier.toUpperCase()}_API_KEY 要一起填才生效，现在按未配置档位处理`);
    return { provider, route: tier, fallbackReason: 'unbound' };
  }
  if (!model) return { provider, route: tier, fallbackReason: 'unbound' };
  return {
    provider: {
      baseUrl: baseUrl ?? provider.baseUrl, model, apiKey: apiKey ?? provider.apiKey, source: 'platform',
      // 档位自己的服务商参数优先；只填 MODEL 的档位继承默认的 LLM_CHAT_EXTRA（上面两个 return 直接用默认 provider，自动带上）
      chatExtra: chatExtra ? { env: `LLM_${tier.toUpperCase()}_CHAT_EXTRA`, raw: chatExtra } : provider.chatExtra,
    },
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

/** 编译并缓存 JSON Schema 的校验器（WeakMap 按对象缓存，Schema 得用模块级常量）；导出给调用方做收拢后的严格校验（#959） */
export function validatorFor(schema: object) {
  let v = compiledSchemas.get(schema);
  if (!v) compiledSchemas.set(schema, v = ajv.compile(schema));
  return v;
}

/** 本层报错固定出中文（LlmError 还不是 MsgError），句式走 msg() 以便词典与将来按语言出（ADR-0060） */
const zh = (m: Msg) => formatServer('zh-CN', m);

/** 外部 signal 中止的文案（#1248）：LlmError 与助手一轮的 AssistantError 共用（本层报错固定中文，句式走 msg() 进词典） */
export const ABORTED = zh(msg('请求已取消'));

/** 调用前检查外部 signal（#1248）：已中止时不发请求、不记 llm_calls，抛 aborted 的 LlmError（不是超时也不 transient，不重试） */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LlmError(ABORTED, false, undefined, false, true);
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
    case 'minItems': return zh(msg('{at}至少要有 {limit} 项', { at, limit: p.limit }));
    case 'maxItems': return zh(msg('{at}最多 {limit} 项', { at, limit: p.limit }));
    case 'minLength': return zh(msg('{at}至少 {limit} 个字', { at, limit: p.limit }));
    case 'maxLength': return zh(msg('{at}最多 {limit} 个字', { at, limit: p.limit }));
    case 'minimum': return zh(msg('{at}不能小于 {limit}', { at, limit: p.limit }));
    case 'maximum': return zh(msg('{at}不能大于 {limit}', { at, limit: p.limit }));
    default: return `${at}${e.message ?? e.keyword}`;
  }
}

/** 校验错误的中文摘要，最多列三条；导出给调用方严格校验时报错文案与 callModel 一致（#959） */
export const schemaErrors = (v: ValidateFunction) => (v.errors ?? []).slice(0, 3).map(describeError).join('；');

/** 按 schema 校验 value，不合时抛 LlmError（文案与 callModel 一致）；导出给调用方收拢后的严格校验（#1162） */
export function assertSchema(schema: object, value: unknown): void {
  const validate = validatorFor(schema);
  if (!validate(value)) throw new LlmError(`模型返回的 JSON 不符合 Schema：${schemaErrors(validate)}`);
}

/** 一次调用的统计，调用日志用：令牌数与 Schema 校验结果（没走到校验时为 null） */
export interface CallStats { usage?: { prompt_tokens?: number; completion_tokens?: number }; schemaValid: boolean | null }

const maskKey = (apiKey: string, s: string) => (apiKey ? s.replaceAll(apiKey, '***') : s);

/** 跑 run，失败都转成 LlmError，消息里的 API Key 换成 ***；timeout 只是超时消息里的秒数，中断本身由 postJson 的 AbortSignal 负责。
 *  signal 是调用方的外部 signal（#1248）：中止时 fetch 以 AbortError 拒绝，名字与外部中止分不开，只看 signal.aborted——
 *  此时不算超时、不标 transient（logged 不重试） */
async function masked<T>(apiKey: string, run: () => Promise<T>, timeout = timeoutMs(), signal?: AbortSignal): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (signal?.aborted) throw new LlmError(ABORTED, false, undefined, false, true);
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new LlmError(maskKey(apiKey, e instanceof LlmError ? e.message
      : timedOut ? `模型服务 ${timeout / 1000} 秒内没有返回`
      : `调用模型服务失败：${e instanceof Error ? e.message : String(e)}`), e instanceof LlmError ? e.transient : true,
      e instanceof LlmError ? e.status : undefined, e instanceof LlmError ? e.timeout : timedOut);
  }
}

/** 返回里的 choices[0].message（带同一条 choice 的 finish_reason），字段都没校验 */
interface RawMessage { content?: unknown; tool_calls?: unknown; finishReason?: unknown }

/** POST 一个 JSON 请求到 {baseUrl}{path}（带 Bearer Key 与超时，外部 signal 一并合进同一个 AbortSignal，#1248），非 2xx 抛 LlmError（5xx 与 429 算 transient），返回解析后的 JSON，不是 JSON 时返回 null */
async function postJson(provider: LlmProvider, path: string, payload: Record<string, unknown>, timeout = timeoutMs(), signal?: AbortSignal): Promise<unknown> {
  const { baseUrl, apiKey } = provider;
  const res = await llmFetch()(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
  });
  // 先遮蔽再截断：Key 跨过截断处时半截 Key 就遮不住了
  if (!res.ok) throw new LlmError(`模型服务返回 HTTP ${res.status}：${maskKey(apiKey, await res.text()).slice(0, 200)}`, res.status >= 500 || res.status === 429, res.status);
  return res.json().catch(() => null);
}

/** chatExtra 里不允许出现的平台字段：服务商参数垫在请求体最底层，这几个键先删掉再合并，覆盖不了平台自己的；
 *  tools 与 response_format 同时出现很多服务不接受（callTools 的注释），更不能从 extra 混进来 */
export const CHAT_EXTRA_PROTECTED = ['model', 'messages', 'response_format', 'tools', 'tool_choice', 'temperature'];

/** 服务商参数原文解析成对象；JSON 不合法或不是对象（数组、null、标量）返回 null。租户保存时（model-provider.ts）也用它校验 */
export function parseChatExtraObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** 把 provider 的 chatExtra 原文解析成要合并进 /chat/completions 请求体的对象（#952）。
 *  在这里（调用时）而不是解析 provider 时做：logged 的 resolve 在 try 之外，提前抛错会漏记 llm_calls，
 *  评测脚本又在模块顶层调 platformProvider()，会在启动时直接崩。JSON 不合法或不是对象（数组、null、标量）都算
 *  配置错误（非 transient），消息只带变量名，不带原文与 Key */
function chatExtraBody(provider: LlmProvider): Record<string, unknown> {
  const { chatExtra } = provider;
  if (!chatExtra) return {};
  const parsed = parseChatExtraObject(chatExtra.raw);
  if (!parsed) throw new LlmError(`模型服务配置错误：${chatExtra.env} 不是合法的 JSON 对象`);
  const extra: Record<string, unknown> = { ...parsed };
  for (const key of CHAT_EXTRA_PROTECTED) delete extra[key];
  return extra;
}

/** 发一次 /chat/completions（chatExtra 的服务商参数垫在最底层，payload 之外补上模型名与 temperature 0，平台字段不会被覆盖），
 *  返回 choices[0].message（带它的 finish_reason，截断判定用）；令牌数填进 stats */
async function postChat(provider: LlmProvider, payload: Record<string, unknown>, stats: CallStats, signal?: AbortSignal): Promise<RawMessage> {
  if (!provider.model) throw new LlmError('模型服务配置不完整：没有填写模型名');
  const body = await postJson(provider, '/chat/completions',
    { ...chatExtraBody(provider), model: provider.model, ...payload, temperature: 0 }, undefined, signal) as
    { choices?: { message?: RawMessage; finish_reason?: unknown }[]; usage?: CallStats['usage'] } | null;
  stats.usage = body?.usage;
  return { ...body?.choices?.[0]?.message ?? {}, finishReason: body?.choices?.[0]?.finish_reason };
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

/** 普通对象（不是数组、不是 null） */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 校验不通过时，把出错位置上值为 null、Schema 不允许 null 的键删掉（qwen-max 对用不到的可选键写 null，按没给处理）。
 *  只处理 type 错误：Schema 允许 null 的键（如映射的 otherwise）不会报 type 错误，原样保留；必填键删掉后会变成
 *  required 错误（缺少 x），自然仍不合格。instancePath 是 JSON Pointer，段里的 ~1 / ~0 按指针规则反转义。
 *  数组元素为 null（父是数组）不处理，交给原报错。返回是否删掉了键 */
function dropNullOptionals(value: unknown, errors: ErrorObject[] | null | undefined): boolean {
  let dropped = false;
  for (const e of errors ?? []) {
    if (e.keyword !== 'type') continue;
    const segments = e.instancePath.split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = segments.pop();
    if (key === undefined) continue;   // 错误落在根上：没有可删的键
    let parent: unknown = value;
    for (const s of segments) {
      if (Array.isArray(parent)) parent = parent[Number(s)];
      else if (isRecord(parent)) parent = parent[s];
      else parent = undefined;
    }
    if (isRecord(parent) && parent[key] === null) {
      delete parent[key];
      dropped = true;
    }
  }
  return dropped;
}

/** 发给模型前从 Schema 里剥掉的关键字：条件与组合（服务商不一定接受，Ollama 遇到会悄悄忽略整个约束）及引用 / 元信息；
 *  这些跨字段规则仍由 Ajv 用完整 Schema 校验（#1178、#1191）。uniqueItems / contains / minContains / maxContains 也剥掉：
 *  DashScope 遇到 type 为 array 且带这几个关键字时整份 json_schema 回 400（实测 qwen-plus、qwen3.8-flash） */
export const MODEL_DROPPED_KEYS = new Set(['if', 'then', 'else', 'not', 'allOf', '$id', '$schema', '$ref',
  'uniqueItems', 'contains', 'minContains', 'maxContains']);

/** Schema 的深拷贝，递归去掉 MODEL_DROPPED_KEYS；不改原 Schema。callModel 的 json_schema 与助手 validate_plan 的工具参数共用 */
export function schemaForModel(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaForModel);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !MODEL_DROPPED_KEYS.has(k)).map(([k, v]) => [k, schemaForModel(v)]));
}

/** 拒绝过某份 json_schema、退回 json_object 成功的端点与模型（键 `${baseUrl}|${model}`）→ 被拒的那些 Schema（按对象身份），
 *  之后这个端点 + 模型 + Schema 直接发 json_object（ADR-0035 修订）。按 Schema 记：服务商常常只拒某个关键字，
 *  一份 Schema 被拒不该让同一模型的其他 Schema 也不发。进程内缓存，setLlmFetch 时清空 */
const jsonObjectOnly = new Map<string, WeakSet<object>>();

/**
 * 用给定的端点调用模型，返回按 schema 校验过的 JSON。不查库、不记日志（评测命令直接用它，产品走 chatJson）。
 * 失败都抛 LlmError（消息里的 API Key 换成 ***，HTTP 错误只带状态码与前 200 字的响应体）；stats 由调用方传入时顺带填上令牌数与校验结果
 */
export async function callModel<T>(provider: LlmProvider, messages: LlmMessage[], schema: object, stats: CallStats = { schemaValid: null },
  name = 'output', signal?: AbortSignal): Promise<T> {
  return masked(provider.apiKey, async () => {
    // 根是 object 的 Schema 剥掉条件关键字后以 json_schema（strict: false，现有 Schema 多不满足 strict）发给模型；
    // 根不是 object（如根上 anyOf）或这个端点 + 模型拒绝过这份 Schema 时发 json_object。HTTP 400 / 422 时同一模型改发 json_object 一次，成功才记缓存
    const modelSchema = schemaForModel(schema);
    const key = `${provider.baseUrl}|${provider.model}`;
    const asSchema = isRecord(modelSchema) && modelSchema.type === 'object' && !jsonObjectOnly.get(key)?.has(schema);
    const jsonObject = () => postChat(provider, { messages, response_format: { type: 'json_object' } }, stats, signal);
    let reply: RawMessage;
    if (!asSchema) reply = await jsonObject();
    else {
      try {
        reply = await postChat(provider, { messages, response_format: { type: 'json_schema', json_schema: { name, schema: modelSchema, strict: false } } }, stats, signal);
      } catch (e) {
        if (!(e instanceof LlmError && (e.status === 400 || e.status === 422))) throw e;
        reply = await jsonObject();
        jsonObjectOnly.set(key, (jsonObjectOnly.get(key) ?? new WeakSet()).add(schema));
      }
    }
    const { content, finishReason } = reply;
    if (typeof content !== 'string') throw new LlmError('模型服务的返回里没有 choices[0].message.content');
    // 截断检查放在解析之前：截断的输出多半也不是合法 JSON，先报原因更清楚（schemaValid 留 null）
    if (finishReason === 'length') throw new LlmError(zh(msg('模型输出被截断（达到输出长度上限），请把需求写得更具体，或换上下文更长的模型')));
    // 思考模型在正文前输出 <think>…</think>：先去掉；有的模型把 JSON 包在 ```json … ``` 代码块里：去掉外壳；
    // 整段不是 JSON 时（前后带说明文字）取第一个完整的 JSON 对象
    const body = stripThink(content).trim();
    const fenced = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    const candidate = fenced ? fenced[1] : body;
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch {
      try { parsed = JSON.parse(firstJsonObject(candidate) ?? ''); } catch { throw new LlmError('模型返回的内容不是 JSON'); }
    }
    const validate = validatorFor(schema);
    stats.schemaValid = validate(parsed);
    // 可选键为 null 时删掉再校验，最多 3 轮；没删掉任何东西就停（报错用最后一次的 schemaErrors）
    for (let round = 0; !stats.schemaValid && round < 3 && dropNullOptionals(parsed, validate.errors); round++) stats.schemaValid = validate(parsed);
    if (!stats.schemaValid) assertSchema(schema, parsed);
    return parsed as T;
  }, undefined, signal);
}

/** 去掉开头的 <think>…</think>（大小写不敏感，到第一个 </think>）；没闭合时原样返回 */
function stripThink(s: string): string {
  return s.trim().replace(/^<think>[\s\S]*?<\/think>/i, '');
}

/** 从第一个 { 起按括号深度扫描（跳过字符串里的括号与转义），返回第一个完整的 {…}；没有时返回 null */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** 给模型的一个工具：parameters 是输入的 JSON Schema */
export interface LlmTool { name: string; description: string; parameters: object }

/** 模型要调用的一个工具：arguments 是模型给的 JSON 文本，没解析 */
export interface LlmToolCall { id: string; name: string; arguments: string }

export interface ToolReply { content: string | null; toolCalls: LlmToolCall[] }

/**
 * 带工具调用模型（OpenAI 兼容的 tools + tool_choice: auto，不带 response_format：很多服务不接受两者同时出现），返回文本回复与要调用的工具。
 * tools 为空数组时请求体里既不带 tools 也不带 tool_choice（空 tools 配 tool_choice 很多服务商直接 400；助手超限后的总结请求这样用，#1180）。
 * 不查库、不记日志；失败与 callModel 一样抛抹掉 Key 的 LlmError，既没有文本也没有工具调用时也算失败
 */
export async function callTools(provider: LlmProvider, messages: LlmMessage[], tools: LlmTool[], stats: CallStats = { schemaValid: null }, signal?: AbortSignal): Promise<ToolReply> {
  return masked(provider.apiKey, async () => {
    const message = await postChat(provider, {
      messages, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' } : {}),
    }, stats, signal);
    const raw = Array.isArray(message.tool_calls) ? message.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] : [];
    const toolCalls = raw.flatMap(c => typeof c?.function?.name === 'string' ? [{
      // 部分兼容接口不给 id：本地生成，loop 回填 tool_call_id 用的是同一个值
      id: typeof c.id === 'string' && c.id ? c.id : `call_${randomUUID()}`,
      name: c.function.name,
      arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
    }] : []);
    const content = typeof message.content === 'string' && message.content ? message.content : null;
    if (content === null && !toolCalls.length) throw new LlmError('模型服务的返回里既没有内容也没有工具调用');
    return { content, toolCalls };
  }, undefined, signal);
}

/**
 * 按租户与用途选档位（resolve，默认 chat 的 resolveRoute）后调用 call。没配置模型服务或没填模型名时直接报错、不发请求、不记日志；
 * 其余调用（成功或失败）都记日志，embedding 调用带上条数 inputCount。日志直接写平台库，不进调用方的事务：调用方回滚时调用记录也要留下。
 * retry 为 true 时，第 1 次抛 transient 且不是超时的 LlmError（429、5xx、网络错误）就等 1–3 秒（带抖动）用同一路由再试 1 次（ADR-0035、ADR-0055）；
 * 每次尝试各记一行，attempt 是第几次
 */
async function logged<T>(tenantId: string, purpose: LlmPurpose, call: (provider: LlmProvider, stats: CallStats) => Promise<T>,
  resolve: (tenantId: string, purpose: LlmPurpose) => Promise<LlmRoute | null> = resolveRoute,
  { inputCount = null, retry = false }: { inputCount?: number | null; retry?: boolean } = {}): Promise<T> {
  const { provider, route, fallbackReason } = (await resolve(tenantId, purpose)) ?? {};
  if (!provider) throw new LlmError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务');
  const { model } = provider;
  if (!model) throw new LlmError('模型服务配置不完整：没有填写模型名');

  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const stats: CallStats = { schemaValid: null };
    let error: string | null = null;
    try {
      return await call(provider, stats);
    } catch (e) {
      error = (e as Error).message;
      if (!(retry && attempt === 1 && e instanceof LlmError && e.transient && !e.timeout)) throw e;
    } finally {
      await getDb().insert(llmCalls).values({
        tenantId, purpose, model, schemaValid: stats.schemaValid, error, inputCount, attempt,
        // 档位与回落原因（ADR-0055）：route 是这次调用所属的档位，fallbackReason 为 'unbound' 表示该档位没绑定模型
        route, fallbackReason,
        // 来源（#843）就是这次实际解析到的端点的 source（chat 由 resolveRoute、embedding 由 resolveEmbeddingProvider 填好），
        // 不在日志层另行推算：embedding 与 chat 可能来自不同套配置
        source: provider.source,
        promptTokens: stats.usage?.prompt_tokens ?? null, completionTokens: stats.usage?.completion_tokens ?? null,
        durationMs: Date.now() - started,
      }).catch(e => console.error('记录模型调用日志失败', e));
    }
    await llmSleep(1000 + Math.random() * 2000);
  }
}

/** 按租户的模型服务 callModel，记调用日志（logged）。signal 已中止时不发请求、不记日志（#1248；仍以 rejected promise 报出，不变成同步抛错） */
export const chatJson = async <T>(tenantId: string, purpose: LlmPurpose, messages: LlmMessage[], schema: object,
  opts: { signal?: AbortSignal } = {}): Promise<T> => {
  throwIfAborted(opts.signal);
  return logged(tenantId, purpose, (provider, stats) => callModel<T>(provider, messages, schema, stats, purpose, opts.signal), resolveRoute,
    { retry: purpose !== 'connectivity' });
};

/** 按租户的模型服务 callTools，记调用日志（logged；schema_valid 为 null） */
export const chatTools = (tenantId: string, purpose: LlmPurpose, messages: LlmMessage[], tools: LlmTool[]): Promise<ToolReply> =>
  logged(tenantId, purpose, (provider, stats) => callTools(provider, messages, tools, stats));

/**
 * 按调用方解析好的档位路由（route）调 callTools 并记调用日志（口径同 chatTools，route / fallback_reason 用传入的 route 的值）。
 * 助手一轮问答开始时解析一次、整轮复用（#531）：tool_call 历史对模型敏感，一次调用中途换模型会不兼容，
 * 路由不再由 logged 每次自己解析（照 embedWith 的写法）。opts.signal 是这一轮的外部中止（#1248）：
 * 调用前已中止时不发请求、不记日志，途中中止时那次请求照常记一行带 error 的日志（已经计费）
 */
export const chatToolsWith = async (tenantId: string, purpose: LlmPurpose, route: LlmRoute, messages: LlmMessage[], tools: LlmTool[],
  opts: { signal?: AbortSignal } = {}): Promise<ToolReply> => {
  throwIfAborted(opts.signal);
  return logged(tenantId, purpose, (provider, stats) => callTools(provider, messages, tools, stats, opts.signal), async () => route);
};

/** 按调用方给出的路由调 callModel 并记调用日志（口径同 chatJson，connectivity 以外的用途也重试 1 次）：保存档位前用还没写库的配置探测一次（#1213）、
 *  连通测试按已解析的档位各测一次时用，路由不再由 logged 自己解析 */
export const chatJsonWith = <T>(tenantId: string, purpose: LlmPurpose, route: LlmRoute, messages: LlmMessage[], schema: object): Promise<T> =>
  logged(tenantId, purpose, (provider, stats) => callModel<T>(provider, messages, schema, stats, purpose), async () => route,
    { retry: purpose !== 'connectivity' });

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
    async () => ({ provider, route: null, fallbackReason: null }), { inputCount: texts.length });
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
 * 检索的查询向量一路传更短的 timeoutMs（catalog/embeddings.ts 的 QUERY_EMBED_TIMEOUT_MS），补算不传、仍是默认超时；
 * retry 只有补算打开（logged 的同模型重试 1 次），查询向量不重试、免得拖慢检索
 */
export const embedWith = (tenantId: string, provider: LlmProvider, texts: string[], opts: { timeoutMs?: number; retry?: boolean } = {}): Promise<number[][]> =>
  logged(tenantId, 'embedding', (p, stats) => callEmbeddings(p, texts, stats, { timeoutMs: opts.timeoutMs }), async () => ({ provider, route: null, fallbackReason: null }),
    { inputCount: texts.length, retry: opts.retry });

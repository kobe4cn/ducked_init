// app/.server/llm.ts —— 模型服务客户端（ADR-0003、ADR-0035）。模型只在设计时产出草稿：调用 OpenAI 兼容的 /chat/completions，
// 要求返回 JSON 对象并按调用方给的 JSON Schema 校验，不合格就报错，不把半成品交给调用方。
// 端点按「租户自己的配置（platform.model_providers，Key 用租户数据密钥加密）> 平台默认（环境变量 LLM_*）」整套选取，不混用。
// 每次调用（成功、HTTP 失败、校验失败）都在 platform.llm_calls 记一行：用途、模型、令牌数、耗时、校验结果与错误摘要，不存提示词与返回原文
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { llmCalls, modelProviders } from './db/schema';
import { decryptForTenant } from './secrets';

/** 调用的用途，记进调用日志 */
export type LlmPurpose = 'connectivity' | 'mapping_draft';

export interface LlmMessage { role: 'system' | 'user'; content: string }

export interface LlmProvider { baseUrl: string; model: string; apiKey: string; source: 'tenant' | 'platform' }

export class LlmError extends Error {}

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

/** 按 providerSource 选出的那一套端点、模型与 Key（租户的 Key 解密后返回）；都没有返回 null */
export async function resolveProvider(tenantId: string): Promise<LlmProvider | null> {
  const [row] = await getDb().select().from(modelProviders).where(eq(modelProviders.tenantId, tenantId));
  switch (providerSource(row)) {
    case 'tenant': {
      const apiKey = row.apiKey ? (await decryptForTenant(tenantId, MODEL_PROVIDER_CONTEXT, row.apiKey)).apiKey : '';
      return { baseUrl: row.baseUrl!, model: row.model ?? '', apiKey, source: 'tenant' };
    }
    case 'platform':
      return { baseUrl: process.env.LLM_BASE_URL!, model: process.env.LLM_MODEL!, apiKey: process.env.LLM_API_KEY!, source: 'platform' };
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

/**
 * 调用模型，返回按 schema 校验过的 JSON。没配置模型服务时直接报错、不发请求、不记日志；
 * 其余失败都记日志并抛 LlmError（消息里的 API Key 换成 ***，HTTP 错误只带状态码与前 200 字的响应体）。
 * 日志直接写平台库，不进调用方的事务：调用方回滚时调用记录也要留下
 */
export async function chatJson<T>(tenantId: string, purpose: LlmPurpose, messages: LlmMessage[], schema: object): Promise<T> {
  const provider = await resolveProvider(tenantId);
  if (!provider) throw new LlmError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务');
  const { baseUrl, model, apiKey } = provider;
  if (!model) throw new LlmError('模型服务配置不完整：没有填写模型名');
  const mask = (s: string) => (apiKey ? s.replaceAll(apiKey, '***') : s);

  const started = Date.now();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let schemaValid: boolean | null = null;
  let error: string | null = null;
  try {
    const res = await llmFetch()(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, temperature: 0 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 先遮蔽再截断：Key 跨过截断处时半截 Key 就遮不住了
    if (!res.ok) throw new LlmError(`模型服务返回 HTTP ${res.status}：${mask(await res.text()).slice(0, 200)}`);
    const body = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[]; usage?: typeof usage } | null;
    usage = body?.usage;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new LlmError('模型服务的返回里没有 choices[0].message.content');
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new LlmError('模型返回的内容不是 JSON'); }
    const validate = validatorFor(schema);
    schemaValid = validate(parsed);
    if (!schemaValid) throw new LlmError(`模型返回的 JSON 不符合 Schema：${schemaErrors(validate)}`);
    return parsed as T;
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    error = mask(e instanceof LlmError ? e.message
      : timedOut ? `模型服务 ${TIMEOUT_MS / 1000} 秒内没有返回`
      : `调用模型服务失败：${e instanceof Error ? e.message : String(e)}`);
    throw new LlmError(error);
  } finally {
    await getDb().insert(llmCalls).values({
      tenantId, purpose, model, schemaValid, error,
      promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null,
      durationMs: Date.now() - started,
    }).catch(e => console.error('记录模型调用日志失败', e));
  }
}

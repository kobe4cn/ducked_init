// test/pipeline/llm-fixtures.ts —— 假模型服务与平台默认配置：流水线测试传 setLlmFetch，HTTP 测试传 f => app.setLlmFetch(f)。
// 不 import app/.server/llm：HTTP harness 用 ssrLoadModule 加载的是另一个实例，注入函数由调用方传入。
// 夹具不碰 afterEach：setLlmFetch(undefined) 与 vi.unstubAllEnvs() 由各文件自己写
import { type Mock, vi } from 'vitest';

type Usage = { prompt_tokens: number; completion_tokens: number };

/** embedding 端点的答复：每个向量按出现顺序给 index（要测乱序返回时在测试里自己构造 Response）；
 *  /embeddings 的 usage 没有 completion_tokens，这里只带 prompt_tokens（llm_calls 的 completion_tokens 为空） */
export const embeddings = (vectors: number[][], usage?: Pick<Usage, 'prompt_tokens'>) =>
  Response.json({ data: vectors.map((embedding, index) => ({ index, embedding })), ...(usage && { usage }) });

/** 平台默认模型服务（环境变量三项都设）；不调 unstubAllEnvs */
export function platformDefault(baseUrl = 'https://platform.example.com/v1'): void {
  vi.stubEnv('LLM_BASE_URL', baseUrl);
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
}

/** 平台默认 embedding 端点（环境变量三项都设，与 chat 的互不影响）；不调 unstubAllEnvs */
export function platformEmbedding(baseUrl = 'https://embed.example.com/v1'): void {
  vi.stubEnv('LLM_EMBEDDING_BASE_URL', baseUrl);
  vi.stubEnv('LLM_EMBEDDING_MODEL', 'text-embedding-v3');
  vi.stubEnv('LLM_EMBEDDING_API_KEY', 'sk-embed-secret');
}

/** 平台档位（ADR-0055，环境变量 LLM_<TIER>_*）：设 MODEL，opts 里给到的项才设（BASE_URL 与 API_KEY 要一起给才生效）；
 *  要测「填了又算没填」时传空串。不调 unstubAllEnvs */
export function platformTier(tier: 'fast' | 'reasoning', model: string, opts: { baseUrl?: string; apiKey?: string } = {}): void {
  const name = `LLM_${tier.toUpperCase()}`;
  vi.stubEnv(`${name}_MODEL`, model);
  if (opts.baseUrl !== undefined) vi.stubEnv(`${name}_BASE_URL`, opts.baseUrl);
  if (opts.apiKey !== undefined) vi.stubEnv(`${name}_API_KEY`, opts.apiKey);
}

/** 请求体（已 JSON.parse）：常用的 messages 与 tools 带类型，其余字段（model、response_format…）不限 */
export interface LlmBody {
  messages: { role: string; content: string; tool_call_id?: string }[];
  tools: { function: { name: string } }[];
  [key: string]: any;
}

/** 假 fetch 收到的一次请求 */
export interface LlmRequest { url: string; headers: Headers; body: LlmBody }

/** 假 fetch：第 n 次请求（从 1 数）记进 received 后返回 respond(n, body)；构造完立刻 set(f) */
export function fakeLlm(set: (f: typeof fetch | undefined) => void, respond: (n: number, body: LlmBody) => Response): { f: Mock; received: LlmRequest[] } {
  const received: LlmRequest[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body: LlmBody = JSON.parse(init?.body as string);
    received.push({ url: String(url), headers: new Headers(init?.headers), body });
    return respond(received.length, body);
  });
  set(f as unknown as typeof fetch);
  return { f, received };
}

const reply = (message: Record<string, unknown>, usage?: Usage) =>
  Response.json({ choices: [{ message }], ...(usage && { usage }) });

/** 模型给出文字答复；usage 省略时不带 usage 字段 */
export const text = (content: string, usage?: Usage) => reply({ role: 'assistant', content }, usage);

/** 模型给出 JSON 文本答复 */
export const json = (content: unknown, usage?: Usage) => text(JSON.stringify(content), usage);

type Call = { name: string; args: unknown; id?: string };

/** 模型要调用工具：id 默认 call_1、call_2…；args 是字符串时原样作为 arguments（用来造不是 JSON 的参数），否则 JSON.stringify */
export const toolCalls = (calls: Call | Call[], usage?: Usage) => reply({
  content: null,
  tool_calls: [calls].flat().map((c, i) => ({
    id: c.id ?? `call_${i + 1}`,
    type: 'function',
    function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) },
  })),
}, usage);

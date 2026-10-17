// test/pipeline/dsl-model-draft.test.ts —— 用模型按需求生成指标定义草稿的流水线接缝（ADR-0035）：modelDraftForDefinition → 注入的假 fetch（setLlmFetch）
// → 转出的 YAML 过指标校验后返回、不写 dsl_versions；platform.llm_calls 的调用日志（purpose = metric_draft）与失败时的审计 definition.model_draft_failed；
// 生成的草稿保存后照常双人发布
import { and, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslVersions, llmCalls } from '../../app/.server/db/schema';
import { createDefinition, DslError, modelDraftForDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

/** 假 fetch：记下收到的请求体，返回 respond 构造的 Response */
function fakeFetch(respond: () => Response) {
  const received: { messages: { role: string; content: string }[] }[] = [];
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    received.push(JSON.parse(init?.body as string));
    return respond();
  });
  setLlmFetch(f as unknown as typeof fetch);
  return { f, received };
}

/** OpenAI 兼容接口的成功返回：content 是 JSON 文本 */
const completion = (content: unknown) =>
  () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 600, completion_tokens: 100 } });

function platformDefault() {
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
}

const REQUEST = '近 30 天每个城市已支付订单的金额合计';

/** 模型对 REQUEST 的回答 */
const MODEL_REVENUE = {
  base: 'order',
  measure: { agg: 'sum', field: 'amount' },
  filter: [{ field: 'status', op: 'in', value: ['paid'] }],
  window: { field: 'created_at', days: 30 },
  dimensions: [{ name: 'city', path: 'order.customer_id -> customer.city' }],
  description: '近 30 天已支付订单金额',
};

const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));
const failures = (tenantId: string) => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'definition.model_draft_failed')));

/** 调用应当失败：返回抛出的错误 */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as DslError);

describe('用模型生成指标定义草稿', () => {
  it('分析师按需求生成：YAML 过校验、带核对注释、不写 dsl_versions；上下文不含敏感字段；保存后由另一位数据工程师发布', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    const { received } = fakeFetch(completion(MODEL_REVENUE));

    const { yaml } = await modelDraftForDefinition(analyst, 'metric', REQUEST);
    expect(yaml.startsWith('# 模型根据需求生成，请核对\n')).toBe(true);
    expect(parse(yaml)).toEqual(MODEL_REVENUE);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    const [call] = await calls(acme);
    expect(call).toMatchObject({ purpose: 'metric_draft', schemaValid: true });
    const user = JSON.parse(received[0]!.messages.find(m => m.role === 'user')!.content);
    expect(user.request).toBe(REQUEST);
    const customer = user.context.entities.find((e: { name: string }) => e.name === 'customer');
    const names = customer.fields.map((f: { name: string }) => f.name);
    expect(names).toContain('city');
    for (const pii of ['name', 'phone', 'email', 'external_id']) expect(names).not.toContain(pii);
    expect(user.context.entities.find((e: { name: string }) => e.name === 'order')).toMatchObject({ base: true });
    expect(user.context.relations).toContain('order.customer_id → customer.customer_id');

    await createDefinition(author, 'metric', 'paid_revenue_30d', yaml);
    await expect(publishDefinition(author, 'metric', 'paid_revenue_30d', 1)).rejects.toThrow(/最后改了这一版草稿/);
    expect(await publishDefinition(reviewer, 'metric', 'paid_revenue_30d', 1)).toMatchObject({ kind: 'gold.dsl', status: 'queued' });
  });

  it('模型返回不合 Schema 时拒绝：调用日志 schema_valid = false，记一条失败审计，不含需求原文', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeFetch(completion({ base: 'order', measure: { agg: 'median', field: 'amount' } }));

    const e = await failure(modelDraftForDefinition(analyst, 'metric', REQUEST));
    expect(e).toBeInstanceOf(DslError);
    expect(e.status).toBe(422);
    expect((await calls(acme))[0]).toMatchObject({ purpose: 'metric_draft', schemaValid: false });
    const [audit] = await failures(acme);
    expect(audit).toMatchObject({ actorEmail: analyst.email, targetType: 'definition', detail: { kind: 'metric', stage: 'model' } });
    expect(String(audit!.detail.error)).toContain('不符合 Schema');
    expect(JSON.stringify(audit!.detail)).not.toContain(REQUEST);
  });

  it('转出的 YAML 不过指标校验时拒绝：带问题列表，审计只记问题数与位置，不含取值', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeFetch(completion({ base: 'order', measure: { agg: 'count' }, filter: [{ field: 'channel_code', op: 'eq', value: 'vip-secret-42' }] }));

    const e = await failure(modelDraftForDefinition(analyst, 'metric', REQUEST));
    expect(e.status).toBe(422);
    expect(e.issues.map(i => i.path)).toEqual(['filter.0.field']);
    expect((await calls(acme))[0]).toMatchObject({ schemaValid: true });
    const [audit] = await failures(acme);
    expect(audit!.detail).toEqual({ kind: 'metric', stage: 'definition', issues: 1, paths: ['filter.0.field'] });
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });

  it('模型服务 HTTP 500 时 422，审计的错误摘要不含 Key', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeFetch(() => new Response('upstream sk-platform-secret exploded', { status: 500 }));

    const e = await failure(modelDraftForDefinition(analyst, 'metric', REQUEST));
    expect(e.status).toBe(422);
    const [audit] = await failures(acme);
    expect(audit!.detail).toMatchObject({ stage: 'model', error: expect.stringContaining('500') });
    expect(JSON.stringify(audit!.detail)).not.toContain('sk-platform-secret');
  });

  it('未配置模型服务时 400、不发请求；查看者 403', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');
    const { f } = fakeFetch(completion(MODEL_REVENUE));

    const e = await failure(modelDraftForDefinition(analyst, 'metric', REQUEST));
    expect(e).toMatchObject({ status: 400, message: expect.stringContaining('未配置模型服务') });
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
    await expect(modelDraftForDefinition(viewer, 'metric', REQUEST)).rejects.toMatchObject({ init: { status: 403 } });
  });
});

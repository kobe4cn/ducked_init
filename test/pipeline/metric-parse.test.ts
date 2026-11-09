// test/pipeline/metric-parse.test.ts —— 一句话解析成指标表单（#516）：parseMetricSentence → 注入的假 fetch（setLlmFetch）
// → 模型输出 MetricSpec（包在 spec 里，另带逐项说明、未知项与不支持的说法）补全路径、转 YAML 过 checkMetric、再转表单（formToYaml 兜底再校验）；
// platform.llm_calls 记 purpose = metric_parse；失败审计 definition.metric_parse_failed（不含原句）；不保存、不写 dsl_versions
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslVersions, llmCalls } from '../../app/.server/db/schema';
import { MAX_SENTENCE, MetricParseError, parseMetricSentence } from '../../app/.server/metric-parse';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { fakeLlm, json, platformDefault } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

/** 答复带的 token 数，记进 llm_calls */
const USAGE = { prompt_tokens: 600, completion_tokens: 100 };

const SENTENCE = '近 30 天已支付或已发货的订单金额';

/** 模型对 SENTENCE 的回答：spec（MetricSpec）加逐项说明、未知项与不支持的说法 */
const MODEL_PARSE = {
  spec: {
    base: 'order',
    measure: { agg: 'sum', field: 'amount' },
    filter: [{ field: 'status', op: 'in', value: ['paid', 'shipped'] }],
    window: { field: 'created_at', days: 30 },
  },
  items: [
    { path: 'measure.field', reason: '金额合计用 order.amount' },
    { path: 'filter.0', reason: '已支付或已发货是同一字段的多个取值，改写成 in' },
    { path: 'window', reason: '近 30 天按下单时间 created_at' },
  ],
  unknowns: ['VIP 等级'],
  unsupported: ['「大客户」没法对应到目录里的字段'],
};

const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));
const failures = (tenantId: string) => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'definition.metric_parse_failed')));

/** 调用应当失败：返回抛出的错误 */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as MetricParseError);

describe('一句话解析成指标表单', () => {
  it('分析师的一句话解析成表单：filter 改写成 in、window 带天数，三个数组原样带回；llm_calls 记 metric_parse，不写 dsl_versions', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    const { received } = fakeLlm(setLlmFetch, () => json(MODEL_PARSE, USAGE));

    const out = await parseMetricSentence(analyst, SENTENCE);
    // 表单取值：过滤取值是字符串，window.days 是数字（metric-form.ts 的约定）
    expect(out.form).toMatchObject({
      base: 'order', agg: 'sum', field: 'amount',
      filter: [{ field: 'status', op: 'in', value: ['paid', 'shipped'] }],
      window: { field: 'created_at', days: 30 },
    });
    expect(out.form.readonly).toEqual([]);
    expect(out.items).toEqual(MODEL_PARSE.items);
    expect(out.unknowns).toEqual(MODEL_PARSE.unknowns);
    expect(out.unsupported).toEqual(MODEL_PARSE.unsupported);

    const [call] = await calls(acme);
    expect(call).toMatchObject({ purpose: 'metric_parse', schemaValid: true });
    // system 是指标规则（与起草共用）加解析说明：或改写 in、只认近 N 天、分母为 0
    const [system, user] = received[0]!.body.messages;
    expect(system).toMatchObject({ role: 'system' });
    expect(system!.content).toContain('capability:metric-dsl');
    for (const rule of ['同一字段的不同取值时改写成一个 in', '近 N 天', '上个月', '分母为 0 时算 0', 'unknowns', 'unsupported']) expect(system!.content).toContain(rule);
    // user 依次是目录总览、按句子搜出的条目与句子原文
    expect(user!.role).toBe('user');
    const [overviewPart, searchPart] = user!.content.split('# 与需求相关的条目');
    expect(overviewPart).toContain('# 语义目录');
    expect(searchPart).toContain('## field:order.amount');
    expect(user!.content.endsWith(`# 句子\n\n${SENTENCE}`)).toBe(true);

    // 不保存、成功不记审计
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
    expect(await failures(acme)).toHaveLength(0);
  });

  it('解析出的 spec 用了不存在的字段时 422：带问题列表，审计只记问题数与位置，不含原句', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeLlm(setLlmFetch, () => json({
      ...MODEL_PARSE,
      spec: { base: 'order', measure: { agg: 'count' }, filter: [{ field: 'channel_code', op: 'eq', value: 'vip-secret-42' }] },
    }, USAGE));

    const e = await failure(parseMetricSentence(analyst, SENTENCE));
    expect(e).toBeInstanceOf(MetricParseError);
    expect(e.status).toBe(422);
    expect(e.issues!.map(i => i.path)).toEqual(['filter.0.field']);
    const [audit] = await failures(acme);
    expect(audit).toMatchObject({ actorEmail: analyst.email, targetType: 'definition', detail: { stage: 'definition', issues: 1, paths: ['filter.0.field'] } });
    expect(JSON.stringify(audit!.detail)).not.toContain(SENTENCE);
    expect(JSON.stringify(audit!.detail)).not.toContain('vip-secret-42');
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);
  });

  it('模型服务 HTTP 500 时 422，审计记阶段与错误摘要', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeLlm(setLlmFetch, () => new Response('upstream exploded', { status: 500 }));

    const e = await failure(parseMetricSentence(analyst, SENTENCE));
    expect(e.status).toBe(422);
    const [audit] = await failures(acme);
    expect(audit!.detail).toMatchObject({ stage: 'model', error: expect.stringContaining('500') });
    expect(JSON.stringify(audit!.detail)).not.toContain(SENTENCE);
  });

  it('空白句子与超过 500 字 400；未配置模型服务 409、不发请求；查看者 403', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');

    for (const bad of ['   \n ', 'x'.repeat(MAX_SENTENCE + 1)]) {
      const e = await failure(parseMetricSentence(analyst, bad));
      expect(e).toBeInstanceOf(MetricParseError);
      expect(e.status).toBe(400);
    }

    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');
    const { f } = fakeLlm(setLlmFetch, () => json(MODEL_PARSE, USAGE));
    const e = await failure(parseMetricSentence(analyst, SENTENCE));
    expect(e).toBeInstanceOf(MetricParseError);
    expect(e.status).toBe(409);
    expect(e.message).toContain('未配置模型服务');
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
    await expect(parseMetricSentence(viewer, SENTENCE)).rejects.toMatchObject({ init: { status: 403 } });
  });
});

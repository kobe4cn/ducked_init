// test/pipeline/metric-parse.test.ts —— 一句话解析成指标表单（#516）：parseMetricSentence → 注入的假 fetch（setLlmFetch）
// → 模型输出 MetricSpec（包在 spec 里，另带逐项说明、未知项与不支持的说法）补全路径、转 YAML 过 checkMetric、再转表单（formToYaml 兜底再校验）；
// platform.llm_calls 记 purpose = metric_parse；失败审计 definition.metric_parse_failed（不含原句）；不保存、不写 dsl_versions
// 检索与起草同一条路（draftSearch，#853：租户 hybrid_search 开关带向量一路，ADR-0047、0049），歧义时照常解析并带回提示（ADR-0056）
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureEmbeddings } from '../../app/.server/catalog/embeddings';
import { refreshProjection } from '../../app/.server/catalog/projection';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslVersions, llmCalls, tenants } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { acceptProposal, proposeKnowledge } from '../../app/.server/knowledge/proposals';
import { MAX_SENTENCE, MetricParseError, parseMetricSentence } from '../../app/.server/metric-parse';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, type LlmBody, type LlmRequest } from './llm-fixtures';

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

/** 只靠向量命中的句子；MARK 只出现在目标指标的说明里——关键词分不出它们，假向量让两者同向、其余正交（照 draft-search.test.ts 的造法） */
const VECTOR_SENTENCE = '顾客流失风险';
const MARK = '不再复购';
const CHURN = `base: order\nmeasure: { agg: count }\ndescription: 未来 90 天内${MARK}的倾向打分\n`;

/** 假向量按文本内容决定：句子与含 MARK 的文本同向 [1,0]，其余正交 [0,1]（维度一致，余弦可比） */
const vec = (t: string): number[] => t === VECTOR_SENTENCE || t.includes(MARK) ? [1, 0] : [0, 1];

/** 开通租户、发布只靠向量命中的指标、建投影、配平台 chat 与 embedding 并 drain 补齐向量缓存（照 draft-search.test.ts 的 vectorReady） */
async function vectorReady() {
  const acme = await newTenant('acme');
  const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
  const reviewer = await memberOf(acme, 'rv@acme.com', 'data_engineer');
  await createDefinition(analyst, 'metric', 'churn_forecast', CHURN);
  await publishDefinition(reviewer, 'metric', 'churn_forecast', 1);
  await refreshProjection(acme);
  platformDefault();
  platformEmbedding();
  // 假 fetch 按请求体分岔：embedding 请求（带 input）按 vec 答向量，chat 请求答一份能过校验的解析
  const { received } = fakeLlm(setLlmFetch, (_n, body: LlmBody) => 'input' in body
    ? embeddings((body.input as string[]).map(t => vec(t)), { prompt_tokens: 3 })
    : json(MODEL_PARSE, USAGE));
  await ensureEmbeddings(acme);
  await drain();
  return { acme, analyst, received };
}

/** 假 fetch 收到的 chat 请求（不带 input 的那次）：开混合检索后 received[0] 是 embedding 请求，不能直接拿 */
const chatOf = (received: LlmRequest[]) => received.filter(r => !('input' in r.body));

/** 最后一次 chat 请求的检索段（「# 与需求相关的条目」与「# 句子」之间）：发给模型的解析上下文里由检索决定的那部分 */
const searchSection = (received: LlmRequest[]) => {
  const user = chatOf(received).at(-1)!.body.messages.at(-1)!;
  return (user.content as string).split('# 与需求相关的条目')[1]!.split('# 句子')[0];
};

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
    // user 依次是目录分层上下文（第一层分组 + 相关分组的组内列表）、按句子搜出的条目与句子原文
    expect(user!.role).toBe('user');
    const [overviewPart, searchPart] = user!.content.split('# 与需求相关的条目');
    expect(overviewPart).toContain('# 语义目录');
    expect(overviewPart).toContain('# 相关分组');
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

  it('租户开了 hybrid_search 时，只靠向量命中的指标进解析上下文；关着时不进，且两种都照常解析', async () => {
    const { acme, analyst, received } = await vectorReady();

    // 开着：先为句子发 embedding 请求，发给模型的检索段里有那个只靠向量命中的指标
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    const on = await parseMetricSentence(analyst, VECTOR_SENTENCE);
    expect(on.form.base).toBe('order');
    expect(received.some(r => 'input' in r.body && (r.body.input as string[]).includes(VECTOR_SENTENCE))).toBe(true);
    expect(searchSection(received)).toContain('## metric:churn_forecast');

    // 关掉：关键词各路命不中它（只命中能力条目，不占名额），检索段没有它，也不再发 embedding 请求；解析照常成功
    const callsBefore = received.length;
    await getDb().update(tenants).set({ hybridSearch: false }).where(eq(tenants.id, acme));
    const off = await parseMetricSentence(analyst, VECTOR_SENTENCE);
    expect(off.form.base).toBe('order');
    expect(searchSection(received)).not.toContain('metric:churn_forecast');
    expect(received.slice(callsBefore).every(r => !('input' in r.body))).toBe(true);
  });

  it('两个指标挂同一个别名：照常解析并带回歧义提示（词与两个候选的标识、名称）；设默认指向后不再提示，默认条目排检索段第一', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    const reviewer = await memberOf(acme, 'rv@acme.com', 'data_engineer');
    // 两个窗口时间字段不同的指标挂同一个别名「营收」：检索判出歧义
    const windowed = (field: string) => `base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: ${field}, days: 30 }\n`;
    for (const [key, field] of [['revenue_365d', 'created_at'], ['gmv_365d', 'paid_at']] as const) {
      await createDefinition(analyst, 'metric', key, windowed(field));
      await publishDefinition(reviewer, 'metric', key, 1);
      await addAlias(analyst, { targetId: `metric:${key}`, alias: '营收' });
    }
    platformDefault();
    const { received } = fakeLlm(setLlmFetch, () => json(MODEL_PARSE, USAGE));

    // 本来要追问：照常解析（表单照常带回），歧义提示带词与两个候选（指标的名称就是键），不放口径取值
    const ambiguous = await parseMetricSentence(analyst, '营收');
    expect(ambiguous.form.base).toBe('order');
    const group = ambiguous.ambiguity?.groups[0]!;
    expect(group?.term).toBe('营收');
    expect(group.candidates.map(c => c.id).sort()).toEqual(['metric:gmv_365d', 'metric:revenue_365d']);
    expect(group.candidates.every(c => c.name === c.id.replace(/^metric:/, ''))).toBe(true);
    expect(JSON.stringify(ambiguous.ambiguity)).not.toContain('diffs');

    // 接受「营收 → revenue_365d」的默认指向后：不再歧义，默认条目排在检索段第一，两个候选都还在检索段里
    const proposal = (await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: 'metric:revenue_365d', kind: 'term_default', content: { term: '营收' },
      evidence: [{ ref: 'metric:revenue_365d', version: 1 }], generatorVersion: 'test-gen-1',
    })))!;
    await acceptProposal(analyst, proposal.id);
    const settled = await parseMetricSentence(analyst, '营收');
    expect(settled.ambiguity).toBe(null);
    const ids = [...searchSection(received).matchAll(/^## (metric:[^\s]+)/gm)].map(m => m[1]);
    expect(ids[0]).toBe('metric:revenue_365d');
    expect(ids).toContain('metric:gmv_365d');
  });
});

// test/pipeline/dsl-model-draft.test.ts —— 用模型按需求生成指标 / 标签定义草稿的流水线接缝（ADR-0035）：modelDraftForDefinition → 注入的假 fetch（setLlmFetch）
// → 转出的 YAML 过该种类的校验后返回、不写 dsl_versions；platform.llm_calls 的调用日志（purpose = metric_draft / tag_draft）与失败时的审计 definition.model_draft_failed；
// 生成的草稿保存后照常双人发布
import { and, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslVersions, llmCalls } from '../../app/.server/db/schema';
import { buildCatalog, estimateTokens, OVERVIEW_TOKENS, type CatalogInput } from '../../app/.server/catalog';
import { deriveProjection } from '../../app/.server/catalog/projection';
import { rank } from '../../app/.server/catalog/rank';
import { knowledgeKey } from '../../app/.server/knowledge/catalog';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { createDefinition, DslError, modelDraftForDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { definitionDraftMessages, SEARCH_LIMIT } from '../../app/.server/pipeline/dsl/model-draft';
import { setLlmFetch, type LlmMessage } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { fakeLlm, json, platformDefault } from './llm-fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

/** 答复带的 token 数，记进 llm_calls */
const USAGE = { prompt_tokens: 600, completion_tokens: 100 };

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
    const { received } = fakeLlm(setLlmFetch, () => json(MODEL_REVENUE, USAGE));

    const { yaml } = await modelDraftForDefinition(analyst, 'metric', REQUEST);
    expect(yaml.startsWith('# 模型根据需求生成，请核对\n')).toBe(true);
    expect(parse(yaml)).toEqual(MODEL_REVENUE);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    const [call] = await calls(acme);
    expect(call).toMatchObject({ purpose: 'metric_draft', schemaValid: true });
    const [system, user] = received[0]!.body.messages;
    expect(system).toMatchObject({ role: 'system', content: expect.stringContaining('## capability:metric-dsl 指标 DSL') });
    expect(user!.role).toBe('user');
    // 依次是目录分层上下文（第一层分组 + 相关分组的组内列表）、按需求搜出的条目与需求原文
    const [overviewPart, searchPart] = user!.content.split('# 与需求相关的条目');
    expect(overviewPart).toContain('# 语义目录');
    expect(overviewPart).toContain('# 相关分组');
    for (const id of ['entity:customer', 'entity:order', 'relation:order.customer_id']) expect(overviewPart).toContain(`- ${id} `);
    expect(searchPart).toContain('## field:order.amount');
    expect(user!.content.endsWith(`# 需求\n\n${REQUEST}`)).toBe(true);
    // 敏感字段、哈希列不进上下文：customer 组的组内列表有 city 的条目行，没有敏感字段的行
    const sent = received[0]!.body.messages.map(m => m.content).join('\n');
    expect(overviewPart).toMatch(/^- field:customer\.city /m);
    for (const pii of ['name', 'phone', 'email', 'external_id']) expect(overviewPart).not.toMatch(new RegExp(`^- field:customer\\.${pii} `, 'm'));
    for (const pii of ['`phone`', '`email`', '`external_id`', 'customer.phone', 'customer.email', 'customer.name', '_hash']) expect(sent).not.toContain(pii);

    await createDefinition(author, 'metric', 'paid_revenue_30d', yaml);
    await expect(publishDefinition(author, 'metric', 'paid_revenue_30d', 1)).rejects.toThrow(/最后改了这一版草稿/);
    expect(await publishDefinition(reviewer, 'metric', 'paid_revenue_30d', 1)).toMatchObject({ kind: 'gold.dsl', status: 'queued' });
  });

  it('需求提到的字段的业务说明出现在搜出的条目里', async () => {
    const { acme, author } = await publishedIdentitySources({ orders: true });
    await saveBusinessNote(author, { entity: 'order', field: 'status', note: '退款单也算一笔订单，状态记为 refunded' });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    const { received } = fakeLlm(setLlmFetch, () => json({ base: 'order', measure: { agg: 'count' }, filter: [{ field: 'status', op: 'eq', value: 'refunded' }] }, USAGE));

    await modelDraftForDefinition(analyst, 'metric', '统计退款单');
    const searchPart = received[0]!.body.messages[1]!.content.split('# 与需求相关的条目')[1]!.split('# 需求')[0]!;
    expect(searchPart).toContain('## field:order.status');
    expect(searchPart).toContain('业务说明：退款单也算一笔订单，状态记为 refunded');
  });

  it('模型返回不合 Schema 时拒绝：调用日志 schema_valid = false，记一条失败审计，不含需求原文', async () => {
    const acme = await newTenant('acme');
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    platformDefault();
    fakeLlm(setLlmFetch, () => json({ base: 'order', measure: { agg: 'median', field: 'amount' } }, USAGE));

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
    fakeLlm(setLlmFetch, () => json({ base: 'order', measure: { agg: 'count' }, filter: [{ field: 'channel_code', op: 'eq', value: 'vip-secret-42' }] }, USAGE));

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
    fakeLlm(setLlmFetch, () => new Response('upstream sk-platform-secret exploded', { status: 500 }));

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
    const { f } = fakeLlm(setLlmFetch, () => json(MODEL_REVENUE, USAGE));

    const e = await failure(modelDraftForDefinition(analyst, 'metric', REQUEST));
    expect(e).toMatchObject({ status: 400, message: expect.stringContaining('未配置模型服务') });
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
    await expect(modelDraftForDefinition(viewer, 'metric', REQUEST)).rejects.toMatchObject({ init: { status: 403 } });
  });
});

/** 手写目录输入里定义所属的空间：目录只记录它，不按它过滤（ADR-0048） */
const SPACE = '00000000-0000-0000-0000-000000000000';

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\ndescription: 近 30 天订单金额\n';
const REVENUE_BY_CITY = 'base: order\nmeasure: { agg: sum, field: amount }\ndimensions:\n  - { name: city, path: order.customer_id -> customer.city }\n';
const TAG_REQUEST = '近 30 天消费满 1000 的是高价值客户，其余为普通';

/** 模型对 TAG_REQUEST 的回答 */
const MODEL_TIER = { metric: 'revenue_30d', rules: [{ value: 'high', when: { gte: 1000 } }], default: 'normal', description: '按近 30 天消费分层' };

describe('用模型生成标签定义草稿', () => {
  it('上下文是目录与标签能力说明（只有已发布指标）；YAML 过标签校验、不写 dsl_versions；保存后由另一位数据工程师发布', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(author, 'metric', 'revenue_30d', REVENUE);
    await publishDefinition(reviewer, 'metric', 'revenue_30d', 1);
    await createDefinition(author, 'metric', 'revenue_by_city', REVENUE_BY_CITY);
    await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
    await createDefinition(author, 'metric', 'draft_only', REVENUE);
    platformDefault();
    const { received } = fakeLlm(setLlmFetch, () => json(MODEL_TIER, USAGE));

    const { yaml } = await modelDraftForDefinition(analyst, 'tag', TAG_REQUEST);
    expect(yaml.startsWith('# 模型根据需求生成，请核对\n')).toBe(true);
    expect(parse(yaml)).toEqual(MODEL_TIER);
    expect(await getDb().select().from(dslVersions)).toHaveLength(3);

    expect((await calls(acme))[0]).toMatchObject({ purpose: 'tag_draft', schemaValid: true });
    const [system, user] = received[0]!.body.messages;
    expect(system!.content).toContain('## capability:tag-dsl 标签 DSL');
    expect(system!.content).not.toContain('capability:metric-dsl');
    // 目录里只有已发布的指标，草稿不出现
    expect(user!.content).toContain('- metric:revenue_30d ');
    expect(user!.content).not.toContain('draft_only');
    expect(user!.content.endsWith(`# 需求\n\n${TAG_REQUEST}`)).toBe(true);

    await createDefinition(author, 'tag', 'value_tier', yaml);
    await expect(publishDefinition(author, 'tag', 'value_tier', 1)).rejects.toThrow(/最后改了这一版草稿/);
    expect(await publishDefinition(reviewer, 'tag', 'value_tier', 1)).toMatchObject({ status: 'queued' });
  });

  it('模型引用带维度或只有草稿的指标时 422，审计种类为标签', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(author, 'metric', 'revenue_30d', REVENUE);
    await publishDefinition(reviewer, 'metric', 'revenue_30d', 1);
    await createDefinition(author, 'metric', 'revenue_by_city', REVENUE_BY_CITY);
    await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
    await createDefinition(author, 'metric', 'draft_only', REVENUE);
    platformDefault();

    for (const metric of ['revenue_by_city', 'draft_only']) {
      fakeLlm(setLlmFetch, () => json({ ...MODEL_TIER, metric }, USAGE));
      const e = await failure(modelDraftForDefinition(analyst, 'tag', TAG_REQUEST));
      expect(e.status).toBe(422);
      expect(e.issues.map(i => i.path)).toEqual(['metric']);
    }
    expect(await failures(acme)).toEqual([
      expect.objectContaining({ detail: { kind: 'tag', stage: 'definition', issues: 1, paths: ['metric'] } }),
      expect.objectContaining({ detail: { kind: 'tag', stage: 'definition', issues: 1, paths: ['metric'] } }),
    ]);
    expect((await calls(acme)).map(c => c.purpose)).toEqual(['tag_draft', 'tag_draft']);
  });

  it('模型输出不合 SINGLE_TAG_SCHEMA 时 422，记审计', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(author, 'metric', 'revenue_30d', REVENUE);
    await publishDefinition(reviewer, 'metric', 'revenue_30d', 1);
    platformDefault();
    fakeLlm(setLlmFetch, () => json({ metric: 'revenue_30d', rules: [{ value: 'high', when: { between: [1, 2] } }], default: 'normal' }, USAGE));

    const e = await failure(modelDraftForDefinition(analyst, 'tag', TAG_REQUEST));
    expect(e.status).toBe(422);
    expect((await calls(acme))[0]).toMatchObject({ purpose: 'tag_draft', schemaValid: false });
    expect((await failures(acme))[0]!.detail).toMatchObject({ kind: 'tag', stage: 'model' });
  });

  it('没有可引用的已发布指标时 400、不发请求', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    await createDefinition(author, 'metric', 'revenue_by_city', REVENUE_BY_CITY);
    await publishDefinition(reviewer, 'metric', 'revenue_by_city', 1);
    await createDefinition(author, 'metric', 'draft_only', REVENUE);
    platformDefault();
    const { f } = fakeLlm(setLlmFetch, () => json(MODEL_TIER, USAGE));

    const e = await failure(modelDraftForDefinition(analyst, 'tag', TAG_REQUEST));
    expect(e).toMatchObject({ status: 400, message: expect.stringContaining('先发布一个数值型指标') });
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
  });
});

describe('大目录下的起草上下文（#855：第一层分组 + 相关分组组内列表）', () => {
  it('按只命中一个实体的需求起草时，相关分组段只有命中实体组的组内列表，不相关实体只在第一层', () => {
    // 五百个自定义实体（第一层放不下，实体组按标识分桶成合并组）与 1200 个指标、带主题，照 test/catalog.test.ts 千指标目录的造法；
    // 只有 e_7 的字段说明带「灯塔」，需求只命中它
    const c = buildCatalog({
      customEntities: Array.from({ length: 500 }, (_, i) => ({
        name: `e_${i}`, label: `实体${i}`, kind: 'dimension' as const, primaryKey: ['id'],
        fields: [
          { name: 'id', type: 'string' as const, description: i === 7 ? '灯塔实体标识' : `第 ${i} 个实体的标识`, sensitive: false },
          { name: `f_${i}`, type: 'string' as const, description: '', sensitive: false },
        ],
        relations: [],
      })),
      definitions: [
        ...Array.from({ length: 1200 }, (_, i): { kind: 'metric'; key: string; version: number; yaml: string; spaceId: string } => ({
          kind: 'metric', key: `m_${i}`, version: 1, spaceId: SPACE,
          yaml: `base: order\nmeasure: { agg: count }\ndescription: 第 ${i} 个测试指标\n`,
        })),
      ],
      knowledge: {
        byTarget: new Map([
          ...Array.from({ length: 50 }, (_, i): [string, { subjects: string[] }] => [knowledgeKey(`metric:m_${i}`), { subjects: ['复购'] }]),
        ]),
      },
    });

    const REQUEST = '按灯塔统计';
    // 排好的条目由调用方传入（#827 起检索在 catalog/draft-search.ts，读库）：这里在内存里按同一式子排序（评测脚本 score.ts 自用的那份）
    const ranked = rank(deriveProjection(c, 'full').filter(r => !r.entryId.startsWith('capability:')), c, REQUEST, {}, SEARCH_LIMIT).map(r => r.entry);
    const content = (definitionDraftMessages('metric', REQUEST, c, ranked) as LlmMessage[])[1]!.content;
    const [layered] = content.split('# 与需求相关的条目');
    // 第一层分组完整给出（合并组行），相关分组段里有命中实体组的组内列表
    expect(layered).toContain('# 相关分组');
    expect(layered).toMatch(/^- group:entities@1 /m);
    expect(layered).toContain('# 分组 group:entity:e_7');
    expect(layered).toMatch(/^- entity:e_7 /m);
    expect(layered).toMatch(/^- field:e_7\.id /m);
    // 不相关实体不出组内列表，条目行只在第一层的合并组行里（或没有）
    expect(layered).not.toMatch(/^- (entity|field):e_8\S* /m);
    expect(layered).not.toMatch(/^- metric:m_\d+ /m);
    // 检索段只搜出命中的字段
    expect(content).toContain('## field:e_7.id ');
    // 总量不超过分层上下文与检索段各自的预算加需求本身
    expect(estimateTokens(content)).toBeLessThanOrEqual(OVERVIEW_TOKENS + 6000 + estimateTokens(REQUEST) + 40);
  });
});

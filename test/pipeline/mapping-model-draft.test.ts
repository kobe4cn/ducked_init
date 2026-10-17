// test/pipeline/mapping-model-draft.test.ts —— 用模型生成映射草稿的流水线接缝（ADR-0035）：modelDraftFor 按「复用已发布映射 > 模型 > 按规则」生成
// → 注入的假 fetch（setLlmFetch）→ platform.mapping_generations 的生成记录、platform.llm_calls 的调用日志与失败时的审计 mapping.model_draft_failed；
// 带着生成记录保存时与生成稿比对 → 审计 mapping.generation_edited（只有字段名）
import { and, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, llmCalls, mappingGenerations } from '../../app/.server/db/schema';
import { setLlmFetch } from '../../app/.server/llm';
import { createMapping, draftFor, dryRunMapping, MappingError, modelDraftFor, modelDraftForMapping, publishMapping, saveMappingDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 假 fetch：记下收到的请求体，返回 respond 构造的 Response */
function fakeFetch(respond: () => Response) {
  const received: Record<string, unknown>[] = [];
  const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    received.push(JSON.parse(init?.body as string));
    return respond();
  });
  setLlmFetch(f as unknown as typeof fetch);
  return { f, received };
}

/** OpenAI 兼容接口的成功返回：content 是 JSON 文本 */
const completion = (content: unknown) =>
  () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }], usage: { prompt_tokens: 800, completion_tokens: 200 } });

function platformDefault() {
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
}

/** 模型对 shop.orders → order 的回答 */
const MODEL_ORDERS = {
  fields: [
    { field: 'order_id', expr: 'string(order_id)', confidence: 0.98, reason: '源表主键' },
    { field: 'customer_id', expr: 'string(customer_id)', confidence: 0.9, reason: '同名列，引用消费者' },
    { field: 'status', expr: 'status', dictionary: [{ from: 'paid', to: 'paid' }, { from: 'refunded', to: 'refunded' }], confidence: 0.85, reason: '常见取值与标准取值同名' },
    { field: 'amount', expr: 'amount', confidence: 0.7, reason: '金额列，单位看起来是元' },
    { field: 'created_at', expr: 'created_at', confidence: 0.9, reason: '下单时间' },
  ],
};

const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
`;

/** 开通租户、登记电商库、选入全部表并采集完 */
async function tenantWithSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER, '门店1'));
  await selectAllTables(author, id);
  await drain();
  return { acme, author, reviewer, sourceId: id };
}

const generations = (tenantId: string) => getDb().select().from(mappingGenerations).where(eq(mappingGenerations.tenantId, tenantId));
const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));
const failures = (tenantId: string) => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'mapping.model_draft_failed')));

/** 调用应当失败：返回抛出的错误 */
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as MappingError);

describe('用模型生成映射草稿', () => {
  it('源表结构命中已发布映射时直接复用，不调用模型，生成记录的来源是 reuse', async () => {
    const { acme, author, reviewer, sourceId } = await tenantWithSource();
    const published = await publish(author, reviewer, sourceId, ORDERS);
    const { id: shop2 } = await registerSource(author, await pgSourceInput(READER, '门店2'));
    await selectAllTables(author, shop2);
    await drain();
    platformDefault();
    const { f } = fakeFetch(completion(MODEL_ORDERS));

    const result = await modelDraftFor(author, shop2, 'orders', 'order');
    expect(result).toMatchObject({ origin: 'reuse', reusedFrom: published, items: [] });
    expect(result.yaml).toMatch(/^# 复用已发布映射/);
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
    expect(await generations(acme)).toEqual([expect.objectContaining({
      id: result.generationId, sourceId: shop2, tableName: 'orders', entity: 'order', origin: 'reuse', yaml: result.yaml, items: [], mappingId: null, createdByEmail: author.email,
    })]);
  });

  it('没有配置模型服务时返回规则草稿并提示，不发请求，生成记录的来源是 rules', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    const { f } = fakeFetch(completion(MODEL_ORDERS));

    const result = await modelDraftFor(author, sourceId, 'orders', 'order');
    expect(result).toMatchObject({ origin: 'rules', notice: '未配置模型服务，已按规则生成', yaml: await draftFor(author, sourceId, 'orders', 'order') });
    expect(f).not.toHaveBeenCalled();
    expect(await calls(acme)).toHaveLength(0);
    expect(await generations(acme)).toEqual([expect.objectContaining({ id: result.generationId, origin: 'rules', items: [] })]);
  });

  it('配置了模型服务时把表上下文与规则草稿发给模型，转出的 YAML 记进生成记录（每项的置信度与理由），不保存映射', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    const { received } = fakeFetch(completion(MODEL_ORDERS));

    const result = await modelDraftFor(author, sourceId, 'orders', 'order');
    expect(result.origin).toBe('model');
    expect(result.notice).toBeUndefined();
    expect(parse(result.yaml)).toMatchObject({
      entity: 'order', table: 'orders',
      fields: { order_id: 'string(order_id)', status: { expr: 'status', dictionary: { paid: 'paid', refunded: 'refunded' } }, amount: 'amount' },
    });
    expect(result.yaml).toContain('amount: amount # 金额列，单位看起来是元');

    const [call] = await calls(acme);
    expect(call).toMatchObject({ purpose: 'mapping_draft', model: 'qwen-plus', schemaValid: true, error: null });
    const messages = received[0].messages as { role: string; content: string }[];
    const user = JSON.parse(messages[1].content);
    expect(user).toMatchObject({ entity: 'order', table: { table: 'orders', rows: 100 } });
    expect(user.table).not.toHaveProperty('samples');
    expect(user.rulesDraft).toMatch(/^# 按规则生成的草稿/);

    const [generation] = await generations(acme);
    expect(generation).toMatchObject({ id: result.generationId, origin: 'model', yaml: result.yaml, mappingId: null });
    expect(generation.items).toContainEqual({ path: 'fields.amount', confidence: 0.7, reason: '金额列，单位看起来是元' });
    expect(generation.items).toHaveLength(5);
    expect(result.items).toEqual(generation.items);
    expect(await failures(acme)).toHaveLength(0);
  });

  it('模型生成的草稿照常保存为成员的草稿、空跑，保存的人不能发布、另一位能发布', async () => {
    const { acme, author, reviewer, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(completion(MODEL_ORDERS));
    const mapping = await createMapping(author, sourceId, (await modelDraftFor(author, sourceId, 'orders', 'order')).yaml);
    const [audit] = await getDb().select().from(auditLogs)
      .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'mapping.drafted'), eq(auditLogs.targetId, mapping.id)));
    expect(audit).toMatchObject({ actorType: 'member', actorEmail: author.email });

    await confirmWatermark(author, sourceId, 'orders', 'order_id');
    await syncSource(author, sourceId);
    await drain();
    const dry = await dryRunMapping(author, mapping.id, 1);
    expect(dry.rows).toHaveLength(50);

    await expect(publishMapping(author, mapping.id, 1)).rejects.toBeInstanceOf(MappingError);
    await expect(publishMapping(reviewer, mapping.id, 1)).resolves.not.toThrow();
  });

  it('模型返回不合 Schema 时拒绝：调用日志 schema_valid = false，记一条失败审计，不写生成记录', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(completion({ fields: [{ field: 'order_id', expr: 'string(order_id)', confidence: 2, reason: '主键' }] }));

    const e = await failure(modelDraftFor(author, sourceId, 'orders', 'order'));
    expect(e).toBeInstanceOf(MappingError);
    expect(e.status).toBe(422);
    expect((await calls(acme))[0]).toMatchObject({ purpose: 'mapping_draft', schemaValid: false });
    expect(await generations(acme)).toHaveLength(0);
    const [audit] = await failures(acme);
    expect(audit).toMatchObject({ actorEmail: author.email, detail: { sourceId, source: '门店1', table: 'orders', entity: 'order', stage: 'model' } });
    expect(String(audit.detail.error)).toContain('不符合 Schema');
  });

  it('转出的 YAML 引用不存在的列时拒绝：带问题列表，审计只记阶段、问题数与位置，不含模型原文', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(completion({ fields: [...MODEL_ORDERS.fields, { field: 'channel', expr: 'no_such_col', confidence: 0.4, reason: '猜的渠道列' }] }));

    const e = await failure(modelDraftFor(author, sourceId, 'orders', 'order'));
    expect(e.status).toBe(422);
    expect(e.issues.length).toBeGreaterThan(0);
    expect((await calls(acme))[0]).toMatchObject({ schemaValid: true });
    expect(await generations(acme)).toHaveLength(0);
    const [audit] = await failures(acme);
    expect(audit.detail).toMatchObject({ stage: 'mapping', issues: e.issues.length, paths: e.issues.map(i => i.path) });
    expect(JSON.stringify(audit.detail)).not.toMatch(/no_such_col|猜的渠道列|paid|refunded/);
  });

  it('模型服务 HTTP 500 时拒绝：审计的错误摘要里没有 Key，不写生成记录', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(() => new Response('upstream error for sk-platform-secret', { status: 500 }));

    const e = await failure(modelDraftFor(author, sourceId, 'orders', 'order'));
    expect(e.status).toBe(422);
    expect(e.message).not.toContain('sk-platform-secret');
    expect(await generations(acme)).toHaveLength(0);
    const [audit] = await failures(acme);
    expect(audit.detail).toMatchObject({ stage: 'model' });
    expect(String(audit.detail.error)).toContain('HTTP 500');
    expect(JSON.stringify(audit.detail)).not.toContain('sk-platform-secret');
  });
});

describe('记录成员对生成草稿的修改', () => {
  const edits = (tenantId: string) => getDb().select().from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'mapping.generation_edited')));
  /** 改金额的表达式、删掉下单时间 */
  const edited = (yaml: string) => yaml.replace('amount: amount', 'amount: amount * 100').replace(/^ {2}created_at: .*\n/m, '');

  it('生成后改了字段再保存：记一条审计，只有字段名与改了哪些属性，生成记录回填映射', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(completion(MODEL_ORDERS));
    const draft = await modelDraftFor(author, sourceId, 'orders', 'order');
    const yaml = edited(draft.yaml);
    expect(yaml).not.toBe(draft.yaml);

    const mapping = await createMapping(author, sourceId, yaml, { generationId: draft.generationId });
    const [audit, ...more] = await edits(acme);
    expect(more).toHaveLength(0);
    expect(audit).toMatchObject({ actorEmail: author.email, targetType: 'mapping', targetId: mapping.id });
    expect(audit.detail).toEqual({
      generationId: draft.generationId, origin: 'model', mappingId: mapping.id, version: 1, source: '门店1', table: 'orders', entity: 'order', generationValid: true,
      added: [], removed: ['created_at'], changed: [{ name: 'amount', fields: ['expr'] }],
      key: false, latest: false, identity: false, keySpace: false, survivorship: false, where: false,
      assertions: { added: [], removed: [], changed: [] },
    });
    expect(JSON.stringify(audit.detail)).not.toMatch(/amount \*|refunded|string\(/);
    expect((await generations(acme))[0].mappingId).toBe(mapping.id);
  });

  it('生成后只加了自定义断言再保存：审计记下断言名，不记 min / max / values', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    platformDefault();
    fakeFetch(completion(MODEL_ORDERS));
    const draft = await modelDraftFor(author, sourceId, 'orders', 'order');
    const yaml = `${draft.yaml}\nassertions:\n  - { field: amount, check: range, min: 12345, level: error }\n`;

    await createMapping(author, sourceId, yaml, { generationId: draft.generationId });
    const [audit] = await edits(acme);
    expect(audit.detail).toMatchObject({ added: [], removed: [], changed: [], assertions: { added: ['custom:amount:range'], removed: [], changed: [] } });
    expect(JSON.stringify(audit.detail)).not.toContain('12345');
  });

  it('原样保存不记审计，生成记录照样回填映射', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    const draft = await modelDraftFor(author, sourceId, 'orders', 'order');
    expect(draft.origin).toBe('rules');
    const mapping = await createMapping(author, sourceId, draft.yaml, { generationId: draft.generationId });
    expect(await edits(acme)).toHaveLength(0);
    expect((await generations(acme))[0].mappingId).toBe(mapping.id);
  });

  it('详情页重新生成后改已有草稿：同样记一条，版本是这一版草稿', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    const mapping = await createMapping(author, sourceId, ORDERS);
    const draft = await modelDraftForMapping(author, mapping.id);
    await saveMappingDraft(author, mapping.id, edited(draft.yaml), { generationId: draft.generationId });
    const [audit] = await edits(acme);
    expect(audit.detail).toMatchObject({ generationId: draft.generationId, origin: 'rules', mappingId: mapping.id, version: 1, removed: ['created_at'] });
  });

  it('别的租户的、或源表 / 实体与映射不一致的生成记录 400，不保存', async () => {
    const { acme, author, sourceId } = await tenantWithSource();
    const other = await newTenant('globex');
    const outsider = await memberOf(other, 'de@globex.com');
    const { id: theirSource } = await registerSource(outsider, await pgSourceInput(READER, '门店1'));
    await selectAllTables(outsider, theirSource);
    await drain();
    const theirs = await modelDraftFor(outsider, theirSource, 'orders', 'order');
    const customers = await modelDraftFor(author, sourceId, 'customers', 'customer');

    for (const generationId of [theirs.generationId, customers.generationId, 'not-a-uuid']) {
      const e = await failure(createMapping(author, sourceId, ORDERS, { generationId }));
      expect(e).toBeInstanceOf(MappingError);
      expect(e.status).toBe(400);
    }
    const mapping = await createMapping(author, sourceId, ORDERS);
    const e = await failure(saveMappingDraft(author, mapping.id, edited(ORDERS), { generationId: customers.generationId }));
    expect(e.status).toBe(400);
    expect(await edits(acme)).toHaveLength(0);
    expect((await generations(other))[0].mappingId).toBeNull();
  });
});

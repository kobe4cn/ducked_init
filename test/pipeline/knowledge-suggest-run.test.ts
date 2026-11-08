// test/pipeline/knowledge-suggest-run.test.ts —— 按主题生成知识提案的服务（ADR-0046 入口③，#512）的接缝：suggestForSubject →
// 注入的假 fetch（setLlmFetch）→ chatJson（llm_calls 记 knowledge_proposal）→ outputToProposals → 事务里 proposeMany（stale 按生成前的
// 依据快照）+ 写 knowledge_generations + 审计 knowledge_proposal.generated。同样的输入与生成器版本再点不调模型（fresh: false）；
// 拒绝过的提案不再出现（计 rejected）；模型失败 422 并记 generate_failed 审计（不含提示词与输出原文）；restricted 投影以外的内容不进提示词
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, knowledgeGenerations, knowledgeProposals, llmCalls } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { currentBases } from '../../app/.server/knowledge/basis';
import { rejectProposal } from '../../app/.server/knowledge/proposals';
import { SuggestError, suggestForSubject } from '../../app/.server/knowledge/suggest-run';
import { subjectInput, SUGGEST_GENERATOR_VERSION } from '../../app/.server/knowledge/suggest';
import { addMembership, createSubject, renameSubject } from '../../app/.server/knowledge/subjects';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { fakeLlm, json, platformDefault } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const REVENUE_V2 = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 新口径\n';
const USAGE = { prompt_tokens: 500, completion_tokens: 80 };

const calls = (tenantId: string) => getDb().select().from(llmCalls).where(eq(llmCalls.tenantId, tenantId));
const generations = (tenantId: string) => getDb().select().from(knowledgeGenerations).where(eq(knowledgeGenerations.tenantId, tenantId));
const auditsOf = (tenantId: string, action: string) => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, action)));

/** 模型返回的一批提案：给主题条目 metric:paid_revenue 提别名 / 口径 / 说明，把邻接条目归入主题；坏条目按参数补在后面 */
function modelOutput(bad: unknown[] = []) {
  return { proposals: [
    { kind: 'alias', targetId: 'metric:paid_revenue', alias: '流水暗号', evidence: [{ ref: 'entity:order' }], reason: '常用叫法' },
    { kind: 'claim', targetId: 'metric:paid_revenue', claim: { type: 'currency', value: 'CNY' }, evidence: [], reason: '币种' },
    { kind: 'note', targetId: 'metric:paid_revenue', note: '只算实付金额', evidence: [{ ref: 'entity:order' }], reason: '口径说明' },
    { kind: 'subject', targetId: 'entity:order', evidence: [{ ref: 'metric:paid_revenue' }], reason: '订单在主题里' },
    ...bad,
  ] };
}

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue，建主题「营收」并归入该指标 */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  const viewer = await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  const subjectId = await createSubject(analyst, '营收');
  await addMembership(analyst, subjectId, 'metric:paid_revenue');
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst, viewer, subjectId };
}

describe('按主题生成知识提案', () => {
  it('成功：提案带证据与 basedOn，llm_calls 记一条 knowledge_proposal，返回各类计数并记 generated 审计；代次行记提案数', async () => {
    const { acme, analyst, subjectId } = await setup();
    platformDefault();
    const { f } = fakeLlm(setLlmFetch, () => json(modelOutput(), USAGE));

    const out = await suggestForSubject(analyst, subjectId);
    expect(out).toEqual({ fresh: true, created: 4, existing: 0, rejected: 0, invalid: 0, stale: 0 });
    expect(f).toHaveBeenCalledTimes(1);
    const [call] = await calls(acme);
    expect(call).toMatchObject({ purpose: 'knowledge_proposal', model: 'qwen-plus', schemaValid: true,
      promptTokens: 500, completionTokens: 80, error: null });

    const rows = await getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, acme));
    expect(rows.map(r => [r.kind, r.targetId]).sort()).toEqual([
      ['alias', 'metric:paid_revenue'], ['claim', 'metric:paid_revenue'], ['note', 'metric:paid_revenue'], ['subject', 'entity:order'],
    ]);
    const alias = rows.find(r => r.kind === 'alias')!;
    expect(alias).toMatchObject({ evidence: [{ ref: 'entity:order' }], generatorVersion: SUGGEST_GENERATOR_VERSION, status: 'proposed' });
    const bases = await currentBases(getDb(), acme);
    expect(alias.basedOn).toEqual([{ id: 'metric:paid_revenue', hash: bases.get('metric:paid_revenue') }]);
    expect(rows.find(r => r.kind === 'claim')!.content).toEqual({ type: 'currency', value: 'unknown' }); // 无证据的口径声明记「未知」

    // 审计 detail 只有计数与 subjectId；代次行记新建数
    const [audit] = await auditsOf(acme, 'knowledge_proposal.generated');
    expect(audit).toMatchObject({ targetType: 'analysis_subject', targetId: subjectId,
      detail: { subjectId, created: 4, existing: 0, rejected: 0, invalid: 0, stale: 0 } });
    expect(await generations(acme)).toEqual([expect.objectContaining({
      subjectId, inputHash: expect.any(String), generatorVersion: SUGGEST_GENERATOR_VERSION,
      proposalCount: 4, createdByEmail: 'an@acme.com',
    })]);
  });

  it('提示词只放 restricted 投影：没有数据源名与源表名，条目只带知识依赖与关系', async () => {
    const { acme, analyst, subjectId } = await setup();
    platformDefault();
    const { received } = fakeLlm(setLlmFetch, () => json(modelOutput(), USAGE));
    const input = subjectInput(await tenantCatalog(acme), { id: subjectId, name: '营收' });

    await suggestForSubject(analyst, subjectId);
    const [system, user] = received[0]!.body.messages;
    const prompt = JSON.stringify([system, user]);
    // user 消息只放去掉 inputHash 的输入 JSON：主题与条目标识在，数据源与源表（restricted 投影整类不进）不在
    expect(user!.content).toContain('"subject":{"id":"' + subjectId + '","name":"营收"}');
    expect(prompt).toContain('metric:paid_revenue');
    for (const leak of ['会员', '埋点', 'customers', 'members', 'orders', 'events', 'consents']) expect(prompt).not.toContain(leak);
    expect(prompt).not.toContain(input.inputHash);
  });

  it('同样的输入与生成器版本再点：不发请求、不写入，返回 fresh: false；拒绝过的提案换名重新生成时计 rejected 不新建', async () => {
    const { acme, analyst, subjectId } = await setup();
    platformDefault();
    const { f } = fakeLlm(setLlmFetch, () => json(modelOutput(), USAGE));
    const first = await suggestForSubject(analyst, subjectId);
    expect(first).toMatchObject({ fresh: true, created: 4 });

    const second = await suggestForSubject(analyst, subjectId);
    expect(second).toEqual({ fresh: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect(await getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, acme))).toHaveLength(4);
    expect(await generations(acme)).toHaveLength(1);
    expect(await auditsOf(acme, 'knowledge_proposal.generated')).toHaveLength(1);

    // 拒绝别名提案后改名（inputHash 含主题名，改名会重新生成）：模型再返回同一条时计 rejected、不新建；仍待处理的三条指纹命中计 existing
    const rejected = (await getDb().select().from(knowledgeProposals)
      .where(and(eq(knowledgeProposals.tenantId, acme), eq(knowledgeProposals.kind, 'alias'))))[0]!;
    await rejectProposal(analyst, rejected.id, '不是这个叫法');
    await renameSubject(analyst, subjectId, '营收口径');
    const again = await suggestForSubject(analyst, subjectId);
    expect(again).toEqual({ fresh: true, created: 0, existing: 3, rejected: 1, invalid: 0, stale: 0 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(await generations(acme)).toHaveLength(2); // 改名后的输入是另一行
    expect((await getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, acme))).map(r => r.status).sort())
      .toEqual(['proposed', 'proposed', 'proposed', 'rejected']);
  });

  it('模型引用输入以外的条目时整条丢弃、计 invalid', async () => {
    const { acme, analyst, subjectId } = await setup();
    platformDefault();
    const bad = [
      { kind: 'alias', targetId: 'metric:paid_revenue', alias: '野路子', evidence: [{ ref: 'metric:nope' }], reason: '依据不在输入里' },
      { kind: 'note', targetId: 'entity:nope', note: '不存在的条目', evidence: [], reason: '目标不在输入里' },
    ];
    fakeLlm(setLlmFetch, () => json(modelOutput(bad), USAGE));
    const invalid = await suggestForSubject(analyst, subjectId);
    expect(invalid).toEqual({ fresh: true, created: 4, existing: 0, rejected: 0, invalid: 2, stale: 0 });
    const [audit] = await auditsOf(acme, 'knowledge_proposal.generated');
    expect(audit!.detail).toMatchObject({ created: 4, invalid: 2 });
    expect((await generations(acme))[0]!.proposalCount).toBe(4);
  });

  it('生成期间依据变了的目标计 stale 不写入：快照在调模型前取，模型应答前另一位成员发布指标 v2', async () => {
    const { acme, analyst, reviewer, subjectId } = await setup();
    await addMembership(analyst, subjectId, 'field:order.status'); // 普通字段没有依据、永不过期，用来对照
    platformDefault();
    setLlmFetch(async () => {
      await saveDslDraft(analyst, 'metric', 'paid_revenue', REVENUE_V2);
      await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
      return json({ proposals: [
        { kind: 'alias', targetId: 'metric:paid_revenue', alias: '营收合计', evidence: [{ ref: 'entity:order' }], reason: '依据已变' },
        { kind: 'note', targetId: 'field:order.status', note: '退款单也算一笔订单', evidence: [], reason: '字段没有依据' },
      ] }, USAGE);
    });
    const stale = await suggestForSubject(analyst, subjectId);
    expect(stale).toEqual({ fresh: true, created: 1, existing: 0, rejected: 0, invalid: 0, stale: 1 });
    expect((await generations(acme))[0]!.proposalCount).toBe(1);
    const rows = await getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, acme));
    expect(rows.filter(r => r.kind === 'alias')).toHaveLength(0);
    expect(rows.map(r => [r.kind, r.targetId])).toEqual([['note', 'field:order.status']]);
  });

  it('模型失败 422 并记 generate_failed 审计（不含提示词与输出原文），不留提案与代次行；查看者 403；未配置模型服务 409 且不发请求；主题不存在 400', async () => {
    const { acme, analyst, viewer, subjectId } = await setup();
    platformDefault();
    fakeLlm(setLlmFetch, () => new Response('upstream sk-platform-secret exploded', { status: 500 }));

    const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('应当失败'); }, (e: unknown) => e as SuggestError);
    const e = await failure(suggestForSubject(analyst, subjectId));
    expect(e).toBeInstanceOf(SuggestError);
    expect(e).toMatchObject({ status: 422, message: expect.stringContaining('500') });
    const [audit] = await auditsOf(acme, 'knowledge_proposal.generate_failed');
    expect(audit).toMatchObject({ targetType: 'analysis_subject', targetId: subjectId,
      detail: { subjectId, stage: 'model', error: expect.stringContaining('500') } });
    expect(JSON.stringify(audit!.detail)).not.toContain('sk-platform-secret');
    // detail 只有 subjectId、阶段与错误摘要，不含提示词（主题名、条目标识）与输出原文（别名）
    expect(JSON.stringify(audit!.detail)).not.toContain('营收');
    expect(JSON.stringify(audit!.detail)).not.toContain('metric:paid_revenue');
    expect(JSON.stringify(audit!.detail)).not.toContain('流水暗号');
    expect((await calls(acme))[0]).toMatchObject({ purpose: 'knowledge_proposal', error: expect.stringContaining('500') });
    expect(await getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, acme))).toHaveLength(0);
    expect(await generations(acme)).toHaveLength(0);
    // 失败后不记代次行，再点还会调模型
    platformDefault();
    const { f } = fakeLlm(setLlmFetch, () => json(modelOutput(), USAGE));
    const retry = await suggestForSubject(analyst, subjectId);
    expect(retry).toMatchObject({ fresh: true, created: 4 });
    expect(f).toHaveBeenCalledTimes(1);

    await expect(suggestForSubject(viewer, subjectId)).rejects.toMatchObject({ init: { status: 403 } });
    vi.stubEnv('LLM_BASE_URL', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_API_KEY', '');
    const none = await failure(suggestForSubject(analyst, subjectId));
    expect(none).toMatchObject({ status: 409, message: expect.stringContaining('未配置模型服务') });
    expect((await calls(acme)).filter(c => c.error === null)).toHaveLength(1); // 只有失败后那次重试成功，409 不发请求
    await expect(suggestForSubject(analyst, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 400, message: '没有这个主题' });
  });
});

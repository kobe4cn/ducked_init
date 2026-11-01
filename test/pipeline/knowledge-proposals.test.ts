// test/pipeline/knowledge-proposals.test.ts —— 知识提案（ADR-0046）的接缝：proposeKnowledge → knowledge_proposals（接受前不进 tenantCatalog、search
// 与 modelDraftForDefinition 发给模型的消息）→ acceptProposal 生成别名 / 口径声明 / 业务说明（审计、目录版本），rejectProposal 按指纹记下、不再提出
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, businessNotes, catalogVersions, knowledgeAliases, knowledgeProposals, semanticClaims } from '../../app/.server/db/schema';
import { createDefinition, modelDraftForDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { acceptProposal, listProposals, proposeKnowledge, rejectProposal, type ProposalInput } from '../../app/.server/knowledge/proposals';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { fakeLlm, json, platformDefault } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const SPENDER = 'metric: paid_revenue\nrules:\n  - { value: high, when: { gte: 1000 } }\ndefault: low\n';
const GEN = 'test-gen-1';
const EVIDENCE = [{ ref: 'metric:paid_revenue', version: 1 }];

const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];
const proposalRows = (tenantId: string) => getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, tenantId));
const audits = (tenantId: string) => getDb().select().from(auditLogs)
  .where(eq(auditLogs.tenantId, tenantId)).then(rows => rows.filter(r => r.action.startsWith('knowledge_proposal.')));
const propose = (tenantId: string, input: Omit<ProposalInput, 'evidence' | 'generatorVersion'> & Partial<ProposalInput>) =>
  getDb().transaction(tx => proposeKnowledge(tx, tenantId, { evidence: EVIDENCE, generatorVersion: GEN, ...input }));

/** 做一件事，断言目录版本 +1、原因是 reason */
async function expectBump<T>(tenantId: string, reason: string, act: () => Promise<T>): Promise<T> {
  const before = (await latestVersion(tenantId))?.version ?? 0;
  const out = await act();
  expect(await latestVersion(tenantId), reason).toMatchObject({ version: before + 1, reason });
  return out;
}

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue 与标签 spender（作者与发布者是两个人） */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  const viewer = await memberOf(s.acme, 'view@acme.com', 'viewer');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  await createDefinition(analyst, 'tag', 'spender', SPENDER);
  await publishDefinition(s.reviewer, 'tag', 'spender', 1);
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst, viewer };
}

/** 让模型起草「统计退款单」，返回发给模型的消息里「与需求相关的条目」一段 */
async function draftContext(analyst: Awaited<ReturnType<typeof setup>>['analyst']) {
  platformDefault();
  const { received } = fakeLlm(setLlmFetch, () => json({ base: 'order', measure: { agg: 'count' } }, { prompt_tokens: 10, completion_tokens: 10 }));
  await modelDraftForDefinition(analyst, 'metric', '统计退款单');
  return received[0]!.body.messages[1]!.content.split('# 与需求相关的条目')[1]!.split('# 需求')[0]!;
}

describe('知识提案', () => {
  it('提案接受前不进目录、检索与起草上下文，接受后才进；指纹相同返回已有的那条，命中已拒绝的返回 null 且不写入；目标或声明不合法 400', async () => {
    const { acme, analyst, mappings } = await setup();
    const alias = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'alias', claim: { alias: '流水暗号' } }))!;
    const claim = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'claim', claim: { type: 'currency', value: 'USD' } }))!;
    const note = (await propose(acme, { targetId: 'field:order.status', kind: 'note', claim: { note: '退款单也算一笔订单，状态记为 refunded' } }))!;
    expect(alias).toMatchObject({ status: 'proposed', kind: 'alias', evidence: EVIDENCE, generatorVersion: GEN, basedOn: [{ id: 'metric:paid_revenue' }] });

    let c = await tenantCatalog(acme);
    expect(expand(c, 'metric:paid_revenue')).not.toHaveProperty('knowledge');
    expect(toMarkdown(expand(c, 'field:order.status')!)).not.toContain('退款单也算');
    expect(search(c, '流水暗号').map(e => toMarkdown(e)).join('\n')).not.toContain('流水暗号');
    expect(await draftContext(analyst)).not.toContain('退款单也算');

    // 同样的提案再次提出：返回已有的那条，不写入（声明里多余的键不影响指纹）
    expect(await propose(acme, { targetId: 'metric:paid_revenue', kind: 'alias', claim: { alias: '流水暗号', extra: 1 }, generatorVersion: 'other' })).toMatchObject({ id: alias.id });
    await rejectProposal(analyst, claim.id, '币种不对');
    expect(await propose(acme, { targetId: 'metric:paid_revenue', kind: 'claim', claim: { type: 'currency', value: 'USD' } })).toBeNull();
    expect(await proposalRows(acme)).toHaveLength(3);

    // 不合法的提案 400、不写入
    const bad: Parameters<typeof propose>[1][] = [
      { targetId: 'metric:nope', kind: 'alias', claim: { alias: 'x' } },
      { targetId: 'field:customer.phone', kind: 'note', claim: { note: 'x' } },
      { targetId: 'field:order.status', mappingId: mappings.tracking, kind: 'alias', claim: { alias: 'x' } },
      { targetId: 'entity:order', kind: 'alias', claim: { alias: '  ' } },
      { targetId: 'entity:order', kind: 'claim', claim: { type: 'currency', value: 'XYZ' } },
      { targetId: 'entity:order', kind: 'note', claim: { note: 1 } },
      { targetId: 'entity:order', kind: 'subject' as never, claim: {} },
      { targetId: 'entity:order', kind: 'alias', claim: { alias: 'x' }, evidence: [{ ref: '' }] },
    ];
    for (const input of bad) await expect(propose(acme, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400 });
    expect(await proposalRows(acme)).toHaveLength(3);

    await acceptProposal(analyst, note.id);
    await acceptProposal(analyst, alias.id);
    c = await tenantCatalog(acme);
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({ knowledge: { aliases: ['流水暗号'] } });
    expect(search(c, '流水暗号')[0]?.id).toBe('metric:paid_revenue');
    expect(await draftContext(analyst)).toContain('业务说明：退款单也算一笔订单，状态记为 refunded');
    expect((await listProposals(getDb(), acme, { status: 'proposed' }))).toHaveLength(0);
    expect((await listProposals(getDb(), acme, { targetId: 'metric:paid_revenue' })).map(p => p.status).sort()).toEqual(['accepted', 'rejected']);
  });

  it('接受（可以先改值）生成别名、口径声明、业务说明，作者是接受的成员，提案关联到生成的知识并记审计与目录版本；拒绝记理由与审计', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const loyalty = orderMappings!.loyalty;
    const alias = (await propose(acme, { targetId: 'entity:order', kind: 'alias', claim: { alias: '交易单' } }))!;
    const claim = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'claim', claim: { type: 'currency', value: 'USD' } }))!;
    const fieldNote = (await propose(acme, { targetId: 'field:order.status', mappingId: loyalty, kind: 'note', claim: { note: '会员单的状态' } }))!;
    const tagNote = (await propose(acme, { targetId: 'tag:spender', kind: 'note', claim: { note: '高消费人群' } }))!;
    const rejected = (await propose(acme, { targetId: 'entity:order', kind: 'alias', claim: { alias: '暗号' } }))!;

    const a = await expectBump(acme, 'alias.added', () => acceptProposal(analyst, alias.id, { alias: '交易订单' }));
    const b = await expectBump(acme, 'semantic_claim.saved', () => acceptProposal(analyst, claim.id));
    const n = await expectBump(acme, 'business_note.updated', () => acceptProposal(author, fieldNote.id));
    const t = await expectBump(acme, 'business_note.updated', () => acceptProposal(analyst, tagNote.id, { note: '近一年高消费人群' }));
    const before = (await latestVersion(acme))!.version;
    const r = await rejectProposal(analyst, rejected.id, '  不是这个意思 ');
    expect((await latestVersion(acme))!.version).toBe(before);

    // 改过值的：生成的知识用改后的值，提案的声明与指纹不变
    expect(a).toMatchObject({ status: 'accepted', reviewedByEmail: 'an@acme.com', claim: { alias: '交易单' }, fingerprint: alias.fingerprint });
    expect(a.reviewedAt).toBeInstanceOf(Date);
    const [aliasRow] = await getDb().select().from(knowledgeAliases).where(eq(knowledgeAliases.id, a.acceptedRef!));
    expect(aliasRow).toMatchObject({ tenantId: acme, targetId: 'entity:order', alias: '交易订单', createdByEmail: 'an@acme.com' });
    const [claimRow] = await getDb().select().from(semanticClaims).where(eq(semanticClaims.id, b.acceptedRef!));
    expect(claimRow).toMatchObject({ targetId: 'metric:paid_revenue', claimType: 'currency', value: 'USD', createdByEmail: 'an@acme.com' });
    const [noteRow] = await getDb().select().from(businessNotes).where(eq(businessNotes.id, n.acceptedRef!));
    expect(noteRow).toMatchObject({ entity: 'order', field: 'status', mappingId: loyalty, targetId: null, note: '会员单的状态', createdByEmail: author.email });
    const [tagRow] = await getDb().select().from(businessNotes).where(eq(businessNotes.id, t.acceptedRef!));
    expect(tagRow).toMatchObject({ targetId: 'tag:spender', note: '近一年高消费人群', createdByEmail: 'an@acme.com' });
    expect(r).toMatchObject({ status: 'rejected', rejectedReason: '不是这个意思', reviewedByEmail: 'an@acme.com', acceptedRef: null });

    const c = await tenantCatalog(acme);
    expect(expand(c, 'entity:order')).toMatchObject({ knowledge: { aliases: ['交易订单'] } });
    expect(expand(c, 'tag:spender')).toMatchObject({ knowledge: { note: '近一年高消费人群' } });

    const logs = await audits(acme);
    expect(logs.map(l => [l.action, l.targetType, l.targetId, l.actorEmail, l.detail])).toEqual(expect.arrayContaining([
      ['knowledge_proposal.accepted', 'knowledge_proposal', alias.id, 'an@acme.com', { proposalId: alias.id, kind: 'alias', targetId: 'entity:order' }],
      ['knowledge_proposal.accepted', 'knowledge_proposal', claim.id, 'an@acme.com', { proposalId: claim.id, kind: 'claim', targetId: 'metric:paid_revenue' }],
      ['knowledge_proposal.accepted', 'knowledge_proposal', fieldNote.id, author.email, { proposalId: fieldNote.id, kind: 'note', targetId: 'field:order.status' }],
      ['knowledge_proposal.accepted', 'knowledge_proposal', tagNote.id, 'an@acme.com', { proposalId: tagNote.id, kind: 'note', targetId: 'tag:spender' }],
      ['knowledge_proposal.rejected', 'knowledge_proposal', rejected.id, 'an@acme.com', { proposalId: rejected.id, kind: 'alias', targetId: 'entity:order' }],
    ]));
    expect(logs).toHaveLength(5);
    expect(JSON.stringify(logs)).not.toMatch(/暗号|不是这个意思|交易单|高消费人群/);
  });

  it('依据已变化时接受 409，已处理的再处理 409，不存在或别的租户的 404；查看者 403，分析师处理映射字段提案 403；生成知识出错时提案仍待处理', async () => {
    const { acme, author, reviewer, analyst, viewer, orderMappings } = await setup();
    const stale = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'alias', claim: { alias: '营收' } }))!;
    await saveDslDraft(analyst, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 新口径\n');
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    await expect(acceptProposal(analyst, stale.id)).rejects.toMatchObject({ status: 409, message: '依据已变化' });

    const mapped = (await propose(acme, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, kind: 'alias', claim: { alias: '会员单状态' } }))!;
    const plain = (await propose(acme, { targetId: 'entity:order', kind: 'alias', claim: { alias: '交易单' } }))!;
    await expect(acceptProposal(viewer, plain.id)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(rejectProposal(viewer, plain.id, 'x')).rejects.toMatchObject({ init: { status: 403 } });
    await expect(acceptProposal(analyst, mapped.id)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(rejectProposal(analyst, mapped.id, 'x')).rejects.toMatchObject({ init: { status: 403 } });

    // 生成知识出错（别名已有）时整体回滚，提案仍待处理；改个值再接受就行
    await addAlias(analyst, { targetId: 'entity:order', alias: '交易单' });
    await expect(acceptProposal(analyst, plain.id)).rejects.toMatchObject({ status: 400 });
    await expect(acceptProposal(analyst, plain.id, { alias: '' })).rejects.toMatchObject({ status: 400 });
    expect((await proposalRows(acme)).find(p => p.id === plain.id)).toMatchObject({ status: 'proposed', acceptedRef: null });
    await acceptProposal(analyst, plain.id, { alias: '交易记录' });
    await expect(acceptProposal(analyst, plain.id)).rejects.toMatchObject({ status: 409 });
    await expect(rejectProposal(analyst, plain.id, 'x')).rejects.toMatchObject({ status: 409 });
    await rejectProposal(author, mapped.id, '');
    await expect(acceptProposal(author, mapped.id)).rejects.toMatchObject({ status: 409 });

    const other = await memberOf(await newTenant('globex'), 'an@globex.com', 'analyst');
    for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      await expect(acceptProposal(analyst, id)).rejects.toMatchObject({ status: 404 });
      await expect(rejectProposal(analyst, id, 'x')).rejects.toMatchObject({ status: 404 });
    }
    await expect(acceptProposal(other, stale.id)).rejects.toMatchObject({ status: 404 });

    expect((await audits(acme)).map(l => l.action).sort()).toEqual(['knowledge_proposal.accepted', 'knowledge_proposal.rejected']);
  });
});

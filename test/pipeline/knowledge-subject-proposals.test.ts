// test/pipeline/knowledge-subject-proposals.test.ts —— 主题归属提案（ADR-0046 的第四种知识提案）的接缝：proposeKnowledge 校验 subjectId
// 是 UUID 且主题属于本租户、未删除，映射字段不能提主题归属（都 400 不写入）；acceptProposal 走 addMembershipTx（ifAbsent）：
// 条目进主题、审计 subject_membership.added、目录版本 +1、acceptedRef 是主题 ID，条目已在主题里时接受也成功且不重复插入不记版本；
// 主题归属不提供修改后接受（带 edits 400、提案仍 proposed）；拒绝后同指纹不再提出；提出后主题被删再接受 400、提案仍 proposed
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, catalogVersions, knowledgeProposals, subjectMemberships } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { acceptProposal, proposeKnowledge, rejectProposal, type ProposalInput } from '../../app/.server/knowledge/proposals';
import { addMembership, createSubject, deleteSubject } from '../../app/.server/knowledge/subjects';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const GEN = 'test-gen-1';
const EVIDENCE = [{ ref: 'metric:paid_revenue', version: 1 }];

const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];
const proposalRows = (tenantId: string) => getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, tenantId));
const memberships = (tenantId: string) => getDb().select().from(subjectMemberships).where(eq(subjectMemberships.tenantId, tenantId));
const addedAudits = (tenantId: string) => getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'subject_membership.added')));
const propose = (tenantId: string, input: Omit<ProposalInput, 'evidence' | 'generatorVersion'>) =>
  getDb().transaction(tx => proposeKnowledge(tx, tenantId, { evidence: EVIDENCE, generatorVersion: GEN, ...input }));

/** 做一件事，断言目录版本 +1、原因是 reason */
async function expectBump<T>(tenantId: string, reason: string, act: () => Promise<T>): Promise<T> {
  const before = (await latestVersion(tenantId))?.version ?? 0;
  const out = await act();
  expect(await latestVersion(tenantId), reason).toMatchObject({ version: before + 1, reason });
  return out;
}

/** 身份打通数据源与订单映射，加一位分析师，发布指标 paid_revenue，建主题「营收」 */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  await createDefinition(analyst, 'metric', 'paid_revenue', REVENUE);
  await publishDefinition(s.reviewer, 'metric', 'paid_revenue', 1);
  const subjectId = await createSubject(analyst, '营收');
  await tenantCatalog(s.acme); // 先把读取时的补记做掉
  return { ...s, analyst, subjectId };
}

describe('主题归属提案', () => {
  it('提出：subjectId 合法时写入；不是 UUID、别的租户的主题、已删除的主题、映射字段时 400 不写入', async () => {
    const { acme, analyst, subjectId, orderMappings } = await setup();
    expect(await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId } }))
      .toMatchObject({ status: 'proposed', kind: 'subject', content: { subjectId } });
    expect(await proposalRows(acme)).toHaveLength(1);

    const other = await memberOf(await newTenant('globex'), 'an@globex.com', 'analyst');
    const foreign = await createSubject(other, '他家的主题');
    const gone = await createSubject(analyst, '要删的主题');
    await deleteSubject(analyst, gone);
    const bad: (Parameters<typeof propose>[1] & { message?: string })[] = [
      { targetId: 'metric:paid_revenue', kind: 'subject', content: {} },
      { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: 'not-a-uuid' } },
      // 是 UUID 但不是主题，与别的租户、已删除的主题同样拦下
      { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: analyst.tenant.id } },
      { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: foreign } },
      { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: gone }, message: '没有这个主题' },
    ];
    for (const { message, ...input } of bad) {
      await expect(propose(acme, input), JSON.stringify(input)).rejects.toMatchObject(message ? { status: 400, message } : { status: 400 });
    }
    // 映射字段不能归入主题（目标本身合法，拦在种类校验上）
    await expect(propose(acme, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, kind: 'subject', content: { subjectId } }))
      .rejects.toMatchObject({ status: 400, message: '映射字段不能归入主题' });
    expect(await proposalRows(acme)).toHaveLength(1);
  });

  it('接受：条目进主题（同 addMembership 的审计与目录版本 +1），acceptedRef 是主题 ID；已在主题里时接受也成功、不重复插入不记版本；带 edits 400 且提案仍 proposed', async () => {
    const { acme, analyst, subjectId } = await setup();
    const p = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId } }))!;
    expect(p).toMatchObject({ status: 'proposed', kind: 'subject', content: { subjectId }, basedOn: [{ id: 'metric:paid_revenue' }] });

    // 不提供修改后接受：带 edits 400，提案仍待处理
    await expect(acceptProposal(analyst, p.id, { subjectId: subjectId })).rejects.toMatchObject({ status: 400, message: '主题归属提案不能修改后接受' });
    expect((await proposalRows(acme)).find(r => r.id === p.id)).toMatchObject({ status: 'proposed', acceptedRef: null });

    const a = await expectBump(acme, 'subject_membership.added', () => acceptProposal(analyst, p.id));
    expect(a).toMatchObject({ status: 'accepted', reviewedByEmail: 'an@acme.com', acceptedRef: subjectId, content: { subjectId }, fingerprint: p.fingerprint });
    expect(await memberships(acme)).toEqual([expect.objectContaining({
      subjectId, targetId: 'metric:paid_revenue', createdByEmail: 'an@acme.com',
    })]);
    expect((await addedAudits(acme)).map(l => [l.targetId, l.detail])).toEqual([[subjectId, { subjectId, targetId: 'metric:paid_revenue' }]]);
    expect(expand(await tenantCatalog(acme), 'metric:paid_revenue')).toMatchObject({ knowledge: { subjects: ['营收'] } });

    // 条目已在主题里（手动加过）时接受也成功：不重复插入、不记新的 subject_membership.added、目录版本不变
    const other = await createSubject(analyst, '复购');
    await addMembership(analyst, other, 'metric:paid_revenue');
    const dup = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: other } }))!;
    const before = (await latestVersion(acme))!.version;
    expect(await acceptProposal(analyst, dup.id)).toMatchObject({ status: 'accepted', acceptedRef: other });
    expect((await latestVersion(acme))!.version).toBe(before);
    expect(await memberships(acme)).toHaveLength(2);
    expect((await addedAudits(acme)).filter(l => l.detail?.subjectId === other)).toHaveLength(1);
  });

  it('拒绝后同一内容再提出返回 null；提出后主题被删，再接受 400、提案仍 proposed、条目没进主题', async () => {
    const { acme, analyst, subjectId } = await setup();
    const p = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId } }))!;
    await rejectProposal(analyst, p.id, '不该归这里');
    expect(await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId } })).toBeNull();

    const subject2 = await createSubject(analyst, '复购');
    const q = (await propose(acme, { targetId: 'metric:paid_revenue', kind: 'subject', content: { subjectId: subject2 } }))!;
    await deleteSubject(analyst, subject2);
    await expect(acceptProposal(analyst, q.id)).rejects.toMatchObject({ status: 400, message: '没有这个主题' });
    expect((await proposalRows(acme)).find(r => r.id === q.id)).toMatchObject({ status: 'proposed', acceptedRef: null });
    expect(await memberships(acme)).toHaveLength(0);
  });
});

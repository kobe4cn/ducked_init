// test/pipeline/knowledge-subjects.test.ts —— 分析主题与主题归属（ADR-0046）的接缝：createSubject / renameSubject / deleteSubject /
// addMembership / removeMembership → analysis_subjects、subject_memberships 与审计、目录版本 → tenantCatalog 条目的 knowledge.subjects、search 与 Markdown
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { analysisSubjects, auditLogs, catalogVersions, subjectMemberships } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import {
  addMembership, createSubject, deleteSubject, listSubjects, removeMembership, renameSubject,
} from '../../app/.server/knowledge/subjects';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const SPENDER = 'metric: paid_revenue\nrules:\n  - { value: high, when: { gte: 1000 } }\ndefault: low\n';

const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];
const audits = (tenantId: string) => getDb().select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId))
  .then(rows => rows.filter(r => r.action.startsWith('analysis_subject.') || r.action.startsWith('subject_membership.')));

/** 做一件事，断言目录版本 +1、原因是 reason */
async function expectBump<T>(tenantId: string, reason: string, act: () => Promise<T>): Promise<T> {
  const before = (await latestVersion(tenantId))?.version ?? 0;
  const out = await act();
  expect(await latestVersion(tenantId), reason).toMatchObject({ version: before + 1, reason });
  return out;
}

/** 身份打通数据源与订单映射，加一位分析师、一位查看者，发布指标 paid_revenue 与标签 spender */
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

const TARGETS = ['entity:order', 'field:order.status', 'metric:paid_revenue', 'tag:spender'];

describe('分析主题', () => {
  it('建主题、把实体 / 字段 / 指标 / 标签加入：条目带 knowledge.subjects（按 cmpName 排）、能用主题名搜到、Markdown 列出；改名跟着变；移出与删主题后归属消失', async () => {
    const { acme, analyst } = await setup();
    // 没有归属的主题不改目录：建主题记审计但不记版本
    const before = (await latestVersion(acme))!.version;
    const growth = await createSubject(analyst, '  增长看板 ');
    const loyalty = await createSubject(analyst, '复购研究');
    expect((await latestVersion(acme))!.version).toBe(before);
    expect(await listSubjects(getDb(), acme)).toEqual([{ id: loyalty, name: '复购研究' }, { id: growth, name: '增长看板' }]);

    for (const t of TARGETS) await expectBump(acme, 'subject_membership.added', () => addMembership(analyst, growth, t));
    await expectBump(acme, 'subject_membership.added', () => addMembership(analyst, loyalty, 'metric:paid_revenue'));

    let c = await tenantCatalog(acme);
    for (const t of TARGETS) expect(expand(c, t), t).toMatchObject({ knowledge: { subjects: t === 'metric:paid_revenue' ? ['复购研究', '增长看板'] : ['增长看板'] } });
    expect(search(c, '增长看板').map(e => e.id)).toEqual(expect.arrayContaining(TARGETS));
    expect(search(c, '复购研究')[0]?.id).toBe('metric:paid_revenue');
    expect(toMarkdown(expand(c, 'entity:order')!)).toContain('- 分析主题：增长看板');
    // 映射血缘项上不挂主题
    const status = expand(c, 'field:order.status')!;
    expect(status.kind === 'field' && status.lineage.some(l => 'knowledge' in l)).toBe(false);

    await expectBump(acme, 'analysis_subject.renamed', () => renameSubject(analyst, growth, '拉新看板'));
    c = await tenantCatalog(acme);
    expect(expand(c, 'tag:spender')).toMatchObject({ knowledge: { subjects: ['拉新看板'] } });
    expect(search(c, '拉新看板').map(e => e.id)).toEqual(expect.arrayContaining(TARGETS));
    expect(search(c, '增长看板').map(e => toMarkdown(e)).join('\n')).not.toContain('增长看板');

    await expectBump(acme, 'subject_membership.removed', () => removeMembership(analyst, growth, 'tag:spender'));
    expect(expand(await tenantCatalog(acme), 'tag:spender')).not.toHaveProperty('knowledge');

    await expectBump(acme, 'analysis_subject.deleted', () => deleteSubject(analyst, growth));
    c = await tenantCatalog(acme);
    for (const t of ['entity:order', 'field:order.status']) expect(expand(c, t), t).not.toHaveProperty('knowledge');
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({ knowledge: { subjects: ['复购研究'] } });
    expect(await getDb().select().from(subjectMemberships).where(eq(subjectMemberships.tenantId, acme))).toEqual([
      expect.objectContaining({ subjectId: loyalty, targetId: 'metric:paid_revenue', createdByEmail: 'an@acme.com' }),
    ]);
    expect(await listSubjects(getDb(), acme)).toEqual([{ id: loyalty, name: '复购研究' }]);
  });

  it('五个动作各记审计，detail 只有 subjectId（与 targetId），不含主题名', async () => {
    const { acme, analyst } = await setup();
    const s = await createSubject(analyst, '暗号甲乙');
    await addMembership(analyst, s, 'entity:order');
    await renameSubject(analyst, s, '暗号丙丁');
    await removeMembership(analyst, s, 'entity:order');
    await deleteSubject(analyst, s);
    const logs = await audits(acme);
    expect(logs.map(l => [l.action, l.targetType, l.targetId, l.detail])).toEqual(expect.arrayContaining([
      ['analysis_subject.created', 'analysis_subject', s, { subjectId: s }],
      ['subject_membership.added', 'analysis_subject', s, { subjectId: s, targetId: 'entity:order' }],
      ['analysis_subject.renamed', 'analysis_subject', s, { subjectId: s }],
      ['subject_membership.removed', 'analysis_subject', s, { subjectId: s, targetId: 'entity:order' }],
      ['analysis_subject.deleted', 'analysis_subject', s, { subjectId: s }],
    ]));
    expect(logs).toHaveLength(5);
    expect(JSON.stringify(logs)).not.toMatch(/暗号/);
  });

  it('重名（不分大小写）、名字长度不对、目标不合法（含敏感字段与映射字段）、重复归属、别的租户的主题时 400 且不留记录；查看者 403', async () => {
    const { acme, analyst, viewer } = await setup();
    const s = await createSubject(analyst, 'GMV 分析');
    const t = await createSubject(analyst, '会员');
    await addMembership(analyst, s, 'metric:paid_revenue');
    const other = await newTenant('globex');
    const outsider = await createSubject(await memberOf(other, 'an@globex.com', 'analyst'), '外部主题');
    const before = (await latestVersion(acme))!.version;

    for (const name of ['gmv 分析', ' GMV 分析 ', '   ', '字'.repeat(31), 42]) {
      await expect(createSubject(analyst, name), String(name)).rejects.toMatchObject({ status: 400 });
    }
    await expect(renameSubject(analyst, t, 'gmv 分析')).rejects.toMatchObject({ status: 400 });
    await expect(renameSubject(analyst, outsider, '换名')).rejects.toMatchObject({ status: 400 });
    await expect(createSubject(analyst, '字'.repeat(30))).resolves.toEqual(expect.any(String));
    await renameSubject(analyst, s, 'gmv 分析'); // 自己改大小写可以

    for (const target of ['entity:nope', 'field:order.nope', 'metric:nope', 'tag:nope', 'source:CRM', 'field:customer.phone', 'field:customer.email', '', 'metric:paid_revenue']) {
      await expect(addMembership(analyst, s, target), target).rejects.toMatchObject({ status: 400 });
    }
    for (const subject of [outsider, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      await expect(addMembership(analyst, subject, 'entity:order'), subject).rejects.toMatchObject({ status: 400 });
    }
    await expect(removeMembership(analyst, s, 'entity:order')).rejects.toMatchObject({ status: 400 });
    await expect(deleteSubject(analyst, outsider)).rejects.toMatchObject({ status: 400 });

    await expect(createSubject(viewer, '查看者的')).rejects.toMatchObject({ init: { status: 403 } });
    await expect(renameSubject(viewer, s, '改')).rejects.toMatchObject({ init: { status: 403 } });
    await expect(deleteSubject(viewer, s)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(addMembership(viewer, t, 'entity:order')).rejects.toMatchObject({ init: { status: 403 } });
    await expect(removeMembership(viewer, s, 'metric:paid_revenue')).rejects.toMatchObject({ init: { status: 403 } });

    expect((await getDb().select().from(analysisSubjects).where(eq(analysisSubjects.tenantId, acme))).map(r => r.name).sort())
      .toEqual(['gmv 分析', '会员', '字'.repeat(30)].sort());
    expect(await getDb().select().from(subjectMemberships).where(eq(subjectMemberships.tenantId, acme))).toHaveLength(1);
    expect((await latestVersion(acme))!.version).toBe(before + 1); // 只有改名（有归属）记了一版
    expect((await audits(acme)).map(l => l.action).sort()).toEqual([
      'analysis_subject.created', 'analysis_subject.created', 'analysis_subject.created', 'analysis_subject.renamed', 'subject_membership.added',
    ]);
  });
});

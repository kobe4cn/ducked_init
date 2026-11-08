// test/pipeline/knowledge-aliases.test.ts —— 别名（ADR-0046）的接缝：addAlias / retireAlias → knowledge_aliases 与审计、目录版本 →
// tenantCatalog 的条目（映射字段在血缘项下）、search 与 Markdown
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, search, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, catalogVersions, knowledgeAliases } from '../../app/.server/db/schema';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { addAlias, retireAlias } from '../../app/.server/knowledge/aliases';
import { definitionHash, planHash } from '../../app/.server/knowledge/basis';
import { publishedPlans } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const REVENUE = 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n';
const SPENDER = 'metric: paid_revenue\nrules:\n  - { value: high, when: { gte: 1000 } }\ndefault: low\n';

const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];
const aliasRows = (tenantId: string) => getDb().select().from(knowledgeAliases).where(eq(knowledgeAliases.tenantId, tenantId));
const audits = (tenantId: string) => getDb().select().from(auditLogs)
  .where(eq(auditLogs.tenantId, tenantId)).then(rows => rows.filter(r => r.action.startsWith('alias.')));

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

describe('别名', () => {
  it('分析师给实体、字段、指标、标签加别名，数据工程师给映射字段加别名：进目录、能搜到、Markdown 列出；停用后都不再出现，行留着', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const loyalty = orderMappings!.loyalty;
    const ids = {
      entity: await expectBump(acme, 'alias.added', () => addAlias(analyst, { targetId: 'entity:order', alias: '  交易单 ' })),
      field: await expectBump(acme, 'alias.added', () => addAlias(analyst, { targetId: 'field:order.status', alias: '单据状态' })),
      metric: await expectBump(acme, 'alias.added', () => addAlias(analyst, { targetId: 'metric:paid_revenue', alias: '营收' })),
      tag: await expectBump(acme, 'alias.added', () => addAlias(analyst, { targetId: 'tag:spender', alias: '高消费' })),
      mapping: await expectBump(acme, 'alias.added', () => addAlias(author, { targetId: 'field:order.status', mappingId: loyalty, alias: '会员单状态' })),
    };

    let c = await tenantCatalog(acme);
    expect(expand(c, 'entity:order')).toMatchObject({ knowledge: { aliases: ['交易单'] } });
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({ knowledge: { aliases: ['营收'] } });
    expect(expand(c, 'tag:spender')).toMatchObject({ knowledge: { aliases: ['高消费'] } });
    const status = expand(c, 'field:order.status')!;
    expect(status).toMatchObject({ knowledge: { aliases: ['单据状态'] } });
    const lineage = status.kind === 'field' ? status.lineage : [];
    expect(lineage.find(l => l.source === '会员')).toMatchObject({ knowledge: { aliases: ['会员单状态'] } });
    expect(lineage.find(l => l.source === 'CRM')).not.toHaveProperty('knowledge');
    for (const [q, id] of [['交易单', 'entity:order'], ['单据状态', 'field:order.status'], ['营收', 'metric:paid_revenue'], ['高消费', 'tag:spender'], ['会员单状态', 'field:order.status']]) {
      expect(search(c, q)[0]?.id, q).toBe(id);
    }
    expect(toMarkdown(status)).toContain('- 别名：单据状态');
    expect(toMarkdown(status)).toContain('会员单状态');
    expect(toMarkdown(expand(c, 'metric:paid_revenue')!)).toContain('- 别名：营收');

    for (const id of Object.values(ids).slice(0, 4)) await expectBump(acme, 'alias.retired', () => retireAlias(analyst, id));
    await expectBump(acme, 'alias.retired', () => retireAlias(author, ids.mapping));
    c = await tenantCatalog(acme);
    expect(c.entries.some(e => 'knowledge' in e || (e.kind === 'field' && e.lineage.some(l => 'knowledge' in l)))).toBe(false);
    for (const q of ['交易单', '单据状态', '营收', '高消费', '会员单状态']) expect(search(c, q).map(e => toMarkdown(e)).join('\n'), q).not.toContain(q);

    const rows = await aliasRows(acme);
    expect(rows).toHaveLength(5);
    expect(rows.every(r => r.retiredAt instanceof Date)).toBe(true);
    expect(rows.find(r => r.id === ids.entity)).toMatchObject({ alias: '交易单', retiredByEmail: 'an@acme.com', createdByEmail: 'an@acme.com' });

    // 停用后可以再加同名的
    await addAlias(analyst, { targetId: 'entity:order', alias: '交易单' });
    expect(expand(await tenantCatalog(acme), 'entity:order')).toMatchObject({ knowledge: { aliases: ['交易单'] } });
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('加与停用记审计 alias.added / alias.retired，detail 只有 targetId 与 mappingId，不含别名原文', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const a = await addAlias(analyst, { targetId: 'field:order.status', alias: '暗号甲乙' });
    const b = await addAlias(author, { targetId: 'field:order.status', mappingId: orderMappings!.crm, alias: '暗号丙丁' });
    await retireAlias(analyst, a);
    const logs = await audits(acme);
    expect(logs.map(l => [l.action, l.targetType, l.targetId, l.detail])).toEqual(expect.arrayContaining([
      ['alias.added', 'knowledge', a, { targetId: 'field:order.status', mappingId: null }],
      ['alias.added', 'knowledge', b, { targetId: 'field:order.status', mappingId: orderMappings!.crm }],
      ['alias.retired', 'knowledge', a, { targetId: 'field:order.status', mappingId: null }],
    ]));
    expect(logs).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toMatch(/暗号/);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('based_on：指标与标签是已发布 YAML 的摘要，映射字段是该映射已发布计划的摘要，实体与普通字段为空', async () => {
    const { acme, author, analyst, orderMappings } = await setup();
    const loyalty = orderMappings!.loyalty;
    await addAlias(analyst, { targetId: 'entity:order', alias: '交易单' });
    await addAlias(analyst, { targetId: 'field:order.status', alias: '单据状态' });
    await addAlias(analyst, { targetId: 'metric:paid_revenue', alias: '营收' });
    await addAlias(analyst, { targetId: 'tag:spender', alias: '高消费' });
    await addAlias(author, { targetId: 'field:order.status', mappingId: loyalty, alias: '会员单状态' });
    const [plan] = await publishedPlans(getDb(), acme, [loyalty]);
    const basedOn = Object.fromEntries((await aliasRows(acme)).map(r => [r.alias, r.basedOn]));
    expect(basedOn).toEqual({
      交易单: [],
      单据状态: [],
      营收: [{ id: 'metric:paid_revenue', hash: definitionHash(REVENUE) }],
      高消费: [{ id: 'tag:spender', hash: definitionHash(SPENDER) }],
      会员单状态: [{ id: `mapping:${loyalty}`, hash: planHash(plan) }],
    });
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s

  it('重复、目标不存在、敏感字段、映射没写入该字段时 400 且不留记录；查看者 403，分析师给映射字段加别名或停用映射字段别名 403', async () => {
    const { acme, author, analyst, viewer, mappings, orderMappings } = await setup();
    const first = await addAlias(analyst, { targetId: 'field:order.status', alias: '单据状态' });
    const mapped = await addAlias(author, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, alias: '会员单状态' });
    await addAlias(analyst, { targetId: 'metric:paid_revenue', alias: 'GMV' });
    const before = (await latestVersion(acme))!.version;
    const bad = [
      { targetId: 'field:order.status', alias: ' 单据状态 ' },
      { targetId: 'metric:paid_revenue', alias: 'gmv' },
      { targetId: 'entity:nope', alias: 'x' },
      { targetId: 'field:order.nope', alias: 'x' },
      { targetId: 'metric:nope', alias: 'x' },
      { targetId: 'tag:nope', alias: 'x' },
      { targetId: 'source:CRM', alias: 'x' },
      { targetId: 'field:customer.name', alias: '姓名' },
      { targetId: 'field:customer.phone', alias: '电话' },
      { targetId: 'field:customer.email', alias: '邮箱' },
      { targetId: 'field:order.status', alias: '   ' },
      { targetId: 'field:order.status', alias: '字'.repeat(51) },
    ];
    for (const input of bad) await expect(addAlias(analyst, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400 });
    const badMapped = [
      { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, alias: '会员单状态' },
      { targetId: 'field:order.status', mappingId: mappings.tracking, alias: 'x' },
      { targetId: 'field:customer.name', mappingId: mappings.crm, alias: 'x' },
      { targetId: 'field:order.status', mappingId: '00000000-0000-0000-0000-000000000000', alias: 'x' },
      { targetId: 'field:order.status', mappingId: 'not-a-uuid', alias: 'x' },
      { targetId: 'entity:order', mappingId: orderMappings!.loyalty, alias: 'x' },
    ];
    for (const input of badMapped) await expect(addAlias(author, input), JSON.stringify(input)).rejects.toMatchObject({ status: 400 });
    await expect(addAlias(analyst, { targetId: 'field:order.status', alias: '字'.repeat(50) })).resolves.toEqual(expect.any(String));
    await retireAlias(analyst, first);
    await expect(retireAlias(analyst, first)).rejects.toMatchObject({ status: 400 });

    await expect(addAlias(viewer, { targetId: 'entity:order', alias: 'x' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(retireAlias(viewer, mapped)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(addAlias(analyst, { targetId: 'field:order.status', mappingId: orderMappings!.loyalty, alias: 'x' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(retireAlias(analyst, mapped)).rejects.toMatchObject({ init: { status: 403 } });

    const rows = await aliasRows(acme);
    expect(rows.map(r => r.alias).sort()).toEqual(['GMV', '会员单状态', '单据状态', '字'.repeat(50)].sort());
    expect(rows.find(r => r.id === mapped)?.retiredAt).toBeNull();
    expect((await audits(acme)).map(l => l.action).sort()).toEqual(['alias.added', 'alias.added', 'alias.added', 'alias.added', 'alias.retired']);
    expect((await latestVersion(acme))!.version).toBe(before + 2);
  }, 180_000); // 每个用例都跑 publishedIdentitySources（平均 26.8 s、中位 30.1 s，docs/test-plans/test-duration-report.md），4 个 worker 并行时超过默认的 90 s
});

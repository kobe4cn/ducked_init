// test/pipeline/customer-source.test.ts —— 跨源引用 customer_source（#150）：草稿检查按数据源名找同租户的数据源，目标源不存在、写在不指向 customer 的字段上时报错，
// 写的是本源时只提示可以省略；发布出的计划里声明了的列带目标源的 sourceId，指向 customer 的引用列带 customerRef。
// 发布时跨源引用的键空间要与目标源 customer 映射的一致，目标源重发 customer 映射使引用失效时被拒；crossSourceReferrers 查得到跨源引用（#187）
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { checkMappingDraft, crossSourceReferrers, MappingError, publishedPlans, publishMapping, saveDraft } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { CRM_ORDERS, LOYALTY, LOYALTY_ORDERS, publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const withSource = (target: string) => CRM_ORDERS.replace('  customer_id: string(customer)\n', `  customer_id: { expr: string(customer), customer_source: ${target} }\n`);

describe('跨源引用 customer_source', () => {
  it('草稿检查对照同租户的数据源；发布后的计划带目标源的 sourceId', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    const problems = (yaml: string) => checkMappingDraft(acme, sources.crm, yaml).then(() => [], (e: MappingError) => e.issues.map(i => `${i.line} ${i.path} ${i.message}`));
    expect(await problems(withSource('不存在'))).toEqual([expect.stringMatching(/^6 fields\.customer_id\.customer_source 没有数据源 不存在/)]);
    expect(await problems(CRM_ORDERS.replace('  amount: amount\n', '  amount: { expr: amount, customer_source: 会员 }\n')))
      .toEqual([expect.stringMatching(/^8 fields\.amount\.customer_source amount 不指向消费者/)]);
    const self = await checkMappingDraft(acme, sources.crm, withSource('CRM'));
    expect(self.notices).toEqual([expect.objectContaining({ line: 6, path: 'fields.customer_id.customer_source', message: expect.stringContaining('可以省略') })]);

    const [orders] = (await publishedPlans(getDb(), acme))
      .filter(p => p.sourceId === sources.crm && p.entity === 'order');
    expect(orders.columns.find(c => c.name === 'customer_id')).toEqual({ name: 'customer_id', type: 'string', expr: 'string(customer)', customerRef: true });
    const version = await saveDraft(author, orders.mapping, withSource('会员'));
    await publishMapping(reviewer, orders.mapping, version);
    const [published] = await publishedPlans(getDb(), acme, [orders.mapping]);
    expect(published.columns.find(c => c.name === 'customer_id')).toMatchObject({ customerSource: sources.loyalty, customerRef: true });
  });

  it('跨源引用的 key_space 要与目标源 customer 映射的一致；目标源改键空间使引用失效时拒绝发布并列出引用映射；crossSourceReferrers 查得到引用', async () => {
    const { acme, author, reviewer, sources, mappings } = await publishedIdentitySources({ orders: true });
    const republish = async (mappingId: string, yaml: string) => publishMapping(reviewer, mappingId, await saveDraft(author, mappingId, yaml));
    await republish(mappings.loyalty, `${LOYALTY}key_space: mem\n`);
    const [orders] = (await publishedPlans(getDb(), acme)).filter(p => p.sourceId === sources.crm && p.entity === 'order');
    const ref = (field: string) => CRM_ORDERS.replace('  customer_id: string(customer)\n', `  customer_id: { ${field} }\n`);

    await expect(republish(orders.mapping, ref('expr: string(customer), customer_source: 会员')))
      .rejects.toThrow(new MappingError('跨源引用字段要写上目标数据源里消费者（customer）映射声明的键空间：customer_id 应写 key_space: mem（数据源 会员）'));
    await expect(republish(orders.mapping, ref('expr: string(customer), customer_source: 会员, key_space: web'))).rejects.toThrow('customer_id 应写 key_space: mem（数据源 会员）');
    expect(await crossSourceReferrers(getDb(), acme, sources.loyalty)).toEqual([]);
    await republish(orders.mapping, ref('expr: string(customer), customer_source: 会员, key_space: mem'));
    expect(await crossSourceReferrers(getDb(), acme, sources.loyalty))
      .toEqual([{ mappingId: orders.mapping, mapping: 'orders → order', sourceId: sources.crm, columns: ['customer_id'] }]);
    expect(await crossSourceReferrers(getDb(), acme, sources.crm)).toEqual([]);

    await expect(republish(mappings.loyalty, `${LOYALTY}key_space: vip\n`))
      .rejects.toThrow(new MappingError('会员 的消费者（customer）映射发布后键空间为 key_space: vip，这些跨源引用会失效：CRM 的 orders → order（customer_id 写的是 key_space: mem），先把它们改成一致再发布'));
    await republish(mappings.loyalty, `${LOYALTY}key_space: mem\nsurvivorship:\n  priority: 1\n`);
  });

  it('目标源的 customer 映射没声明键空间时跨源引用不能写键空间；目标源去掉键空间使写了键空间的引用失效时拒绝发布', async () => {
    const { acme, author, reviewer, sources, mappings } = await publishedIdentitySources({ orders: true });
    const republish = async (mappingId: string, yaml: string) => publishMapping(reviewer, mappingId, await saveDraft(author, mappingId, yaml));
    const plans = await publishedPlans(getDb(), acme);
    const orderOf = (sourceId: string) => plans.find(p => p.sourceId === sourceId && p.entity === 'order')!.mapping;
    const loyaltyRef = (field: string) => LOYALTY_ORDERS.replace('  customer_id: string(member_id)\n', `  customer_id: { ${field} }\n`);

    await expect(republish(orderOf(sources.loyalty), loyaltyRef('expr: string(member_id), customer_source: CRM, key_space: crm')))
      .rejects.toThrow(new MappingError('跨源引用字段要写上目标数据源里消费者（customer）映射声明的键空间：customer_id 不应写键空间，目标数据源没声明（数据源 CRM）'));
    await republish(orderOf(sources.loyalty), loyaltyRef('expr: string(member_id), customer_source: CRM'));

    await republish(mappings.loyalty, `${LOYALTY}key_space: mem\n`);
    await republish(orderOf(sources.crm), CRM_ORDERS.replace('  customer_id: string(customer)\n', '  customer_id: { expr: string(customer), customer_source: 会员, key_space: mem }\n'));
    await expect(republish(mappings.loyalty, LOYALTY))
      .rejects.toThrow(new MappingError('会员 的消费者（customer）映射发布后不再声明键空间，这些跨源引用会失效：CRM 的 orders → order（customer_id 写的是 key_space: mem），先把它们改成一致再发布'));
  });
});

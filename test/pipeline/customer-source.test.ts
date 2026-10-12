// test/pipeline/customer-source.test.ts —— 跨源引用 customer_source（#150）：草稿检查按数据源名找同租户的数据源，目标源不存在、写在不指向 customer 的字段上时报错，
// 写的是本源时只提示可以省略；发布出的计划里声明了的列带目标源的 sourceId，指向 customer 的引用列带 customerRef
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { checkMappingDraft, MappingError, publishedPlans, publishMapping, saveDraft } from '../../app/.server/mappings';
import { resetDb } from '../http/harness';
import { CRM_ORDERS, publishedIdentitySources } from './identity-fixtures';

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
});

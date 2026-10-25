// test/pipeline/catalog.test.ts —— 语义目录的加载（ADR-0041）：tenantCatalog 从平台库读出数据源、同步范围内的源表、已发布映射与自定义实体，
// 生成总览与条目；同步范围内还没映射的源表标「未映射」，范围外的不收，敏感字段与它们引用的源列不进目录；
// 源表带采集统计，实体带合并行数，字段带所映射源列的源端样本统计；发布的指标能展开、能按说明搜到，模板带产出列与最近一次快照
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, overview, search, toJson, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb } from '../../app/.server/db/client';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { relistSource, setSyncScope } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

describe('语义目录的加载', () => {
  it('收进同步范围内的源表（没映射的标未映射），不收范围外的，敏感字段与它们引用的源列不出现', async () => {
    const { acme, author, sources } = await publishedIdentitySources({ orders: true });
    await grantOnSource(`
      CREATE TABLE crm.stores (store_id text PRIMARY KEY, region text, updated_at timestamp NOT NULL);
      CREATE TABLE crm.audit_log (id int PRIMARY KEY, note text);
      GRANT SELECT ON ALL TABLES IN SCHEMA crm TO ${READER.user};`);
    await relistSource(author, sources.crm);
    await drain();
    await setSyncScope(author, sources.crm, { add: ['stores'] });
    await drain();

    const c = await tenantCatalog(acme);
    expect(expand(c, 'source:CRM')).toMatchObject({ tables: ['table:CRM/customers', 'table:CRM/orders', 'table:CRM/stores'] });
    expect(expand(c, 'table:CRM/stores')).toMatchObject({
      kind: 'table', mapped: false, entities: [], description: '源表，未映射',
      columns: expect.arrayContaining([{ name: 'store_id', type: expect.any(String) }, { name: 'region', type: expect.any(String) }]),
    });
    expect(expand(c, 'table:CRM/orders')).toMatchObject({ mapped: true, entities: ['entity:order'] });
    expect(expand(c, 'table:CRM/audit_log')).toBeNull();
    expect(expand(c, 'field:order.status')).toMatchObject({ lineage: expect.arrayContaining([expect.objectContaining({ source: 'CRM', table: 'orders' })]) });
    expect(expand(c, 'entity:customer')).toMatchObject({ tables: ['table:CRM/customers', 'table:会员/members', 'table:埋点/users'] });

    const md = toMarkdown(overview(c));
    expect(md).toMatch(/table:CRM\/stores .*未映射/);
    expect(md).not.toContain('audit_log');

    const all = [md, toJson(overview(c)), ...c.entries.flatMap(e => [toMarkdown(e), toJson(e)]),
      ...['手机 phone', '邮箱 email', '姓名 name', 'unionid external'].flatMap(q => [toMarkdown(search(c, q)), toJson(search(c, q))])].join('\n');
    for (const field of ['name', 'phone', 'email', 'external_id']) expect(all, field).not.toContain(`field:customer.${field}`);
    const customer = expand(c, 'entity:customer');
    expect(customer && 'fields' in customer && customer.fields.map(f => f.name)).not.toEqual(expect.arrayContaining(['name']));
    // 源表 customers 的敏感列：映射成 external_id 的 unionid，名字像敏感信息的 name / mobile / email
    expect(expand(c, 'table:CRM/customers')).toMatchObject({ columns: [{ name: 'id' }, { name: 'updated_at' }] });
    for (const word of ['unionid', 'mobile', 'full_name', 'external_id']) expect(all, word).not.toContain(word);
  });

  it('源表带采集统计，实体带合并行数，字段带源端样本；敏感列没有取值与范围，统计不进总览', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await drain();
    const c = await tenantCatalog(acme);

    const orders = expand(c, 'table:CRM/orders');
    expect(orders).toMatchObject({ stats: { rows: 6, sampleRows: 6, at: expect.any(String) } });
    const cols = orders?.kind === 'table' ? orders.stats!.columns : [];
    expect(cols.find(col => col.name === 'status')).toMatchObject({ nullRate: 0, top: [{ value: 'paid', rows: 5 }, { value: 'refunded', rows: 1 }] });
    expect(cols.find(col => col.name === 'created_at')).toMatchObject({ range: { min: expect.stringContaining('2024-04-01'), max: expect.stringContaining('2024-06-30') } });
    expect(cols.find(col => col.name === 'order_no')).not.toHaveProperty('range');
    expect(toMarkdown(orders!)).toContain('（采集时间）');

    // CRM 6 行加会员 5 行
    expect(expand(c, 'entity:order')).toMatchObject({ stats: { rows: 11, at: expect.any(String) } });
    expect(toMarkdown(expand(c, 'entity:order')!)).toContain('（最近一次合并）');
    expect(expand(c, 'field:order.status')).toMatchObject({ lineage: expect.arrayContaining([
      expect.objectContaining({ source: 'CRM', table: 'orders', sample: [expect.objectContaining({ name: 'status', top: [{ value: 'paid', rows: 5 }, { value: 'refunded', rows: 1 }] })] }),
    ]) });
    expect(toMarkdown(expand(c, 'field:order.status')!)).toContain('源端样本 `status`');

    // 映射成 external_id 的 unionid（列名不像敏感信息，采集时照样存了取值）与像敏感信息的列不出现
    const customers = expand(c, 'table:CRM/customers');
    expect(customers?.kind === 'table' && customers.stats!.columns.map(col => col.name)).toEqual(['id', 'updated_at']);
    const all = [toMarkdown(overview(c)), toJson(overview(c)), ...c.entries.flatMap(e => [toMarkdown(e), toJson(e)])].join('\n');
    for (const word of ['wx_union_8', '张三', '13800000002', 'zhang@crm.test']) expect(all, word).not.toContain(word);
    expect(toJson(overview(c))).not.toMatch(/采集时间|最近一次合并|nullRate|sampleRows|"top"/);
  });

  it('发布的指标取最新发布版：能展开、能按说明搜到，草稿不算；自动启用的模板带产出列与快照', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await createDefinition(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 旧口径\n');
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: status, op: eq, value: paid }\ndescription: 已支付订单的实付金额\n');
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: count }\ndescription: 草稿口径\n');
    await drain();

    const c = await tenantCatalog(acme);
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({
      version: 2, description: '已支付订单的实付金额', measure: 'sum(amount)',
      dependencies: { entities: ['entity:order'], fields: ['field:order.amount', 'field:order.status'] },
    });
    expect(search(c, '已支付 实付金额')[0]?.id).toBe('metric:paid_revenue');
    expect(toMarkdown(overview(c))).toContain('- metric:paid_revenue paid_revenue — 已支付订单的实付金额');
    expect(toJson(c.entries)).not.toMatch(/旧口径|草稿口径/);
    // 映射合并后平台自动启用的模板：产出列与最近一次快照
    expect(expand(c, 'template:rfm')).toMatchObject({
      version: 1, entities: ['entity:order', 'entity:customer'], columns: expect.arrayContaining([expect.objectContaining({ name: 'segment' })]),
      snapshot: { table: expect.stringMatching(/^gold\.rfm__/), rows: expect.any(Number), at: expect.any(String) },
    });
    expect(toMarkdown(overview(c))).toContain('- template:rfm RFM 分层');
  });
});

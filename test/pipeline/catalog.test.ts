// test/pipeline/catalog.test.ts —— 语义目录的加载（ADR-0041）：tenantCatalog 从平台库读出数据源、同步范围内的源表、已发布映射与自定义实体，
// 生成总览与条目；同步范围内还没映射的源表标「未映射」，范围外的不收，敏感字段与它们引用的源列不进目录
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, overview, search, toJson, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { closeDb } from '../../app/.server/db/client';
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
});

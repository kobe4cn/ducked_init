// test/pipeline/passthrough.test.ts —— 一键直通的接缝（ADR-0019）：createPassthrough 从一张已采集的源表一次生成自定义实体的登记草稿与恒等映射草稿，
// 字段的类型与敏感标记取自源列，主键取源表主键（没有时取声明的业务主键）；预检不过时两份草稿都不写
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getCustomEntity } from '../../app/.server/custom-entities';
import { closeDb } from '../../app/.server/db/client';
import { getMapping, listMappings } from '../../app/.server/mappings';
import { createPassthrough, passthroughRegistration } from '../../app/.server/passthrough';
import type { TableProfile } from '../../app/.server/pipeline/source-engine';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 一位数据工程师与一个已采集的 PostgreSQL 数据源 */
async function profiledSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, sourceId);
  await drain();
  return { author, sourceId };
}

describe('一键直通', () => {
  it('从 customers 生成登记草稿与以它为目标的恒等映射草稿：类型与敏感标记取自源列，主键取源表主键', async () => {
    const { author, sourceId } = await profiledSource();
    const { entityId, mappingId } = await createPassthrough(author, sourceId, 'customers');

    const { entity, draft, published } = await getCustomEntity(author, entityId);
    expect(entity.name).toBe('custom_customers');
    expect(published).toBeNull();
    expect(draft).toMatchObject({ version: 1, label: 'customers', kind: 'dimension', primaryKey: ['customer_id'], authors: ['de@acme.com'], lastEditor: 'de@acme.com' });
    const fields = Object.fromEntries(draft!.fields.map(f => [f.name, { type: f.type, sensitive: f.sensitive }]));
    expect(fields).toMatchObject({
      name: { type: 'string', sensitive: true },
      email: { type: 'string', sensitive: true },
      phone: { type: 'string', sensitive: true },
      city: { type: 'string', sensitive: false },
      created_at: { type: 'timestamp', sensitive: false },
      updated_at: { type: 'timestamp', sensitive: false },
    });
    expect(Object.keys(fields)).toEqual(['customer_id', 'name', 'email', 'phone', 'city', 'created_at', 'updated_at']);

    const mapping = await getMapping(author, mappingId);
    expect(mapping).toMatchObject({ entity: 'custom_customers', tableName: 'customers', sourceId });
    expect(mapping.versions).toEqual([expect.objectContaining({ version: 1, status: 'draft', lastEditor: 'de@acme.com' })]);
    expect(mapping.versions[0].yaml).toMatch(/key: \[ ?customer_id ?\]/);
  });

  it('源表没有主键也没有业务主键、同名实体已存在时拒绝，两份草稿都不写', async () => {
    const { author, sourceId } = await profiledSource();
    await expect(createPassthrough(author, sourceId, 'regions')).rejects.toThrow('主键');
    expect((await listMappings(author)).mappings).toHaveLength(0);

    await createPassthrough(author, sourceId, 'customers');
    await expect(createPassthrough(author, sourceId, 'customers')).rejects.toThrow('已有名为 custom_customers 的自定义实体');
    expect((await listMappings(author)).mappings).toHaveLength(1);
  });

  it('表不在同步范围或没采集时给出原因；分析师不能生成', async () => {
    const { author, sourceId } = await profiledSource();
    await expect(createPassthrough(author, sourceId, 'nope')).rejects.toThrow('数据源中没有表 nope');
    const analyst = await memberOf(author.tenant.id, 'an@acme.com', 'analyst');
    await expect(createPassthrough(analyst, sourceId, 'customers')).rejects.toMatchObject({ init: { status: 403 } });
  });

  it('有列名规范化后不合字段名规则或重名、表名做不成实体名时拒绝', () => {
    const table = (name: string, columns: string[]): TableProfile => ({
      name, rows: 1, sampleRows: 1, watermarkCandidates: [], primaryKey: ['id'], keyCandidates: [],
      columns: columns.map(c => ({ name: c, type: 'VARCHAR', nullRate: 0, distinct: 1, min: null, max: null })),
    });
    expect(() => passthroughRegistration(table('stores', ['id', '门店']), ['id'])).toThrow('列 门店');
    expect(() => passthroughRegistration(table('stores', ['id', 'Store Name', 'store_name']), ['id'])).toThrow('store_name');
    expect(() => passthroughRegistration(table('门店', ['id']), ['id'])).toThrow('表名');
    expect(passthroughRegistration(table('Stores', ['ID', 'Store Name']), ['ID'])).toMatchObject({
      name: 'custom_stores', primaryKey: ['id'], fields: [{ name: 'id' }, { name: 'store_name' }],
    });
  });
});

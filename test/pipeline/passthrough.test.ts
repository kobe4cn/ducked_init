// test/pipeline/passthrough.test.ts —— 一键直通的接缝（ADR-0019）：createPassthrough 从一张已采集的源表一次生成自定义实体的登记草稿与恒等映射草稿，
// 字段的类型与敏感标记取自源列，主键取源表主键（没有时取声明的业务主键）；预检不过时两份草稿都不写。
// publishPassthrough 由另一位成员把两份草稿一起双人发布并入队合并，任一份不满足发布条件时都不发布
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getCustomEntity } from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { customEntities, customEntityVersions } from '../../app/.server/db/schema';
import { discardDraft, getMapping, listMappings } from '../../app/.server/mappings';
import { createPassthrough, passthroughPair, passthroughRegistration, publishPassthrough } from '../../app/.server/passthrough';
import type { TableProfile } from '../../app/.server/pipeline/source-engine';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables, silver } from './fixtures';
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

describe('登记与映射一起发布', () => {
  /** 已同步 customers 的数据源上一键生成的两份草稿，另一位数据工程师 de2 */
  async function drafts() {
    const { author, sourceId } = await profiledSource();
    await confirmWatermark(author, sourceId, 'customers', 'updated_at');
    await syncSource(author, sourceId);
    await drain();
    const { entityId, mappingId } = await createPassthrough(author, sourceId, 'customers');
    const reviewer = await memberOf(author.tenant.id, 'de2@acme.com');
    return { author, reviewer, entityId, mappingId };
  }

  it('另一位工程师一起发布后两份都是已发布版本，合并后 silver.custom_customers 有源表的全部行，敏感字段存哈希', async () => {
    const { author, reviewer, entityId, mappingId } = await drafts();
    expect(await passthroughPair(author.tenant.id, 'custom_customers')).toMatchObject({ mappingId, version: 1, table: 'customers', lastEditor: 'de@acme.com' });

    await publishPassthrough(reviewer, entityId, 1, mappingId, 1);
    expect((await getCustomEntity(author, entityId)).published).toMatchObject({ version: 1, publishedByEmail: 'de2@acme.com' });
    expect((await getMapping(author, mappingId)).versions).toEqual([expect.objectContaining({ version: 1, status: 'published' })]);
    expect(await passthroughPair(author.tenant.id, 'custom_customers')).toBeNull();

    await drain();
    const rows = await silver(author.tenant.id, 'custom_customers', 'customer_id');
    expect(rows).toHaveLength(40);
    expect(rows[0].email).toMatch(/^[0-9a-f]{64}$/);
  });

  it('最后保存人 403、分析师 403、其他租户 404；单独丢弃映射草稿后再一起发布被拒，登记仍是草稿', async () => {
    const { author, reviewer, entityId, mappingId } = await drafts();
    await expect(publishPassthrough(author, entityId, 1, mappingId, 1)).rejects.toMatchObject({ status: 403 });
    const analyst = await memberOf(author.tenant.id, 'an@acme.com', 'analyst');
    await expect(publishPassthrough(analyst, entityId, 1, mappingId, 1)).rejects.toMatchObject({ init: { status: 403 } });
    const outsider = await memberOf(await newTenant('globex'), 'de@globex.com');
    await expect(publishPassthrough(outsider, entityId, 1, mappingId, 1)).rejects.toMatchObject({ status: 404 });

    await discardDraft(author, mappingId);
    await expect(publishPassthrough(reviewer, entityId, 1, mappingId, 1)).rejects.toMatchObject({ status: 404 });
    const { draft, published } = await getCustomEntity(author, entityId);
    expect(published).toBeNull();
    expect(draft).toMatchObject({ version: 1 });
  });

  it('等锁期间登记草稿被改时报「请刷新后重新检查」，两份都不发布', async () => {
    const { author, reviewer, entityId, mappingId } = await drafts();
    let publishing!: Promise<unknown>;
    await getDb().transaction(async tx => {
      // 先锁住实体行，等一起发布卡在这把锁上，再改草稿
      await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
      publishing = publishPassthrough(reviewer, entityId, 1, mappingId, 1).catch((e: unknown) => e);
      for (;;) {
        const [{ n }] = (await getDb().execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`)).rows as { n: number }[];
        if (n > 0) break;
        await new Promise(r => setTimeout(r, 20));
      }
      await tx.update(customEntityVersions).set({ updatedAt: new Date() })
        .where(and(eq(customEntityVersions.entityId, entityId), eq(customEntityVersions.version, 1)));
    });
    expect(await publishing).toMatchObject({ message: expect.stringContaining('请刷新后重新检查') });
    expect((await getCustomEntity(author, entityId)).published).toBeNull();
    expect((await getMapping(author, mappingId)).versions).toEqual([expect.objectContaining({ status: 'draft' })]);
  });
});

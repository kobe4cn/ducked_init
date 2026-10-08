// 自定义实体登记的接缝（ADR-0019）：createCustomEntity / saveCustomEntityDraft 校验名称、字段与主键后保存草稿；
// 双人发布与丢弃同源视图；publishedCustomEntities 给出每个实体最新的已发布版本。关系的终点保存与发布时都校验；发布过的实体只能新增字段与关系；
// deleteCustomEntity 删除没被已发布映射引用的实体；draftFor 按已发布登记生成自定义实体的映射草稿；inferCustomEntityDrafts 为已发布映射在用、但没登记的实体推断登记草稿；
// relationSuggestions 按列名与取值包含推荐关系，adoptRelation 把推荐的关系采纳进登记草稿
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import {
  adoptRelation, createCustomEntity, deleteCustomEntity, discardCustomEntityDraft, getCustomEntity, inferCustomEntityDrafts, listCustomEntities, publishCustomEntity,
  publishedCustomEntities, saveCustomEntityDraft, type CustomEntityInput,
} from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { customEntities, customEntityVersions } from '../../app/.server/db/schema';
import type { EntityRelation } from '../../app/lib/canonical-model';
import { createMapping, draftFor, getMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { relationSuggestions } from '../../app/.server/relation-suggest';
import { syncSource } from '../../app/.server/source-sync';
import { listTasks } from '../../app/.server/tasks';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 两位数据工程师 */
async function engineers() {
  const acme = await newTenant('acme');
  return { acme, author: await memberOf(acme, 'de@acme.com'), reviewer: await memberOf(acme, 'de2@acme.com') };
}

const STORE: CustomEntityInput = {
  name: 'custom_store',
  label: '门店',
  kind: 'dimension',
  fields: [
    { name: 'store_id', type: 'string', description: '门店编号', sensitive: false },
    { name: 'manager_phone', type: 'string', description: '店长手机', sensitive: true },
    { name: 'opened_on', type: 'date', description: '', sensitive: false },
  ],
  primaryKey: ['store_id'],
};

describe('自定义实体草稿', () => {
  it('保存后列表与详情能看到草稿', async () => {
    const { author } = await engineers();
    const id = await createCustomEntity(author, STORE);
    expect(await listCustomEntities(author)).toEqual([{ id, name: 'custom_store', label: '门店', kind: 'dimension', published: null, draft: 1, inferred: false }]);
    const entity = await getCustomEntity(author, id);
    expect(entity.entity).toEqual({ id, name: 'custom_store' });
    expect(entity.draft).toMatchObject({ version: 1, label: '门店', fields: STORE.fields, primaryKey: ['store_id'], lastEditor: 'de@acme.com' });
  });

  it('校验名称、字段名、主键与敏感字段类型，不合格时什么也不保存', async () => {
    const { author } = await engineers();
    const rejected: [Partial<CustomEntityInput>, RegExp][] = [
      [{ name: 'store' }, /custom_ 开头/],
      [{ name: 'custom_Store' }, /custom_ 开头/],
      [{ label: ' ' }, /中文名/],
      [{ fields: [] }, /至少登记一个字段/],
      [{ fields: [{ name: 'Store-Id', type: 'string', description: '', sensitive: false }] }, /字段名 Store-Id/],
      [{ fields: [STORE.fields[0], STORE.fields[0]] }, /store_id 重复/],
      [{ fields: [{ name: 'store_id', type: 'varchar' as never, description: '', sensitive: false }] }, /类型/],
      [{ fields: [STORE.fields[0], { name: 'phone', type: 'integer', description: '', sensitive: true }] }, /敏感字段.*string/],
      [{ primaryKey: [] }, /主键/],
      [{ primaryKey: ['store_code'] }, /主键 store_code 不是已登记的字段/],
    ];
    for (const [patch, message] of rejected) {
      const error = await createCustomEntity(author, { ...STORE, ...patch }).then(() => '已保存', (e: Error) => e.message);
      expect(error, JSON.stringify(patch)).toMatch(message);
    }
    expect(await listCustomEntities(author)).toEqual([]);

    const id = await createCustomEntity(author, STORE);
    await expect(createCustomEntity(author, { ...STORE, label: '另一个门店' })).rejects.toThrow(/已有名为 custom_store 的自定义实体/);
    await expect(saveCustomEntityDraft(author, id, { ...STORE, primaryKey: ['nope'] })).rejects.toThrow(/主键 nope/);
    // 名称建实体时定下：保存草稿不接收名称
    await saveCustomEntityDraft(author, id, { ...STORE, name: 'custom_renamed', label: '店' });
    expect((await getCustomEntity(author, id)).entity.name).toBe('custom_store');
  });

  it('其他租户的实体 404', async () => {
    const { author } = await engineers();
    const id = await createCustomEntity(author, STORE);
    const outsider = await memberOf(await newTenant('globex'), 'de@globex.com');
    await expect(getCustomEntity(outsider, id)).rejects.toMatchObject({ status: 404 });
    await expect(saveCustomEntityDraft(outsider, id, STORE)).rejects.toMatchObject({ status: 404 });
    await expect(discardCustomEntityDraft(outsider, id)).rejects.toMatchObject({ status: 404 });
    // 不同租户可以用同一个名称
    await createCustomEntity(outsider, STORE);
  });
});

describe('自定义实体发布', () => {
  it('双人发布：最后保存的人发布不了，另一位发布后锁定；再改是新的一版草稿，丢弃回到已发布版本', async () => {
    const { acme, author, reviewer } = await engineers();
    const id = await createCustomEntity(author, STORE);

    await expect(publishCustomEntity(author, id, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('你最后改了这一版草稿') });
    expect(await publishedCustomEntities(getDb(), acme)).toEqual(new Map());
    await publishCustomEntity(reviewer, id, 1);
    await expect(publishCustomEntity(reviewer, id, 1)).rejects.toMatchObject({ status: 400, message: '已发布的版本已锁定' });
    expect((await getCustomEntity(author, id)).published).toMatchObject({ version: 1, publishedByEmail: 'de2@acme.com' });

    const more = { ...STORE, fields: [...STORE.fields, { name: 'city', type: 'string' as const, description: '', sensitive: false }] };
    expect(await saveCustomEntityDraft(reviewer, id, more)).toBe(2);
    expect(await saveCustomEntityDraft(author, id, { ...more, label: '线下门店' })).toBe(2);
    expect((await getCustomEntity(author, id)).draft).toMatchObject({ authors: ['de2@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com' });
    // 草稿不影响已发布的登记
    expect(await publishedCustomEntities(getDb(), acme)).toEqual(new Map([['custom_store', {
      name: 'custom_store', label: '门店', kind: 'dimension', fields: STORE.fields, primaryKey: ['store_id'], relations: [],
    }]]));

    expect(await discardCustomEntityDraft(author, id)).toEqual({ kept: true });
    const entity = await getCustomEntity(author, id);
    expect(entity.draft).toBeNull();
    expect(entity.versions.map(v => v.version)).toEqual([1]);
    expect(await listCustomEntities(author)).toEqual([{ id, name: 'custom_store', label: '门店', kind: 'dimension', published: 1, draft: null, inferred: false }]);
  });

  it('丢弃从没发布过的实体会删除它；分析师不能起草与发布', async () => {
    const { acme, author } = await engineers();
    const id = await createCustomEntity(author, STORE);
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    expect(await listCustomEntities(analyst)).toHaveLength(1);
    await expect(publishCustomEntity(analyst, id, 1)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(saveCustomEntityDraft(analyst, id, STORE)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(createCustomEntity(analyst, { ...STORE, name: 'custom_x' })).rejects.toMatchObject({ init: { status: 403 } });

    expect(await discardCustomEntityDraft(author, id)).toEqual({ kept: false });
    await expect(getCustomEntity(author, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('发布后只能新增字段', () => {
  it('删字段、改字段类型、改敏感标记、改主键被拒绝；新增字段、改中文名 / 类型 / 说明可以保存并发布', async () => {
    const { acme, author, reviewer } = await engineers();
    const id = await createCustomEntity(author, STORE);
    // 从没发布过的草稿随便改
    await saveCustomEntityDraft(author, id, { ...STORE, fields: STORE.fields.slice(0, 1) });
    await saveCustomEntityDraft(author, id, STORE);
    await publishCustomEntity(reviewer, id, 1);

    const [storeId, phone, opened] = STORE.fields;
    const rejected: [Partial<CustomEntityInput>, RegExp][] = [
      [{ fields: [storeId, phone] }, /不能删除字段 opened_on/],
      [{ fields: [storeId, phone, { ...opened, name: 'open_date' }] }, /不能删除字段 opened_on/],
      [{ fields: [storeId, phone, { ...opened, type: 'timestamp' }] }, /不能改字段 opened_on 的类型/],
      [{ fields: [storeId, { ...phone, sensitive: false }, opened] }, /不能改字段 manager_phone 的敏感标记/],
      [{ primaryKey: ['store_id', 'opened_on'] }, /不能改主键/],
    ];
    for (const [patch, message] of rejected) {
      const error = await saveCustomEntityDraft(author, id, { ...STORE, ...patch }).then(() => '已保存', (e: Error) => e.message);
      expect(error, JSON.stringify(patch)).toMatch(message);
      expect(error).toContain('改主键、改类型、改名要新建实体');
    }
    expect((await getCustomEntity(author, id)).draft).toBeNull();

    const changed: CustomEntityInput = {
      label: '线下门店',
      kind: 'fact',
      fields: [{ ...opened, description: '开业日期' }, storeId, phone, { name: 'city', type: 'string', description: '', sensitive: false }],
      primaryKey: ['store_id'],
    };
    expect(await saveCustomEntityDraft(author, id, changed)).toBe(2);
    await publishCustomEntity(reviewer, id, 2);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')).toMatchObject({ label: '线下门店', kind: 'fact', fields: changed.fields });
    // 对照的是最新的已发布版本
    await expect(saveCustomEntityDraft(author, id, STORE)).rejects.toThrow(/不能删除字段 city/);
  });
});

describe('关系', () => {
  const REGION: CustomEntityInput = {
    name: 'custom_region',
    label: '大区',
    kind: 'dimension',
    fields: [{ name: 'region_id', type: 'string', description: '', sensitive: false }, { name: 'region_name', type: 'string', description: '', sensitive: false }],
    primaryKey: ['region_id'],
  };
  const toRegion: EntityRelation = { from: { entity: 'custom_store', field: 'region_id' }, ref: { entity: 'custom_region', field: 'region_id' } };
  const STORE_IN_REGION: CustomEntityInput = {
    ...STORE, fields: [...STORE.fields, { name: 'region_id', type: 'string', description: '', sensitive: false }], relations: [toRegion],
  };

  /** 主键标了敏感的实体：标准层里主键是哈希 */
  const VAULT: CustomEntityInput = {
    name: 'custom_vault', label: '保险柜', kind: 'dimension', primaryKey: ['vault_id'],
    fields: [{ name: 'vault_id', type: 'string', description: '', sensitive: true }],
  };
  const toVault: EntityRelation = { from: { entity: 'custom_store', field: 'manager_phone' }, ref: { entity: 'custom_vault', field: 'vault_id' } };

  /** 两位数据工程师，大区已登记并发布 */
  async function withRegion() {
    const people = await engineers();
    const regionId = await createCustomEntity(people.author, REGION);
    await publishCustomEntity(people.reviewer, regionId, 1);
    return { ...people, regionId };
  }

  it('关系的终点可以是已发布的自定义实体或标准实体的主键，跟登记一起保存、发布', async () => {
    const { acme, author, reviewer } = await withRegion();
    const storeId = await createCustomEntity(author, STORE_IN_REGION);
    const toCustomer: EntityRelation = { from: { entity: 'custom_redeem', field: 'customer_id' }, ref: { entity: 'customer', field: 'customer_id' } };
    const redeemId = await createCustomEntity(author, {
      name: 'custom_redeem', label: '核销', kind: 'fact',
      fields: [{ name: 'redeem_id', type: 'string', description: '', sensitive: false }, { name: 'customer_id', type: 'string', description: '', sensitive: false }],
      primaryKey: ['redeem_id'],
      // 起点不写实体时就是本实体
      relations: [{ from: { entity: '', field: 'customer_id' }, ref: toCustomer.ref }],
    });
    expect((await getCustomEntity(author, storeId)).draft).toMatchObject({ relations: [toRegion] });
    await publishCustomEntity(reviewer, storeId, 1);
    await publishCustomEntity(reviewer, redeemId, 1);
    const published = await publishedCustomEntities(getDb(), acme);
    expect(published.get('custom_store')?.relations).toEqual([toRegion]);
    expect(published.get('custom_redeem')?.relations).toEqual([toCustomer]);
    expect(published.get('custom_region')?.relations).toEqual([]);
  });

  it('起点字段没登记、终点不存在或没发布、终点不是单列主键、两端类型或敏感性不一致时报错，什么也不保存', async () => {
    const { author, reviewer } = await withRegion();
    await publishCustomEntity(reviewer, await createCustomEntity(author, VAULT), 1);
    // 只有草稿的实体不能作终点
    await createCustomEntity(author, { ...REGION, name: 'custom_zone' });
    await createCustomEntity(author, {
      ...REGION, name: 'custom_cell', fields: [...REGION.fields, { name: 'cell_id', type: 'string', description: '', sensitive: false }], primaryKey: ['region_id', 'cell_id'],
    });
    const rel = (from: string, entity: string, field: string): Partial<CustomEntityInput> => ({
      relations: [{ from: { entity: 'custom_store', field: from }, ref: { entity, field } }],
    });
    const rejected: [Partial<CustomEntityInput>, RegExp][] = [
      [rel('nope', 'custom_region', 'region_id'), /起点 nope 不是已登记的字段/],
      [{ relations: [{ ...toRegion, from: { entity: 'custom_region', field: 'region_id' } }] }, /起点要是本实体 custom_store 或标准实体的字段/],
      [{ relations: [toRegion, toRegion] }, /重复/],
      [rel('region_id', 'custom_store', 'store_id'), /自指算成环/],
      [rel('region_id', 'custom_nowhere', 'region_id'), /custom_nowhere 不存在或没发布/],
      [rel('region_id', 'custom_zone', 'region_id'), /custom_zone 不存在或没发布/],
      [rel('region_id', 'custom_region', 'region_name'), /region_name 不是 custom_region 的主键（region_id）/],
      [rel('region_id', 'customer', 'phone'), /phone 不是 customer 的主键（customer_id）/],
      [{ ...STORE_IN_REGION, fields: [...STORE.fields, { name: 'region_id', type: 'integer', description: '', sensitive: false }] }, /类型不一致.*integer.*string/],
      [rel('opened_on', 'customer', 'customer_id'), /类型不一致/],
      [rel('manager_phone', 'customer', 'customer_id'), /^关系 custom_store\.manager_phone → customer\.customer_id：两端敏感性不一致（起点敏感、终点明文），标准层里无法关联$/],
      [rel('region_id', 'custom_vault', 'vault_id'), /^关系 custom_store\.region_id → custom_vault\.vault_id：两端敏感性不一致（起点明文、终点敏感），标准层里无法关联$/],
    ];
    for (const [patch, message] of rejected) {
      const error = await createCustomEntity(author, { ...STORE_IN_REGION, ...patch }).then(() => '已保存', (e: Error) => e.message);
      expect(error, JSON.stringify(patch)).toMatch(message);
    }
    expect((await listCustomEntities(author)).map(e => e.name)).toEqual(['custom_cell', 'custom_region', 'custom_vault', 'custom_zone']);

    // 终点主键有两列：草稿的复合主键不算（没发布），发布后报「单列主键」
    const cell = (await listCustomEntities(author)).find(e => e.name === 'custom_cell')!;
    await publishCustomEntity(reviewer, cell.id, 1);
    await expect(createCustomEntity(author, { ...STORE_IN_REGION, ...rel('region_id', 'custom_cell', 'region_id') })).rejects.toThrow(/custom_cell 的主键有多列/);
  });

  it('两端都敏感的关系照常保存、发布', async () => {
    const { acme, author, reviewer } = await withRegion();
    await publishCustomEntity(reviewer, await createCustomEntity(author, VAULT), 1);
    const storeId = await createCustomEntity(author, { ...STORE_IN_REGION, relations: [toRegion, toVault] });
    await publishCustomEntity(reviewer, storeId, 1);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')?.relations).toEqual([toRegion, toVault]);
  });

  it('已发布的敏感性不一致的关系不拦：照原样保留时能加字段、保存并发布；新加的不一致关系照样拒绝', async () => {
    const { acme, author, reviewer } = await withRegion();
    const storeId = await createCustomEntity(author, STORE_IN_REGION);
    await publishCustomEntity(reviewer, storeId, 1);
    // 校验上线前发布的不一致关系：敏感的 manager_phone → 明文的 customer.customer_id
    const legacy: EntityRelation = { from: { entity: 'custom_store', field: 'manager_phone' }, ref: { entity: 'customer', field: 'customer_id' } };
    await getDb().update(customEntityVersions).set({ relations: [toRegion, legacy] }).where(eq(customEntityVersions.entityId, storeId));

    const fields = [...STORE_IN_REGION.fields, { name: 'note', type: 'string' as const, description: '', sensitive: false }];
    expect(await saveCustomEntityDraft(author, storeId, { ...STORE_IN_REGION, fields, relations: [toRegion, legacy] })).toBe(2);
    await publishCustomEntity(reviewer, storeId, 2);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')?.fields.map(f => f.name)).toContain('note');

    const another: EntityRelation = { from: { entity: 'customer', field: 'phone' }, ref: { entity: 'custom_store', field: 'store_id' } };
    await expect(saveCustomEntityDraft(author, storeId, { ...STORE_IN_REGION, fields, relations: [toRegion, legacy, another] }))
      .rejects.toThrow('关系 customer.phone → custom_store.store_id：两端敏感性不一致（起点敏感、终点明文），标准层里无法关联');
  });

  it('发布时再校验终点：保存后终点被删就发布不了', async () => {
    const { author, reviewer, regionId } = await withRegion();
    const storeId = await createCustomEntity(author, STORE_IN_REGION);
    await deleteCustomEntity(reviewer, regionId);
    await expect(publishCustomEntity(reviewer, storeId, 1)).rejects.toThrow(/custom_region 不存在或没发布/);
    expect((await getCustomEntity(author, storeId)).published).toBeNull();
  });

  it('发布后删掉或改动已发布的关系被拒绝；新增关系可以保存并发布', async () => {
    const { acme, author, reviewer } = await withRegion();
    const storeId = await createCustomEntity(author, STORE_IN_REGION);
    await publishCustomEntity(reviewer, storeId, 1);
    const otherRegion = await createCustomEntity(author, { ...REGION, name: 'custom_area' });
    await publishCustomEntity(reviewer, otherRegion, 1);

    const rejected: [Partial<CustomEntityInput>, RegExp][] = [
      [{ relations: [] }, /不能删除或修改关系 custom_store\.region_id → custom_region\.region_id/],
      [{ relations: [{ ...toRegion, ref: { entity: 'custom_area', field: 'region_id' } }] }, /不能删除或修改关系 custom_store\.region_id → custom_region\.region_id/],
    ];
    for (const [patch, message] of rejected) {
      const error = await saveCustomEntityDraft(author, storeId, { ...STORE_IN_REGION, ...patch }).then(() => '已保存', (e: Error) => e.message);
      expect(error, JSON.stringify(patch)).toMatch(message);
    }
    expect((await getCustomEntity(author, storeId)).draft).toBeNull();

    const toCustomer: EntityRelation = { from: { entity: 'custom_store', field: 'customer_id' }, ref: { entity: 'customer', field: 'customer_id' } };
    const fields = [...STORE_IN_REGION.fields, { name: 'customer_id', type: 'string' as const, description: '', sensitive: false }];
    expect(await saveCustomEntityDraft(author, storeId, { ...STORE_IN_REGION, fields, relations: [toCustomer, toRegion] })).toBe(2);
    await publishCustomEntity(reviewer, storeId, 2);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')?.relations).toEqual([toCustomer, toRegion]);
  });
});

describe('标准实体字段作起点、成环', () => {
  const ORDERS = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
extensions:
  x_store_id: { type: string, expr: string(customer_id) }
  x_store_no: { type: integer, expr: customer_id }
`;
  const toStore = (entity: string, field: string): EntityRelation => ({ from: { entity, field }, ref: { entity: 'custom_store', field: 'store_id' } });

  /** 两位数据工程师，order 映射（扩展字段 x_store_id、x_store_no）已发布，另有一份只有草稿的 order 映射用了 x_draft_only */
  async function withOrderMapping() {
    const people = await engineers();
    const { id: sourceId } = await registerSource(people.author, await pgSourceInput(READER));
    await selectAllTables(people.author, sourceId);
    await drain();
    await publish(people.author, people.reviewer, sourceId, ORDERS);
    await createMapping(people.author, sourceId, 'model: 1\nentity: order\ntable: customers\nfields:\n  order_id: string(customer_id)\nextensions:\n  x_draft_only: { type: string, expr: city }\n');
    return people;
  }

  it('能在终点的登记上声明标准字段与 x_ 字段作起点的关系，x_ 字段的类型取自已发布映射', async () => {
    const { acme, author, reviewer } = await withOrderMapping();
    const relations = [toStore('order', 'x_store_id'), toStore('order', 'store_id')];
    const storeId = await createCustomEntity(author, { ...STORE, relations });
    await publishCustomEntity(reviewer, storeId, 1);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')?.relations).toEqual(relations);

    const rejected: [EntityRelation, RegExp][] = [
      [toStore('order', 'x_nowhere'), /x_nowhere 没有被已发布的 order 映射用过/],
      [toStore('order', 'x_draft_only'), /x_draft_only 没有被已发布的 order 映射用过/],
      [toStore('order', 'x_store_no'), /类型不一致（integer → string）/],
      [toStore('order', 'nope'), /nope 不是 order 的字段/],
      [{ from: { entity: 'order', field: 'store_id' }, ref: { entity: 'customer', field: 'customer_id' } }, /起点是标准实体时，终点要是本实体 custom_store/],
    ];
    for (const [relation, message] of rejected) {
      const error = await saveCustomEntityDraft(author, storeId, { ...STORE, relations: [...relations, relation] }).then(() => '已保存', (e: Error) => e.message);
      expect(error, JSON.stringify(relation)).toMatch(message);
    }
    expect((await getCustomEntity(author, storeId)).draft).toBeNull();
  });

  it('成环时报错并写出环的路径：自定义实体之间的环、加上标准模型内置 ref 的环；发布时再查一次', async () => {
    const { author, reviewer } = await engineers();
    const entity = (name: string, key: string, more: string[] = []): CustomEntityInput => ({
      name, label: name, kind: 'dimension', primaryKey: [key],
      fields: [key, ...more].map(f => ({ name: f, type: 'string', description: '', sensitive: false })),
    });
    const b = await createCustomEntity(author, entity('custom_b', 'b_id', ['a_id']));
    await publishCustomEntity(reviewer, b, 1);
    const a = await createCustomEntity(author, {
      ...entity('custom_a', 'a_id', ['b_id']), relations: [{ from: { entity: 'custom_a', field: 'b_id' }, ref: { entity: 'custom_b', field: 'b_id' } }],
    });
    // A 还是草稿：B → A 的终点不合格；A 发布后 B → A 成环
    const backToA = { ...entity('custom_b', 'b_id', ['a_id']), relations: [{ from: { entity: '', field: 'a_id' }, ref: { entity: 'custom_a', field: 'a_id' } }] };
    await expect(saveCustomEntityDraft(author, b, backToA)).rejects.toThrow(/custom_a 不存在或没发布/);
    await publishCustomEntity(reviewer, a, 1);
    await expect(saveCustomEntityDraft(author, b, backToA)).rejects.toThrow('关系成环：custom_b → custom_a → custom_b');

    // custom_store → order_item →（内置 ref）order → custom_store
    await expect(createCustomEntity(author, {
      ...STORE,
      fields: [...STORE.fields, { name: 'last_item_id', type: 'string', description: '', sensitive: false }],
      relations: [toStore('order', 'store_id'), { from: { entity: 'custom_store', field: 'last_item_id' }, ref: { entity: 'order_item', field: 'order_item_id' } }],
    })).rejects.toThrow('关系成环：custom_store → order_item → order → custom_store');

    // 两份草稿各自不成环，先发布的一份让另一份发布时成环
    const c = await createCustomEntity(author, entity('custom_c', 'c_id', ['d_id']));
    await publishCustomEntity(reviewer, c, 1);
    const d = await createCustomEntity(author, entity('custom_d', 'd_id', ['c_id']));
    await publishCustomEntity(reviewer, d, 1);
    const cToD = await saveCustomEntityDraft(author, c, { ...entity('custom_c', 'c_id', ['d_id']), relations: [{ from: { entity: '', field: 'd_id' }, ref: { entity: 'custom_d', field: 'd_id' } }] });
    const dToC = await saveCustomEntityDraft(author, d, { ...entity('custom_d', 'd_id', ['c_id']), relations: [{ from: { entity: '', field: 'c_id' }, ref: { entity: 'custom_c', field: 'c_id' } }] });
    await publishCustomEntity(reviewer, c, cToD);
    await expect(publishCustomEntity(reviewer, d, dToC)).rejects.toThrow('关系成环：custom_d → custom_c → custom_d');
  });
});

describe('删除自定义实体', () => {
  it('被已发布映射引用时拒绝并列出映射；没被引用时删除并记审计', async () => {
    const { acme, author, reviewer } = await engineers();
    const id = await createCustomEntity(author, STORE);
    await publishCustomEntity(reviewer, id, 1);
    const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
    await selectAllTables(author, sourceId);
    await drain();
    const yaml = 'model: 1\nentity: custom_store\ntable: customers\nextensions:\n  store_id: { type: string, expr: string(customer_id) }\ndedupe: { key: [store_id] }\n';
    // 只有草稿的映射不算引用
    await createMapping(author, sourceId, yaml.replace('table: customers', 'table: orders').replace('customer_id', 'order_id'));
    await publish(author, reviewer, sourceId, yaml);

    await expect(deleteCustomEntity(reviewer, id)).rejects.toMatchObject({
      status: 400, message: 'custom_store 被已发布的映射或关系引用，不能删除：「电商库」customers',
    });
    expect((await getCustomEntity(author, id)).referrers).toEqual(['「电商库」customers']);

    const unused = await createCustomEntity(author, { ...STORE, name: 'custom_region' });
    await deleteCustomEntity(reviewer, unused);
    await expect(getCustomEntity(author, unused)).rejects.toMatchObject({ status: 404 });
    expect((await listAuditLogs(acme)).filter(l => l.action === '删除自定义实体').map(l => l.summary)).toEqual(['custom_region']);
  });

  it('被其他实体的已发布关系指向时拒绝并列出关系；挂在本实体上的关系不算', async () => {
    const { author, reviewer } = await engineers();
    const storeId = await createCustomEntity(author, {
      ...STORE, relations: [{ from: { entity: 'order', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }],
    });
    await publishCustomEntity(reviewer, storeId, 1);
    const shelf: CustomEntityInput = {
      name: 'custom_shelf', label: '货架', kind: 'dimension', primaryKey: ['shelf_id'],
      fields: ['shelf_id', 'store_id'].map(name => ({ name, type: 'string', description: '', sensitive: false })),
      relations: [{ from: { entity: '', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }],
    };
    const shelfId = await createCustomEntity(author, shelf);
    // 只有草稿的关系不算
    expect((await getCustomEntity(author, storeId)).referrers).toEqual([]);
    await publishCustomEntity(reviewer, shelfId, 1);

    await expect(deleteCustomEntity(reviewer, storeId)).rejects.toMatchObject({
      status: 400, message: 'custom_store 被已发布的映射或关系引用，不能删除：关系 custom_shelf.store_id → custom_store.store_id',
    });
    expect((await getCustomEntity(author, storeId)).referrers).toEqual(['关系 custom_shelf.store_id → custom_store.store_id']);
    await deleteCustomEntity(reviewer, shelfId);
    await deleteCustomEntity(reviewer, storeId);
    expect(await listCustomEntities(author)).toEqual([]);
  });

  it('需要发布权限：分析师 403，其他租户 404', async () => {
    const { acme, author } = await engineers();
    const id = await createCustomEntity(author, STORE);
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await expect(deleteCustomEntity(analyst, id)).rejects.toMatchObject({ init: { status: 403 } });
    const outsider = await memberOf(await newTenant('globex'), 'de@globex.com');
    await expect(deleteCustomEntity(outsider, id)).rejects.toMatchObject({ status: 404 });
    expect(await listCustomEntities(author)).toHaveLength(1);
  });
});

describe('映射对照自定义实体登记', () => {
  it('没登记或只有草稿时映射保存不了；登记发布后能保存、发布并合并进标准层，敏感字段按登记存哈希', async () => {
    const { acme, author, reviewer } = await engineers();
    const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
    await selectAllTables(author, sourceId);
    await drain();
    await confirmWatermark(author, sourceId, 'customers', 'updated_at');
    await syncSource(author, sourceId);
    await drain();
    const yaml = `model: 1
entity: custom_store
table: customers
extensions:
  store_id: { type: string, expr: string(customer_id) }
  manager_phone: { type: string, expr: phone }
dedupe: { key: [store_id] }
`;
    const rejected = () => createMapping(author, sourceId, yaml).then(() => '已保存', (e: { issues: unknown }) => e.issues);
    expect(await rejected()).toEqual([
      { line: 2, col: 9, path: 'entity', message: expect.stringContaining('请先到「自定义实体」登记并发布') },
    ]);
    const id = await createCustomEntity(author, STORE);
    expect(await rejected()).toEqual([expect.objectContaining({ path: 'entity' })]);

    await publishCustomEntity(reviewer, id, 1);
    const mappingId = await publish(author, reviewer, sourceId, yaml);
    const rows = await silver(acme, 'custom_store', 'store_id::INT');
    expect(rows).toHaveLength(40);
    expect(rows[0]).toMatchObject({ store_id: '1', manager_phone: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // 保存草稿同样对照登记：没登记的字段报在该字段
    await expect(saveDraft(author, mappingId, yaml.replace('dedupe', '  city: { type: string, expr: city }\ndedupe'))).rejects.toMatchObject({
      issues: [expect.objectContaining({ line: 7, path: 'extensions.city', message: expect.stringContaining('没有登记字段 city') })],
    });
  });

  it('登记发布后按规则生成的草稿直接能保存；没登记、只有草稿或源表没有主键对应的列时报错', async () => {
    const { author, reviewer } = await engineers();
    const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
    await selectAllTables(author, sourceId);
    await drain();
    const MEMBER: CustomEntityInput = {
      name: 'custom_member', label: '会员', kind: 'dimension', primaryKey: ['customer_id'],
      fields: [
        { name: 'customer_id', type: 'string', description: '', sensitive: false },
        { name: 'phone', type: 'string', description: '', sensitive: true },
        { name: 'created_at', type: 'date', description: '', sensitive: false },
      ],
    };
    const draft = () => draftFor(author, sourceId, 'customers', 'custom_member');
    const unregistered = '只能为标准实体或已发布登记的自定义实体生成草稿，custom_member 都不是';
    await expect(draft()).rejects.toThrow(unregistered);
    const id = await createCustomEntity(author, MEMBER);
    await expect(draft()).rejects.toThrow(unregistered);

    await publishCustomEntity(reviewer, id, 1);
    const yaml = await draft();
    expect(yaml).toContain('created_at → 源列 created_at');
    await expect(createMapping(author, sourceId, yaml)).resolves.toBeTruthy();

    const other = await createCustomEntity(author, { ...MEMBER, name: 'custom_shop', primaryKey: ['shop_id'], fields: [...MEMBER.fields, { name: 'shop_id', type: 'string', description: '', sensitive: false }] });
    await publishCustomEntity(reviewer, other, 1);
    await expect(draftFor(author, sourceId, 'customers', 'custom_shop')).rejects.toThrow('源表没有与主键字段 shop_id 对应的列');
  });
});

describe('推断登记', () => {
  /** 登记并发布 custom_store、发布引用它的映射后直接删掉登记，模拟登记功能上线前就在用的实体 */
  async function unregistered(yamls: string[], sync = false) {
    const { acme, author, reviewer } = await engineers();
    const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
    await selectAllTables(author, sourceId);
    await drain();
    await publishCustomEntity(reviewer, await createCustomEntity(author, STORE), 1);
    const mappingIds = [];
    for (const yaml of yamls) mappingIds.push(await publish(author, reviewer, sourceId, yaml));
    await getDb().delete(customEntities);
    if (sync) {
      await confirmWatermark(author, sourceId, 'customers', 'updated_at');
      await syncSource(author, sourceId);
    }
    return { acme, author, reviewer, mappingIds };
  }
  const CUSTOMERS = `model: 1
entity: custom_store
table: customers
extensions:
  store_id: { type: string, expr: string(customer_id) }
  manager_phone: { type: string, expr: phone }
dedupe: { key: [store_id] }
`;
  const ORDERS = `model: 1
entity: custom_store
table: orders
extensions:
  store_id: { type: string, expr: string(customer_id) }
  opened_on: { type: date, expr: created_at }
dedupe: { key: [store_id, opened_on] }
`;

  it('字段取各映射扩展字段的并集、类型与敏感标记照映射，主键取映射 ID 排第一的去重键并说明分歧；重复调用不多出草稿', async () => {
    const { acme, author, mappingIds } = await unregistered([CUSTOMERS, ORDERS]);
    await getDb().transaction(tx => inferCustomEntityDrafts(tx, acme));
    await getDb().transaction(tx => inferCustomEntityDrafts(tx, acme));

    const [summary] = await listCustomEntities(author);
    expect(summary).toMatchObject({ name: 'custom_store', label: 'store', kind: 'dimension', published: null, draft: 1 });
    const { draft, versions } = await getCustomEntity(author, summary.id);
    expect(versions).toHaveLength(1);
    const first = mappingIds[0] < mappingIds[1] ? 'customers' : 'orders';
    expect(draft).toMatchObject({
      authors: ['platform'],
      lastEditor: 'platform',
      primaryKey: first === 'customers' ? ['store_id'] : ['store_id', 'opened_on'],
    });
    expect(draft!.fields.map(({ description: _, ...f }) => f).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'manager_phone', type: 'string', sensitive: true },
      { name: 'opened_on', type: 'date', sensitive: false },
      { name: 'store_id', type: 'string', sensitive: false },
    ]);
    expect(draft!.fields.find(f => f.name === 'store_id')!.description).toMatch(/去重键不一致[^]*store_id, opened_on/);
  });

  it('推断草稿直接发布被拒；一位成员确认保存、另一位成员发布后成为已发布登记；确认前照常合并', async () => {
    const { acme, author, reviewer } = await unregistered([CUSTOMERS], true);
    await getDb().transaction(tx => inferCustomEntityDrafts(tx, acme));
    const [{ id }] = await listCustomEntities(author);
    await expect(publishCustomEntity(reviewer, id, 1)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('先由一位成员确认') });

    // 确认前：已发布映射照常合并进标准层
    await drain();
    expect(await silver(acme, 'custom_store', 'store_id::INT')).toHaveLength(40);

    const { draft } = await getCustomEntity(author, id);
    await saveCustomEntityDraft(author, id, { label: '门店', kind: draft!.kind, fields: draft!.fields, primaryKey: draft!.primaryKey });
    await publishCustomEntity(reviewer, id, 1);
    expect((await publishedCustomEntities(getDb(), acme)).get('custom_store')).toMatchObject({
      label: '门店', primaryKey: ['store_id'], fields: [expect.objectContaining({ name: 'store_id' }), expect.objectContaining({ name: 'manager_phone', sensitive: true })],
    });
    // 已登记的实体不再推断
    await getDb().transaction(tx => inferCustomEntityDrafts(tx, acme));
    expect((await getCustomEntity(author, id)).versions).toHaveLength(1);
  });

  it('成员已有草稿的实体不推断、不覆盖', async () => {
    const { acme, author } = await unregistered([CUSTOMERS]);
    const id = await createCustomEntity(author, { ...STORE, label: '成员登记的门店' });
    await getDb().transaction(tx => inferCustomEntityDrafts(tx, acme));
    const { versions, draft } = await getCustomEntity(author, id);
    expect(versions).toHaveLength(1);
    expect(draft).toMatchObject({ label: '成员登记的门店', fields: STORE.fields, lastEditor: 'de@acme.com' });
  });
});

describe('自定义实体跨映射检查主键唯一', () => {
  const CUSTOMERS = `model: 1
entity: custom_store
table: customers
extensions:
  store_id: { type: string, expr: string(customer_id) }
dedupe: { key: [store_id] }
`;
  const ORDERS = `model: 1
entity: custom_store
table: orders
extensions:
  store_id: { type: string, expr: string(customer_id) }
  opened_on: { type: date, expr: created_at }
dedupe: { key: [store_id] }
`;
  /** 登记并发布 custom_store（referenced 时另登记指向它的 custom_shelf），customers 映射先合并，再发布 store_id 与之重叠的 orders 映射 */
  async function overlapping(referenced: boolean) {
    const { acme, author, reviewer } = await engineers();
    const { id: sourceId } = await registerSource(author, await pgSourceInput(READER));
    await selectAllTables(author, sourceId);
    await drain();
    await confirmWatermark(author, sourceId, 'customers', 'updated_at');
    await confirmWatermark(author, sourceId, 'orders', 'order_id');
    await syncSource(author, sourceId);
    await drain();
    await publishCustomEntity(reviewer, await createCustomEntity(author, STORE), 1);
    if (referenced) {
      await publishCustomEntity(reviewer, await createCustomEntity(author, {
        name: 'custom_shelf', label: '货架', kind: 'dimension', primaryKey: ['shelf_id'],
        fields: [{ name: 'shelf_id', type: 'string', description: '', sensitive: false }, { name: 'store_id', type: 'string', description: '', sensitive: false }],
        relations: [{ from: { entity: 'custom_shelf', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }],
      }), 1);
    }
    const first = await publish(author, reviewer, sourceId, CUSTOMERS);
    const before = await silver(acme, 'custom_store', 'store_id::INT, _mapping');
    const second = await publish(author, reviewer, sourceId, ORDERS);
    return { acme, author, first, second, before };
  }

  it('被指向时后合并的映射带着重复的主键合并失败，列出冲突的键与映射，标准层不变；先合并的映射照常完成', async () => {
    const { acme, author, first, second, before } = await overlapping(true);
    expect(before).toHaveLength(40);
    expect((await getMapping(author, first)).merge.history[0]).toMatchObject({ mode: 'rebuild', rows: 40 });

    const conflict = `主键 store_id 跨映射重复：1（映射 ${[first, second].sort().join('、')}）；10（映射`;
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('failed');
    expect(merge.error).toContain(conflict);
    const { error } = (await getMapping(author, second)).merge.history[0] as { error: string };
    expect(error).toContain(conflict);
    // 最多列出 5 个键：1、10、11、12、13，共 40 个
    expect(error.match(/（映射/g)).toHaveLength(5);
    expect(error).toContain('共 40 个');
    expect(await silver(acme, 'custom_store', 'store_id::INT, _mapping')).toEqual(before);
  });

  it('没被关系指向时同样的重复也合并失败（ADR-0024 独占），标准层不变', async () => {
    const { acme, before } = await overlapping(false);
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('failed');
    expect(merge.error).toContain('主键 store_id 跨映射重复');
    expect(await silver(acme, 'custom_store', 'store_id::INT, _mapping')).toEqual(before);
  });
});

describe('关系推荐', () => {
  /** 大区 N / S；门店的大区都在其中，网点有一个不存在的大区 W */
  const TABLES = `
    CREATE TABLE shop.areas (code text PRIMARY KEY, name text NOT NULL);
    INSERT INTO shop.areas VALUES ('N', '北区'), ('S', '南区');
    CREATE TABLE shop.stores (store_id text PRIMARY KEY, region_code text NOT NULL);
    INSERT INTO shop.stores VALUES ('S1', 'N'), ('S2', 'S'), ('S3', 'N');
    CREATE TABLE shop.outlets (outlet_id text PRIMARY KEY, region_code text NOT NULL);
    INSERT INTO shop.outlets VALUES ('O1', 'N'), ('O2', 'W');
    GRANT SELECT ON shop.areas, shop.stores, shop.outlets TO ${READER.user};`;
  const field = (name: string) => ({ name, type: 'string' as const, description: '', sensitive: false });
  const entity = (name: string, key: string, ...more: string[]): CustomEntityInput =>
    ({ name, label: name, kind: 'dimension', fields: [key, ...more].map(field), primaryKey: [key] });
  const mapping = (name: string, table: string, key: string, ...more: string[]) =>
    `model: 1\nentity: ${name}\ntable: ${table}\nextensions:\n${[key, ...more].map(f => `  ${f}: { type: string, expr: ${f} }\n`).join('')}dedupe: { key: [${key}] }\n`;
  const toRegion = (from: string): EntityRelation => ({ from: { entity: from, field: 'region_code' }, ref: { entity: 'custom_region', field: 'code' } });
  /** 标准字段 order.store_id 按列名指向门店，没有已发布的 order 映射，取值无从核对 */
  const orderToStore = { relation: { from: { entity: 'order', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } }, checked: 'name-only' };

  /** 门店、网点、大区都已登记并发布，门店与网点的映射已合并；大区的映射还没发布 */
  async function withStores() {
    const people = await engineers();
    const input = await pgSourceInput(READER);
    await grantOnSource(TABLES);
    const { id: sourceId } = await registerSource(people.author, input);
    await selectAllTables(people.author, sourceId);
    await drain();
    await syncSource(people.author, sourceId);
    await drain();
    const ids: Record<string, string> = {};
    for (const [name, key, more] of [['custom_region', 'code', 'name'], ['custom_store', 'store_id', 'region_code'], ['custom_outlet', 'outlet_id', 'region_code']]) {
      ids[name] = await createCustomEntity(people.author, entity(name, key, more));
      await publishCustomEntity(people.reviewer, ids[name], 1);
    }
    await publish(people.author, people.reviewer, sourceId, mapping('custom_store', 'stores', 'store_id', 'region_code'));
    await publish(people.author, people.reviewer, sourceId, mapping('custom_outlet', 'outlets', 'outlet_id', 'region_code'));
    return { ...people, sourceId, ids };
  }

  it('按列名推荐，起点的常见取值都在终点的标准层里时标「取值已核对」，有找不到的不推荐，终点还没合并时标「未核对取值」', async () => {
    const { author, reviewer, sourceId, ids } = await withStores();
    expect(await relationSuggestions(author, ids.custom_store)).toEqual([{ relation: toRegion('custom_store'), checked: 'name-only' }, orderToStore]);
    await publish(author, reviewer, sourceId, mapping('custom_region', 'areas', 'code', 'name'));
    expect(await relationSuggestions(author, ids.custom_store)).toEqual([{ relation: toRegion('custom_store'), checked: 'values' }, orderToStore]);
    expect(await relationSuggestions(author, ids.custom_outlet)).toEqual([]);
  });

  it('采纳后关系进了草稿、采纳的人是最后保存的人，不再推荐；重复采纳报错；分析师不能采纳', async () => {
    const { acme, author, reviewer, ids } = await withStores();
    expect(await adoptRelation(reviewer, ids.custom_store, { from: { entity: '', field: 'region_code' }, ref: { entity: 'custom_region', field: 'code' } })).toBe(2);
    const { draft } = await getCustomEntity(author, ids.custom_store);
    expect(draft).toMatchObject({ relations: [toRegion('custom_store')], lastEditor: 'de2@acme.com' });
    expect(await relationSuggestions(author, ids.custom_store)).toEqual([orderToStore]);
    await expect(adoptRelation(author, ids.custom_store, toRegion('custom_store'))).rejects.toThrow('关系 custom_store.region_code → custom_region.code 已经登记');
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await expect(adoptRelation(analyst, ids.custom_store, toRegion('custom_store'))).rejects.toMatchObject({ init: { status: 403 } });
  });
});

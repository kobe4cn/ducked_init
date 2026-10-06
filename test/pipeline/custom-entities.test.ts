// 自定义实体登记的接缝（ADR-0019）：createCustomEntity / saveCustomEntityDraft 校验名称、字段与主键后保存草稿；
// 双人发布与丢弃同源视图；publishedCustomEntities 给出每个实体最新的已发布版本。发布过的实体只能新增字段；
// deleteCustomEntity 删除没被已发布映射引用的实体；draftFor 按已发布登记生成自定义实体的映射草稿；inferCustomEntityDrafts 为已发布映射在用、但没登记的实体推断登记草稿
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import {
  createCustomEntity, deleteCustomEntity, discardCustomEntityDraft, getCustomEntity, inferCustomEntityDrafts, listCustomEntities, publishCustomEntity,
  publishedCustomEntities, saveCustomEntityDraft, type CustomEntityInput,
} from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { customEntities } from '../../app/.server/db/schema';
import { createMapping, draftFor, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables, silver } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

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
      name: 'custom_store', label: '门店', kind: 'dimension', fields: STORE.fields, primaryKey: ['store_id'],
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
      status: 400, message: 'custom_store 被已发布的映射引用，不能删除：「电商库」customers',
    });
    expect((await getCustomEntity(author, id)).referrers).toEqual(['「电商库」customers']);

    const unused = await createCustomEntity(author, { ...STORE, name: 'custom_region' });
    await deleteCustomEntity(reviewer, unused);
    await expect(getCustomEntity(author, unused)).rejects.toMatchObject({ status: 404 });
    expect((await listAuditLogs(acme)).filter(l => l.action === '删除自定义实体').map(l => l.summary)).toEqual(['custom_region']);
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

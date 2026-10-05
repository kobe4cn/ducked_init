// 自定义实体登记的接缝（ADR-0019）：createCustomEntity / saveCustomEntityDraft 校验名称、字段与主键后保存草稿；
// 双人发布与丢弃同源视图；publishedCustomEntities 给出每个实体最新的已发布版本
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCustomEntity, discardCustomEntityDraft, getCustomEntity, listCustomEntities, publishCustomEntity, publishedCustomEntities, saveCustomEntityDraft,
  type CustomEntityInput,
} from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

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
    expect(await listCustomEntities(author)).toEqual([{ id, name: 'custom_store', label: '门店', kind: 'dimension', published: null, draft: 1 }]);
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
    expect(await listCustomEntities(author)).toEqual([{ id, name: 'custom_store', label: '门店', kind: 'dimension', published: 1, draft: null }]);
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

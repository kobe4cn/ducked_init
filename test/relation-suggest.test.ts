// test/relation-suggest.test.ts —— 关系推荐的规则（ADR-0019）：suggestRelations 按列名相似、两端类型与已有关系，从候选起点与终点里挑出关系，带上取值核对的结果
import { describe, expect, it } from 'vitest';
import { suggestRelations, type SuggestInput } from '../app/.server/relation-suggest';
import { relationText } from '../app/lib/canonical-model';

const rel = (from: string, ref: string) => {
  const [fe, ff] = from.split('.');
  const [re, rf] = ref.split('.');
  return { from: { entity: fe, field: ff }, ref: { entity: re, field: rf } };
};
const texts = (input: SuggestInput) => suggestRelations(input).map(s => relationText(s.relation));

/** 门店登记了 region_code、customer_id、code 与 opened_on；终点有大区（主键 code）、消费者、门店自己（主键 store_id） */
const STORE: SuggestInput = {
  entity: 'custom_store',
  origins: [
    { entity: 'custom_store', field: 'store_id', type: 'string', sensitive: false },
    { entity: 'custom_store', field: 'region_code', type: 'string', sensitive: false },
    { entity: 'custom_store', field: 'customer_id', type: 'string', sensitive: false },
    { entity: 'custom_store', field: 'opened_on', type: 'date', sensitive: false },
    { entity: 'order', field: 'store_id', type: 'string', sensitive: false },
    { entity: 'order', field: 'x_store_id', type: 'string', sensitive: false },
    { entity: 'order', field: 'x_store_store_id', type: 'string', sensitive: false },
    { entity: 'order', field: 'x_region_code', type: 'string', sensitive: false },
  ],
  targets: [
    { entity: 'custom_region', key: 'code', type: 'string', sensitive: false },
    { entity: 'customer', key: 'customer_id', type: 'string', sensitive: false },
    { entity: 'custom_store', key: 'store_id', type: 'string', sensitive: false },
  ],
  existing: [],
};

describe('suggestRelations', () => {
  it('起点字段名等于终点主键，或等于「终点实体名去掉 custom_ 前缀_主键」时推荐；标准实体的 x_ 字段去掉前缀再比', () => {
    expect(texts(STORE)).toEqual([
      'custom_store.region_code → custom_region.code',
      'custom_store.customer_id → customer.customer_id',
      'order.store_id → custom_store.store_id',
      'order.x_store_id → custom_store.store_id',
      'order.x_store_store_id → custom_store.store_id',
    ]);
  });

  it('本实体的字段不指向本实体，标准实体的字段只指向本实体', () => {
    expect(texts({ ...STORE, origins: [{ entity: 'custom_store', field: 'store_id', type: 'string', sensitive: false }, { entity: 'order', field: 'x_region_code', type: 'string', sensitive: false }] })).toEqual([]);
  });

  it('两端类型不一致时不推荐', () => {
    expect(texts({ ...STORE, origins: [{ entity: 'custom_store', field: 'region_code', type: 'integer', sensitive: false }, { entity: 'order', field: 'store_id', type: 'integer', sensitive: false }] })).toEqual([]);
  });

  it('两端敏感性不一致时不推荐：标准层里一端是哈希，关联不上', () => {
    const sensitive = (o: SuggestInput['origins'][number]) => ({ ...o, sensitive: o.field === 'customer_id' || o.field === 'x_store_id' });
    expect(texts({ ...STORE, origins: STORE.origins.map(sensitive) })).toEqual([
      'custom_store.region_code → custom_region.code',
      'order.store_id → custom_store.store_id',
      'order.x_store_store_id → custom_store.store_id',
    ]);
    // 两端都敏感照常推荐
    const targets = STORE.targets.map(t => ({ ...t, sensitive: t.entity === 'customer' }));
    expect(texts({ ...STORE, origins: STORE.origins.map(sensitive), targets })).toContain('custom_store.customer_id → customer.customer_id');
  });

  it('已有的关系（内置 ref、已发布或草稿上登记的）不再推荐', () => {
    const existing = [rel('custom_store.region_code', 'custom_region.code'), rel('order.store_id', 'custom_store.store_id')];
    expect(texts({ ...STORE, existing })).toEqual([
      'custom_store.customer_id → customer.customer_id',
      'order.x_store_id → custom_store.store_id',
      'order.x_store_store_id → custom_store.store_id',
    ]);
  });

  it('取值全部找到的标「取值已核对」，有找不到的丢弃，没核对的标「未核对取值」', () => {
    const checks = new Map([
      ['custom_store.region_code → custom_region.code', true],
      ['custom_store.customer_id → customer.customer_id', false],
    ]);
    const suggestions = suggestRelations({ ...STORE, origins: STORE.origins.slice(0, 5), checks });
    expect(suggestions).toEqual([
      { relation: rel('custom_store.region_code', 'custom_region.code'), checked: 'values' },
      { relation: rel('order.store_id', 'custom_store.store_id'), checked: 'name-only' },
    ]);
  });
});

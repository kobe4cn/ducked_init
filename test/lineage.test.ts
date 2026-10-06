// test/lineage.test.ts —— 数据地图的血缘：由已发布映射推出表级（数据源 → 源表 → 映射及版本 → 标准层表）、字段级（标准层字段对应的源列与表达式）
// 与关系边（标准实体的 ref、经 silver._identities 关联 customer、event.device_id → silver._device_owner），以及一个源列的影响范围（纯函数）
import { describe, expect, it } from 'vitest';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';
import { deriveLineage, impactOf } from '../app/lib/lineage';

const plan = (over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: 'm-order',
  version: 3,
  sourceId: 's-shop',
  entity: 'order',
  table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'customer_id', type: 'string', expr: 'buyer' },
    { name: 'status', type: 'string', expr: 'status', dictionary: { paid: 'paid' }, enum: ['paid', 'refunded', 'cancelled'], otherwise: null },
    { name: 'total_amount', type: 'decimal', expr: 'coalesce(amount, 0) - discount + amount' },
    { name: 'x_buyer_phone', type: 'string', expr: 'phone', sensitive: true },
  ],
  entityColumns: [],
  key: ['order_id'],
  latest: null,
  ...over,
});

const sources = [
  { id: 's-shop', name: '商城', kind: 'postgres' },
  { id: 's-erp', name: 'ERP', kind: 'mysql' },
];

const plans = [
  plan(),
  plan({
    mapping: 'm-customer', version: 1, sourceId: 's-erp', entity: 'customer', table: 'v_members',
    view: { key: [] }, sourceView: { version: 2, sql: 'select 1', tables: ['members'] },
    columns: [{ name: 'customer_id', type: 'string', expr: 'member_no' }, { name: 'phone', type: 'string', expr: 'mobile', sensitive: true }],
    key: ['customer_id'],
  }),
  plan({
    mapping: 'm-store', version: 2, sourceId: 's-erp', entity: 'custom_store', table: 'stores',
    columns: [{ name: 'store_id', type: 'string', expr: 'id' }, { name: 'x_region', type: 'string', expr: 'region' }],
    key: ['store_id'],
  }),
];

describe('由已发布映射推导血缘', () => {
  it('表级：数据源、源表（或源视图）、映射及版本、标准层表', () => {
    expect(deriveLineage({ plans, sources }).tables).toEqual([
      { sourceId: 's-erp', sourceName: 'ERP', sourceKind: 'mysql', table: 'stores', viaView: false, mapping: 'm-store', version: 2, entity: 'custom_store', target: 'silver.custom_store', custom: true },
      { sourceId: 's-erp', sourceName: 'ERP', sourceKind: 'mysql', table: 'v_members', viaView: true, mapping: 'm-customer', version: 1, entity: 'customer', target: 'silver.customer', custom: false },
      { sourceId: 's-shop', sourceName: '商城', sourceKind: 'postgres', table: 'orders', viaView: false, mapping: 'm-order', version: 3, entity: 'order', target: 'silver.order', custom: false },
    ]);
  });

  it('字段级：每列的源列与表达式，标出敏感哈希、值字典与扩展字段（自定义实体的列不算扩展字段）', () => {
    const { fields } = deriveLineage({ plans, sources });
    expect(fields.map(f => `${f.entity}.${f.field}`)).toEqual([
      'custom_store.store_id', 'custom_store.x_region',
      'customer.customer_id', 'customer.phone',
      'order.customer_id', 'order.order_id', 'order.status', 'order.total_amount', 'order.x_buyer_phone',
    ]);
    const by = (k: string) => fields.find(f => `${f.entity}.${f.field}` === k);
    expect(by('order.total_amount')).toEqual({
      entity: 'order', field: 'total_amount', mapping: 'm-order', version: 3, sourceId: 's-shop', table: 'orders',
      expr: 'coalesce(amount, 0) - discount + amount', sourceColumns: ['amount', 'discount'], sensitive: false, dictionary: false, extension: false,
      fallback: null,
    });
    expect(by('order.status')).toMatchObject({ dictionary: true, sensitive: false, extension: false, fallback: { value: null } });
    expect(by('order.x_buyer_phone')).toMatchObject({ sensitive: true, extension: true, sourceColumns: ['phone'] });
    expect(by('customer.phone')).toMatchObject({ sensitive: true, table: 'v_members', sourceColumns: ['mobile'] });
    expect(by('custom_store.x_region')).toMatchObject({ extension: false });
    expect(JSON.stringify(fields)).not.toContain('paid');
  });

  it('反查一个源列影响了哪些标准层字段', () => {
    const lineage = deriveLineage({ plans, sources });
    expect(impactOf(lineage, 's-shop', 'orders', 'amount').map(f => `${f.entity}.${f.field}`)).toEqual(['order.total_amount']);
    expect(impactOf(lineage, 's-erp', 'orders', 'amount')).toEqual([]);
    expect(impactOf(lineage, 's-erp', 'v_members', 'mobile').map(f => f.field)).toEqual(['phone']);
  });

  it('关系边：内置 ref、指向 customer 的经 silver._identities 关联、event.device_id 指向 silver._device_owner', () => {
    const { edges } = deriveLineage({ plans: [], sources: [] });
    expect(edges).toContainEqual({ from: { entity: 'order_item', field: 'order_id' }, to: { table: 'silver.order', field: 'order_id' }, kind: 'ref' });
    expect(edges).toContainEqual({
      from: { entity: 'order', field: 'customer_id' }, to: { table: 'silver.customer', field: 'customer_id' },
      via: { table: 'silver._identities', on: ['_source', 'customer_id'] }, kind: 'identity',
    });
    expect(edges).toContainEqual({ from: { entity: 'event', field: 'device_id' }, to: { table: 'silver._device_owner', field: 'device_id' }, kind: 'device' });
    expect(edges.filter(e => e.kind === 'identity')).toHaveLength(8);
    expect(edges.filter(e => e.kind === 'ref')).toHaveLength(6);
  });
});

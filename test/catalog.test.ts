// test/catalog.test.ts —— 语义目录（ADR-0041）：按元数据生成条目，总览、按稳定标识展开与关键词搜索，可渲染成 Markdown 与 JSON；
// 敏感字段、哈希列与系统列不进目录（纯函数，手工构造 CatalogInput）
import { describe, expect, it } from 'vitest';
import { buildCatalog, estimateTokens, expand, overview, search, toJson, toMarkdown, type CatalogInput } from '../app/.server/catalog';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const plan = (over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: 'm-order',
  version: 3,
  sourceId: 's-shop',
  entity: 'order',
  table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'customer_id', type: 'string', expr: 'string(buyer)', customerRef: true },
    { name: 'status', type: 'string', expr: 'state', dictionary: { 已支付: 'paid' }, enum: ['paid', 'refunded'], otherwise: null },
    { name: 'x_buyer_phone', type: 'string', expr: 'buyer_phone', sensitive: true },
    { name: 'x_coupon_code', type: 'string', expr: 'coupon' },
  ],
  entityColumns: [],
  key: ['order_id'],
  latest: null,
  ...over,
});

const input = (): CatalogInput => ({
  sources: [
    { id: 's-shop', name: '商城', kind: 'postgres' },
    { id: 's-erp', name: 'ERP', kind: 'mysql' },
  ],
  tables: [
    {
      sourceId: 's-shop', name: 'orders', view: false,
      columns: [
        { name: 'order_id', type: 'BIGINT' }, { name: 'buyer', type: 'INTEGER' }, { name: 'state', type: 'VARCHAR' },
        { name: 'buyer_phone', type: 'VARCHAR' }, { name: 'coupon', type: 'VARCHAR' }, { name: 'contact_x', type: 'VARCHAR' },
        { name: 'memo', type: 'VARCHAR', formats: [{ format: 'email' }] }, { name: 'secret_code', type: 'VARCHAR' },
      ],
    },
    { sourceId: 's-shop', name: 'members', view: false, columns: [{ name: 'member_id', type: 'BIGINT' }, { name: 'level', type: 'VARCHAR' }] },
    { sourceId: 's-erp', name: 'customers', view: false, columns: [{ name: 'id', type: 'INTEGER' }, { name: 'unionid', type: 'VARCHAR' }] },
    {
      sourceId: 's-erp', name: 'v_stores', view: true,
      columns: [{ name: 'store_id', type: 'VARCHAR' }, { name: 'region', type: 'VARCHAR' }, { name: 'mgr', type: 'VARCHAR' }, { name: '_hash', type: 'VARCHAR' }, { name: '_synced_at', type: 'TIMESTAMP' }],
    },
  ],
  plans: [
    plan({ columns: [...plan().columns, { name: 'store_id', type: 'string', expr: 'secret_code', sensitive: true }] }),
    plan({ mapping: 'm-erp-order', version: 1, sourceId: 's-erp', table: 'customers', entity: 'customer', columns: [
      { name: 'customer_id', type: 'string', expr: 'string(id)' },
      { name: 'external_id', type: 'string', expr: 'unionid', sensitive: true },
    ] }),
    plan({ mapping: 'm-store', version: 2, sourceId: 's-erp', table: 'v_stores', entity: 'custom_store', sourceView: { version: 1, sql: 'select 1', tables: [] }, columns: [
      { name: 'store_id', type: 'string', expr: 'store_id' },
      { name: 'region', type: 'string', expr: 'region' },
      { name: 'manager_phone', type: 'string', expr: 'mgr', sensitive: true },
    ] }),
    plan({ mapping: 'm-erp-orders', version: 4, sourceId: 's-erp', table: 'customers', entity: 'order', columns: [{ name: 'order_id', type: 'string', expr: 'string(id)' }] }),
    // 读的表已移出同步范围
    plan({ mapping: 'm-legacy', version: 1, table: 'legacy_orders', columns: [{ name: 'order_id', type: 'string', expr: 'no' }] }),
  ],
  customEntities: [{
    name: 'custom_store', label: '门店', kind: 'dimension', primaryKey: ['store_id'],
    fields: [
      { name: 'store_id', type: 'string', description: '门店编码', sensitive: false },
      { name: 'region', type: 'string', description: '所在大区（华东、华南）', sensitive: false },
      { name: 'manager_phone', type: 'string', description: '店长手机', sensitive: true },
    ],
    relations: [{ from: { entity: 'custom_store', field: 'manager_phone' }, ref: { entity: 'customer', field: 'customer_id' } }],
  }],
  mergeGroups: [{ entity: 'order', id: 'g-1', version: 1, rule: { kind: 'priority' }, members: ['m-erp-orders', 'm-order', 'm-gone'] }],
});

/** 全部输出：总览、每个条目的展开与几次搜索，Markdown 与 JSON 各一份 */
function everything(input: CatalogInput) {
  const c = buildCatalog(input);
  const ov = overview(c);
  const ids = c.entries.map(e => e.id);
  const out = [toMarkdown(ov), toJson(ov)];
  for (const id of ids) out.push(toMarkdown(expand(c, id)!), toJson(expand(c, id)!));
  for (const q of ['phone', 'unionid', '手机', 'hash', 'synced', 'secret', 'contact', 'memo']) out.push(toMarkdown(search(c, q)), toJson(search(c, q)));
  return { c, ids, text: out.join('\n') };
}

describe('语义目录', () => {
  it('同一份输入生成的总览与展开逐字节相同，标识只用名字、不带版本，按标识排序', () => {
    const a = everything(input());
    const shuffled = input();
    shuffled.sources!.reverse(); shuffled.tables!.reverse(); shuffled.plans!.reverse();
    const b = everything(shuffled);
    expect(b.text).toBe(a.text);
    expect(a.ids).toEqual([...a.ids].sort());
    expect(a.ids).toEqual(expect.arrayContaining([
      'source:商城', 'source:ERP', 'table:商城/orders', 'table:ERP/v_stores', 'entity:order', 'entity:custom_store', 'field:order.status',
      'field:order.x_coupon_code', 'relation:order.customer_id',
    ]));
    expect(a.ids.every(id => /^(source|table|entity|field|relation):/.test(id) && !/m-order|\bv\d/.test(id))).toBe(true);
  });

  it('总览每项一行（标识、名称、说明截到 40 字），实体附字段名，估算不超过 4000 token', () => {
    const c = buildCatalog(input());
    const md = toMarkdown(overview(c));
    expect(estimateTokens(md)).toBeLessThanOrEqual(4000);
    const line = md.split('\n').find(l => l.includes('entity:order '))!;
    expect(line).toContain('订单');
    expect(line).toMatch(/order_id, customer_id, status.*x_coupon_code/);
    expect(md).toMatch(/table:商城\/members .*未映射/);
    expect(md).not.toContain('field:');
    const long = md.split('\n').find(l => l.includes('entity:points_transaction '))!;
    expect(long).toContain('一笔积分变动（获得、消费抵扣、兑换、过期、调整）。当前余额看会员的积分，'.slice(0, 40));
    expect(long).not.toContain('获取与消耗看积分流水');
  });

  it('字段太多时总览里的实体只给字段数，仍不超过 4000 token', () => {
    const big = input();
    const many = Array.from({ length: 1000 }, (_, i) => ({ name: `stat_field_${i}`, type: 'string' as const, description: `第 ${i} 个统计字段的说明`, sensitive: false }));
    big.customEntities![0].fields.push(...many);
    const c = buildCatalog(big);
    const md = toMarkdown(overview(c));
    expect(estimateTokens(md)).toBeLessThanOrEqual(4000);
    expect(md).not.toContain('stat_field_999');
    expect(md).toMatch(/entity:custom_store .*1002 个字段/);
    expect(md).toMatch(/entity:order .*\d+ 个字段/);
    expect(expand(c, 'field:custom_store.stat_field_999')).toMatchObject({ kind: 'field', type: 'string' });
  });

  it('按标识展开数据源、源表、实体、字段与关系，标识不存在时返回 null', () => {
    const c = buildCatalog(input());
    expect(expand(c, 'source:商城')).toMatchObject({ kind: 'source', name: '商城', sourceKind: 'postgres', tables: ['table:商城/members', 'table:商城/orders'] });
    expect(expand(c, 'table:商城/members')).toMatchObject({ kind: 'table', mapped: false, entities: [], columns: [{ name: 'member_id', type: 'BIGINT' }, { name: 'level', type: 'VARCHAR' }] });
    expect(expand(c, 'table:ERP/v_stores')).toMatchObject({ kind: 'table', view: true, mapped: true, entities: ['entity:custom_store'] });
    const order = expand(c, 'entity:order');
    expect(order).toMatchObject({
      kind: 'entity', name: '订单', custom: false, key: ['order_id'],
      tables: ['table:ERP/customers', 'table:商城/legacy_orders', 'table:商城/orders'], unscoped: ['table:商城/legacy_orders'],
      mergeGroups: [{ rule: '按优先级', members: ['table:ERP/customers', 'table:商城/orders'] }],
    });
    expect(order && 'fields' in order && order.fields.map(f => f.name)).toEqual(expect.arrayContaining(['status', 'x_coupon_code']));
    expect(toMarkdown(order!)).toContain('table:商城/legacy_orders（不在同步范围）');
    expect(expand(c, 'table:商城/legacy_orders')).toBeNull();
    expect(expand(c, 'entity:custom_store')).toMatchObject({ kind: 'entity', name: '门店', custom: true, key: ['store_id'] });
    expect(expand(c, 'field:order.status')).toMatchObject({
      kind: 'field', entity: 'entity:order', name: '订单状态', type: 'string', enum: ['created', 'paid', 'shipped', 'completed', 'cancelled', 'refunded'],
      lineage: [{ source: '商城', table: 'orders', expr: 'state', sourceColumns: ['state'], dictionary: true }],
    });
    expect(expand(c, 'field:order.amount')).toMatchObject({ kind: 'field', lineage: [] });
    expect(expand(c, 'relation:order.customer_id')).toMatchObject({ kind: 'relation', from: 'field:order.customer_id', to: 'field:customer.customer_id' });
    expect(toMarkdown(expand(c, 'field:order.status')!)).toContain('refunded');
    expect(JSON.parse(toJson(expand(c, 'source:ERP')!))).toMatchObject({ id: 'source:ERP' });
    for (const id of ['entity:nope', 'field:order.nope', 'source:', 'relation:custom_store.manager_phone', 'table:ERP/members']) expect(expand(c, id)).toBeNull();
  });

  it('按中英文关键词搜到字段说明与枚举取值，顺序确定', () => {
    const c = buildCatalog(input());
    const zh = search(c, '订单状态');
    expect(zh[0].id).toBe('field:order.status');
    expect(search(c, '大区').map(e => e.id)).toEqual(['field:custom_store.region']);
    const en = search(c, 'REFUNDED orders');
    expect(en.map(e => e.id)).toContain('field:order.status');
    expect(en.map(e => e.id)).toEqual(search(c, 'refunded ORDERS').map(e => e.id));
    // 同分按标识排
    const hits = search(c, 'redeemed');
    expect(hits.map(e => e.id)).toEqual([...hits.map(e => e.id)].sort());
    expect(search(c, '积分', 3)).toHaveLength(3);
    expect(search(c, 'x')).toEqual([]);
    expect(toMarkdown(search(c, '大区'))).toContain('field:custom_store.region');
  });

  it('敏感字段、哈希列与系统列不出现在任何输出里', () => {
    const { ids, text } = everything(input());
    for (const id of ['field:customer.phone', 'field:customer.name', 'field:customer.email', 'field:customer.external_id', 'field:order.x_buyer_phone',
      'field:custom_store.manager_phone', 'relation:custom_store.manager_phone']) expect(ids).not.toContain(id);
    // 敏感的计划列、它们引用的源列、像敏感信息的源列（列名或取值格式）、哈希列与系统列
    for (const word of ['x_buyer_phone', 'buyer_phone', 'manager_phone', 'unionid', 'secret_code', 'mgr', 'contact_x', 'memo', '_hash', '_synced_at', 'external_id']) {
      expect(text, word).not.toContain(word);
    }
  });
});

// test/lineage-search.test.ts —— 数据地图的反向查：按列名或「表.列」（不区分大小写）找出受影响的源表、映射、标准层表、连线与字段行；
// 源表抽屉按源列列出它影响的标准层字段（纯函数）
import { describe, expect, it } from 'vitest';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';
import { deriveLineage } from '../app/lib/lineage';
import { searchImpact, tableImpact } from '../app/lib/lineage-search';

const plan = (over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: 'm-order',
  version: 3,
  sourceId: 's-shop',
  entity: 'order',
  table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'status' },
    { name: 'total_amount', type: 'decimal', expr: 'coalesce(amount, 0) - discount' },
  ],
  entityColumns: [],
  key: ['order_id'],
  latest: null,
  ...over,
});

const sources = [
  { id: 's-shop', name: '商城', kind: 'postgres' },
  { id: 's-club', name: '会员', kind: 'mysql' },
];

// 两个数据源都有叫 orders 的表
const lineage = deriveLineage({
  sources,
  plans: [
    plan(),
    plan({
      mapping: 'm-club-order', version: 1, sourceId: 's-club',
      columns: [{ name: 'order_id', type: 'string', expr: 'no' }, { name: 'status', type: 'string', expr: 'upper(Status)' }],
    }),
    plan({
      mapping: 'm-customer', version: 2, sourceId: 's-club', entity: 'customer', table: 'members',
      columns: [{ name: 'customer_id', type: 'string', expr: 'member_no' }, { name: 'status', type: 'string', expr: 'status' }],
      key: ['customer_id'],
    }),
  ],
});

const sorted = (s: Set<string>) => [...s].sort();

describe('反向查一个源列影响了哪些标准层字段', () => {
  it('只写列名时匹配所有源表里的这个列：源表、映射、标准层表与它们之间的连线，聚焦画布的连线与字段行', () => {
    const hits = searchImpact(lineage, 'discount')!;
    expect(sorted(hits.nodes)).toEqual(['mapping:m-order', 'silver.order', 'source:s-shop', 'table:s-shop:orders']);
    expect(sorted(hits.edges)).toEqual([
      'm-order:discount->total_amount',
      'mapping:m-order->silver.order',
      'source:s-shop->mapping:m-order',
      'table:s-shop:orders->mapping:m-order',
    ]);
    expect(sorted(hits.fields)).toEqual(['silver.order/total_amount', 'table:s-shop:orders/discount']);
  });

  it('列名跨源表命中', () => {
    const hits = searchImpact(lineage, 'status')!;
    expect(sorted(hits.nodes)).toEqual([
      'mapping:m-club-order', 'mapping:m-customer', 'mapping:m-order',
      'silver.customer', 'silver.order',
      'source:s-club', 'source:s-shop',
      'table:s-club:members', 'table:s-club:orders', 'table:s-shop:orders',
    ]);
  });

  it('「表.列」只匹配这个名字的源表，两个数据源里同名的 orders 都命中', () => {
    const hits = searchImpact(lineage, 'orders.status')!;
    expect(sorted(hits.nodes)).toEqual([
      'mapping:m-club-order', 'mapping:m-order', 'silver.order',
      'source:s-club', 'source:s-shop', 'table:s-club:orders', 'table:s-shop:orders',
    ]);
    expect(sorted(hits.fields)).toEqual(['silver.order/status', 'table:s-club:orders/Status', 'table:s-shop:orders/status']);
  });

  it('不区分大小写，忽略首尾空白', () => {
    expect(sorted(searchImpact(lineage, '  ORDERS.Status ')!.nodes)).toEqual(sorted(searchImpact(lineage, 'orders.status')!.nodes));
    expect(sorted(searchImpact(lineage, 'MEMBER_NO')!.fields)).toEqual(['silver.customer/customer_id', 'table:s-club:members/member_no']);
  });

  it('没有命中时各集合为空；没有输入时为 null', () => {
    const hits = searchImpact(lineage, 'members.amount')!;
    expect([hits.nodes.size, hits.edges.size, hits.fields.size]).toEqual([0, 0, 0]);
    expect(searchImpact(lineage, '')).toBeNull();
    expect(searchImpact(lineage, '   ')).toBeNull();
  });
});

describe('源表抽屉', () => {
  it('按源列（排序）列出这张源表影响的标准层字段、映射与表达式，同名的 orders 按数据源分开', () => {
    const impact = tableImpact(lineage, 'table:s-club:orders')!;
    expect(impact).toMatchObject({ sourceId: 's-club', sourceName: '会员', table: 'orders' });
    expect(impact.columns).toEqual([
      { column: 'Status', fields: [{ entity: 'order', field: 'status', mapping: 'm-club-order', version: 1, expr: 'upper(Status)' }] },
      { column: 'no', fields: [{ entity: 'order', field: 'order_id', mapping: 'm-club-order', version: 1, expr: 'no' }] },
    ]);
    expect(tableImpact(lineage, 'table:s-shop:orders')!.columns.map(c => c.column)).toEqual(['amount', 'discount', 'order_id', 'status']);
  });

  it('不是源表节点或没有映射用到这张表时为 null', () => {
    for (const node of ['silver.order', 'table:s-shop:members', 'table:s-shop', 'mapping:m-order']) expect(tableImpact(lineage, node)).toBeNull();
  });
});

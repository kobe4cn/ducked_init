// test/lineage-focus.test.ts —— 数据地图的单表聚焦画布：只有一张标准层表与写入它的源表，同名源表按数据源分成两个节点；
// 节点逐行列出字段（源表只列被引用到的源列），节点高度随行数变；每对（源列, 字段）一条边，handle 是列名，多列表达式出多条边，常量没有入边（纯函数）
import { describe, expect, it } from 'vitest';
import type { FieldLineage } from '../app/lib/lineage';
import { focusGraph } from '../app/lib/lineage-focus';

const field = (sourceId: string, table: string, mapping: string, name: string, expr: string, sourceColumns: string[]): FieldLineage => ({
  entity: 'order', field: name, mapping, version: 1, sourceId, table, expr, sourceColumns,
  sensitive: false, dictionary: false, extension: false, fallback: null,
});

const lineage = [
  field('crm', 'orders', 'm1', 'order_id', 'order_no', ['order_no']),
  field('crm', 'orders', 'm1', 'amount', 'amount', ['amount']),
  field('crm', 'orders', 'm1', 'status', "concat(state, '-', sub_state)", ['state', 'sub_state']),
  field('crm', 'orders', 'm1', 'channel', "'crm'", []),
  field('loyalty', 'orders', 'm2', 'order_id', 'string(id)', ['id']),
  field('loyalty', 'orders', 'm2', 'amount', 'total', ['total']),
];
const fields = ['order_id', 'status', 'amount', 'channel'];

describe('单表聚焦画布', () => {
  it('同名源表按数据源是两个节点，源表只列被引用到的源列（按字段顺序），标准层表列出字段；节点高度随行数变', () => {
    const g = focusGraph({ entity: 'order', fields, lineage, sourceNames: { crm: 'CRM 库', loyalty: '会员库' } });
    const node = (id: string) => g.nodes.find(n => n.id === id)!;
    expect(g.nodes.map(n => n.id).sort()).toEqual(['silver.order', 'table:crm:orders', 'table:loyalty:orders']);
    expect(node('table:crm:orders').data).toMatchObject({ kind: 'table', label: 'orders', sourceName: 'CRM 库', columns: ['order_no', 'state', 'sub_state', 'amount'] });
    expect(node('table:loyalty:orders').data).toMatchObject({ kind: 'table', label: 'orders', sourceName: '会员库', columns: ['id', 'total'] });
    expect(node('silver.order').data).toMatchObject({ kind: 'silver', label: 'silver.order', columns: fields });
    expect(node('silver.order').height).toBeGreaterThan(node('table:loyalty:orders').height);
    // 从左到右：源表、标准层表
    expect(node('table:crm:orders').position.x).toBeLessThan(node('silver.order').position.x);
  });

  it('每条边从源列连到标准层字段：多列表达式出多条边，常量没有入边', () => {
    const g = focusGraph({ entity: 'order', fields, lineage, sourceNames: {} });
    const edges = g.edges.map(e => `${e.source}.${e.sourceHandle}→${e.targetHandle}`);
    expect(edges.sort()).toEqual([
      'table:crm:orders.amount→amount',
      'table:crm:orders.order_no→order_id',
      'table:crm:orders.state→status',
      'table:crm:orders.sub_state→status',
      'table:loyalty:orders.id→order_id',
      'table:loyalty:orders.total→amount',
    ]);
    for (const e of g.edges) expect(e.target).toBe('silver.order');
    expect(g.edges.some(e => e.targetHandle === 'channel')).toBe(false);
    expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length);
    // 源表的 handle 都在它的行里，字段的 handle 都在标准层表的行里
    for (const e of g.edges) {
      expect((g.nodes.find(n => n.id === e.source)!.data.columns)).toContain(e.sourceHandle);
      expect(g.nodes.find(n => n.id === 'silver.order')!.data.columns).toContain(e.targetHandle);
    }
  });

  it('只看写入这张表的血缘；数据源名字缺省时用数据源 ID', () => {
    const g = focusGraph({ entity: 'order', fields, lineage: [...lineage, { ...field('crm', 'customers', 'm3', 'name', 'name', ['name']), entity: 'customer' }], sourceNames: {} });
    expect(g.nodes.some(n => n.id === 'table:crm:customers')).toBe(false);
    expect(g.nodes.find(n => n.id === 'table:crm:orders')!.data).toMatchObject({ sourceName: 'crm' });
  });
});

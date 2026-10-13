// test/lineage-graph.test.ts —— 数据地图的关系图：由血缘的关系边与已接入的实体画出节点（含 _identities、_device_owner）、边的种类与说明、
// 跨源引用合并到同一字段的边上并标「跨源 · <数据源名>」，dagre 布局的坐标，显示未接入的标准实体时的节点与边（标为未接入），_identities 节点上的打通摘要（有合并、拆开时多一行组数），
// 以及点表节点给出的示例 SQL（按租户湖挂载为 lake 来写，不带连接方式与凭据；未接入的节点没有）（纯函数）
import { describe, expect, it } from 'vitest';
import { deriveLineage } from '../app/lib/lineage';
import { crossSourceLabel, identityChangesLabel, relationGraph, ruleLabels, sampleSql } from '../app/lib/lineage-graph';

const { edges } = deriveLineage({ plans: [], sources: [] });
const graphOf = (connected: string[], extra: { showAll?: boolean; identity?: Parameters<typeof relationGraph>[0]['identity'] } = {}) =>
  relationGraph({ edges, connected, showAll: false, ...extra });

describe('关系图', () => {
  it('只接入 order 时，没有 customer 节点，也没有 identity 边', () => {
    const g = graphOf(['order']);
    expect(g.nodes.map(n => n.id)).toEqual(['order']);
    expect(g.nodes[0]).toMatchObject({ label: '订单', kind: 'entity' });
    expect(g.edges).toEqual([]);
  });

  it('接入 customer、order、order_item、event 时，节点与边的种类、说明符合预期', () => {
    const g = graphOf(['customer', 'order', 'order_item', 'event']);
    expect(g.nodes.map(n => [n.id, n.kind]).sort()).toEqual([
      ['_device_owner', 'device'], ['_identities', 'identity'],
      ['customer', 'entity'], ['event', 'entity'], ['order', 'entity'], ['order_item', 'entity'],
    ]);
    const edge = (source: string, target: string) => g.edges.filter(e => e.source === source && e.target === target).map(e => ({ kind: e.kind, label: e.label }));
    expect(edge('order_item', 'order')).toEqual([{ kind: 'ref', label: 'order_id → order.order_id' }]);
    expect(edge('order', 'customer')).toEqual([{ kind: 'identity', label: '经 _identities 按 (_customer_source, customer_id) 关联' }]);
    expect(edge('event', 'customer')).toEqual([{ kind: 'identity', label: '经 _identities 按 (_customer_source, customer_id) 关联' }]);
    expect(edge('customer', '_identities')).toEqual([{ kind: 'identity', label: 'customer_id → consumer_id' }]);
    expect(edge('event', '_device_owner')).toEqual([{ kind: 'device', label: 'device_id（不带 _source，取最近一次登录）' }]);
    // 只有指向标准实体的 ref / identity 边带起点字段，用来对上合并后的孤儿统计
    const fromField = (source: string, target: string) => g.edges.filter(e => e.source === source && e.target === target).map(e => e.fromField);
    expect(fromField('order_item', 'order')).toEqual(['order_id']);
    expect(fromField('order', 'customer')).toEqual(['customer_id']);
    expect(fromField('event', 'customer')).toEqual(['customer_id']);
    expect(fromField('customer', '_identities')).toEqual([undefined]);
    expect(fromField('event', '_device_owner')).toEqual([undefined]);
    // 两端都已接入的边才保留
    for (const e of g.edges) {
      expect(g.nodes.some(n => n.id === e.source)).toBe(true);
      expect(g.nodes.some(n => n.id === e.target)).toBe(true);
    }
    expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length);
  });

  it('跨源引用：同一字段已有内置边时合并到那条边上（不画重复边），扩展字段另出一条边；都带目标数据源', () => {
    const to = { table: 'silver.customer', field: 'customer_id' };
    const via = { table: 'silver._identities', on: ['_source', 'customer_id'] };
    const cross = [
      ...edges,
      { from: { entity: 'order', field: 'customer_id' }, to, via, kind: 'identity' as const, customerSource: 's-erp', customerSourceName: 'ERP' },
      { from: { entity: 'order', field: 'customer_id' }, to, via, kind: 'identity' as const, customerSource: 's-crm', customerSourceName: 'CRM' },
      // 同一字段指向同一数据源的只记一次
      { from: { entity: 'order', field: 'customer_id' }, to, via, kind: 'identity' as const, customerSource: 's-erp', customerSourceName: 'ERP' },
      { from: { entity: 'order', field: 'x_referrer' }, to, via, kind: 'identity' as const, customerSource: 's-gone' },
    ];
    const g = relationGraph({ edges: cross, connected: ['customer', 'order'], showAll: false });
    const toCustomer = g.edges.filter(e => e.source === 'order' && e.target === 'customer');
    expect(toCustomer.map(e => [e.fromField, e.crossSource])).toEqual([
      ['customer_id', [{ sourceId: 's-erp', name: 'ERP' }, { sourceId: 's-crm', name: 'CRM' }]],
      ['x_referrer', [{ sourceId: 's-gone', name: null }]],
    ]);
    expect(toCustomer.every(e => e.kind === 'identity')).toBe(true);
    expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length);
    expect(crossSourceLabel(toCustomer[0])).toBe('跨源 · ERP、CRM');
    // 不知道数据源名（没有 sources:read）时只写「跨源」
    expect(crossSourceLabel(toCustomer[1])).toBe('跨源');
    // 没有跨源声明时没有 crossSource，与现在一致
    expect(graphOf(['customer', 'order']).edges.some(e => 'crossSource' in e)).toBe(false);
    expect(crossSourceLabel(graphOf(['customer', 'order']).edges[0])).toBeNull();
  });

  it('每个节点都有坐标与尺寸；自定义实体只出节点，标签用实体名', () => {
    const g = graphOf(['customer', 'order', 'custom_store']);
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect([n.width, n.height]).toEqual([180, 56]);
    }
    expect(g.nodes.find(n => n.id === 'custom_store')).toMatchObject({ label: 'custom_store', kind: 'entity' });
    expect(g.edges.some(e => e.source === 'custom_store' || e.target === 'custom_store')).toBe(false);
    // 不止一层，坐标不全相同
    expect(new Set(g.nodes.map(n => n.x)).size).toBeGreaterThan(1);
  });

  it('显示未接入的标准实体时，未接入的实体出节点并标为未接入，两端有一端未接入的边也是未接入', () => {
    const g = graphOf(['customer', 'coupon'], { showAll: true });
    expect(g.nodes.find(n => n.id === 'coupon_template')).toMatchObject({ label: '券模板', kind: 'entity', connected: false });
    expect(g.nodes.find(n => n.id === 'coupon')).toMatchObject({ connected: true });
    expect(g.nodes.find(n => n.id === '_identities')).toMatchObject({ connected: true });
    // _device_owner 仍按 event 是否已接入
    expect(g.nodes.some(n => n.id === '_device_owner')).toBe(false);
    expect(g.edges.find(e => e.kind === 'ref' && e.source === 'coupon' && e.target === 'coupon_template')).toMatchObject({ connected: false });
    expect(g.edges.find(e => e.source === 'coupon' && e.target === 'customer')).toMatchObject({ connected: true });
    expect(g.edges.find(e => e.source === 'order_item' && e.target === 'order')).toMatchObject({ connected: false });
    // 未接入的表在湖里还没有，不给示例 SQL
    expect(sampleSql('coupon_template', g)).toBeNull();
    expect(sampleSql('coupon', g)).toContain('lake.silver."coupon"');
  });

  it('不显示未接入的标准实体时，没有这些节点，节点与边都是已接入', () => {
    const g = graphOf(['customer', 'coupon']);
    expect(g.nodes.map(n => n.id).sort()).toEqual(['_identities', 'coupon', 'customer']);
    expect(g.nodes.every(n => n.connected) && g.edges.every(e => e.connected)).toBe(true);
  });

  it('_identities 节点挂上打通摘要，并为显示摘要加高', () => {
    const identity = { rules: ['phone', 'email'], summary: { groups: 3, records: 7 } };
    const g = graphOf(['customer'], { identity });
    const node = g.nodes.find(n => n.id === '_identities')!;
    expect(node.identity).toEqual(identity);
    expect(node.height).toBeGreaterThan(56);
    expect(g.nodes.find(n => n.id === 'customer')!.identity).toBeUndefined();
    expect(ruleLabels(['phone', 'email', 'external_id'])).toBe('手机号 > 邮箱 > 外部 ID');
  });

  it('最近一次打通有合并或拆开时多一行「合并 N 组、拆开 M 组」并再加高；都为 0 或没有这两项时不显示', () => {
    const base = { groups: 3, records: 7 };
    expect(identityChangesLabel({ ...base, merged: 2, split: 0 })).toBe('合并 2 组、拆开 0 组');
    expect(identityChangesLabel({ ...base, merged: 0, split: 1 })).toBe('合并 0 组、拆开 1 组');
    for (const summary of [{ ...base, merged: 0, split: 0 }, { ...base, merged: null, split: null }, base, null]) expect(identityChangesLabel(summary)).toBeNull();
    const height = (summary: { groups: number; records: number; merged?: number; split?: number }) =>
      graphOf(['customer'], { identity: { rules: null, summary } }).nodes.find(n => n.id === '_identities')!.height;
    expect(height({ ...base, merged: 1, split: 0 })).toBeGreaterThan(height(base));
  });
});

describe('示例 SQL', () => {
  const g = graphOf(['customer', 'order', 'order_item', 'event', 'custom_store']);

  it('按统一消费者汇总订单：join lake.silver."_identities"，按 customer_id 旁的数据源列 _customer_source 关联（跨源引用），不带连接方式与凭据', () => {
    const sql = sampleSql('order', g)!;
    expect(sql).toContain('lake.silver."order"');
    expect(sql).toContain('lake.silver."_identities"');
    expect(sql).toContain('i._source = t."_customer_source" AND i.customer_id = t."customer_id"');
    expect(sql).toContain('consumer_id');
    expect(sql).toContain('LIMIT 100');
    for (const id of g.nodes.map(n => n.id)) {
      const s = sampleSql(id, g)!;
      expect(s).toContain('lake.silver.');
      for (const banned of ['ATTACH', 'password', 's3://']) expect(s).not.toContain(banned);
    }
  });

  it('customer、_identities、_device_owner 与其余表各有模板，不认识的节点返回 null', () => {
    expect(sampleSql('customer', g)).toContain('i.consumer_id, c.*');
    expect(sampleSql('customer', g)).toContain('i._source = c._source');
    expect(sampleSql('_identities', g)).toMatch(/GROUP BY consumer_id/);
    expect(sampleSql('_device_owner', g)).toContain('lake.silver."event" e LEFT JOIN lake.silver."_device_owner" d ON d.device_id = e.device_id');
    expect(sampleSql('order_item', g)).toBe('SELECT *\nFROM lake.silver."order_item"\nLIMIT 100;');
    expect(sampleSql('custom_store', g)).toContain('lake.silver."custom_store"');
    expect(sampleSql('nope', g)).toBeNull();
  });
});

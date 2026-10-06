// test/lineage-graph.test.ts —— 数据地图的关系图：由血缘的关系边与已接入的实体画出节点（含 _identities、_device_owner）、边的种类与说明、
// dagre 布局的坐标，以及点表节点给出的示例 SQL（按租户湖挂载为 lake 来写，不带连接方式与凭据）（纯函数）
import { describe, expect, it } from 'vitest';
import { deriveLineage } from '../app/lib/lineage';
import { relationGraph, sampleSql } from '../app/lib/lineage-graph';

const { edges } = deriveLineage({ plans: [], sources: [] });
const graphOf = (connected: string[]) => relationGraph({ edges, connected });

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
    expect(edge('order', 'customer')).toEqual([{ kind: 'identity', label: '经 _identities 按 (_source, customer_id) 关联' }]);
    expect(edge('event', 'customer')).toEqual([{ kind: 'identity', label: '经 _identities 按 (_source, customer_id) 关联' }]);
    expect(edge('customer', '_identities')).toEqual([{ kind: 'identity', label: 'customer_id → consumer_id' }]);
    expect(edge('event', '_device_owner')).toEqual([{ kind: 'device', label: 'device_id（不带 _source，取最近一次登录）' }]);
    // 两端都已接入的边才保留
    for (const e of g.edges) {
      expect(g.nodes.some(n => n.id === e.source)).toBe(true);
      expect(g.nodes.some(n => n.id === e.target)).toBe(true);
    }
    expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length);
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
});

describe('示例 SQL', () => {
  const g = graphOf(['customer', 'order', 'order_item', 'event', 'custom_store']);

  it('按统一消费者汇总订单：join lake.silver."_identities"，不带连接方式与凭据', () => {
    const sql = sampleSql('order', g)!;
    expect(sql).toContain('lake.silver."order"');
    expect(sql).toContain('lake.silver."_identities"');
    expect(sql).toContain('i._source = t._source AND i.customer_id = t.customer_id');
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
    expect(sampleSql('_identities', g)).toMatch(/GROUP BY consumer_id/);
    expect(sampleSql('_device_owner', g)).toContain('lake.silver."event" e LEFT JOIN lake.silver."_device_owner" d ON d.device_id = e.device_id');
    expect(sampleSql('order_item', g)).toBe('SELECT *\nFROM lake.silver."order_item"\nLIMIT 100;');
    expect(sampleSql('custom_store', g)).toContain('lake.silver."custom_store"');
    expect(sampleSql('nope', g)).toBeNull();
  });
});

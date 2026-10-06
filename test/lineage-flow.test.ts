// test/lineage-flow.test.ts —— 数据地图的流向图：源表挂在数据源分组下（子节点坐标相对分组、分组排在子节点前），源表 → 映射 → 标准层表 → 打通表的边，
// 数据源超过 5 个时默认全部折叠、折叠后边改从分组节点出发，标准层表的行数（最近一次合并成功的各映射的行数之和）与映射数，
// 映射节点的合并状态（成功、跳过、失败、从未合并）（纯函数）
import { describe, expect, it } from 'vitest';
import { deriveLineage, type TableLineage } from '../app/lib/lineage';
import { defaultCollapsed, type FlowMerge, flowGraph } from '../app/lib/lineage-flow';

const { edges: identityEdges } = deriveLineage({ plans: [], sources: [] });

const table = (sourceId: string, tableName: string, mapping: string, entity: string, version = 1): TableLineage => ({
  sourceId, sourceName: `${sourceId} 库`, sourceKind: 'postgres', table: tableName, viaView: false,
  mapping, version, entity, target: `silver.${entity}`, custom: false,
});

const tables = [
  table('crm', 'customers', 'm1', 'customer', 2),
  table('crm', 'orders', 'm2', 'order'),
  table('loyalty', 'members', 'm3', 'customer'),
  table('tracking', 'events', 'm4', 'event', 3),
];
const ok = (rows: number, at = '2026-10-01T00:00:00.000Z'): FlowMerge => ({ status: 'ok', at, rows });
const merges: Record<string, FlowMerge> = {
  m1: ok(10),
  m2: ok(5),
  m3: { status: 'failed', at: '2026-10-01T00:00:01.000Z', rows: null },
  m4: { status: 'skipped', at: '2026-10-01T00:00:02.000Z', rows: null },
};

describe('流向图', () => {
  it('源表挂在数据源分组下，分组排在子节点前，边从源表经映射到标准层表、再到打通表', () => {
    const g = flowGraph({ tables, merges, identityEdges }, new Set());
    const node = (id: string) => g.nodes.find(n => n.id === id)!;
    const groups = g.nodes.filter(n => n.type === 'group');
    expect(groups.map(n => n.id).sort()).toEqual(['source:crm', 'source:loyalty', 'source:tracking']);
    expect(node('source:crm').data).toMatchObject({ kind: 'source', label: 'crm 库', collapsed: false });

    const customers = node('table:crm:customers');
    expect(customers).toMatchObject({ parentId: 'source:crm', extent: 'parent', data: { kind: 'table', label: 'customers' } });
    expect(node('table:crm:orders').parentId).toBe('source:crm');
    for (const child of g.nodes.filter(n => n.parentId)) {
      const parent = g.nodes.findIndex(n => n.id === child.parentId);
      expect(parent).toBeGreaterThanOrEqual(0);
      expect(parent).toBeLessThan(g.nodes.indexOf(child));
      // 子节点坐标相对分组，落在分组之内
      const p = g.nodes[parent];
      expect(child.position.x).toBeGreaterThanOrEqual(0);
      expect(child.position.y).toBeGreaterThanOrEqual(0);
      expect(child.position.x + child.width!).toBeLessThanOrEqual(p.width!);
      expect(child.position.y + child.height!).toBeLessThanOrEqual(p.height!);
    }

    expect(node('mapping:m1').data).toMatchObject({ kind: 'mapping', label: 'customers → customer v2', mappingId: 'm1', version: 2 });
    const edge = (source: string, target: string) => g.edges.some(e => e.source === source && e.target === target);
    expect(edge('table:crm:customers', 'mapping:m1')).toBe(true);
    expect(edge('mapping:m1', 'silver.customer')).toBe(true);
    expect(edge('table:loyalty:members', 'mapping:m3')).toBe(true);
    expect(edge('mapping:m3', 'silver.customer')).toBe(true);
    expect(edge('silver.customer', '_identities')).toBe(true);
    expect(edge('silver.event', '_device_owner')).toBe(true);
    // 标准层表之间的关系属于关系图，不在流向图里
    expect(edge('silver.order', 'silver.customer')).toBe(false);
    for (const e of g.edges) {
      expect(g.nodes.some(n => n.id === e.source)).toBe(true);
      expect(g.nodes.some(n => n.id === e.target)).toBe(true);
    }
    expect(new Set(g.edges.map(e => e.id)).size).toBe(g.edges.length);
    expect(new Set(g.nodes.map(n => n.id)).size).toBe(g.nodes.length);
    // 从左到右：源表、映射、标准层表、打通表
    const x = (id: string) => node(id).position.x + (node(id).parentId ? node(node(id).parentId!).position.x : 0);
    expect(x('table:crm:customers')).toBeLessThan(x('mapping:m1'));
    expect(x('mapping:m1')).toBeLessThan(x('silver.customer'));
    expect(x('silver.customer')).toBeLessThan(x('_identities'));
  });

  it('6 个数据源时默认全部折叠，折叠的数据源画成一个节点，边改从分组节点出发', () => {
    const many = Array.from({ length: 6 }, (_, i) => table(`s${i}`, `t${i}`, `m${i}`, 'customer'));
    const ids = [...new Set(many.map(t => t.sourceId))];
    expect(defaultCollapsed(ids)).toEqual(new Set(ids));
    expect(defaultCollapsed(ids.slice(0, 5)).size).toBe(0);

    const g = flowGraph({ tables: many, merges: {}, identityEdges }, defaultCollapsed(ids));
    expect(g.nodes.some(n => n.data.kind === 'table')).toBe(false);
    expect(g.nodes.some(n => n.parentId)).toBe(false);
    const s0 = g.nodes.find(n => n.id === 'source:s0')!;
    expect(s0.type).not.toBe('group');
    expect(s0.data).toMatchObject({ kind: 'source', collapsed: true });
    expect([s0.width, s0.height]).toEqual([180, 56]);
    expect(g.edges.some(e => e.source === 'source:s0' && e.target === 'mapping:m0')).toBe(true);

    // 只折叠一个时，其余数据源照常展开
    const one = flowGraph({ tables: many, merges: {}, identityEdges }, new Set(['s0']));
    expect(one.edges.some(e => e.source === 'source:s0' && e.target === 'mapping:m0')).toBe(true);
    expect(one.edges.some(e => e.source === 'table:s1:t1' && e.target === 'mapping:m1')).toBe(true);
  });

  it('标准层表带写入它的映射数与最近一次合并成功的各映射的行数之和；最近一次失败或跳过的不计入行数', () => {
    const g = flowGraph({ tables, merges: { ...merges, m3: ok(7) }, identityEdges }, new Set());
    expect(g.nodes.find(n => n.id === 'silver.customer')!.data).toMatchObject({ kind: 'silver', label: 'silver.customer', rows: 17, mappings: 2 });
    expect(g.nodes.find(n => n.id === 'silver.order')!.data).toMatchObject({ rows: 5, mappings: 1 });

    const failed = flowGraph({ tables, merges, identityEdges }, new Set());
    expect(failed.nodes.find(n => n.id === 'silver.customer')!.data).toMatchObject({ rows: 10, mappings: 2 });
    expect(failed.nodes.find(n => n.id === 'silver.event')!.data).toMatchObject({ rows: 0, mappings: 1 });
  });

  it('映射节点带最近一次合并的时间与结果：成功、跳过、失败、从未合并', () => {
    const g = flowGraph({ tables, merges: { m1: merges.m1, m3: merges.m3, m4: merges.m4 }, identityEdges }, new Set());
    const data = (id: string) => g.nodes.find(n => n.id === `mapping:${id}`)!.data;
    expect(data('m1')).toMatchObject({ status: 'ok', at: '2026-10-01T00:00:00.000Z' });
    expect(data('m3')).toMatchObject({ status: 'failed', at: '2026-10-01T00:00:01.000Z' });
    expect(data('m4')).toMatchObject({ status: 'skipped', at: '2026-10-01T00:00:02.000Z' });
    expect(data('m2')).toMatchObject({ status: 'never', at: null });
  });

  it('打通表节点按接入的实体出现，_identities 挂上打通摘要', () => {
    const identity = { rules: ['phone'], summary: { groups: 3, records: 7 } };
    const g = flowGraph({ tables: [tables[1]], merges, identityEdges, identity }, new Set());
    expect(g.nodes.some(n => n.id === '_identities' || n.id === '_device_owner')).toBe(false);
    const withCustomer = flowGraph({ tables, merges, identityEdges, identity }, new Set());
    expect(withCustomer.nodes.find(n => n.id === '_identities')!.data).toMatchObject({ kind: 'identity', identity });
    expect(withCustomer.nodes.find(n => n.id === '_device_owner')!.data).toMatchObject({ kind: 'device' });
  });
});

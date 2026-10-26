// test/catalog-versions.test.ts —— 目录版本（ADR-0041）的比较：去掉统计后按条目标识比出新增、删除与改动，只改统计没有差异（纯函数，手工构造 CatalogInput）
import { describe, expect, it } from 'vitest';
import { buildCatalog, overview, toMarkdown, type CatalogInput } from '../app/.server/catalog';
import { diffCatalog, stripStats } from '../app/.server/catalog/versions';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const plan: MergeMappingParam = {
  mapping: 'm-order', version: 3, sourceId: 's-shop', entity: 'order', table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'state' },
  ],
  entityColumns: [], key: ['order_id'], latest: null,
};

const input = (over: Partial<CatalogInput> = {}): CatalogInput => ({
  sources: [{ id: 's-shop', name: '商城', kind: 'postgres' }, { id: 's-erp', name: 'ERP', kind: 'mysql' }],
  tables: [{ sourceId: 's-shop', name: 'orders', view: false, columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'state', type: 'VARCHAR' }] }],
  plans: [plan],
  customEntities: [{
    name: 'custom_store', label: '门店', kind: 'dimension', primaryKey: ['store_id'],
    fields: [{ name: 'store_id', type: 'string', description: '门店编码', sensitive: false }],
    relations: [],
  }],
  templates: [{ template: 'rfm', version: 1, params: { lookbackDays: 365 }, snapshot: null }],
  ...over,
});

/** 带统计：源表采集统计（字段来源的源端样本由它来）、实体行数与模板快照 */
const withStats = (rows = 120, over: Partial<CatalogInput> = {}): CatalogInput => ({
  ...input(over),
  tableStats: [{
    sourceId: 's-shop', name: 'orders', rows, sampleRows: 100, profiledAt: '2024-07-01T08:00:00.000Z',
    columns: [
      { name: 'order_id', type: 'BIGINT', nullRate: 0, min: '1', max: String(rows) },
      { name: 'state', type: 'VARCHAR', nullRate: 0.05, min: null, max: null, top: [{ value: '已支付', rows: rows - 10 }] },
    ],
  }],
  entityStats: [{ entity: 'order', rows: rows - 2, at: '2024-07-03T08:00:00.000Z' }],
  templates: [{ template: 'rfm', version: 1, params: { lookbackDays: 365 }, snapshot: { table: 'gold.rfm__t1', rows, at: '2026-10-01T00:00:00.000Z' } }],
});

const snap = (i: CatalogInput) => stripStats(buildCatalog(i));
const none = { added: [], removed: [], changed: [] };

describe('目录版本的比较', () => {
  it('只改统计（源表统计、源端样本、实体行数、模板快照）时没有差异', () => {
    const plain = buildCatalog(input());
    expect(JSON.stringify(buildCatalog(withStats()))).not.toBe(JSON.stringify(plain));
    expect(diffCatalog(snap(input()), snap(withStats()))).toEqual(none);
    expect(diffCatalog(snap(withStats()), snap(withStats(999)))).toEqual(none);
  });

  it('自定义实体加字段：实体条目改了 fields，字段条目是新增', () => {
    const more = input({ customEntities: [{ ...input().customEntities![0], fields: [
      ...input().customEntities![0].fields, { name: 'region', type: 'string', description: '所在大区', sensitive: false },
    ] }] });
    expect(diffCatalog(snap(withStats()), snap(withStats(500, more)))).toEqual({
      added: [{ id: 'field:custom_store.region', kind: 'field', name: 'region' }],
      removed: [],
      changed: [{ id: 'entity:custom_store', kind: 'entity', name: '门店', keys: ['fields'] }],
    });
  });

  it('改业务说明是字段条目的改动，只列出变了的顶层键', () => {
    const noted = input({ notes: new Map([['order.status', '只算已支付']]) });
    const d = diffCatalog(snap(input()), snap(noted));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([expect.objectContaining({ id: 'field:order.status', kind: 'field', keys: ['note'] })]);
  });

  it('删掉数据源：它的条目是删除；没有上一版时全部条目都是新增', () => {
    const d = diffCatalog(snap(input()), snap(input({ sources: [{ id: 's-shop', name: '商城', kind: 'postgres' }] })));
    expect(d).toEqual({ added: [], removed: [{ id: 'source:ERP', kind: 'source', name: 'ERP' }], changed: [] });
    const all = snap(input());
    expect(diffCatalog([], all).added.map(x => x.id)).toEqual(all.map(e => e.id));
  });

  it('总览带目录版本号，还没有版本时不显示', () => {
    const c = buildCatalog(input());
    expect(overview(c).version).toBeNull();
    expect(toMarkdown(overview(c))).not.toContain('目录版本');
    const v = overview({ ...c, version: 7 });
    expect(v.version).toBe(7);
    expect(toMarkdown(v).split('\n').slice(0, 3)).toEqual(['# 语义目录', '', '目录版本 7']);
    expect(stripStats({ ...c, version: 7 })).toEqual(stripStats(c));
  });
});

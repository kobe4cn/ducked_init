// test/catalog-projection.test.ts —— 目录检索投影（ADR-0047）的派生：纯函数，手工构造 CatalogInput。同一份目录派生两次相同；
// restricted 里没有数据源与源表行、字段文字不带映射说明与映射知识；只改统计时派生结果相同；可见性类别按角色算
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCatalog, type CatalogInput } from '../app/.server/catalog';
import { deriveProjection, visibilityClass } from '../app/.server/catalog/projection';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const SPACE = '00000000-0000-0000-0000-000000000000';

const plan: MergeMappingParam = {
  mapping: 'm-order', version: 3, sourceId: 's-shop', entity: 'order', table: 'sh_trade',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'state' },
  ],
  entityColumns: [], key: ['order_id'], latest: null,
};

/** 带映射说明与映射字段别名（只在 full 里出现）、实体字段别名与主题（两类都有）的输入 */
const input = (rows?: number): CatalogInput => ({
  sources: [{ id: 's-shop', name: '商城库', kind: 'postgres' }],
  tables: [{ sourceId: 's-shop', name: 'sh_trade', view: false, columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'state', type: 'VARCHAR' }] }],
  plans: [plan],
  templates: [{ template: 'rfm', version: 1, params: { lookbackDays: 365 }, spaceId: SPACE, snapshot: rows ? { table: 'gold.rfm__t1', rows, at: '2026-10-01T00:00:00.000Z' } : null }],
  notes: new Map([['order.status@m-order', '商城库的状态码']]),
  knowledge: { byTarget: new Map([
    ['field:order.status', { aliases: ['单据状态'], subjects: ['交易分析'] }],
    ['field:order.status\nm-order', { aliases: ['商城状态别名'] }],
  ]) },
  ...(rows && {
    tableStats: [{
      sourceId: 's-shop', name: 'sh_trade', rows, sampleRows: 100, profiledAt: '2024-07-01T08:00:00.000Z',
      columns: [{ name: 'state', type: 'VARCHAR', nullRate: 0, min: null, max: null, top: [{ value: '已支付', rows }] }],
    }],
    entityStats: [{ entity: 'order', rows, at: '2024-07-03T08:00:00.000Z' }],
  }),
});

describe('检索投影的派生', () => {
  it('同一份目录派生两次相同；每个条目一行、按 entryId 排序，textHash 是文字的 sha256，带别名、主题与所属空间', () => {
    const c = buildCatalog(input());
    const full = deriveProjection(c, 'full');
    expect(deriveProjection(buildCatalog(input()), 'full')).toEqual(full);
    expect(full.map(r => r.entryId)).toEqual(c.entries.map(e => e.id).sort());
    for (const r of full) expect(r.textHash).toBe(createHash('sha256').update(r.text).digest('hex'));
    expect(full.find(r => r.entryId === 'field:order.status')).toMatchObject({ aliases: ['单据状态'], subjects: ['交易分析'], spaceId: null });
    expect(full.find(r => r.entryId === 'template:rfm')).toMatchObject({ spaceId: SPACE, aliases: [], subjects: [] });
    expect(full.find(r => r.entryId === 'field:order.status')!.text).toContain('商城状态别名');
  });

  it('restricted 里没有 source: 与 table: 行，任何文字都不带数据源名、源表名、映射说明与映射知识', () => {
    const c = buildCatalog(input());
    const full = deriveProjection(c, 'full');
    const restricted = deriveProjection(c, 'restricted');
    expect(full.some(r => r.entryId.startsWith('source:'))).toBe(true);
    expect(full.some(r => r.entryId.startsWith('table:'))).toBe(true);
    expect(restricted.map(r => r.entryId)).toEqual(full.map(r => r.entryId).filter(id => !/^(source|table):/.test(id)));
    for (const r of restricted) {
      expect(r.text).not.toContain('商城');
      expect(r.text).not.toContain('sh_trade');
    }
    expect(restricted.find(r => r.entryId === 'field:order.status')).toMatchObject({ aliases: ['单据状态'], subjects: ['交易分析'] });
  });

  it('只改统计（源表统计、实体行数、模板快照）时派生结果相同', () => {
    for (const cls of ['full', 'restricted'] as const) {
      expect(deriveProjection(buildCatalog(input(120)), cls)).toEqual(deriveProjection(buildCatalog(input()), cls));
      expect(deriveProjection(buildCatalog(input(999)), cls)).toEqual(deriveProjection(buildCatalog(input()), cls));
    }
  });

  it('可见性类别按角色算：有 sources:read 是 full，否则 restricted', () => {
    expect(visibilityClass('admin')).toBe('full');
    expect(visibilityClass('analyst')).toBe('full');
    expect(visibilityClass('viewer')).toBe('restricted');
  });
});

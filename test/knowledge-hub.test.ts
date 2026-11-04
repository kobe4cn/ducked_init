// test/knowledge-hub.test.ts —— 业务知识集中页的读模型 buildKnowledgeHub（ADR-0046，纯函数，不碰库）：
// 多主题的条目每组各出现一次、总数按条目去重；主题按 cmpName 排、「未归入主题」在最后；需复核的 unknown 记为 needsReview；
// 指标的成员声明优先于系统声明；带 mappingId 的提案、目标不在条目里的提案不计数；所属实体未接入（tables 为空）的 decimal 字段不列
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, EntityEntry, FieldEntry, MetricEntry } from '../app/.server/catalog';
import type { Claim, Knowledge } from '../app/.server/knowledge/catalog';
import { buildKnowledgeHub } from '../app/.server/knowledge/hub';
import type { Proposal } from '../app/.server/knowledge/proposals';

/** 手写目录输入里定义与模板所属的空间：目录只记录它，不按它过滤（ADR-0048） */
const SPACE = '00000000-0000-0000-0000-000000000000';

const entity = (name: string, tables: string[], knowledge?: Knowledge): EntityEntry => ({
  kind: 'entity', id: `entity:${name}`, name, description: '', entity: name, custom: false, key: ['id'], fields: [],
  tables, unscoped: [], relations: [], mergeGroups: [], stats: null, ...(knowledge ? { knowledge } : {}),
});

const field = (entityName: string, name: string, knowledge?: Knowledge): FieldEntry => ({
  kind: 'field', id: `field:${entityName}.${name}`, name, description: '', entity: `entity:${entityName}`, field: name,
  type: 'decimal', lineage: [], ...(knowledge ? { knowledge } : {}),
});

const metric = (key: string, system: Claim[], knowledge?: Knowledge): MetricEntry => ({
  kind: 'metric', id: `metric:${key}`, name: key, description: '', key, version: 1, spaceId: SPACE, base: 'order', measure: 'sum(amount)',
  dimensions: [], dependencies: { metrics: [], entities: [], fields: [] }, system: { text: '', claims: system },
  ...(knowledge ? { knowledge } : {}),
});

const proposal = (targetId: string, mappingId: string | null = null) => ({ targetId, mappingId, status: 'proposed' }) as Proposal;

const UNKNOWN_UNIT: Claim[] = [{ type: 'unit', value: 'unknown' }];

describe('buildKnowledgeHub', () => {
  it('属于两个主题的条目两组都有，总数按条目去重；主题按 cmpName 排，未归入主题在最后', () => {
    const entries: CatalogEntry[] = [
      metric('revenue', UNKNOWN_UNIT, { subjects: ['营收', '订单'] }),
      metric('gmv', UNKNOWN_UNIT),
    ];
    const hub = buildKnowledgeHub(entries, [proposal('metric:revenue'), proposal('metric:revenue')]);

    expect(hub.groups.map(g => g.subject)).toEqual(['订单', '营收', null]);
    for (const g of hub.groups.slice(0, 2)) {
      expect(g.items.map(i => i.targetId)).toEqual(['metric:revenue']);
      expect(g).toMatchObject({ proposals: 2, missing: 1 });
    }
    expect(hub.groups[2].items.map(i => i.targetId)).toEqual(['metric:gmv']);
    expect(hub.totals).toEqual({ proposals: 2, missing: 2, subjects: 2 });
  });

  it('主题排序用 cmpName（汉字按拼音、排在拉丁字母前）', () => {
    const entries: CatalogEntry[] = [
      metric('a', UNKNOWN_UNIT, { subjects: ['Zeta'] }),
      metric('b', UNKNOWN_UNIT, { subjects: ['营收'] }),
      metric('c', UNKNOWN_UNIT, { subjects: ['订单'] }),
      metric('d', UNKNOWN_UNIT),
      metric('e', UNKNOWN_UNIT, { subjects: ['Alpha'] }),
    ];
    expect(buildKnowledgeHub(entries, []).groups.map(g => g.subject)).toEqual(['订单', '营收', 'Alpha', 'Zeta', null]);
  });

  it('需复核的 unknown 记为 needsReview，普通 unknown 记为 unknown，没有声明记为 undeclared', () => {
    const entries: CatalogEntry[] = [
      metric('stale', [], { claims: [{ type: 'unit', value: 'unknown', previous: 'currency_major', needsReview: true }] }),
      metric('plain', UNKNOWN_UNIT),
      metric('none', []),
    ];
    const items = buildKnowledgeHub(entries, []).groups.flatMap(g => g.items);
    expect(Object.fromEntries(items.map(i => [i.targetId, i.missing]))).toEqual({
      'metric:stale': [{ type: 'unit', state: 'needsReview' }],
      'metric:plain': [{ type: 'unit', state: 'unknown' }],
      'metric:none': [{ type: 'unit', state: 'undeclared' }],
    });
  });

  it('指标有成员声明时以成员声明为准，不看系统声明', () => {
    const entries: CatalogEntry[] = [
      metric('declared', UNKNOWN_UNIT, { claims: [{ type: 'unit', value: 'currency_major' }] }),
      metric('overridden', [{ type: 'unit', value: 'currency_major' }], { claims: [{ type: 'unit', value: 'unknown' }] }),
    ];
    const hub = buildKnowledgeHub(entries, []);
    expect(hub.groups.flatMap(g => g.items).map(i => [i.targetId, i.missing])).toEqual([
      ['metric:overridden', [{ type: 'unit', state: 'unknown' }]],
    ]);
  });

  it('带 mappingId 的提案、目标不在条目里的提案不计数', () => {
    const entries: CatalogEntry[] = [entity('order', []), metric('revenue', [{ type: 'unit', value: 'currency_major' }])];
    const hub = buildKnowledgeHub(entries, [
      proposal('entity:order', '00000000-0000-0000-0000-000000000001'),
      proposal('metric:deleted'),
      proposal('field:customer.email'),
      proposal('metric:revenue'),
    ]);
    expect(hub.groups.flatMap(g => g.items).map(i => [i.targetId, i.proposals])).toEqual([['metric:revenue', 1]]);
    expect(hub.totals.proposals).toBe(1);
  });

  it('所属实体已接入的 decimal 字段检查单位与币种，tables 为空的实体的 decimal 字段不列', () => {
    const entries: CatalogEntry[] = [
      entity('order', ['CRM/orders']), field('order', 'amount'),
      entity('card', []), field('card', 'balance'),
    ];
    const hub = buildKnowledgeHub(entries, []);
    expect(hub.groups.flatMap(g => g.items).map(i => [i.targetId, i.missing])).toEqual([
      ['field:order.amount', [{ type: 'unit', state: 'undeclared' }, { type: 'currency', state: 'undeclared' }]],
    ]);
    expect(hub.totals).toEqual({ proposals: 0, missing: 2, subjects: 0 });
  });
});

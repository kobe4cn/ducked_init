// test/key-check.test.ts —— 主键冲突体检的入队参数（按实体汇总映射、主键与是否按数据源比较）与建议的判定顺序（纯函数）
import { describe, expect, it } from 'vitest';
import type { RegisteredEntity } from '../app/.server/custom-entities';
import { keyCheckEntities } from '../app/.server/key-check';
import { suggestionOf } from '../app/.server/pipeline/key-check-engine';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const plan = (mapping: string, entity: string, columns: string[]): MergeMappingParam => ({
  mapping, version: 1, sourceId: 's1', entity, table: 't', entityColumns: [], key: [columns[0]], latest: null,
  columns: columns.map(name => ({ name, type: 'string', expr: name })),
});

const registration = (name: string, primaryKey: string[], relations: RegisteredEntity['relations'] = []): RegisteredEntity => ({
  name, label: name, kind: 'fact', fields: primaryKey.map(f => ({ name: f, type: 'string', description: '', sensitive: false })), primaryKey, relations,
});

describe('体检参数', () => {
  it('按实体汇总映射与列；customer 不参与；主键含指向 customer 的字段（内置 ref 或登记上的关系）时按数据源比较', () => {
    const published = new Map([
      ['custom_visit', registration('custom_visit', ['member_id', 'day'], [{ from: { entity: 'custom_visit', field: 'member_id' }, ref: { entity: 'customer', field: 'customer_id' } }])],
      ['custom_ticket', registration('custom_ticket', ['ticket_id'])],
    ]);
    expect(keyCheckEntities([
      plan('m1', 'customer', ['customer_id']),
      plan('m2', 'touch', ['touch_id', 'campaign_id']),
      plan('m3', 'touch', ['touch_id']),
      plan('m4', 'consent', ['customer_id', 'channel']),
      plan('m5', 'custom_visit', ['member_id', 'day']),
      plan('m6', 'custom_ticket', ['ticket_id']),
      plan('m7', 'custom_unknown', ['id']),
    ], published)).toEqual([
      { entity: 'touch', key: ['touch_id'], bySource: false, mappings: [{ mapping: 'm2', columns: ['touch_id', 'campaign_id'] }, { mapping: 'm3', columns: ['touch_id'] }] },
      { entity: 'consent', key: ['customer_id', 'channel'], bySource: true, mappings: [{ mapping: 'm4', columns: ['customer_id', 'channel'] }] },
      { entity: 'custom_visit', key: ['member_id', 'day'], bySource: true, mappings: [{ mapping: 'm5', columns: ['member_id', 'day'] }] },
      { entity: 'custom_ticket', key: ['ticket_id'], bySource: false, mappings: [{ mapping: 'm6', columns: ['ticket_id'] }] },
    ]);
  });
});

describe('建议', () => {
  it('依次取第一条命中的：一边的键全在另一边里 → 比例 ≥ 0.8 → 比例 ≤ 0.2 → 人工判断（含没有可比的字段）', () => {
    expect(suggestionOf({ overlap: 10, keysA: 10, keysB: 50, agreement: 0.5 })).toBe('duplicate');
    expect(suggestionOf({ overlap: 10, keysA: 50, keysB: 10, agreement: null })).toBe('duplicate');
    expect(suggestionOf({ overlap: 10, keysA: 20, keysB: 50, agreement: 0.8 })).toBe('drop_one');
    expect(suggestionOf({ overlap: 10, keysA: 20, keysB: 50, agreement: 0.2 })).toBe('key_space');
    expect(suggestionOf({ overlap: 10, keysA: 20, keysB: 50, agreement: 0.5 })).toBe('review');
    expect(suggestionOf({ overlap: 10, keysA: 20, keysB: 50, agreement: null })).toBe('review');
  });
});

// test/llm-context.test.ts —— buildTableContext（纯函数）：采集的表统计 → 发给模型的表上下文；没给样本时不带 samples 键
import { describe, expect, it } from 'vitest';
import { buildTableContext } from '../app/.server/pipeline/llm-context';
import type { TableProfile } from '../app/.server/pipeline/source-engine';

const PROFILE: TableProfile = {
  name: 'customers',
  rows: 40,
  sampleRows: 40,
  columns: [
    { name: 'customer_id', type: 'INTEGER', nullRate: 0, distinct: 40, min: '1', max: '40' },
    { name: 'email', type: 'VARCHAR', nullRate: 0.25, distinct: 30, min: null, max: null, length: { min: 16, max: 18 }, formats: [{ format: 'email', share: 1 }] },
    { name: 'city', type: 'VARCHAR', nullRate: 0, distinct: 4, min: null, max: null, length: { min: 2, max: 2 }, top: [{ value: '上海', rows: 10 }] },
  ],
  watermarkCandidates: [{ column: 'updated_at', kind: 'updated_at', reason: '更新时间' }],
  primaryKey: ['customer_id'],
  keyCandidates: [],
};

describe('buildTableContext', () => {
  it('只有表结构与列统计，没有 samples 键', () => {
    const context = buildTableContext(PROFILE);
    expect('samples' in context).toBe(false);
    expect(context).toEqual({
      table: 'customers',
      rows: 40,
      primaryKey: ['customer_id'],
      keyCandidates: [],
      columns: [
        { name: 'customer_id', type: 'INTEGER', nullRate: 0, distinct: 40, min: '1', max: '40', length: null, formats: null, top: null },
        { name: 'email', type: 'VARCHAR', nullRate: 0.25, distinct: 30, min: null, max: null, length: { min: 16, max: 18 }, formats: [{ format: 'email', share: 1 }], top: null },
        { name: 'city', type: 'VARCHAR', nullRate: 0, distinct: 4, min: null, max: null, length: { min: 2, max: 2 }, formats: null, top: [{ value: '上海', rows: 10 }] },
      ],
    });
  });

  it('给了样本行时原样带上', () => {
    const samples = [{ customer_id: 1, email: 'a'.repeat(64), city: '上海' }];
    expect(buildTableContext(PROFILE, samples).samples).toEqual(samples);
    expect(buildTableContext(PROFILE, []).samples).toEqual([]);
  });
});

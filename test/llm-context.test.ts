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

  it('敏感列名的 min / max 剔成 null，兜住旧的采集结果（#1317）：BIGINT 手机号、DATE 生日都不带，普通数值列保持原值', () => {
    const context = buildTableContext({
      ...PROFILE,
      columns: [
        { name: '买家手机号', type: 'BIGINT', nullRate: 0.5841, distinct: 1990, min: '13000000029', max: '13000000035' },
        { name: 'birthday', type: 'DATE', nullRate: 0, distinct: 30, min: '1990-01-01', max: '2000-12-31' },
        { name: '数量', type: 'INTEGER', nullRate: 0, distinct: 5, min: '1', max: '9' },
      ],
    });
    const byName = Object.fromEntries(context.columns.map(c => [c.name, c]));
    expect(byName['买家手机号']).toMatchObject({ min: null, max: null });
    expect(byName['birthday']).toMatchObject({ min: null, max: null });
    expect(byName['数量']).toMatchObject({ min: '1', max: '9' });
  });
});

// test/lake-inspect.test.ts —— 漂移检查的应有结构：按实体汇总各已发布映射的列（敏感字段一律 VARCHAR、多映射取并集、带系统列），
// 以及比较前的类型规范化（纯函数）
import { describe, expect, it } from 'vitest';
import { expectedTables } from '../app/.server/lake-inspect';
import { normalizeType } from '../app/.server/pipeline/inspect-engine';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const plan = (mapping: string, entity: string, entityColumns: MergeMappingParam['entityColumns'], columns: MergeMappingParam['columns'] = []): MergeMappingParam => ({
  mapping, version: 1, sourceId: 's1', entity, table: 't', columns, entityColumns, key: ['customer_id'], latest: null,
});

const SYSTEM = { _mapping: 'VARCHAR', _source: 'VARCHAR', _version: 'INTEGER', _merged_at: 'TIMESTAMPTZ', _key_space: 'VARCHAR' };

describe('应有结构', () => {
  it('敏感字段写成 VARCHAR，其余按字段类型；同一实体的多个映射取列的并集，带系统列', () => {
    const expected = expectedTables([
      plan('m1', 'customer', [{ name: 'customer_id', type: 'string' }, { name: 'phone', type: 'string' }, { name: 'x_points', type: 'integer' }]),
      plan('m2', 'customer', [{ name: 'customer_id', type: 'string' }, { name: 'phone', type: 'string' }, { name: 'x_wechat', type: 'string' }, { name: 'x_level', type: 'integer' }],
        [{ name: 'x_level', type: 'integer', expr: 'level', sensitive: true }]),
      plan('m3', 'order', [{ name: 'order_id', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'paid_at', type: 'timestamp' }]),
    ]);
    expect(expected).toEqual({
      customer: { customer_id: 'VARCHAR', phone: 'VARCHAR', x_points: 'BIGINT', x_wechat: 'VARCHAR', x_level: 'VARCHAR', ...SYSTEM },
      order: { order_id: 'VARCHAR', amount: 'DECIMAL(18, 2)', paid_at: 'TIMESTAMPTZ', ...SYSTEM },
    });
  });

  it('没有已发布映射时没有应有的表', () => {
    expect(expectedTables([])).toEqual({});
  });
});

describe('类型规范化', () => {
  it('转大写、去掉空白，带时区的时间统一写成 TIMESTAMPTZ', () => {
    expect(normalizeType('DECIMAL(18, 2)')).toBe(normalizeType('DECIMAL(18,2)'));
    expect(normalizeType('TIMESTAMP WITH TIME ZONE')).toBe('TIMESTAMPTZ');
    expect(normalizeType('timestamptz')).toBe('TIMESTAMPTZ');
    expect(normalizeType('varchar')).toBe('VARCHAR');
    expect(normalizeType('TIMESTAMP')).not.toBe(normalizeType('TIMESTAMPTZ'));
  });
});

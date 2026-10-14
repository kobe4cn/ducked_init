// test/schema-diff.test.ts —— 源表结构的比对：新增、删除、改类型的列，类型变化是否只是放宽（纯函数）
import { describe, expect, it } from 'vitest';
import { diffColumns, isWidened } from '../app/.server/pipeline/schema-diff';

const cols = (spec: Record<string, string>) => Object.entries(spec).map(([name, type]) => ({ name, type }));

describe('diffColumns', () => {
  it('结构没变时 changed 为 false，各项为空', () => {
    const same = cols({ id: 'INTEGER', name: 'VARCHAR' });
    expect(diffColumns(same, same)).toEqual({ changed: false, added: [], removed: [], typeChanged: [] });
  });

  it('列出新增、删除与改类型的列，类型变化带原类型、新类型与是否放宽', () => {
    const prev = cols({ id: 'INTEGER', amount: 'DECIMAL(10,2)', note: 'VARCHAR', code: 'BIGINT' });
    const next = cols({ id: 'BIGINT', amount: 'INTEGER', code: 'VARCHAR', level: 'VARCHAR' });
    expect(diffColumns(prev, next)).toEqual({
      changed: true,
      added: ['level'],
      removed: ['note'],
      typeChanged: [
        { name: 'id', from: 'INTEGER', to: 'BIGINT', widened: true },
        { name: 'amount', from: 'DECIMAL(10,2)', to: 'INTEGER', widened: false },
        { name: 'code', from: 'BIGINT', to: 'VARCHAR', widened: true },
      ],
    });
  });

  it('只是列的顺序变了不算变化', () => {
    expect(diffColumns(cols({ a: 'INTEGER', b: 'VARCHAR' }), cols({ b: 'VARCHAR', a: 'INTEGER' })).changed).toBe(false);
  });
});

describe('isWidened', () => {
  it('整数加宽、DATE 到 TIMESTAMP、DECIMAL 位数够时是放宽；变窄或丢小数位不是', () => {
    expect(isWidened('SMALLINT', 'INTEGER')).toBe(true);
    expect(isWidened('BIGINT', 'INTEGER')).toBe(false);
    expect(isWidened('DATE', 'TIMESTAMP WITH TIME ZONE')).toBe(true);
    expect(isWidened('INTEGER', 'DECIMAL(12,2)')).toBe(true);
    expect(isWidened('DECIMAL(10,2)', 'DECIMAL(10,0)')).toBe(false);
  });
});

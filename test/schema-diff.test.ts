// test/schema-diff.test.ts —— 源表结构的比对：新增、删除、改类型的列，类型变化是否只是放宽、是否破坏映射引用的列（纯函数）
import { describe, expect, it } from 'vitest';
import { breakingColumns, diffColumns, isBreaking, isWidened } from '../app/.server/pipeline/schema-diff';

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

describe('破坏性变化', () => {
  it('isBreaking：收窄或改成 VARCHAR（原来不是）算破坏性，放宽到别的类型不算', () => {
    expect(isBreaking('DECIMAL(10,2)', 'INTEGER')).toBe(true);
    expect(isBreaking('INTEGER', 'VARCHAR')).toBe(true);
    expect(isBreaking('INTEGER', 'BIGINT')).toBe(false);
    expect(isBreaking('VARCHAR', 'VARCHAR')).toBe(false);
  });

  it('breakingColumns：只看引用的列，对照原始层类型；删除的列与破坏性改类型的列分开列出，原始层没有的列不查', () => {
    const bronze = cols({ id: 'INTEGER', amount: 'DECIMAL(10,2)', phone: 'VARCHAR', code: 'INTEGER', note: 'VARCHAR' });
    // code 上一次改成了 BIGINT，这次又改成 VARCHAR：对照原始层的 INTEGER
    const latest = cols({ id: 'BIGINT', amount: 'INTEGER', code: 'VARCHAR' });
    expect(breakingColumns(new Set(['id', 'amount', 'phone', 'code', 'ghost']), bronze, latest)).toEqual({
      removed: ['phone'],
      typeChanged: [{ name: 'amount', from: 'DECIMAL(10,2)', to: 'INTEGER' }, { name: 'code', from: 'INTEGER', to: 'VARCHAR' }],
    });
    expect(breakingColumns(new Set(['id']), bronze, latest)).toEqual({ removed: [], typeChanged: [] });
  });
});
